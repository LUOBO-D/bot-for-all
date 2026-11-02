import request from 'supertest';
import type { Server } from 'socket.io';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import { createMessage } from '../src/services/message';
import { joinRoom as joinRoomService } from '../src/services/room';
import {
  parseSendAt,
  processDueScheduled,
  recoverStuckScheduled,
  SCHEDULED_MAX_PENDING,
} from '../src/services/scheduled';
import type { AuthUser, MessageDTO } from '../src/types';
import { createTestRoom, createTestUser, delay, startTestServer, tokenFor, type TestServer } from './helpers';

/**
 * Only the worker's failure path needs a broken `createMessage`; everything else
 * runs the real implementation, so the mock stays transparent by default.
 */
const messageMock = vi.hoisted(() => ({ failNextCreate: false }));

vi.mock('../src/services/message', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/message')>();
  return {
    ...actual,
    createMessage: async (input: Parameters<typeof actual.createMessage>[0]) => {
      if (messageMock.failNextCreate) {
        messageMock.failNextCreate = false;
        throw new Error('simulated delivery failure');
      }
      return actual.createMessage(input);
    },
  };
});

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

beforeEach(async () => {
  // `test/setup.ts` truncates the tables that existed before this feature.
  await pool.query('DELETE FROM scheduled_messages');
  messageMock.failNextCreate = false;
});

afterAll(async () => {
  await server.close();
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

function futureIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

async function postSchedule(
  roomId: number,
  actor: AuthUser,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(server.url)
    .post(`/api/rooms/${roomId}/messages/schedule`)
    .set('Authorization', auth(actor))
    .send(body);
}

async function listScheduledFor(roomId: number, actor: AuthUser): Promise<request.Response> {
  return request(server.url)
    .get(`/api/rooms/${roomId}/messages/scheduled`)
    .set('Authorization', auth(actor));
}

async function deleteScheduled(
  roomId: number,
  actor: AuthUser,
  id: number,
): Promise<request.Response> {
  return request(server.url)
    .delete(`/api/rooms/${roomId}/messages/scheduled/${id}`)
    .set('Authorization', auth(actor));
}

async function patchScheduled(
  roomId: number,
  actor: AuthUser,
  id: number,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(server.url)
    .patch(`/api/rooms/${roomId}/messages/scheduled/${id}`)
    .set('Authorization', auth(actor))
    .send(body);
}

async function insertScheduled(input: {
  roomId: number;
  senderId: number;
  content: string;
  sendAt: Date;
  status?: string;
}): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO scheduled_messages (room_id, sender_id, content, send_at, status)
     VALUES (?, ?, ?, ?, ?)`,
    [input.roomId, input.senderId, input.content, input.sendAt, input.status ?? 'pending'],
  );
  return result.insertId;
}

async function readScheduled(id: number): Promise<RowDataPacket | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT status, sent_message_id FROM scheduled_messages WHERE id = ?',
    [id],
  );
  return rows[0];
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

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await delay(25);
  }
}

describe('scheduled message API', () => {
  it('creates a schedule and lists only the caller’s own pending rows', async () => {
    const owner = await createTestUser('sched_owner');
    const member = await createTestUser('sched_member');
    const outsider = await createTestUser('sched_outsider');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const sendAt = futureIso(MINUTE);
    const created = await postSchedule(roomId, owner, { content: 'see you later', sendAt });
    expect(created.status).toBe(201);
    expect(created.body.scheduled).toMatchObject({ content: 'see you later', sendAt });
    expect(typeof created.body.scheduled.id).toBe('number');
    expect(new Date(created.body.scheduled.createdAt).toString()).not.toBe('Invalid Date');

    const mine = await listScheduledFor(roomId, owner);
    expect(mine.status).toBe(200);
    expect(mine.body.messages).toHaveLength(1);
    expect(mine.body.messages[0].id).toBe(created.body.scheduled.id);

    const theirs = await listScheduledFor(roomId, member);
    expect(theirs.status).toBe(200);
    expect(theirs.body.messages).toEqual([]);

    const denied = await listScheduledFor(roomId, outsider);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('NOT_MEMBER');
  });

  it('lists pending rows earliest first', async () => {
    const user = await createTestUser('sched_order');
    const roomId = await createTestRoom(user);

    await postSchedule(roomId, user, { content: 'third', sendAt: futureIso(30 * MINUTE) });
    await postSchedule(roomId, user, { content: 'first', sendAt: futureIso(2 * MINUTE) });
    await postSchedule(roomId, user, { content: 'second', sendAt: futureIso(10 * MINUTE) });

    const listed = await listScheduledFor(roomId, user);
    expect(listed.body.messages.map((row: { content: string }) => row.content)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('rejects non-members, bad content and out-of-window sendAt values', async () => {
    const owner = await createTestUser('sched_guard');
    const outsider = await createTestUser('sched_guard_out');
    const roomId = await createTestRoom(owner);

    const outsiderAttempt = await postSchedule(roomId, outsider, {
      content: 'hi',
      sendAt: futureIso(MINUTE),
    });
    expect(outsiderAttempt.status).toBe(403);
    expect(outsiderAttempt.body.error.code).toBe('NOT_MEMBER');

    const empty = await postSchedule(roomId, owner, { content: '   ', sendAt: futureIso(MINUTE) });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('INVALID_INPUT');

    const tooLong = await postSchedule(roomId, owner, {
      content: 'x'.repeat(4001),
      sendAt: futureIso(MINUTE),
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('INVALID_INPUT');

    const notIso = await postSchedule(roomId, owner, { content: 'hi', sendAt: 'tomorrow' });
    expect(notIso.status).toBe(400);
    expect(notIso.body.error.code).toBe('INVALID_INPUT');

    const past = await postSchedule(roomId, owner, {
      content: 'hi',
      sendAt: new Date(Date.now() - MINUTE).toISOString(),
    });
    expect(past.status).toBe(400);
    expect(past.body.error.code).toBe('INVALID_SEND_AT');

    const tooSoon = await postSchedule(roomId, owner, {
      content: 'hi',
      sendAt: futureIso(200),
    });
    expect(tooSoon.status).toBe(400);
    expect(tooSoon.body.error.code).toBe('INVALID_SEND_AT');

    const tooFar = await postSchedule(roomId, owner, {
      content: 'hi',
      sendAt: futureIso(30 * DAY + MINUTE),
    });
    expect(tooFar.status).toBe(400);
    expect(tooFar.body.error.code).toBe('INVALID_SEND_AT');

    const listed = await listScheduledFor(roomId, owner);
    expect(listed.body.messages).toEqual([]);
  });

  it('cancels a pending schedule, but only the owner’s own pending rows', async () => {
    const owner = await createTestUser('sched_cancel');
    const member = await createTestUser('sched_cancel_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const created = await postSchedule(roomId, owner, {
      content: 'cancel me',
      sendAt: futureIso(MINUTE),
    });
    const id = created.body.scheduled.id as number;

    const foreign = await deleteScheduled(roomId, member, id);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('SCHEDULED_NOT_FOUND');

    const missing = await deleteScheduled(roomId, owner, id + 999);
    expect(missing.status).toBe(404);

    const cancelled = await deleteScheduled(roomId, owner, id);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.ok).toBe(true);
    expect((await readScheduled(id))?.status).toBe('cancelled');

    const again = await deleteScheduled(roomId, owner, id);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('NOT_PENDING');

    const listed = await listScheduledFor(roomId, owner);
    expect(listed.body.messages).toEqual([]);
  });

  it('edits content, time or both on the owner’s pending row', async () => {
    const owner = await createTestUser('sched_edit');
    const roomId = await createTestRoom(owner);

    const originalSendAt = futureIso(10 * MINUTE);
    const created = await postSchedule(roomId, owner, {
      content: 'draft one',
      sendAt: originalSendAt,
    });
    const id = created.body.scheduled.id as number;
    const createdAt = created.body.scheduled.createdAt as string;

    // Content only: the time is untouched and surrounding whitespace is trimmed.
    const contentOnly = await patchScheduled(roomId, owner, id, { content: '  edited text  ' });
    expect(contentOnly.status).toBe(200);
    expect(contentOnly.body.scheduled).toMatchObject({
      id,
      content: 'edited text',
      sendAt: originalSendAt,
      createdAt,
    });

    // Time only: the text survives.
    const movedSendAt = futureIso(20 * MINUTE);
    const timeOnly = await patchScheduled(roomId, owner, id, { sendAt: movedSendAt });
    expect(timeOnly.status).toBe(200);
    expect(timeOnly.body.scheduled).toMatchObject({
      id,
      content: 'edited text',
      sendAt: movedSendAt,
      createdAt,
    });

    // Both at once.
    const bothSendAt = futureIso(3 * MINUTE);
    const both = await patchScheduled(roomId, owner, id, {
      content: 'final text',
      sendAt: bothSendAt,
    });
    expect(both.status).toBe(200);
    expect(both.body.scheduled).toMatchObject({
      id,
      content: 'final text',
      sendAt: bothSendAt,
      createdAt,
    });

    // The edited row is still the same pending entry and re-sorts by its new time.
    const listed = await listScheduledFor(roomId, owner);
    expect(listed.body.messages).toHaveLength(1);
    expect(listed.body.messages[0]).toMatchObject({ id, content: 'final text', sendAt: bothSendAt });
  });

  it('rejects edits by other members, unknown ids, non-pending rows and bad values', async () => {
    const owner = await createTestUser('sched_edit_guard');
    const member = await createTestUser('sched_edit_member');
    const outsider = await createTestUser('sched_edit_outsider');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const originalSendAt = futureIso(10 * MINUTE);
    const created = await postSchedule(roomId, owner, {
      content: 'keep me',
      sendAt: originalSendAt,
    });
    const id = created.body.scheduled.id as number;

    // Someone else's row does not exist as far as the caller can tell.
    const foreign = await patchScheduled(roomId, member, id, { content: 'stolen' });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('SCHEDULED_NOT_FOUND');

    const nonMember = await patchScheduled(roomId, outsider, id, { content: 'hi' });
    expect(nonMember.status).toBe(403);
    expect(nonMember.body.error.code).toBe('NOT_MEMBER');

    const missing = await patchScheduled(roomId, owner, id + 999, { content: 'hi' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('SCHEDULED_NOT_FOUND');

    const badId = await request(server.url)
      .patch(`/api/rooms/${roomId}/messages/scheduled/not-a-number`)
      .set('Authorization', auth(owner))
      .send({ content: 'hi' });
    expect(badId.status).toBe(400);
    expect(badId.body.error.code).toBe('INVALID_SCHEDULED_ID');

    const emptyBody = await patchScheduled(roomId, owner, id, {});
    expect(emptyBody.status).toBe(400);
    expect(emptyBody.body.error.code).toBe('INVALID_INPUT');

    const blank = await patchScheduled(roomId, owner, id, { content: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error.code).toBe('INVALID_INPUT');

    const tooLong = await patchScheduled(roomId, owner, id, { content: 'x'.repeat(4001) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('INVALID_INPUT');

    const notIso = await patchScheduled(roomId, owner, id, { sendAt: 'tomorrow' });
    expect(notIso.status).toBe(400);
    expect(notIso.body.error.code).toBe('INVALID_INPUT');

    for (const badSendAt of [
      new Date(Date.now() - MINUTE).toISOString(),
      futureIso(200),
      futureIso(30 * DAY + MINUTE),
    ]) {
      const response = await patchScheduled(roomId, owner, id, { sendAt: badSendAt });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_SEND_AT');
    }

    // A row that already left `pending` cannot be edited: it is a 400, not a 404.
    const cancelled = await deleteScheduled(roomId, owner, id);
    expect(cancelled.status).toBe(200);
    const notPending = await patchScheduled(roomId, owner, id, { content: 'too late' });
    expect(notPending.status).toBe(400);
    expect(notPending.body.error.code).toBe('NOT_PENDING');

    // None of the rejected attempts changed anything.
    const listed = await listScheduledFor(roomId, owner);
    expect(listed.body.messages).toEqual([]);
  });

  it('caps pending rows per user and room', async () => {
    const owner = await createTestUser('sched_cap');
    const member = await createTestUser('sched_cap_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const ids: number[] = [];
    for (let index = 0; index < SCHEDULED_MAX_PENDING; index += 1) {
      const response = await postSchedule(roomId, owner, {
        content: `queued ${index}`,
        sendAt: futureIso(MINUTE + index * SECOND),
      });
      expect(response.status).toBe(201);
      ids.push(response.body.scheduled.id as number);
    }

    const overflow = await postSchedule(roomId, owner, {
      content: 'one too many',
      sendAt: futureIso(MINUTE),
    });
    expect(overflow.status).toBe(400);
    expect(overflow.body.error.code).toBe('TOO_MANY_SCHEDULED');

    // The cap is per user: a second member still has room in the same room.
    const otherMember = await postSchedule(roomId, member, {
      content: 'my own queue',
      sendAt: futureIso(MINUTE),
    });
    expect(otherMember.status).toBe(201);

    // Cancelling frees a slot.
    expect((await deleteScheduled(roomId, owner, ids[0])).status).toBe(200);
    const afterCancel = await postSchedule(roomId, owner, {
      content: 'room again',
      sendAt: futureIso(MINUTE),
    });
    expect(afterCancel.status).toBe(201);
  });
});

describe('scheduled message worker', () => {
  it('delivers a due row exactly once, broadcasts it and links the message', async () => {
    const user = await createTestUser('sched_worker');
    const roomId = await createTestRoom(user);
    const id = await insertScheduled({
      roomId,
      senderId: user.id,
      content: 'delayed hello',
      sendAt: new Date(Date.now() - SECOND),
    });

    const { io, events } = createFakeIo();
    const triggered: MessageDTO[] = [];
    const result = await processDueScheduled({
      io,
      onUserMessage: (_roomId, message) => {
        triggered.push(message);
      },
    });

    expect(result).toEqual({ processed: 1, sent: 1, failed: 0 });

    const [messageRows] = await pool.query<RowDataPacket[]>(
      'SELECT id, sender_type, sender_id, content FROM messages WHERE room_id = ?',
      [roomId],
    );
    expect(messageRows).toHaveLength(1);
    expect(messageRows[0].sender_type).toBe('user');
    expect(Number(messageRows[0].sender_id)).toBe(user.id);
    expect(String(messageRows[0].content)).toBe('delayed hello');

    const row = await readScheduled(id);
    expect(row?.status).toBe('sent');
    expect(Number(row?.sent_message_id)).toBe(Number(messageRows[0].id));

    expect(events).toHaveLength(1);
    expect(events[0].room).toBe(`room:${roomId}`);
    expect(events[0].event).toBe('message:new');
    expect(events[0].payload.roomId).toBe(roomId);
    expect(events[0].payload.message.id).toBe(Number(messageRows[0].id));
    expect(events[0].payload.message.senderType).toBe('user');
    expect(triggered).toHaveLength(1);
    expect(triggered[0].id).toBe(Number(messageRows[0].id));

    // A second pass sees nothing pending and must not post or broadcast again.
    const second = await processDueScheduled({ io });
    expect(second).toEqual({ processed: 0, sent: 0, failed: 0 });
    expect(events).toHaveLength(1);
    const [afterRows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM messages WHERE room_id = ?',
      [roomId],
    );
    expect(afterRows).toHaveLength(1);
  });

  it('notifies members mentioned by a delivered message', async () => {
    const sender = await createTestUser('sched_mention_from');
    const target = await createTestUser('sched_mention_to');
    const roomId = await createTestRoom(sender);
    await joinRoomService(target.id, roomId);

    await insertScheduled({
      roomId,
      senderId: sender.id,
      content: 'hey @sched_mention_to look',
      sendAt: new Date(Date.now() - SECOND),
    });

    const { io } = createFakeIo();
    await processDueScheduled({ io });

    const notification = await waitFor(async () => {
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT id FROM notifications WHERE type = 'mention' AND user_id = ?",
        [target.id],
      );
      return rows[0];
    });
    expect(Number(notification.id)).toBeGreaterThan(0);
  });

  it('marks a row failed when delivery throws and keeps it out of the queue', async () => {
    const user = await createTestUser('sched_failure');
    const roomId = await createTestRoom(user);
    const id = await insertScheduled({
      roomId,
      senderId: user.id,
      content: 'doomed',
      sendAt: new Date(Date.now() - SECOND),
    });

    const { io, events } = createFakeIo();
    messageMock.failNextCreate = true;
    const result = await processDueScheduled({ io });

    expect(result).toEqual({ processed: 1, sent: 0, failed: 1 });
    expect((await readScheduled(id))?.status).toBe('failed');
    expect(events).toHaveLength(0);

    const [messageRows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM messages WHERE room_id = ?',
      [roomId],
    );
    expect(messageRows).toHaveLength(0);

    // Failed rows are terminal: a later tick does not retry them.
    const second = await processDueScheduled({ io });
    expect(second).toEqual({ processed: 0, sent: 0, failed: 0 });
  });

  it('leaves future rows pending', async () => {
    const user = await createTestUser('sched_future');
    const roomId = await createTestRoom(user);
    const id = await insertScheduled({
      roomId,
      senderId: user.id,
      content: 'later',
      sendAt: new Date(Date.now() + MINUTE),
    });

    const { io, events } = createFakeIo();
    const result = await processDueScheduled({ io });

    expect(result).toEqual({ processed: 0, sent: 0, failed: 0 });
    expect((await readScheduled(id))?.status).toBe('pending');
    expect(events).toHaveLength(0);
  });

  it('recovers rows stuck in sending and delivers them', async () => {
    const user = await createTestUser('sched_recovery');
    const roomId = await createTestRoom(user);
    const id = await insertScheduled({
      roomId,
      senderId: user.id,
      content: 'survived the crash',
      sendAt: new Date(Date.now() - SECOND),
      status: 'sending',
    });

    const recovered = await recoverStuckScheduled();
    expect(recovered).toBe(1);
    expect((await readScheduled(id))?.status).toBe('pending');

    const { io, events } = createFakeIo();
    const result = await processDueScheduled({ io });
    expect(result).toEqual({ processed: 1, sent: 1, failed: 0 });
    expect((await readScheduled(id))?.status).toBe('sent');
    expect(events).toHaveLength(1);
    expect(events[0].payload.message.content).toBe('survived the crash');
  });

  it('does not post a second copy when a recovered row was already delivered', async () => {
    const user = await createTestUser('sched_retry');
    const roomId = await createTestRoom(user);
    const id = await insertScheduled({
      roomId,
      senderId: user.id,
      content: 'only once',
      sendAt: new Date(Date.now() - SECOND),
      status: 'sending',
    });

    // Simulate a crash after the message insert but before the status update:
    // the message exists with the idempotency key the worker uses.
    const created = await createMessage({
      roomId,
      senderId: user.id,
      senderType: 'user',
      content: 'only once',
      clientMsgId: `sched:${id}`,
    });

    await recoverStuckScheduled();
    const { io, events } = createFakeIo();
    const result = await processDueScheduled({ io });

    expect(result).toEqual({ processed: 1, sent: 1, failed: 0 });
    expect((await readScheduled(id))?.status).toBe('sent');
    expect(Number((await readScheduled(id))?.sent_message_id)).toBe(created.id);

    const [messageRows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM messages WHERE room_id = ?',
      [roomId],
    );
    expect(messageRows).toHaveLength(1);
    // Already delivered before the crash, so nothing is broadcast again.
    expect(events).toHaveLength(0);
  });
});

describe('parseSendAt', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');

  it('accepts the inclusive 1s..30d window', () => {
    expect(parseSendAt(new Date(now + SECOND).toISOString(), now).getTime()).toBe(now + SECOND);
    expect(parseSendAt(new Date(now + 30 * DAY).toISOString(), now).getTime()).toBe(now + 30 * DAY);
  });

  it('rejects values outside the window or not ISO at all', () => {
    expect(() => parseSendAt(new Date(now + SECOND - 1).toISOString(), now)).toThrow(/1 second/);
    expect(() => parseSendAt(new Date(now + 30 * DAY + 1).toISOString(), now)).toThrow(/30 days/);
    expect(() => parseSendAt('not-a-date', now)).toThrow(/ISO 8601/);
  });
});
