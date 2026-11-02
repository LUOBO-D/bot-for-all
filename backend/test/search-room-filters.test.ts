import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool } from '../src/db';
import { createMessage, deleteMessage } from '../src/services/message';
import { createRoom, joinRoom } from '../src/services/room';
import type { AuthUser } from '../src/types';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

function searchAs(user: AuthUser, roomId: number, query: Record<string, string | number>) {
  return request(app)
    .get(`/api/rooms/${roomId}/search`)
    .query(query)
    .set('Authorization', `Bearer ${tokenFor(user)}`);
}

/** Backdates a message so day-window assertions do not depend on the clock. */
async function setCreatedAt(id: number, value: string): Promise<void> {
  await pool.execute('UPDATE messages SET created_at = ? WHERE id = ?', [value, id]);
}

async function seed(
  roomId: number,
  sender: AuthUser,
  content: string,
  options: { createdAt?: string; status?: 'done' | 'streaming' } = {},
): Promise<{ id: number; seq: number }> {
  const message = await createMessage({
    roomId,
    senderId: sender.id,
    senderType: 'user',
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

describe('room message search filters', () => {
  it('filters by senderId and ANDs it with the content query', async () => {
    const alice = await createTestUser('alice');
    const bob = await createTestUser('bob');
    const room = await createRoom(alice.id, { name: 'general' });
    await joinRoom(bob.id, room.id);

    await seed(room.id, alice, 'needle from alice');
    await seed(room.id, bob, 'needle from bob');
    await seed(room.id, bob, 'unrelated from bob');

    const bobOnly = await searchAs(alice, room.id, { q: 'needle', senderId: bob.id });
    expect(bobOnly.status).toBe(200);
    expect(contents(bobOnly)).toEqual(['needle from bob']);

    const aliceOnly = await searchAs(alice, room.id, { q: 'needle', senderId: alice.id });
    expect(aliceOnly.status).toBe(200);
    expect(contents(aliceOnly)).toEqual(['needle from alice']);

    // A member who never posted, and a user who is not in the room, both
    // simply match nothing; senderId is a value filter, not a membership gate.
    const quiet = await createTestUser('quiet');
    const outsider = await createTestUser('outsider');
    await joinRoom(quiet.id, room.id);
    const noPosts = await searchAs(alice, room.id, { q: 'needle', senderId: quiet.id });
    expect(noPosts.status).toBe(200);
    expect(noPosts.body.messages).toEqual([]);
    const nonMember = await searchAs(alice, room.id, { q: 'needle', senderId: outsider.id });
    expect(nonMember.status).toBe(200);
    expect(nonMember.body.messages).toEqual([]);
  });

  it('includes the whole UTC day at both ends', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });

    await seed(room.id, alice, 'needle before', { createdAt: '2024-06-14 23:59:59.999' });
    await seed(room.id, alice, 'needle start', { createdAt: '2024-06-15 00:00:00.000' });
    await seed(room.id, alice, 'needle end', { createdAt: '2024-06-15 23:59:59.999' });
    await seed(room.id, alice, 'needle after', { createdAt: '2024-06-16 00:00:00.000' });

    const day = await searchAs(alice, room.id, {
      q: 'needle',
      from: '2024-06-15',
      to: '2024-06-15',
    });
    expect(day.status).toBe(200);
    expect(contents(day).sort()).toEqual(['needle end', 'needle start']);

    const fromOnly = await searchAs(alice, room.id, { q: 'needle', from: '2024-06-15' });
    expect(contents(fromOnly).sort()).toEqual(['needle after', 'needle end', 'needle start']);

    const toOnly = await searchAs(alice, room.id, { q: 'needle', to: '2024-06-15' });
    expect(contents(toOnly).sort()).toEqual(['needle before', 'needle end', 'needle start']);
  });

  it('combines sender, date and content while skipping deleted and streaming rows', async () => {
    const alice = await createTestUser('alice');
    const bob = await createTestUser('bob');
    const room = await createRoom(alice.id, { name: 'general' });
    await joinRoom(bob.id, room.id);

    await seed(room.id, bob, 'needle target', { createdAt: '2024-06-15 12:00:00.000' });
    await seed(room.id, bob, 'needle too old', { createdAt: '2024-01-01 12:00:00.000' });
    await seed(room.id, alice, 'needle wrong sender', {
      createdAt: '2024-06-15 12:00:00.000',
    });
    const deleted = await seed(room.id, bob, 'needle deleted', {
      createdAt: '2024-06-15 13:00:00.000',
    });
    await deleteMessage(room.id, deleted.seq, bob.id, false);
    await seed(room.id, bob, 'needle streaming', {
      createdAt: '2024-06-15 14:00:00.000',
      status: 'streaming',
    });

    const res = await searchAs(alice, room.id, {
      q: 'needle',
      senderId: bob.id,
      from: '2024-06-01',
      to: '2024-06-30',
    });
    expect(res.status).toBe(200);
    expect(contents(res)).toEqual(['needle target']);
  });

  it('keeps LIKE metacharacters literal with filters applied', async () => {
    const alice = await createTestUser('alice');
    const bob = await createTestUser('bob');
    const room = await createRoom(alice.id, { name: 'general' });
    await joinRoom(bob.id, room.id);

    await seed(room.id, bob, 'a_b');
    await seed(room.id, bob, 'axb');
    await seed(room.id, bob, '100%');
    await seed(room.id, bob, '100 percent');
    await seed(room.id, bob, 'back\\slash');

    const underscore = await searchAs(alice, room.id, { q: 'a_b', senderId: bob.id });
    expect(underscore.status).toBe(200);
    expect(contents(underscore)).toEqual(['a_b']);

    const percent = await searchAs(alice, room.id, { q: '%', senderId: bob.id });
    expect(percent.status).toBe(200);
    expect(contents(percent)).toEqual(['100%']);

    const backslash = await searchAs(alice, room.id, { q: '\\', senderId: bob.id });
    expect(backslash.status).toBe(200);
    expect(contents(backslash)).toEqual(['back\\slash']);
  });

  it('rejects malformed and impossible filters without leaking results', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });
    await seed(room.id, alice, 'needle visible');

    const invalid: Array<Record<string, string | number>> = [
      { q: 'needle', senderId: 'abc' },
      { q: 'needle', senderId: 0 },
      { q: 'needle', senderId: -3 },
      { q: 'needle', senderId: 1.5 },
      { q: 'needle', from: 'nope' },
      { q: 'needle', from: '2024-02-30' },
      { q: 'needle', from: '2024-13-01' },
      { q: 'needle', from: '2024-1-1' },
      { q: 'needle', from: '2024-06-15T00:00:00.000Z' },
      { q: 'needle', to: 'yesterday' },
      { q: 'needle', to: '2024-06-31' },
      { q: 'needle', from: '2024-06-16', to: '2024-06-15' },
      { q: 'needle', limit: 0 },
      { q: 'needle', limit: 51 },
    ];

    for (const query of invalid) {
      const res = await searchAs(alice, room.id, query);
      expect(res.status, JSON.stringify(query)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    }

    const ok = await searchAs(alice, room.id, { q: 'needle' });
    expect(ok.status).toBe(200);
    expect(contents(ok)).toEqual(['needle visible']);
  });

  it('rejects non-members even with valid filters', async () => {
    const alice = await createTestUser('alice');
    const bob = await createTestUser('bob');
    const secret = await createRoom(bob.id, { name: 'secret-room', isPublic: false });
    await seed(secret.id, bob, 'needle secret');

    const res = await searchAs(alice, secret.id, {
      q: 'needle',
      senderId: bob.id,
      from: '2024-01-01',
      to: '2024-12-31',
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_MEMBER');
  });

  it('returns the newest matches first and honours the limit', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });

    await seed(room.id, alice, 'needle one');
    await seed(room.id, alice, 'needle two');
    await seed(room.id, alice, 'needle three');

    const first = await searchAs(alice, room.id, { q: 'needle', limit: 1 });
    expect(first.status).toBe(200);
    expect(contents(first)).toEqual(['needle three']);

    const all = await searchAs(alice, room.id, { q: 'needle', limit: 50 });
    expect(contents(all)).toEqual(['needle three', 'needle two', 'needle one']);
  });
});

describe('room message search paging', () => {
  it('reports hasMore and continues with offset in seq order', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });
    for (const suffix of ['one', 'two', 'three', 'four', 'five']) {
      await seed(room.id, alice, `needle ${suffix}`);
    }

    const first = await searchAs(alice, room.id, { q: 'needle', limit: 2 });
    expect(first.status).toBe(200);
    expect(first.body.hasMore).toBe(true);
    expect(contents(first)).toEqual(['needle five', 'needle four']);

    const second = await searchAs(alice, room.id, { q: 'needle', limit: 2, offset: 2 });
    expect(second.status).toBe(200);
    expect(second.body.hasMore).toBe(true);
    expect(contents(second)).toEqual(['needle three', 'needle two']);

    const last = await searchAs(alice, room.id, { q: 'needle', limit: 2, offset: 4 });
    expect(last.status).toBe(200);
    expect(last.body.hasMore).toBe(false);
    expect(contents(last)).toEqual(['needle one']);

    const past = await searchAs(alice, room.id, { q: 'needle', limit: 2, offset: 99 });
    expect(past.status).toBe(200);
    expect(past.body.messages).toEqual([]);
    expect(past.body.hasMore).toBe(false);

    // The largest legal page still reports the (absent) next page correctly.
    const full = await searchAs(alice, room.id, { q: 'needle', limit: 50, offset: 0 });
    expect(full.status).toBe(200);
    expect(full.body.hasMore).toBe(false);
    expect(contents(full)).toHaveLength(5);
  });

  it('reports no more pages when the page is exactly full', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });
    for (const suffix of ['one', 'two', 'three']) {
      await seed(room.id, alice, `needle ${suffix}`);
    }

    const exact = await searchAs(alice, room.id, { q: 'needle', limit: 3 });
    expect(exact.status).toBe(200);
    expect(exact.body.hasMore).toBe(false);
    expect(contents(exact)).toEqual(['needle three', 'needle two', 'needle one']);

    const short = await searchAs(alice, room.id, { q: 'needle', limit: 2 });
    expect(short.body.hasMore).toBe(true);
  });

  it('pages the filtered matches, not the raw room messages', async () => {
    const alice = await createTestUser('alice');
    const bob = await createTestUser('bob');
    const room = await createRoom(alice.id, { name: 'general' });
    await joinRoom(bob.id, room.id);

    // Insertion order (and therefore seq) interleaves non-matching, deleted
    // and other-sender rows: offset must count only the matches that survive
    // every filter.
    await seed(room.id, bob, 'needle bob one', { createdAt: '2024-06-01 12:00:00.000' });
    await seed(room.id, bob, 'unrelated bob', { createdAt: '2024-06-02 12:00:00.000' });
    await seed(room.id, bob, 'needle bob two', { createdAt: '2024-06-03 12:00:00.000' });
    const deleted = await seed(room.id, bob, 'needle bob deleted', {
      createdAt: '2024-06-04 12:00:00.000',
    });
    await deleteMessage(room.id, deleted.seq, bob.id, false);
    await seed(room.id, bob, 'needle bob three', { createdAt: '2024-06-05 12:00:00.000' });
    await seed(room.id, alice, 'needle alice other', { createdAt: '2024-06-06 12:00:00.000' });

    const filters = { q: 'needle', senderId: bob.id, from: '2024-06-01', to: '2024-06-30' };
    const first = await searchAs(alice, room.id, { ...filters, limit: 1 });
    expect(first.status).toBe(200);
    expect(first.body.hasMore).toBe(true);
    expect(contents(first)).toEqual(['needle bob three']);

    const second = await searchAs(alice, room.id, { ...filters, limit: 1, offset: 1 });
    expect(second.body.hasMore).toBe(true);
    expect(contents(second)).toEqual(['needle bob two']);

    const third = await searchAs(alice, room.id, { ...filters, limit: 1, offset: 2 });
    expect(third.body.hasMore).toBe(false);
    expect(contents(third)).toEqual(['needle bob one']);

    const past = await searchAs(alice, room.id, { ...filters, limit: 1, offset: 3 });
    expect(past.body.messages).toEqual([]);
    expect(past.body.hasMore).toBe(false);
  });

  it('walks every match once with offset until hasMore is false', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });

    const expected: string[] = [];
    for (let index = 1; index <= 7; index += 1) {
      expected.unshift(`needle ${index}`);
      await seed(room.id, alice, `needle ${index}`);
      await seed(room.id, alice, `noise ${index}`);
    }

    const collected: string[] = [];
    const seqs: number[] = [];
    let offset = 0;
    for (;;) {
      const res = await searchAs(alice, room.id, { q: 'needle', limit: 3, offset });
      expect(res.status).toBe(200);
      expect(res.body.hasMore).toBe(res.body.messages.length === 3);
      const page = res.body.messages as Array<{ content: string; seq: number }>;
      collected.push(...page.map((message) => message.content));
      seqs.push(...page.map((message) => message.seq));
      offset += page.length;
      if (!res.body.hasMore) {
        break;
      }
      expect(page).toHaveLength(3);
    }

    expect(collected).toEqual(expected);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
  });

  it('rejects a negative or non-integer offset', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });
    await seed(room.id, alice, 'needle visible');

    const invalid: Array<Record<string, string | number>> = [
      { q: 'needle', offset: -1 },
      { q: 'needle', offset: -20 },
      { q: 'needle', offset: 'abc' },
      { q: 'needle', offset: 1.5 },
      { q: 'needle', offset: '1.5' },
      // Larger than Number.MAX_SAFE_INTEGER cannot be a real result count.
      { q: 'needle', offset: '1e21' },
      { q: 'needle', offset: String(Number.MAX_SAFE_INTEGER + 1) },
    ];

    for (const query of invalid) {
      const res = await searchAs(alice, room.id, query);
      expect(res.status, JSON.stringify(query)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    }

    const zero = await searchAs(alice, room.id, { q: 'needle', offset: 0 });
    expect(zero.status).toBe(200);
    expect(contents(zero)).toEqual(['needle visible']);
    expect(zero.body.hasMore).toBe(false);
  });
});
