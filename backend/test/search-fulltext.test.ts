import fs from 'node:fs';
import path from 'node:path';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { pool } from '../src/db';
import { createMessage, deleteMessage } from '../src/services/message';
import { createRoom, joinRoom } from '../src/services/room';
import type { AuthUser } from '../src/types';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

function searchRoomAs(user: AuthUser, roomId: number, query: Record<string, string | number>) {
  return request(app)
    .get(`/api/rooms/${roomId}/search`)
    .query(query)
    .set('Authorization', `Bearer ${tokenFor(user)}`);
}

function searchGloballyAs(user: AuthUser, query: Record<string, string | number>) {
  return request(app)
    .get('/api/search/messages')
    .query(query)
    .set('Authorization', `Bearer ${tokenFor(user)}`);
}

/** Backdates a message so date-window assertions do not depend on the clock. */
async function setCreatedAt(id: number, value: string): Promise<void> {
  await pool.execute('UPDATE messages SET created_at = ? WHERE id = ?', [value, id]);
}

async function seed(
  roomId: number,
  sender: AuthUser,
  content: string,
  options: {
    createdAt?: string;
    status?: 'done' | 'streaming';
    senderType?: 'user' | 'bot' | 'system';
  } = {},
): Promise<{ id: number; seq: number }> {
  const message = await createMessage({
    roomId,
    senderId: sender.id,
    senderType: options.senderType ?? 'user',
    content,
    status: options.status,
  });
  if (options.createdAt) {
    await setCreatedAt(message.id, options.createdAt);
  }
  return { id: message.id, seq: message.seq };
}

function contents(res: request.Response): string[] {
  return (res.body.messages as Array<{ content: string }>).map((message) => message.content);
}

describe('message full-text search', () => {
  it('matches English words and their prefixes through the ngram index', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });
    await seed(room.id, alice, 'searchable needle');
    await seed(room.id, alice, 'needle in a haystack');
    await seed(room.id, alice, 'unrelated message');

    const needle = await searchRoomAs(alice, room.id, { q: 'needle' });
    expect(needle.status).toBe(200);
    expect(contents(needle)).toEqual(['needle in a haystack', 'searchable needle']);

    // ngram stores bigrams, so a two-character-plus fragment still matches in
    // the middle of a word, exactly like the LIKE scan it replaced.
    const prefix = await searchRoomAs(alice, room.id, { q: 'need' });
    expect(prefix.status).toBe(200);
    expect(contents(prefix)).toEqual(['needle in a haystack', 'searchable needle']);
  });

  it('matches CJK text with a two-character query', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });
    await seed(room.id, alice, '我们的聊天室');
    await seed(room.id, alice, '聊天室消息检索');
    await seed(room.id, alice, '完全无关的内容');

    const chat = await searchRoomAs(alice, room.id, { q: '聊天' });
    expect(chat.status).toBe(200);
    expect(contents(chat)).toEqual(['聊天室消息检索', '我们的聊天室']);

    const chatRoom = await searchRoomAs(alice, room.id, { q: '聊天室' });
    expect(chatRoom.status).toBe(200);
    expect(contents(chatRoom)).toEqual(['聊天室消息检索', '我们的聊天室']);

    const message = await searchRoomAs(alice, room.id, { q: '消息' });
    expect(message.status).toBe(200);
    expect(contents(message)).toEqual(['聊天室消息检索']);
  });

  it('keeps a multi-word query as one adjacent phrase', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });
    await seed(room.id, alice, 'alpha beta');
    await seed(room.id, alice, 'alpha gamma beta');
    await seed(room.id, alice, 'beta alpha');

    // Unquoted BOOLEAN MODE would return all three; the phrase must stay
    // adjacent and in order.
    const phrase = await searchRoomAs(alice, room.id, { q: 'alpha beta' });
    expect(phrase.status).toBe(200);
    expect(contents(phrase)).toEqual(['alpha beta']);
  });

  it('falls back to LIKE for a single character', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });
    await seed(room.id, alice, 'cat');
    await seed(room.id, alice, 'dog');
    await seed(room.id, alice, '你好世界');

    // The ngram index cannot answer a one-character query, so it must still
    // behave like the old substring scan.
    const latin = await searchRoomAs(alice, room.id, { q: 'a' });
    expect(latin.status).toBe(200);
    expect(contents(latin)).toEqual(['cat']);

    const cjk = await searchRoomAs(alice, room.id, { q: '你' });
    expect(cjk.status).toBe(200);
    expect(contents(cjk)).toEqual(['你好世界']);
  });

  it('falls back to LIKE for LIKE and BOOLEAN MODE metacharacters', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });
    await seed(room.id, alice, '100% sure');
    await seed(room.id, alice, 'a_b match');
    await seed(room.id, alice, 'back\\slash');
    await seed(room.id, alice, 'say "needle" now');
    await seed(room.id, alice, 'ping @alice');
    await seed(room.id, alice, 'plus +minus');
    await seed(room.id, alice, 'plain needle');

    const cases: Array<[string, string]> = [
      ['%', '100% sure'],
      ['_', 'a_b match'],
      ['\\', 'back\\slash'],
      ['"needle"', 'say "needle" now'],
      ['@alice', 'ping @alice'],
      ['+minus', 'plus +minus'],
      ['100%', '100% sure'],
    ];

    for (const [query, expected] of cases) {
      const res = await searchRoomAs(alice, room.id, { q: query });
      expect(res.status, query).toBe(200);
      expect(contents(res), query).toEqual([expected]);
    }
  });

  it('falls back to LIKE when the ngram index drops stopwords', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });
    await seed(room.id, alice, 'in the room');
    await seed(room.id, alice, 'the quick brown fox');
    await seed(room.id, alice, 'with great power');
    await seed(room.id, alice, 'unrelated message');

    // InnoDB's default stopword list covers "the", "in" and "with", so the
    // ngram index can return nothing for text that is literally present; the
    // service must re-run the query as a LIKE scan.
    const cases: Array<[string, string[]]> = [
      ['the', ['the quick brown fox', 'in the room']],
      ['in', ['in the room']],
      ['with', ['with great power']],
      ['in the room', ['in the room']],
    ];
    for (const [query, expected] of cases) {
      const res = await searchRoomAs(alice, room.id, { q: query });
      expect(res.status, query).toBe(200);
      expect(contents(res), query).toEqual(expected);
    }
  });

  it('re-runs as LIKE when the index returns nothing for an indexed bigram', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });
    await seed(room.id, alice, 'with great power');
    await seed(room.id, alice, 'unrelated message');

    // "wi" is a valid two-letter query, but the bigram contains the stopword
    // "i", so the ngram index stores no entry and the MATCH returns zero
    // rows. The literal scan must still find the message.
    const roomRes = await searchRoomAs(alice, room.id, { q: 'wi' });
    expect(roomRes.status).toBe(200);
    expect(contents(roomRes)).toEqual(['with great power']);

    const globalRes = await searchGloballyAs(alice, { q: 'wi' });
    expect(globalRes.status).toBe(200);
    expect(globalRes.body.total).toBe(1);
    expect(contents(globalRes)).toEqual(['with great power']);
  });

  it('reuses sender and date filters when falling back for a stopword phrase', async () => {
    const alice = await createTestUser('alice');
    const bob = await createTestUser('bob');
    const room = await createRoom(alice.id, { name: 'general' });
    await joinRoom(bob.id, room.id);
    await seed(room.id, bob, 'in the room by bob', { createdAt: '2024-06-15 12:00:00.000' });
    await seed(room.id, alice, 'in the room by alice', {
      createdAt: '2024-06-15 12:00:00.000',
    });
    await seed(room.id, bob, 'in the room too old', {
      createdAt: '2023-01-01 12:00:00.000',
    });

    const res = await searchRoomAs(alice, room.id, {
      q: 'in the room',
      senderId: bob.id,
      from: '2024-06-01',
      to: '2024-06-30',
    });
    expect(res.status).toBe(200);
    expect(contents(res)).toEqual(['in the room by bob']);
  });

  it('combines the full-text path with sender, type and date filters', async () => {
    const alice = await createTestUser('alice');
    const bob = await createTestUser('bob');
    const helper = await createTestUser('helperbot', 'user', 'bot');
    const room = await createRoom(alice.id, { name: 'general' });
    await joinRoom(bob.id, room.id);

    await seed(room.id, bob, 'needle target', { createdAt: '2024-06-15 12:00:00.000' });
    await seed(room.id, bob, 'needle too old', { createdAt: '2023-01-01 12:00:00.000' });
    await seed(room.id, alice, 'needle wrong sender', {
      createdAt: '2024-06-15 12:00:00.000',
    });
    await seed(room.id, helper, 'needle from the bot', {
      createdAt: '2024-06-16 12:00:00.000',
      senderType: 'bot',
    });

    const filtered = await searchRoomAs(alice, room.id, {
      q: 'needle',
      senderId: bob.id,
      from: '2024-06-01',
      to: '2024-06-30',
    });
    expect(filtered.status).toBe(200);
    expect(contents(filtered)).toEqual(['needle target']);

    // A bot-authored row goes through the same index and keeps its sender.
    const fromBot = await searchRoomAs(alice, room.id, { q: 'needle', senderId: helper.id });
    expect(fromBot.status).toBe(200);
    expect(contents(fromBot)).toEqual(['needle from the bot']);
    expect(fromBot.body.messages[0].senderType).toBe('bot');
  });

  it('skips deleted and streaming messages on the full-text path', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });
    const deleted = await seed(room.id, alice, 'needle deleted');
    await deleteMessage(room.id, deleted.seq, alice.id, false);
    await seed(room.id, alice, 'needle streaming', { status: 'streaming' });
    await seed(room.id, alice, 'needle done');

    const res = await searchRoomAs(alice, room.id, { q: 'needle' });
    expect(res.status).toBe(200);
    expect(contents(res)).toEqual(['needle done']);
  });

  it('runs global search through the same index with filters', async () => {
    const alice = await createTestUser('alice');
    const bob = await createTestUser('bob');
    const general = await createRoom(alice.id, { name: 'general' });
    const random = await createRoom(alice.id, { name: 'random' });
    await joinRoom(bob.id, general.id);
    await joinRoom(bob.id, random.id);

    await seed(general.id, bob, 'needle target', { createdAt: '2024-06-15 12:00:00.000' });
    await seed(general.id, bob, 'needle too old', { createdAt: '2023-01-01 12:00:00.000' });
    await seed(general.id, alice, 'needle wrong sender', {
      createdAt: '2024-06-15 12:00:00.000',
    });
    await seed(random.id, bob, '聊天室消息检索', { createdAt: '2024-06-15 12:00:00.000' });

    const english = await searchGloballyAs(alice, { q: 'needle' });
    expect(english.status).toBe(200);
    expect(english.body.total).toBe(3);

    const cjk = await searchGloballyAs(alice, { q: '聊天' });
    expect(cjk.status).toBe(200);
    expect(cjk.body.total).toBe(1);
    expect(contents(cjk)).toEqual(['聊天室消息检索']);
    expect(cjk.body.messages[0].roomName).toBe('random');

    const filtered = await searchGloballyAs(alice, {
      q: 'needle',
      roomId: general.id,
      sender: 'bob',
      after: '2024-01-01T00:00:00.000Z',
      before: '2024-12-01T00:00:00.000Z',
    });
    expect(filtered.status).toBe(200);
    expect(filtered.body.total).toBe(1);
    expect(contents(filtered)).toEqual(['needle target']);
    expect(filtered.body.messages[0].roomName).toBe('general');
  });

  it('keeps the LIKE fallback literal in global search too', async () => {
    const alice = await createTestUser('alice');
    const first = await createRoom(alice.id, { name: 'first' });
    const second = await createRoom(alice.id, { name: 'second' });
    await seed(first.id, alice, '100% sure');
    await seed(second.id, alice, 'a_b match');
    await seed(second.id, alice, 'plain text');

    const percent = await searchGloballyAs(alice, { q: '%' });
    expect(percent.status).toBe(200);
    expect(contents(percent)).toEqual(['100% sure']);

    const underscore = await searchGloballyAs(alice, { q: 'a_b' });
    expect(underscore.status).toBe(200);
    expect(contents(underscore)).toEqual(['a_b match']);
  });

  it('falls back to LIKE for stopwords in global search and reports the real total', async () => {
    const alice = await createTestUser('alice');
    const first = await createRoom(alice.id, { name: 'first' });
    const second = await createRoom(alice.id, { name: 'second' });
    await seed(first.id, alice, 'in the room');
    await seed(second.id, alice, 'the quick brown fox');
    await seed(second.id, alice, 'with great power');

    const the = await searchGloballyAs(alice, { q: 'the' });
    expect(the.status).toBe(200);
    expect(the.body.total).toBe(2);
    expect(contents(the)).toEqual(['the quick brown fox', 'in the room']);

    const within = await searchGloballyAs(alice, { q: 'with' });
    expect(within.status).toBe(200);
    expect(within.body.total).toBe(1);
    expect(contents(within)).toEqual(['with great power']);

    const onlyIn = await searchGloballyAs(alice, { q: 'in' });
    expect(onlyIn.status).toBe(200);
    expect(onlyIn.body.total).toBe(1);
    expect(contents(onlyIn)).toEqual(['in the room']);

    const phrase = await searchGloballyAs(alice, { q: 'in the room' });
    expect(phrase.status).toBe(200);
    expect(phrase.body.total).toBe(1);
    expect(contents(phrase)).toEqual(['in the room']);
  });

  it('keeps zero results and a zero total when neither path matches', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });
    await seed(room.id, alice, 'plain text');

    const roomRes = await searchRoomAs(alice, room.id, { q: 'the' });
    expect(roomRes.status).toBe(200);
    expect(contents(roomRes)).toEqual([]);

    const globalRes = await searchGloballyAs(alice, { q: 'in the room' });
    expect(globalRes.status).toBe(200);
    expect(globalRes.body.total).toBe(0);
    expect(globalRes.body.messages).toEqual([]);
  });

  it('installs the ngram full-text index on messages', async () => {
    const [indexes] = await pool.query<RowDataPacket[]>(
      `SELECT INDEX_NAME, INDEX_TYPE, COLUMN_NAME
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'messages'
         AND INDEX_NAME = 'ft_messages_content'`,
    );
    expect(
      indexes.map((row) => `${row.INDEX_NAME}:${row.INDEX_TYPE}:${row.COLUMN_NAME}`),
    ).toEqual(['ft_messages_content:FULLTEXT:content']);

    // The parser choice is only visible in the DDL, and it is what makes CJK
    // searchable at all.
    const [createRows] = await pool.query<RowDataPacket[]>('SHOW CREATE TABLE messages');
    const ddl = String(createRows[0]['Create Table']);
    expect(ddl).toContain('ft_messages_content');
    expect(ddl).toContain('WITH PARSER `ngram`');

    // The optimizer really picks the index for a MATCH, so the service query
    // is not silently scanning.
    const [plan] = await pool.query<RowDataPacket[]>(
      `EXPLAIN SELECT id FROM messages
       WHERE MATCH(content) AGAINST ('"needle"' IN BOOLEAN MODE)`,
    );
    expect(plan[0].type).toBe('fulltext');
  });

  it('re-runs the full-text migration without failing', async () => {
    const candidates = [
      path.resolve(process.cwd(), '../db/migrations/0029_messages_fulltext.sql'),
      path.resolve(process.cwd(), 'db/migrations/0029_messages_fulltext.sql'),
    ];
    const file = candidates.find((candidate) => fs.existsSync(candidate));
    expect(file, `migration not found in ${candidates.join(', ')}`).toBeDefined();

    // MySQL DDL is not transactional, so a crash after the ALTER but before
    // the version row must not break the next run.
    const conn = await createConnection({
      uri: config.databaseUrl,
      multipleStatements: true,
      timezone: 'Z',
    });
    try {
      await conn.query(fs.readFileSync(file as string, 'utf8'));
      await conn.query(fs.readFileSync(file as string, 'utf8'));
    } finally {
      await conn.end();
    }

    const [indexes] = await pool.query<RowDataPacket[]>(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'messages'
         AND INDEX_NAME = 'ft_messages_content'`,
    );
    expect(indexes).toHaveLength(1);
  });
});
