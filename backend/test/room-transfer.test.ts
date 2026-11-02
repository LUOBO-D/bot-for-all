import request from 'supertest';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import { joinRoom as joinRoomService, listMembers } from '../src/services/room';
import type { AuthUser, RoomSummary } from '../src/types';
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
const sockets: Socket[] = [];

beforeAll(async () => {
  server = await startTestServer();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.disconnect();
  }
});

afterAll(async () => {
  await server.close();
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

async function transfer(
  roomId: number,
  actor: AuthUser,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(server.url)
    .post(`/api/rooms/${roomId}/transfer`)
    .set('Authorization', auth(actor))
    .send(body);
}

async function listMine(actor: AuthUser): Promise<RoomSummary[]> {
  const response = await request(server.url)
    .get('/api/rooms')
    .set('Authorization', auth(actor));
  expect(response.status).toBe(200);
  return response.body.mine as RoomSummary[];
}

async function ownerIdOf(roomId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT owner_id FROM rooms WHERE id = ?',
    [roomId],
  );
  return Number(rows[0]?.owner_id);
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

describe('room ownership transfer', () => {
  it('moves the room owner and both membership roles', async () => {
    const owner = await createTestUser('tr_owner');
    const successor = await createTestUser('tr_successor');
    const roomId = await createTestRoom(owner);
    await joinRoomService(successor.id, roomId);

    const response = await transfer(roomId, owner, { userId: successor.id });

    expect(response.status).toBe(200);
    expect(response.body.ownerId).toBe(successor.id);
    expect(response.body.member).toMatchObject({
      userId: successor.id,
      role: 'owner',
      type: 'human',
    });

    expect(await ownerIdOf(roomId)).toBe(successor.id);
    expect(await roleOf(roomId, successor.id)).toBe('owner');
    expect(await roleOf(roomId, owner.id)).toBe('member');

    const successorList = await listMine(successor);
    expect(successorList.find((room) => room.id === roomId)?.ownerId).toBe(successor.id);
    const previousList = await listMine(owner);
    expect(previousList.find((room) => room.id === roomId)?.ownerId).toBe(successor.id);

    const members = await listMembers(roomId);
    expect(members.filter((member) => member.role === 'owner')).toHaveLength(1);
    expect(members.find((member) => member.userId === owner.id)?.role).toBe('member');
  });

  it('lets the new owner rename and kick while the old owner loses those powers', async () => {
    const owner = await createTestUser('tr_perm_owner');
    const successor = await createTestUser('tr_perm_successor');
    const bystander = await createTestUser('tr_perm_bystander');
    const roomId = await createTestRoom(owner);
    await joinRoomService(successor.id, roomId);
    await joinRoomService(bystander.id, roomId);

    expect((await transfer(roomId, owner, { userId: successor.id })).status).toBe(200);

    const oldRename = await request(server.url)
      .patch(`/api/rooms/${roomId}`)
      .set('Authorization', auth(owner))
      .send({ name: 'taken over by nobody' });
    expect(oldRename.status).toBe(403);
    expect(oldRename.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const newRename = await request(server.url)
      .patch(`/api/rooms/${roomId}`)
      .set('Authorization', auth(successor))
      .send({ name: 'handover room' });
    expect(newRename.status).toBe(200);
    expect((newRename.body.room as RoomSummary).name).toBe('handover room');

    const oldKick = await request(server.url)
      .delete(`/api/rooms/${roomId}/members/${bystander.id}`)
      .set('Authorization', auth(owner));
    expect(oldKick.status).toBe(403);
    expect(oldKick.body.error.code).toBe('NOT_ALLOWED');
    expect(await roleOf(roomId, bystander.id)).toBe('member');

    const newKick = await request(server.url)
      .delete(`/api/rooms/${roomId}/members/${owner.id}`)
      .set('Authorization', auth(successor));
    expect(newKick.status).toBe(200);
    expect(await roleOf(roomId, owner.id)).toBeNull();

    const backAgain = await transfer(roomId, owner, { userId: successor.id });
    expect(backAgain.status).toBe(403);
    expect(backAgain.body.error.code).toBe('NOT_MEMBER');
  });

  it('rejects callers who are not the owner', async () => {
    const owner = await createTestUser('tr_deny_owner');
    const member = await createTestUser('tr_deny_member');
    const outsider = await createTestUser('tr_deny_outsider');
    const target = await createTestUser('tr_deny_target');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    await joinRoomService(target.id, roomId);

    const byMember = await transfer(roomId, member, { userId: target.id });
    expect(byMember.status).toBe(403);
    expect(byMember.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const byOutsider = await transfer(roomId, outsider, { userId: target.id });
    expect(byOutsider.status).toBe(403);
    expect(byOutsider.body.error.code).toBe('NOT_MEMBER');

    expect(await ownerIdOf(roomId)).toBe(owner.id);
    expect(await roleOf(roomId, owner.id)).toBe('owner');
    expect(await roleOf(roomId, target.id)).toBe('member');
  });

  it('rejects a target that is not a member of the room', async () => {
    const owner = await createTestUser('tr_missing_owner');
    const stranger = await createTestUser('tr_missing_stranger');
    const roomId = await createTestRoom(owner);

    const response = await transfer(roomId, owner, { userId: stranger.id });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('MEMBER_NOT_FOUND');
    expect(await ownerIdOf(roomId)).toBe(owner.id);
  });

  it('rejects a bot target', async () => {
    const owner = await createTestUser('tr_bot_owner');
    const roomId = await createTestRoom(owner);
    const botId = await addBotMember(roomId, owner, 'tr_bot_member');

    const response = await transfer(roomId, owner, { userId: botId });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_TARGET');
    expect(await ownerIdOf(roomId)).toBe(owner.id);
    expect(await roleOf(roomId, botId)).toBe('bot');
  });

  it('rejects transferring to yourself or with an invalid user id', async () => {
    const owner = await createTestUser('tr_self_owner');
    const roomId = await createTestRoom(owner);

    const self = await transfer(roomId, owner, { userId: owner.id });
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe('INVALID_TARGET');

    const zero = await transfer(roomId, owner, { userId: 0 });
    expect(zero.status).toBe(400);
    expect(zero.body.error.code).toBe('INVALID_TARGET');

    const missing = await transfer(roomId, owner, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_TARGET');

    expect(await ownerIdOf(roomId)).toBe(owner.id);
    expect(await roleOf(roomId, owner.id)).toBe('owner');
  });

  it('broadcasts room:owner and members:changed to the room', async () => {
    const owner = await createTestUser('tr_socket_owner');
    const successor = await createTestUser('tr_socket_successor');
    const roomId = await createTestRoom(owner);
    await joinRoomService(successor.id, roomId);

    const ownerSocket = await connectClient(server.url, tokenFor(owner));
    sockets.push(ownerSocket);
    const successorSocket = await connectClient(server.url, tokenFor(successor));
    sockets.push(successorSocket);
    await joinRoomSocket(ownerSocket, roomId);
    await joinRoomSocket(successorSocket, roomId);

    const ownerEvent = waitForEvent<{ roomId: number; ownerId: number }>(
      ownerSocket,
      'room:owner',
      (payload) => payload.roomId === roomId,
    );
    const successorEvent = waitForEvent<{ roomId: number; ownerId: number }>(
      successorSocket,
      'room:owner',
      (payload) => payload.roomId === roomId,
    );
    const ownerMembers = waitForEvent<{ roomId: number }>(
      ownerSocket,
      'members:changed',
      (payload) => payload.roomId === roomId,
    );
    const successorMembers = waitForEvent<{ roomId: number }>(
      successorSocket,
      'members:changed',
      (payload) => payload.roomId === roomId,
    );

    const response = await transfer(roomId, owner, { userId: successor.id });
    expect(response.status).toBe(200);

    expect(await ownerEvent).toEqual({ roomId, ownerId: successor.id });
    expect(await successorEvent).toEqual({ roomId, ownerId: successor.id });
    expect((await ownerMembers).roomId).toBe(roomId);
    expect((await successorMembers).roomId).toBe(roomId);
  });
});
