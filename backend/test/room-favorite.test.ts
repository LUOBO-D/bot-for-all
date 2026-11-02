import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, type RowDataPacket } from '../src/db';
import { createMessage } from '../src/services/message';
import { createRoom, joinRoom } from '../src/services/room';
import type { AuthUser, RoomSummary } from '../src/types';
import { createTestUser, startTestServer, tokenFor, type TestServer } from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

async function setFavorite(
  roomId: number,
  actor: AuthUser,
  body: unknown,
): Promise<request.Response> {
  return request(server.url)
    .post(`/api/rooms/${roomId}/favorite`)
    .set('Authorization', auth(actor))
    .send(body as Record<string, unknown>);
}

async function listMine(actor: AuthUser): Promise<RoomSummary[]> {
  const response = await request(server.url).get('/api/rooms').set('Authorization', auth(actor));
  expect(response.status).toBe(200);
  return response.body.mine as RoomSummary[];
}

async function storedFavorite(roomId: number, userId: number): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT favorite FROM room_members WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  return Boolean(rows[0]?.favorite);
}

async function backdateRoom(roomId: number, createdAt: string): Promise<void> {
  await pool.execute('UPDATE rooms SET created_at = ? WHERE id = ?', [createdAt, roomId]);
}

async function backdateLastMessage(roomId: number, createdAt: string): Promise<void> {
  await pool.execute('UPDATE messages SET created_at = ? WHERE room_id = ?', [
    createdAt,
    roomId,
  ]);
}

describe('room favorites', () => {
  it('stores the favorite on the membership and returns it from listRooms', async () => {
    const owner = await createTestUser('fav_owner');
    const member = await createTestUser('fav_member');
    const room = await createRoom(owner.id, { name: 'fav-room', isPublic: true });
    await joinRoom(member.id, room.id);

    expect(await storedFavorite(room.id, owner.id)).toBe(false);

    const response = await setFavorite(room.id, owner, { favorite: true });
    expect(response.status).toBe(200);
    expect(response.body.favorite).toBe(true);
    expect(await storedFavorite(room.id, owner.id)).toBe(true);

    const mine = await listMine(owner);
    expect(mine.find((entry) => entry.id === room.id)?.favorite).toBe(true);

    // Per-user state: the other member is unaffected.
    const memberMine = await listMine(member);
    expect(memberMine.find((entry) => entry.id === room.id)?.favorite).toBe(false);
  });

  it('is idempotent when the same value is set twice', async () => {
    const owner = await createTestUser('fav_idem');
    const room = await createRoom(owner.id, { name: 'idem', isPublic: true });

    const first = await setFavorite(room.id, owner, { favorite: true });
    expect(first.status).toBe(200);
    expect(first.body.favorite).toBe(true);

    const second = await setFavorite(room.id, owner, { favorite: true });
    expect(second.status).toBe(200);
    expect(second.body.favorite).toBe(true);
    expect(await storedFavorite(room.id, owner.id)).toBe(true);
  });

  it('clears the favorite', async () => {
    const owner = await createTestUser('fav_clear');
    const room = await createRoom(owner.id, { name: 'clear', isPublic: true });
    await setFavorite(room.id, owner, { favorite: true });

    const response = await setFavorite(room.id, owner, { favorite: false });
    expect(response.status).toBe(200);
    expect(response.body.favorite).toBe(false);
    expect(await storedFavorite(room.id, owner.id)).toBe(false);
    expect((await listMine(owner)).find((entry) => entry.id === room.id)?.favorite).toBe(false);
  });

  it('rejects a non-member with 403 NOT_MEMBER', async () => {
    const owner = await createTestUser('fav_nm_owner');
    const outsider = await createTestUser('fav_nm_outsider');
    const room = await createRoom(owner.id, { name: 'private-nm', isPublic: true });

    const response = await setFavorite(room.id, outsider, { favorite: true });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
  });

  it('rejects a non-boolean body with 400', async () => {
    const owner = await createTestUser('fav_bad_owner');
    const room = await createRoom(owner.id, { name: 'bad-body', isPublic: true });

    for (const body of [{ favorite: 'yes' }, { favorite: 1 }, {}]) {
      const response = await setFavorite(room.id, owner, body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }
    expect(await storedFavorite(room.id, owner.id)).toBe(false);
  });

  it('orders favorites first, then by last message time', async () => {
    const owner = await createTestUser('fav_order');
    const older = await createRoom(owner.id, { name: 'older', isPublic: true });
    const middle = await createRoom(owner.id, { name: 'middle', isPublic: true });
    const newest = await createRoom(owner.id, { name: 'newest', isPublic: true });

    // Rooms: `older` is the oldest room, `newest` the newest.
    await backdateRoom(older.id, '2019-01-01 00:00:00.000');
    await backdateRoom(middle.id, '2019-06-01 00:00:00.000');
    await backdateRoom(newest.id, '2019-07-01 00:00:00.000');

    // `newest` gets the freshest message, `middle` an older one, `older` none.
    await createMessage({
      roomId: middle.id,
      senderId: owner.id,
      senderType: 'user',
      content: 'middle message',
    });
    await createMessage({
      roomId: newest.id,
      senderId: owner.id,
      senderType: 'user',
      content: 'newest message',
    });
    await backdateLastMessage(middle.id, '2020-01-01 00:00:00.000');
    await backdateLastMessage(newest.id, '2021-01-01 00:00:00.000');

    // No favorites: latest activity first.
    expect((await listMine(owner)).map((entry) => entry.id)).toEqual([
      newest.id,
      middle.id,
      older.id,
    ]);

    // Favoriting the oldest room lifts it above both newer rooms.
    await setFavorite(older.id, owner, { favorite: true });
    const favorited = await listMine(owner);
    expect(favorited.map((entry) => entry.id)).toEqual([older.id, newest.id, middle.id]);
    expect(favorited[0]?.favorite).toBe(true);

    // Unfavoriting restores activity order.
    await setFavorite(older.id, owner, { favorite: false });
    expect((await listMine(owner)).map((entry) => entry.id)).toEqual([
      newest.id,
      middle.id,
      older.id,
    ]);
  });
});
