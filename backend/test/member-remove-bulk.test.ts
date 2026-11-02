import request from 'supertest';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/bot/crypto';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import { getBotById } from '../src/services/bot';
import { joinRoom as joinRoomService, setMemberRole } from '../src/services/room';
import type { AuthUser } from '../src/types';
import {
  connectClient,
  createTestRoom,
  createTestUser,
  delay,
  joinRoom as joinRoomSocket,
  startTestServer,
  tokenFor,
  waitForEvent,
  type TestServer,
} from './helpers';

let server: TestServer;
const clients: Socket[] = [];

beforeAll(async () => {
  server = await startTestServer();
});

afterEach(() => {
  while (clients.length > 0) {
    clients.pop()?.close();
  }
});

afterAll(async () => {
  await server.close();
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

function removeAs(actor: AuthUser, roomId: number, body: unknown) {
  return request(server.url)
    .delete(`/api/rooms/${roomId}/members`)
    .set('Authorization', auth(actor))
    .send(body as object);
}

async function hasMembership(roomId: number, userId: number): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  return Boolean(rows[0]);
}

async function insertRoomBot(roomId: number, owner: AuthUser, username: string): Promise<number> {
  const botUser = await createTestUser(username, 'user', 'bot');
  await pool.execute<ResultSetHeader>(
    `INSERT INTO bots
       (user_id, base_url, api_key_encrypted, model, system_prompt, trigger_mode,
        owner_user_id, scope, room_id, temperature, max_tokens, enabled)
     VALUES (?, 'http://127.0.0.1:4010', ?, 'fake-ok', 'bot prompt', 'mention',
             ?, 'room', ?, 0.70, 1024, 1)`,
    [botUser.id, encryptSecret('test-key'), owner.id, roomId],
  );
  await pool.execute<ResultSetHeader>(
    'INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)',
    [roomId, botUser.id, 'bot'],
  );
  return botUser.id;
}

async function insertScheduled(roomId: number, senderId: number, content: string): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO scheduled_messages (room_id, sender_id, content, send_at, status)
     VALUES (?, ?, ?, DATE_ADD(NOW(3), INTERVAL 1 HOUR), 'pending')`,
    [roomId, senderId, content],
  );
  return result.insertId;
}

async function scheduledStatus(id: number): Promise<string | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT status FROM scheduled_messages WHERE id = ?',
    [id],
  );
  return rows[0] ? String(rows[0].status) : undefined;
}

async function openClient(token: string): Promise<Socket> {
  const client = await connectClient(server.url, token);
  clients.push(client);
  return client;
}

describe('DELETE /api/rooms/:id/members', () => {
  it('removes every requested member, evicts their sockets and broadcasts once', async () => {
    const owner = await createTestUser('bulkremove_owner');
    const first = await createTestUser('bulkremove_first');
    const second = await createTestUser('bulkremove_second');
    const roomId = await createTestRoom(owner);
    await joinRoomService(first.id, roomId);
    await joinRoomService(second.id, roomId);

    const ownerClient = await openClient(tokenFor(owner));
    const firstClient = await openClient(tokenFor(first));
    const secondClient = await openClient(tokenFor(second));
    await joinRoomSocket(ownerClient, roomId);
    await joinRoomSocket(firstClient, roomId);
    await joinRoomSocket(secondClient, roomId);

    const changes: number[] = [];
    ownerClient.on('members:changed', (payload: { roomId: number }) => {
      if (payload.roomId === roomId) {
        changes.push(payload.roomId);
      }
    });
    const firstRevoked = waitForEvent<{ roomId: number }>(
      firstClient,
      'room:revoked',
      (payload) => payload.roomId === roomId,
    );
    const secondRevoked = waitForEvent<{ roomId: number }>(
      secondClient,
      'room:revoked',
      (payload) => payload.roomId === roomId,
    );

    const response = await removeAs(owner, roomId, { userIds: [first.id, second.id] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ removed: 2 });
    expect(await hasMembership(roomId, first.id)).toBe(false);
    expect(await hasMembership(roomId, second.id)).toBe(false);
    expect(await hasMembership(roomId, owner.id)).toBe(true);
    await expect(firstRevoked).resolves.toEqual({ roomId });
    await expect(secondRevoked).resolves.toEqual({ roomId });

    // One broadcast for the whole batch, never one per removed member.
    await delay(250);
    expect(changes).toEqual([roomId]);

    const after = await request(server.url)
      .get(`/api/rooms/${roomId}/members`)
      .set('Authorization', auth(first));
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('NOT_MEMBER');
  });

  it('deduplicates ids and counts each member once', async () => {
    const owner = await createTestUser('bulkremove_dup_owner');
    const first = await createTestUser('bulkremove_dup_first');
    const second = await createTestUser('bulkremove_dup_second');
    const roomId = await createTestRoom(owner);
    await joinRoomService(first.id, roomId);
    await joinRoomService(second.id, roomId);

    const response = await removeAs(owner, roomId, {
      userIds: [first.id, first.id, second.id],
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ removed: 2 });
    expect(await hasMembership(roomId, first.id)).toBe(false);
    expect(await hasMembership(roomId, second.id)).toBe(false);
  });

  it('rolls the whole batch back when one target is not a member', async () => {
    const owner = await createTestUser('bulkremove_missing_owner');
    const member = await createTestUser('bulkremove_missing_member');
    const outsider = await createTestUser('bulkremove_missing_outsider');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const response = await removeAs(owner, roomId, { userIds: [member.id, outsider.id] });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('MEMBER_NOT_FOUND');
    expect(await hasMembership(roomId, member.id)).toBe(true);
  });

  it('rejects removing yourself and leaves the rest of the batch untouched', async () => {
    const owner = await createTestUser('bulkremove_self_owner');
    const member = await createTestUser('bulkremove_self_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const response = await removeAs(owner, roomId, { userIds: [member.id, owner.id] });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_ALLOWED');
    expect(await hasMembership(roomId, owner.id)).toBe(true);
    expect(await hasMembership(roomId, member.id)).toBe(true);

    const globalAdmin = await createTestUser('bulkremove_self_admin', 'admin');
    await joinRoomService(globalAdmin.id, roomId);
    const byAdmin = await removeAs(globalAdmin, roomId, { userIds: [globalAdmin.id] });
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.error.code).toBe('NOT_ALLOWED');
    expect(await hasMembership(roomId, globalAdmin.id)).toBe(true);
  });

  it('never removes the owner, even when a global admin asks', async () => {
    const owner = await createTestUser('bulkremove_owner_target_owner');
    const member = await createTestUser('bulkremove_owner_target_member');
    const globalAdmin = await createTestUser('bulkremove_owner_target_admin', 'admin');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    await joinRoomService(globalAdmin.id, roomId);

    const response = await removeAs(globalAdmin, roomId, { userIds: [member.id, owner.id] });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_ALLOWED');
    expect(await hasMembership(roomId, owner.id)).toBe(true);
    expect(await hasMembership(roomId, member.id)).toBe(true);
  });

  it('keeps the bulk route for the owner and global admin only', async () => {
    const owner = await createTestUser('bulkremove_deny_owner');
    const roomAdmin = await createTestUser('bulkremove_deny_admin');
    const plain = await createTestUser('bulkremove_deny_plain');
    const outsider = await createTestUser('bulkremove_deny_outsider');
    const roomId = await createTestRoom(owner);
    await joinRoomService(roomAdmin.id, roomId);
    await joinRoomService(plain.id, roomId);
    await setMemberRole(roomId, owner.id, 'user', roomAdmin.id, 'admin');

    const byRoomAdmin = await removeAs(roomAdmin, roomId, { userIds: [plain.id] });
    expect(byRoomAdmin.status).toBe(403);
    expect(byRoomAdmin.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const byPlain = await removeAs(plain, roomId, { userIds: [plain.id] });
    expect(byPlain.status).toBe(403);
    expect(byPlain.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const byOutsider = await removeAs(outsider, roomId, { userIds: [plain.id] });
    expect(byOutsider.status).toBe(403);
    expect(byOutsider.body.error.code).toBe('NOT_MEMBER');

    expect(await hasMembership(roomId, plain.id)).toBe(true);

    // The single-target route keeps working for a room admin.
    const single = await request(server.url)
      .delete(`/api/rooms/${roomId}/members/${plain.id}`)
      .set('Authorization', auth(roomAdmin));
    expect(single.status).toBe(200);
    expect(await hasMembership(roomId, plain.id)).toBe(false);
  });

  it('lets a global admin remove members without owning the room', async () => {
    const owner = await createTestUser('bulkremove_global_owner');
    const globalAdmin = await createTestUser('bulkremove_global_admin', 'admin');
    const roomAdmin = await createTestUser('bulkremove_global_roomadmin');
    const roomId = await createTestRoom(owner);
    await joinRoomService(globalAdmin.id, roomId);
    await joinRoomService(roomAdmin.id, roomId);
    await setMemberRole(roomId, owner.id, 'user', roomAdmin.id, 'admin');

    const response = await removeAs(globalAdmin, roomId, { userIds: [roomAdmin.id] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ removed: 1 });
    expect(await hasMembership(roomId, roomAdmin.id)).toBe(false);
    expect(await hasMembership(roomId, owner.id)).toBe(true);
  });

  it('cancels the removed members’ pending scheduled messages in that room only', async () => {
    const owner = await createTestUser('bulkremove_sched_owner');
    const member = await createTestUser('bulkremove_sched_member');
    const roomId = await createTestRoom(owner);
    const otherRoomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    await joinRoomService(member.id, otherRoomId);

    const queuedHere = await insertScheduled(roomId, member.id, 'queued here');
    const queuedElsewhere = await insertScheduled(otherRoomId, member.id, 'queued elsewhere');

    const response = await removeAs(owner, roomId, { userIds: [member.id] });

    expect(response.status).toBe(200);
    expect(await scheduledStatus(queuedHere)).toBe('cancelled');
    expect(await scheduledStatus(queuedElsewhere)).toBe('pending');
  });

  it('disables the removed members’ room bots and drops their memberships', async () => {
    const owner = await createTestUser('bulkremove_bot_owner');
    const member = await createTestUser('bulkremove_bot_member');
    const roomId = await createTestRoom(owner);
    const otherRoomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    await joinRoomService(member.id, otherRoomId);

    const kickedBot = await insertRoomBot(roomId, member, 'bulkremove_room_bot');
    const untouchedBot = await insertRoomBot(otherRoomId, member, 'bulkremove_other_bot');

    const response = await removeAs(owner, roomId, { userIds: [member.id] });

    expect(response.status).toBe(200);
    expect(await hasMembership(roomId, kickedBot)).toBe(false);
    expect((await getBotById(kickedBot)).enabled).toBe(false);
    expect(await hasMembership(otherRoomId, untouchedBot)).toBe(true);
    expect((await getBotById(untouchedBot)).enabled).toBe(true);
  });

  it('removes bot members like any other member', async () => {
    const owner = await createTestUser('bulkremove_bottarget_owner');
    const member = await createTestUser('bulkremove_bottarget_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    const botId = await insertRoomBot(roomId, owner, 'bulkremove_target_bot');

    const response = await removeAs(owner, roomId, { userIds: [member.id, botId] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ removed: 2 });
    expect(await hasMembership(roomId, botId)).toBe(false);
    expect(await hasMembership(roomId, member.id)).toBe(false);
  });

  it('rejects an empty batch, more than 100 ids and malformed bodies', async () => {
    const owner = await createTestUser('bulkremove_invalid_owner');
    const roomId = await createTestRoom(owner);

    const empty = await removeAs(owner, roomId, { userIds: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('INVALID_INPUT');

    const tooMany = await removeAs(owner, roomId, {
      userIds: Array.from({ length: 101 }, (_, index) => index + 1),
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('INVALID_INPUT');

    const malformed = await removeAs(owner, roomId, { userIds: ['1'] });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_INPUT');

    expect(await hasMembership(roomId, owner.id)).toBe(true);
  });
});
