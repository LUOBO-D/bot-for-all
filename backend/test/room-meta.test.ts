import request from 'supertest';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pool, type RowDataPacket } from '../src/db';
import { joinRoom as joinRoomService, setMemberRole } from '../src/services/room';
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
  const response = await request(server.url)
    .get('/api/rooms')
    .set('Authorization', auth(actor));
  expect(response.status).toBe(200);
  return response.body.mine as RoomSummary[];
}

async function listPublic(actor: AuthUser): Promise<RoomSummary[]> {
  const response = await request(server.url)
    .get('/api/rooms')
    .set('Authorization', auth(actor));
  expect(response.status).toBe(200);
  return response.body.public as RoomSummary[];
}

describe('room announcement', () => {
  it('lets the owner set an announcement and lists it back', async () => {
    const owner = await createTestUser('ann_owner');
    const roomId = await createTestRoom(owner);

    const response = await patchRoom(roomId, owner, { announcement: '今晚十点维护' });
    expect(response.status).toBe(200);
    expect((response.body.room as RoomSummary).announcement).toBe('今晚十点维护');

    const mine = await listMine(owner);
    expect(mine.find((room) => room.id === roomId)?.announcement).toBe('今晚十点维护');
  });

  it('lets a room admin set the announcement but not the room name', async () => {
    const owner = await createTestUser('ann_owner2');
    const member = await createTestUser('ann_admin2');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    await setMemberRole(roomId, owner.id, 'user', member.id, 'admin');

    const response = await patchRoom(roomId, member, { announcement: 'room admin notice' });
    expect(response.status).toBe(200);
    expect((response.body.room as RoomSummary).announcement).toBe('room admin notice');

    const rename = await patchRoom(roomId, member, { name: 'hijacked' });
    expect(rename.status).toBe(403);
    expect(rename.body.error.code).toBe('ROOM_OWNER_REQUIRED');
  });

  it('rejects announcements from plain members', async () => {
    const owner = await createTestUser('ann_owner3');
    const member = await createTestUser('ann_member3');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const response = await patchRoom(roomId, member, { announcement: 'nope' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ROOM_MODERATOR_REQUIRED');

    const mine = await listMine(owner);
    expect(mine.find((room) => room.id === roomId)?.announcement).toBe('');
  });

  it('lets a global admin set the announcement without joining', async () => {
    const owner = await createTestUser('ann_owner4');
    const admin = await createTestUser('ann_admin4', 'admin');
    const roomId = await createTestRoom(owner);

    const response = await patchRoom(roomId, admin, { announcement: 'global admin notice' });
    expect(response.status).toBe(200);
    expect((response.body.room as RoomSummary).announcement).toBe('global admin notice');

    const mine = await listMine(owner);
    expect(mine.find((room) => room.id === roomId)?.announcement).toBe('global admin notice');
  });

  it('rejects announcements longer than 2000 characters', async () => {
    const owner = await createTestUser('ann_owner5');
    const roomId = await createTestRoom(owner);

    const response = await patchRoom(roomId, owner, { announcement: 'a'.repeat(2001) });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_INPUT');
  });

  it('broadcasts room:updated to the room after a patch', async () => {
    const owner = await createTestUser('ann_owner6');
    const roomId = await createTestRoom(owner);
    const socket = await connectClient(server.url, tokenFor(owner));
    sockets.push(socket);
    await joinRoomSocket(socket, roomId);

    const updated = waitForEvent<{
      roomId: number;
      name: string;
      topic: string;
      announcement: string;
    }>(socket, 'room:updated', (payload) => payload.roomId === roomId);

    const response = await patchRoom(roomId, owner, { announcement: 'broadcast me' });
    expect(response.status).toBe(200);

    const payload = await updated;
    expect(payload).toMatchObject({
      roomId,
      name: expect.any(String),
      topic: expect.any(String),
      announcement: 'broadcast me',
    });
  });
});

describe('room mute', () => {
  it('stores mute per member and reflects it in my rooms', async () => {
    const owner = await createTestUser('mute_owner');
    const member = await createTestUser('mute_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const on = await request(server.url)
      .post(`/api/rooms/${roomId}/mute`)
      .set('Authorization', auth(member))
      .send({ muted: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ muted: true });

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT muted FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, member.id],
    );
    expect(Number(rows[0]?.muted)).toBe(1);
    expect((await listMine(member)).find((room) => room.id === roomId)?.muted).toBe(true);

    const off = await request(server.url)
      .post(`/api/rooms/${roomId}/mute`)
      .set('Authorization', auth(member))
      .send({ muted: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ muted: false });

    const [offRows] = await pool.query<RowDataPacket[]>(
      'SELECT muted FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, member.id],
    );
    expect(Number(offRows[0]?.muted)).toBe(0);
    expect((await listMine(member)).find((room) => room.id === roomId)?.muted).toBe(false);

    // Mute is per user: the owner is unaffected.
    expect((await listMine(owner)).find((room) => room.id === roomId)?.muted).toBe(false);
  });

  it('rejects mute for non-members', async () => {
    const owner = await createTestUser('mute_owner2');
    const outsider = await createTestUser('mute_outsider2');
    const roomId = await createTestRoom(owner);

    const response = await request(server.url)
      .post(`/api/rooms/${roomId}/mute`)
      .set('Authorization', auth(outsider))
      .send({ muted: true });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
  });

  it('reports muted=false for public rooms the user has not joined', async () => {
    const owner = await createTestUser('mute_owner3');
    const outsider = await createTestUser('mute_outsider3');
    const roomId = await createTestRoom(owner);

    const publicRooms = await listPublic(outsider);
    const room = publicRooms.find((entry) => entry.id === roomId);
    expect(room).toBeDefined();
    expect(room?.muted).toBe(false);
    expect(room?.announcement).toBe('');
  });
});
