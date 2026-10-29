import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool, type RowDataPacket } from '../src/db';
import { createMessage, listMessages, searchMessages } from '../src/services/message';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

describe('messages', () => {
  it('allocates contiguous seq values under concurrency', async () => {
    const user = await createTestUser('alice');
    const roomId = await createTestRoom(user);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        createMessage({
          roomId,
          senderId: user.id,
          senderType: 'user',
          content: `message ${index}`,
          clientMsgId: `client-${index}`,
        }),
      ),
    );

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT seq FROM messages WHERE room_id = ? ORDER BY seq',
      [roomId],
    );
    expect(rows.map((row) => Number(row.seq))).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });

  it('deduplicates by clientMsgId without consuming a seq', async () => {
    const user = await createTestUser('bob');
    const roomId = await createTestRoom(user);

    const first = await createMessage({
      roomId,
      senderId: user.id,
      senderType: 'user',
      content: 'once',
      clientMsgId: 'dup-1',
    });
    const second = await createMessage({
      roomId,
      senderId: user.id,
      senderType: 'user',
      content: 'once',
      clientMsgId: 'dup-1',
    });

    expect(second.id).toBe(first.id);
    expect(second.seq).toBe(first.seq);

    const [rooms] = await pool.query<RowDataPacket[]>(
      'SELECT max_seq FROM rooms WHERE id = ?',
      [roomId],
    );
    expect(Number(rooms[0].max_seq)).toBe(1);
  });

  it('persists the reply target', async () => {
    const user = await createTestUser('reply_user');
    const roomId = await createTestRoom(user);
    const first = await createMessage({
      roomId,
      senderId: user.id,
      senderType: 'user',
      content: 'original',
      clientMsgId: 'reply-1',
    });
    const reply = await createMessage({
      roomId,
      senderId: user.id,
      senderType: 'user',
      content: 'answer',
      clientMsgId: 'reply-2',
      replyToId: first.id,
    });

    expect(reply.replyToId).toBe(first.id);
  });

  it('returns only messages after afterSeq', async () => {
    const user = await createTestUser('carol');
    const roomId = await createTestRoom(user);
    for (let index = 1; index <= 5; index += 1) {
      await createMessage({
        roomId,
        senderId: user.id,
        senderType: 'user',
        content: `m${index}`,
        clientMsgId: `c${index}`,
      });
    }

    const result = await listMessages(roomId, { afterSeq: 2, limit: 10 });
    expect(result.messages.map((message) => message.seq)).toEqual([3, 4, 5]);
    expect(result.hasMore).toBe(false);
  });

  it('searches message content within a room', async () => {
    const user = await createTestUser('search_user');
    const roomId = await createTestRoom(user);
    for (const [index, content] of ['alpha', 'searchable needle', 'omega'].entries()) {
      await createMessage({
        roomId,
        senderId: user.id,
        senderType: 'user',
        content,
        clientMsgId: `search-${index}`,
      });
    }

    const results = await searchMessages(roomId, 'needle');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('searchable needle');
  });

  it('paginates backwards with beforeSeq', async () => {
    const user = await createTestUser('dave');
    const roomId = await createTestRoom(user);
    for (let index = 1; index <= 5; index += 1) {
      await createMessage({
        roomId,
        senderId: user.id,
        senderType: 'user',
        content: `m${index}`,
        clientMsgId: `c${index}`,
      });
    }

    const result = await listMessages(roomId, { beforeSeq: 4, limit: 2 });
    expect(result.messages.map((message) => message.seq)).toEqual([2, 3]);
    expect(result.hasMore).toBe(true);
  });

  it('rejects non-members over HTTP', async () => {
    const owner = await createTestUser('owner');
    const outsider = await createTestUser('outsider');
    const roomId = await createTestRoom(owner);

    const response = await request(app)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${tokenFor(outsider)}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
  });
});
