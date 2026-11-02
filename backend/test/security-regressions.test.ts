import request from 'supertest';
import type { Server } from 'socket.io';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import { LOGIN_IP_RATE_MAX } from '../src/routes/auth';
import {
  assertCanSendMessage,
  createMessage,
  createPoll,
  MESSAGE_EDIT_HISTORY_LIMIT,
} from '../src/services/message';
import { joinRoom } from '../src/services/room';
import { processDueScheduled } from '../src/services/scheduled';
import type { AuthUser, MessageDTO } from '../src/types';
import {
  createTestRoom,
  createTestUser,
  delay,
  startTestServer,
  tokenFor,
  type TestServer,
} from './helpers';

/**
 * Round 62 regressions: scheduled messages and forwards must pay the shared
 * slow-mode/rate gate, a queue must not outlive the sender's right to post,
 * and a saved message must not stay readable after the member leaves.
 */
let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

const SECOND = 1000;
const MINUTE = 60 * SECOND;

beforeEach(() => {
  // Individual tests opt into the limiter; a failed assertion must not leak the
  // enabled flag into the next test.
  config.rateLimitEnabled = false;
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

function futureIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function setSlowMode(
  roomId: number,
  actor: AuthUser,
  seconds: number,
): Promise<request.Response> {
  return request(server.url)
    .patch(`/api/rooms/${roomId}`)
    .set('Authorization', auth(actor))
    .send({ slowModeSeconds: seconds });
}

async function insertScheduled(input: {
  roomId: number;
  senderId: number;
  content: string;
  sendAt: Date;
}): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO scheduled_messages (room_id, sender_id, content, send_at, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [input.roomId, input.senderId, input.content, input.sendAt],
  );
  return result.insertId;
}

async function scheduledStatus(id: number): Promise<string | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT status, sent_message_id FROM scheduled_messages WHERE id = ?',
    [id],
  );
  return rows[0] ? String(rows[0].status) : undefined;
}

async function scheduledSendAt(id: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT send_at FROM scheduled_messages WHERE id = ?',
    [id],
  );
  return new Date(rows[0].send_at).getTime();
}

async function roomMessageCount(roomId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM messages WHERE room_id = ?',
    [roomId],
  );
  return Number(rows[0].total);
}

interface EmittedEvent {
  room: string;
  event: string;
  payload: { roomId: number; message: MessageDTO };
}

/** Minimal socket.io stand-in: the worker only ever calls `to(room).emit(...)`. */
function createFakeIo(): { io: Server; events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: EmittedEvent['payload']): boolean => {
        events.push({ room, event, payload });
        return true;
      },
    }),
  } as unknown as Server;
  return { io, events };
}

describe('schedule and forward use the shared send gate', () => {
  it('rejects a scheduled message during the room slow-mode window', async () => {
    const owner = await createTestUser('sec_gate_sched_owner');
    const roomId = await createTestRoom(owner);
    expect((await setSlowMode(roomId, owner, 30)).status).toBe(200);
    await createMessage({
      roomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'posted just now',
    });

    const response = await request(server.url)
      .post(`/api/rooms/${roomId}/messages/schedule`)
      .set('Authorization', auth(owner))
      .send({ content: 'queued too soon', sendAt: futureIso(MINUTE) });

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('SLOW_MODE');
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM scheduled_messages WHERE room_id = ?',
      [roomId],
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects a forward into a room during its slow-mode window', async () => {
    const owner = await createTestUser('sec_gate_forward_owner');
    const targetRoomId = await createTestRoom(owner);
    const sourceRoomId = await createTestRoom(owner);
    const source = await createMessage({
      roomId: sourceRoomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'relay me',
    });
    expect((await setSlowMode(targetRoomId, owner, 30)).status).toBe(200);
    await createMessage({
      roomId: targetRoomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'posted just now',
    });

    const response = await request(server.url)
      .post(`/api/rooms/${targetRoomId}/forward`)
      .set('Authorization', auth(owner))
      .send({ sourceRoomId, sourceSeq: source.seq });

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('SLOW_MODE');
    expect(await roomMessageCount(targetRoomId)).toBe(1);
  });
});

describe('pending schedules do not outlive the right to post', () => {
  it('cancels a leaver’s rows in that room only and never delivers a stale one', async () => {
    const owner = await createTestUser('sec_leave_owner');
    const member = await createTestUser('sec_leave_member');
    const roomId = await createTestRoom(owner);
    const otherRoomId = await createTestRoom(owner);
    await joinRoom(member.id, roomId);
    await joinRoom(member.id, otherRoomId);

    const leaving = await insertScheduled({
      roomId,
      senderId: member.id,
      content: 'from the room I am leaving',
      sendAt: new Date(Date.now() - SECOND),
    });
    const elsewhere = await insertScheduled({
      roomId: otherRoomId,
      senderId: member.id,
      content: 'from a room I am staying in',
      sendAt: new Date(Date.now() + MINUTE),
    });

    const left = await request(server.url)
      .post(`/api/rooms/${roomId}/leave`)
      .set('Authorization', auth(member));
    expect(left.status).toBe(200);

    expect(await scheduledStatus(leaving)).toBe('cancelled');
    // Leaving one room must not touch the queue of another membership.
    expect(await scheduledStatus(elsewhere)).toBe('pending');

    // A row still pending after the membership ended must be cancelled by the
    // worker itself rather than delivered with nobody in the room.
    const stale = await insertScheduled({
      roomId,
      senderId: member.id,
      content: 'stale after leaving',
      sendAt: new Date(Date.now() - SECOND),
    });
    const { io, events } = createFakeIo();
    const result = await processDueScheduled({ io });

    expect(result).toEqual({ processed: 1, sent: 0, failed: 1, cancelled: 1 });
    expect(await scheduledStatus(stale)).toBe('cancelled');
    expect(events).toHaveLength(0);
    expect(await roomMessageCount(roomId)).toBe(0);
  });

  it('cancels a kicked member’s rows and skips a stale due row', async () => {
    const owner = await createTestUser('sec_kick_owner');
    const member = await createTestUser('sec_kick_member');
    const roomId = await createTestRoom(owner);
    await joinRoom(member.id, roomId);

    const queued = await insertScheduled({
      roomId,
      senderId: member.id,
      content: 'kicked before send',
      sendAt: new Date(Date.now() - SECOND),
    });

    const kicked = await request(server.url)
      .delete(`/api/rooms/${roomId}/members/${member.id}`)
      .set('Authorization', auth(owner));
    expect(kicked.status).toBe(200);
    expect(await scheduledStatus(queued)).toBe('cancelled');

    const stale = await insertScheduled({
      roomId,
      senderId: member.id,
      content: 'stale after being kicked',
      sendAt: new Date(Date.now() - SECOND),
    });
    const { io, events } = createFakeIo();
    const result = await processDueScheduled({ io });

    expect(result).toEqual({ processed: 1, sent: 0, failed: 1, cancelled: 1 });
    expect(await scheduledStatus(stale)).toBe('cancelled');
    expect(events).toHaveLength(0);
    expect(await roomMessageCount(roomId)).toBe(0);
  });

  it('cancels every room’s rows when an admin bans the sender', async () => {
    const admin = await createTestUser('sec_ban_admin', 'admin');
    const owner = await createTestUser('sec_ban_owner');
    const member = await createTestUser('sec_ban_member');
    const firstRoomId = await createTestRoom(owner);
    const secondRoomId = await createTestRoom(owner);
    await joinRoom(member.id, firstRoomId);
    await joinRoom(member.id, secondRoomId);

    const first = await insertScheduled({
      roomId: firstRoomId,
      senderId: member.id,
      content: 'first room',
      sendAt: new Date(Date.now() + MINUTE),
    });
    const second = await insertScheduled({
      roomId: secondRoomId,
      senderId: member.id,
      content: 'second room',
      sendAt: new Date(Date.now() + MINUTE),
    });

    const banned = await request(server.url)
      .patch(`/api/admin/users/${member.id}/status`)
      .set('Authorization', auth(admin))
      .send({ status: 'banned' });
    expect(banned.status).toBe(200);

    expect(await scheduledStatus(first)).toBe('cancelled');
    expect(await scheduledStatus(second)).toBe('cancelled');

    // Even a row that slips into the queue after the ban is never delivered.
    const stale = await insertScheduled({
      roomId: firstRoomId,
      senderId: member.id,
      content: 'stale after ban',
      sendAt: new Date(Date.now() - SECOND),
    });
    const { io, events } = createFakeIo();
    const result = await processDueScheduled({ io });

    expect(result).toEqual({ processed: 1, sent: 0, failed: 1, cancelled: 1 });
    expect(await scheduledStatus(stale)).toBe('cancelled');
    expect(events).toHaveLength(0);
    expect(await roomMessageCount(firstRoomId)).toBe(0);
  });

  it('cancels queued rows for every user in a bulk ban', async () => {
    const admin = await createTestUser('sec_bulk_ban_admin', 'admin');
    const owner = await createTestUser('sec_bulk_ban_owner');
    const first = await createTestUser('sec_bulk_ban_first');
    const second = await createTestUser('sec_bulk_ban_second');
    const roomId = await createTestRoom(owner);
    await joinRoom(first.id, roomId);
    await joinRoom(second.id, roomId);

    const firstRow = await insertScheduled({
      roomId,
      senderId: first.id,
      content: 'first queued',
      sendAt: new Date(Date.now() + MINUTE),
    });
    const secondRow = await insertScheduled({
      roomId,
      senderId: second.id,
      content: 'second queued',
      sendAt: new Date(Date.now() + MINUTE),
    });

    const response = await request(server.url)
      .patch('/api/admin/users/bulk-status')
      .set('Authorization', auth(admin))
      .send({ userIds: [first.id, second.id], status: 'banned' });
    expect(response.status).toBe(200);

    expect(await scheduledStatus(firstRow)).toBe('cancelled');
    expect(await scheduledStatus(secondRow)).toBe('cancelled');
  });
});

describe('scheduled delivery pays the send gate at due time', () => {
  it('defers the second of two due rows while slow mode is open, then sends it', async () => {
    const user = await createTestUser('sec_defer_slow');
    const roomId = await createTestRoom(user);
    // Long enough that the first delivery certainly leaves the window open.
    expect((await setSlowMode(roomId, user, 5)).status).toBe(200);

    const firstId = await insertScheduled({
      roomId,
      senderId: user.id,
      content: 'first due',
      sendAt: new Date(Date.now() - 2 * SECOND),
    });
    const secondId = await insertScheduled({
      roomId,
      senderId: user.id,
      content: 'second due',
      sendAt: new Date(Date.now() - SECOND),
    });

    const { io, events } = createFakeIo();
    const firstTick = await processDueScheduled({ io });

    // The first row posts; the second is pushed back instead of failing.
    expect(firstTick).toEqual({ processed: 2, sent: 1, failed: 0, deferred: 1 });
    expect(await scheduledStatus(firstId)).toBe('sent');
    expect(await scheduledStatus(secondId)).toBe('pending');
    expect(await roomMessageCount(roomId)).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].payload.message.content).toBe('first due');

    // The pause is a real future `send_at`, so the very next tick cannot spin.
    const deferredAt = await scheduledSendAt(secondId);
    expect(deferredAt).toBeGreaterThan(Date.now());

    // Once the pushed window passes, the still-queued row is delivered.
    await delay(Math.max(0, deferredAt - Date.now()) + 250);
    const secondTick = await processDueScheduled({ io });

    expect(secondTick).toEqual({ processed: 1, sent: 1, failed: 0 });
    expect(await scheduledStatus(secondId)).toBe('sent');
    expect(await roomMessageCount(roomId)).toBe(2);
    expect(events).toHaveLength(2);
    expect(events[1].payload.message.content).toBe('second due');
  });

  it('defers a due row rejected by the per-member message rate limit', async () => {
    const user = await createTestUser('sec_defer_rate');
    const roomId = await createTestRoom(user);
    config.rateLimitEnabled = true;
    try {
      // Ten hits fill the 10-per-10s window; the worker's check is the eleventh.
      for (let hit = 0; hit < 10; hit += 1) {
        await assertCanSendMessage(roomId, user.id);
      }
      const id = await insertScheduled({
        roomId,
        senderId: user.id,
        content: 'rate limited at due time',
        sendAt: new Date(Date.now() - SECOND),
      });

      const { io, events } = createFakeIo();
      const tick = await processDueScheduled({ io });

      expect(tick).toEqual({ processed: 1, sent: 0, failed: 0, deferred: 1 });
      expect(await scheduledStatus(id)).toBe('pending');
      expect(await scheduledSendAt(id)).toBeGreaterThan(Date.now());
      expect(await roomMessageCount(roomId)).toBe(0);
      expect(events).toHaveLength(0);
    } finally {
      config.rateLimitEnabled = false;
    }
  });
});

describe('saved messages follow current membership', () => {
  it('hides a bookmark after leaving and restores it after rejoining', async () => {
    const owner = await createTestUser('sec_saved_owner');
    const member = await createTestUser('sec_saved_member');
    const roomId = await createTestRoom(owner);
    await joinRoom(member.id, roomId);
    const message = await createMessage({
      roomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'keep this',
    });

    const saved = await request(server.url)
      .post(`/api/rooms/${roomId}/messages/${message.seq}/save`)
      .set('Authorization', auth(member));
    expect(saved.status).toBe(200);

    const visible = await request(server.url)
      .get('/api/me/saved')
      .set('Authorization', auth(member));
    expect(visible.status).toBe(200);
    expect(visible.body.total).toBe(1);
    expect(visible.body.items).toHaveLength(1);
    expect(visible.body.items[0].message.content).toBe('keep this');
    expect(visible.body.items[0].roomName).toBeTruthy();

    const left = await request(server.url)
      .post(`/api/rooms/${roomId}/leave`)
      .set('Authorization', auth(member));
    expect(left.status).toBe(200);

    const hidden = await request(server.url)
      .get('/api/me/saved')
      .set('Authorization', auth(member));
    expect(hidden.status).toBe(200);
    expect(hidden.body.total).toBe(0);
    expect(hidden.body.items).toEqual([]);

    // The bookmark row itself survives, so rejoining brings the entry back.
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT message_id FROM saved_messages WHERE user_id = ?',
      [member.id],
    );
    expect(rows).toHaveLength(1);

    await joinRoom(member.id, roomId);
    const restored = await request(server.url)
      .get('/api/me/saved')
      .set('Authorization', auth(member));
    expect(restored.status).toBe(200);
    expect(restored.body.total).toBe(1);
    expect(restored.body.items[0].message.id).toBe(message.id);
    expect(restored.body.items[0].message.content).toBe('keep this');
  });

  it('keeps the count aligned with the page for another room’s bookmark', async () => {
    const owner = await createTestUser('sec_saved_count_owner');
    const member = await createTestUser('sec_saved_count_member');
    const keptRoomId = await createTestRoom(owner);
    const leftRoomId = await createTestRoom(owner);
    await joinRoom(member.id, keptRoomId);
    await joinRoom(member.id, leftRoomId);

    const keptMessage = await createMessage({
      roomId: keptRoomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'stays visible',
    });
    const leftMessage = await createMessage({
      roomId: leftRoomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'hidden after leaving',
    });
    for (const [roomId, seq] of [
      [keptRoomId, keptMessage.seq],
      [leftRoomId, leftMessage.seq],
    ] as const) {
      const response = await request(server.url)
        .post(`/api/rooms/${roomId}/messages/${seq}/save`)
        .set('Authorization', auth(member));
      expect(response.status).toBe(200);
    }

    expect(
      (
        await request(server.url)
          .post(`/api/rooms/${leftRoomId}/leave`)
          .set('Authorization', auth(member))
      ).status,
    ).toBe(200);

    const list = await request(server.url)
      .get('/api/me/saved?limit=1')
      .set('Authorization', auth(member));
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].message.id).toBe(keptMessage.id);
  });
});

describe('edit history retention', () => {
  it('keeps only the newest 50 revisions and serves them oldest-first', async () => {
    const owner = await createTestUser('sec_edit_cap_owner');
    const roomId = await createTestRoom(owner);
    const message = await createMessage({
      roomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'v0',
    });

    for (let version = 1; version <= 55; version += 1) {
      const response = await request(server.url)
        .patch(`/api/rooms/${roomId}/messages/${message.seq}`)
        .set('Authorization', auth(owner))
        .send({ content: `v${version}` });
      expect(response.status).toBe(200);
    }

    // 55 edits archived v0..v54; only the newest 50 (v5..v54) may survive.
    const expected = Array.from(
      { length: MESSAGE_EDIT_HISTORY_LIMIT },
      (_, index) => `v${index + 5}`,
    );
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT old_content FROM message_edits WHERE message_id = ? ORDER BY edited_at, id',
      [message.id],
    );
    expect(rows).toHaveLength(MESSAGE_EDIT_HISTORY_LIMIT);
    expect(rows.map((row) => String(row.old_content))).toEqual(expected);

    const history = await request(server.url)
      .get(`/api/rooms/${roomId}/messages/${message.seq}/edits`)
      .set('Authorization', auth(owner));
    expect(history.status).toBe(200);
    expect(history.body.current).toBe('v55');
    expect(history.body.edits).toHaveLength(MESSAGE_EDIT_HISTORY_LIMIT);
    expect(history.body.edits.map((entry: { oldContent: string }) => entry.oldContent)).toEqual(
      expected,
    );
  });
});

describe('write rate limits', () => {
  it('caps message edits at 20 per user per room per minute', async () => {
    config.rateLimitEnabled = true;
    const owner = await createTestUser('sec_edit_rate_owner');
    const roomId = await createTestRoom(owner);
    const message = await createMessage({
      roomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'rate-0',
    });

    for (let version = 1; version <= 20; version += 1) {
      const response = await request(server.url)
        .patch(`/api/rooms/${roomId}/messages/${message.seq}`)
        .set('Authorization', auth(owner))
        .send({ content: `rate-${version}` });
      expect(response.status).toBe(200);
    }
    const limited = await request(server.url)
      .patch(`/api/rooms/${roomId}/messages/${message.seq}`)
      .set('Authorization', auth(owner))
      .send({ content: 'rate-overflow' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('caps reactions at 60 per user per room per minute', async () => {
    config.rateLimitEnabled = true;
    const owner = await createTestUser('sec_reaction_rate_owner');
    const roomId = await createTestRoom(owner);
    const message = await createMessage({
      roomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'react to me',
    });

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request(server.url)
        .post(`/api/rooms/${roomId}/messages/${message.seq}/reactions`)
        .set('Authorization', auth(owner))
        .send({ emoji: '🔥' });
      expect(response.status).toBe(200);
    }
    const limited = await request(server.url)
      .post(`/api/rooms/${roomId}/messages/${message.seq}/reactions`)
      .set('Authorization', auth(owner))
      .send({ emoji: '🔥' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('caps poll votes at 60 per user per room per minute', async () => {
    config.rateLimitEnabled = true;
    const owner = await createTestUser('sec_poll_rate_owner');
    const roomId = await createTestRoom(owner);
    const poll = await createPoll({
      roomId,
      senderId: owner.id,
      question: 'Vote rate?',
      options: ['Yes', 'No'],
      multiple: false,
      closesAt: null,
    });
    const optionId = poll.poll?.options[0]?.id ?? 0;
    expect(optionId).toBeGreaterThan(0);

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request(server.url)
        .post(`/api/rooms/${roomId}/messages/${poll.seq}/poll/votes`)
        .set('Authorization', auth(owner))
        .send({ optionIds: [optionId] });
      expect(response.status).toBe(200);
    }
    const limited = await request(server.url)
      .post(`/api/rooms/${roomId}/messages/${poll.seq}/poll/votes`)
      .set('Authorization', auth(owner))
      .send({ optionIds: [optionId] });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('login IP rate limit', () => {
  it('caps attempts per client IP regardless of the username tried', async () => {
    config.rateLimitEnabled = true;
    for (let attempt = 0; attempt < LOGIN_IP_RATE_MAX; attempt += 1) {
      // A fresh username every time keeps the per-username bucket empty; only
      // the IP counter sees the whole run.
      const response = await request(server.url)
        .post('/api/auth/login')
        .send({ username: `ghost_ip_${attempt}`, password: 'definitely-wrong' });
      expect(response.status).toBe(401);
    }
    const limited = await request(server.url)
      .post('/api/auth/login')
      .send({ username: 'ghost_ip_after_limit', password: 'definitely-wrong' });
    expect(limited.status).toBe(400);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  }, 60_000);
});
