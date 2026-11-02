import request from 'supertest';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { pool, type RowDataPacket } from '../src/db';
import { getRoomSlowMode, joinRoom as joinRoomService, setMemberRole } from '../src/services/room';
import type { AuthUser, RoomSummary } from '../src/types';
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

async function patchRoom(
  roomId: number,
  actor: AuthUser,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(server.url)
    .patch(`/api/rooms/${roomId}`)
    .set('Authorization', auth(actor))
    .send(body);
}

async function listMine(actor: AuthUser): Promise<RoomSummary[]> {
  const response = await request(server.url).get('/api/rooms').set('Authorization', auth(actor));
  expect(response.status).toBe(200);
  return response.body.mine as RoomSummary[];
}

async function listPublic(actor: AuthUser): Promise<RoomSummary[]> {
  const response = await request(server.url).get('/api/rooms').set('Authorization', auth(actor));
  expect(response.status).toBe(200);
  return response.body.public as RoomSummary[];
}

async function storedSlowMode(roomId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT slow_mode_seconds FROM rooms WHERE id = ?',
    [roomId],
  );
  return Number(rows[0]?.slow_mode_seconds ?? -1);
}

type SendAck =
  | { ok: true; message: { seq: number; content: string } }
  | { ok: false; code: string; message: string };

function send(socket: Socket, roomId: number, content: string): Promise<SendAck> {
  const { promise, resolve } = Promise.withResolvers<SendAck>();
  socket.emit('message:send', { roomId, content }, (response: unknown) => {
    resolve(response as SendAck);
  });
  return promise;
}

async function messageCount(roomId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM messages WHERE room_id = ?',
    [roomId],
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Rate-limit buckets live in process memory and survive the per-test TRUNCATE,
 * while room/user ids restart at 1, so a window opened by an earlier test can
 * still be open for the same `slow:<roomId>:<userId>` key. Wait it out before
 * asserting that the first send is accepted.
 */
async function resetSlowWindow(): Promise<void> {
  await delay(1100);
}

describe('room slow mode settings', () => {
  it('lets the owner set and clear the slow mode', async () => {
    const owner = await createTestUser('slow_owner');
    const roomId = await createTestRoom(owner);

    const on = await patchRoom(roomId, owner, { slowModeSeconds: 30 });
    expect(on.status).toBe(200);
    expect((on.body.room as RoomSummary).slowModeSeconds).toBe(30);
    expect(await storedSlowMode(roomId)).toBe(30);
    expect(await getRoomSlowMode(roomId)).toBe(30);
    expect((await listMine(owner)).find((room) => room.id === roomId)?.slowModeSeconds).toBe(30);

    const off = await patchRoom(roomId, owner, { slowModeSeconds: 0 });
    expect(off.status).toBe(200);
    expect((off.body.room as RoomSummary).slowModeSeconds).toBe(0);
    expect(await storedSlowMode(roomId)).toBe(0);
    expect((await listMine(owner)).find((room) => room.id === roomId)?.slowModeSeconds).toBe(0);
  });

  it('defaults to 0 and exposes the field to non-members', async () => {
    const owner = await createTestUser('slow_owner2');
    const outsider = await createTestUser('slow_outsider2');
    const roomId = await createTestRoom(owner);

    const before = (await listPublic(outsider)).find((room) => room.id === roomId);
    expect(before).toBeDefined();
    expect(before?.slowModeSeconds).toBe(0);

    const response = await patchRoom(roomId, owner, { slowModeSeconds: 5 });
    expect(response.status).toBe(200);

    const after = (await listPublic(outsider)).find((room) => room.id === roomId);
    expect(after?.slowModeSeconds).toBe(5);
  });

  it('lets a room admin set it, but not a plain member', async () => {
    const owner = await createTestUser('slow_owner3');
    const moderator = await createTestUser('slow_mod3');
    const member = await createTestUser('slow_member3');
    const roomId = await createTestRoom(owner);
    await joinRoomService(moderator.id, roomId);
    await joinRoomService(member.id, roomId);
    await setMemberRole(roomId, owner.id, 'user', moderator.id, 'admin');

    const byModerator = await patchRoom(roomId, moderator, { slowModeSeconds: 10 });
    expect(byModerator.status).toBe(200);
    expect((byModerator.body.room as RoomSummary).slowModeSeconds).toBe(10);

    const byMember = await patchRoom(roomId, member, { slowModeSeconds: 60 });
    expect(byMember.status).toBe(403);
    expect(byMember.body.error.code).toBe('ROOM_MODERATOR_REQUIRED');
    expect(await storedSlowMode(roomId)).toBe(10);

    // Renaming still belongs to the owner alone.
    const rename = await patchRoom(roomId, moderator, { name: 'hijacked' });
    expect(rename.status).toBe(403);
    expect(rename.body.error.code).toBe('ROOM_OWNER_REQUIRED');
  });

  it('rejects non-members and lets a global admin set it without joining', async () => {
    const owner = await createTestUser('slow_owner4');
    const outsider = await createTestUser('slow_outsider4');
    const admin = await createTestUser('slow_admin4', 'admin');
    const roomId = await createTestRoom(owner);

    const byOutsider = await patchRoom(roomId, outsider, { slowModeSeconds: 5 });
    expect(byOutsider.status).toBe(403);
    expect(byOutsider.body.error.code).toBe('NOT_MEMBER');

    const byAdmin = await patchRoom(roomId, admin, { slowModeSeconds: 300 });
    expect(byAdmin.status).toBe(200);
    expect((byAdmin.body.room as RoomSummary).slowModeSeconds).toBe(300);
    expect(await storedSlowMode(roomId)).toBe(300);
  });

  it('accepts the 0..3600 boundaries and rejects everything else', async () => {
    const owner = await createTestUser('slow_owner5');
    const roomId = await createTestRoom(owner);

    for (const value of [0, 3600]) {
      const response = await patchRoom(roomId, owner, { slowModeSeconds: value });
      expect(response.status).toBe(200);
      expect((response.body.room as RoomSummary).slowModeSeconds).toBe(value);
    }

    for (const value of [3601, -1, 1.5, '5', null]) {
      const response = await patchRoom(roomId, owner, { slowModeSeconds: value });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }
    expect(await storedSlowMode(roomId)).toBe(3600);

    const empty = await patchRoom(roomId, owner, {});
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('INVALID_INPUT');
  });

  it('broadcasts the new value in room:updated', async () => {
    const owner = await createTestUser('slow_owner6');
    const roomId = await createTestRoom(owner);
    const socket = await connectClient(server.url, tokenFor(owner));
    sockets.push(socket);
    await joinRoomSocket(socket, roomId);

    const updated = waitForEvent<{ roomId: number; slowModeSeconds: number }>(
      socket,
      'room:updated',
      (payload) => payload.roomId === roomId,
    );
    const response = await patchRoom(roomId, owner, { slowModeSeconds: 30 });
    expect(response.status).toBe(200);
    expect((await updated).slowModeSeconds).toBe(30);
  });
});

describe('room slow mode enforcement', () => {
  afterEach(() => {
    config.rateLimitEnabled = false;
  });

  it('accepts the first message and rejects the second with SLOW_MODE', async () => {
    config.rateLimitEnabled = false;
    await resetSlowWindow();
    const owner = await createTestUser('slow_send_owner');
    const roomId = await createTestRoom(owner);
    expect((await patchRoom(roomId, owner, { slowModeSeconds: 1 })).status).toBe(200);

    const socket = await connectClient(server.url, tokenFor(owner));
    sockets.push(socket);
    await joinRoomSocket(socket, roomId);

    const first = await send(socket, roomId, 'first');
    expect(first.ok).toBe(true);

    const second = await send(socket, roomId, 'second');
    expect(second.ok).toBe(false);
    if (second.ok) {
      throw new Error('second send should have been throttled');
    }
    expect(second.code).toBe('SLOW_MODE');
    expect(second.message).toContain('慢速模式');
    expect(second.message).toContain('1 秒');

    // The rejected send must not have created a row.
    expect(await messageCount(roomId)).toBe(1);
  });

  it('accepts another message once the window has elapsed', async () => {
    config.rateLimitEnabled = false;
    await resetSlowWindow();
    const owner = await createTestUser('slow_wait_owner');
    const roomId = await createTestRoom(owner);
    expect((await patchRoom(roomId, owner, { slowModeSeconds: 1 })).status).toBe(200);

    const socket = await connectClient(server.url, tokenFor(owner));
    sockets.push(socket);
    await joinRoomSocket(socket, roomId);

    expect((await send(socket, roomId, 'before wait')).ok).toBe(true);
    expect((await send(socket, roomId, 'too soon')).ok).toBe(false);

    await delay(1100);
    expect((await send(socket, roomId, 'after wait')).ok).toBe(true);
    expect(await messageCount(roomId)).toBe(2);
  });

  it('throttles each member separately', async () => {
    config.rateLimitEnabled = false;
    await resetSlowWindow();
    const owner = await createTestUser('slow_pair_owner');
    const member = await createTestUser('slow_pair_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    expect((await patchRoom(roomId, owner, { slowModeSeconds: 1 })).status).toBe(200);

    const ownerSocket = await connectClient(server.url, tokenFor(owner));
    sockets.push(ownerSocket);
    await joinRoomSocket(ownerSocket, roomId);
    const memberSocket = await connectClient(server.url, tokenFor(member));
    sockets.push(memberSocket);
    await joinRoomSocket(memberSocket, roomId);

    expect((await send(ownerSocket, roomId, 'owner one')).ok).toBe(true);
    expect((await send(ownerSocket, roomId, 'owner two')).ok).toBe(false);

    // The member's own window is untouched by the owner's sends.
    expect((await send(memberSocket, roomId, 'member one')).ok).toBe(true);
    expect((await send(memberSocket, roomId, 'member two')).ok).toBe(false);

    expect(await messageCount(roomId)).toBe(2);
  });

  it('does not throttle when slow mode is off', async () => {
    config.rateLimitEnabled = false;
    await resetSlowWindow();
    const owner = await createTestUser('slow_off_owner');
    const roomId = await createTestRoom(owner);

    const socket = await connectClient(server.url, tokenFor(owner));
    sockets.push(socket);
    await joinRoomSocket(socket, roomId);

    expect((await send(socket, roomId, 'one')).ok).toBe(true);
    expect((await send(socket, roomId, 'two')).ok).toBe(true);
    expect(await messageCount(roomId)).toBe(2);
  });
});
