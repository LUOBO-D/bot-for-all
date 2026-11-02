import request from 'supertest';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import { joinRoom as joinRoomService, setMemberRole } from '../src/services/room';
import type { AuthUser } from '../src/types';
import {
  connectClient,
  createTestRoom,
  createTestUser,
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

function setRolesAs(actor: AuthUser, roomId: number, body: unknown) {
  return request(server.url)
    .patch(`/api/rooms/${roomId}/members/roles`)
    .set('Authorization', auth(actor))
    .send(body as object);
}

async function roleOf(roomId: number, userId: number): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT role FROM room_members WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  return rows[0] ? String(rows[0].role) : null;
}

async function addBotMember(roomId: number, owner: AuthUser, username: string): Promise<number> {
  const botUser = await createTestUser(username, 'user', 'bot');
  await pool.execute<ResultSetHeader>(
    `INSERT INTO bots
       (user_id, base_url, api_key_encrypted, model, system_prompt, owner_user_id, scope, room_id, enabled)
     VALUES (?, 'http://127.0.0.1:4010', 'encrypted-key', 'fake-ok', '', ?, 'room', ?, 1)`,
    [botUser.id, owner.id, roomId],
  );
  await pool.execute<ResultSetHeader>(
    'INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)',
    [roomId, botUser.id, 'bot'],
  );
  return botUser.id;
}

async function openClient(token: string): Promise<Socket> {
  const client = await connectClient(server.url, token);
  clients.push(client);
  return client;
}

describe('PATCH /api/rooms/:id/members/roles', () => {
  it('updates every requested member, reports the changed count and broadcasts', async () => {
    const owner = await createTestUser('bulkroles_owner');
    const first = await createTestUser('bulkroles_first');
    const second = await createTestUser('bulkroles_second');
    const roomId = await createTestRoom(owner);
    await joinRoomService(first.id, roomId);
    await joinRoomService(second.id, roomId);

    const ownerClient = await openClient(tokenFor(owner));
    await joinRoomSocket(ownerClient, roomId);
    const broadcast = waitForEvent<{ roomId: number }>(
      ownerClient,
      'members:changed',
      (payload) => payload.roomId === roomId,
    );

    const response = await setRolesAs(owner, roomId, {
      userIds: [first.id, second.id],
      role: 'admin',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: 2 });
    expect(await roleOf(roomId, first.id)).toBe('admin');
    expect(await roleOf(roomId, second.id)).toBe('admin');
    await expect(broadcast).resolves.toMatchObject({ roomId });
  });

  it('deduplicates ids and counts only members whose role actually changes', async () => {
    const owner = await createTestUser('bulkroles_dup_owner');
    const alreadyAdmin = await createTestUser('bulkroles_dup_admin');
    const member = await createTestUser('bulkroles_dup_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(alreadyAdmin.id, roomId);
    await joinRoomService(member.id, roomId);
    await setMemberRole(roomId, owner.id, 'user', alreadyAdmin.id, 'admin');

    const response = await setRolesAs(owner, roomId, {
      userIds: [member.id, member.id, alreadyAdmin.id],
      role: 'admin',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: 1 });
    expect(await roleOf(roomId, member.id)).toBe('admin');
    expect(await roleOf(roomId, alreadyAdmin.id)).toBe('admin');
  });

  it('rolls the whole batch back when one target is not a member', async () => {
    const owner = await createTestUser('bulkroles_missing_owner');
    const member = await createTestUser('bulkroles_missing_member');
    const outsider = await createTestUser('bulkroles_missing_outsider');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const response = await setRolesAs(owner, roomId, {
      userIds: [member.id, outsider.id],
      role: 'admin',
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('MEMBER_NOT_FOUND');
    expect(await roleOf(roomId, member.id)).toBe('member');
  });

  it('rejects the owner and leaves the rest of the batch untouched', async () => {
    const owner = await createTestUser('bulkroles_ownertarget_owner');
    const member = await createTestUser('bulkroles_ownertarget_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const response = await setRolesAs(owner, roomId, {
      userIds: [member.id, owner.id],
      role: 'admin',
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_ALLOWED');
    expect(await roleOf(roomId, owner.id)).toBe('owner');
    expect(await roleOf(roomId, member.id)).toBe('member');
  });

  it('rejects bots and leaves the rest of the batch untouched', async () => {
    const owner = await createTestUser('bulkroles_bot_owner');
    const member = await createTestUser('bulkroles_bot_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    const botId = await addBotMember(roomId, owner, 'bulkroles_bot');

    const response = await setRolesAs(owner, roomId, {
      userIds: [member.id, botId],
      role: 'admin',
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_ALLOWED');
    expect(await roleOf(roomId, botId)).toBe('bot');
    expect(await roleOf(roomId, member.id)).toBe('member');
  });

  it('requires the owner or a global admin', async () => {
    const owner = await createTestUser('bulkroles_deny_owner');
    const roomAdmin = await createTestUser('bulkroles_deny_admin');
    const plain = await createTestUser('bulkroles_deny_plain');
    const outsider = await createTestUser('bulkroles_deny_outsider');
    const roomId = await createTestRoom(owner);
    await joinRoomService(roomAdmin.id, roomId);
    await joinRoomService(plain.id, roomId);
    await setMemberRole(roomId, owner.id, 'user', roomAdmin.id, 'admin');

    const byRoomAdmin = await setRolesAs(roomAdmin, roomId, {
      userIds: [plain.id],
      role: 'admin',
    });
    expect(byRoomAdmin.status).toBe(403);
    expect(byRoomAdmin.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const byPlain = await setRolesAs(plain, roomId, { userIds: [plain.id], role: 'admin' });
    expect(byPlain.status).toBe(403);
    expect(byPlain.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const byOutsider = await setRolesAs(outsider, roomId, {
      userIds: [plain.id],
      role: 'admin',
    });
    expect(byOutsider.status).toBe(403);
    expect(byOutsider.body.error.code).toBe('NOT_MEMBER');

    expect(await roleOf(roomId, plain.id)).toBe('member');
  });

  it('reports zero when no role changes and supports demotion', async () => {
    const owner = await createTestUser('bulkroles_noop_owner');
    const member = await createTestUser('bulkroles_noop_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    await setMemberRole(roomId, owner.id, 'user', member.id, 'admin');

    const noop = await setRolesAs(owner, roomId, { userIds: [member.id], role: 'admin' });
    expect(noop.status).toBe(200);
    expect(noop.body).toEqual({ updated: 0 });
    expect(await roleOf(roomId, member.id)).toBe('admin');

    const demote = await setRolesAs(owner, roomId, { userIds: [member.id], role: 'member' });
    expect(demote.status).toBe(200);
    expect(demote.body).toEqual({ updated: 1 });
    expect(await roleOf(roomId, member.id)).toBe('member');
  });

  it('lets a global admin change roles without owning the room', async () => {
    const owner = await createTestUser('bulkroles_global_owner');
    const globalAdmin = await createTestUser('bulkroles_global_admin', 'admin');
    const member = await createTestUser('bulkroles_global_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(globalAdmin.id, roomId);
    await joinRoomService(member.id, roomId);

    const response = await setRolesAs(globalAdmin, roomId, {
      userIds: [member.id],
      role: 'admin',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: 1 });
    expect(await roleOf(roomId, member.id)).toBe('admin');
  });

  it('rejects an empty batch, more than 100 ids and an invalid role', async () => {
    const owner = await createTestUser('bulkroles_invalid_owner');
    const roomId = await createTestRoom(owner);

    const empty = await setRolesAs(owner, roomId, { userIds: [], role: 'admin' });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('INVALID_INPUT');

    const tooMany = await setRolesAs(owner, roomId, {
      userIds: Array.from({ length: 101 }, (_, index) => index + 1),
      role: 'admin',
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('INVALID_INPUT');

    const badRole = await setRolesAs(owner, roomId, { userIds: [owner.id], role: 'owner' });
    expect(badRole.status).toBe(400);
    expect(badRole.body.error.code).toBe('INVALID_INPUT');
  });
});
