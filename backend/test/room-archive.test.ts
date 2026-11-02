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

async function setArchived(
  roomId: number,
  actor: AuthUser,
  body: unknown,
): Promise<request.Response> {
  return request(server.url)
    .post(`/api/rooms/${roomId}/archive`)
    .set('Authorization', auth(actor))
    .send(body as Record<string, unknown>);
}

async function listMine(actor: AuthUser): Promise<RoomSummary[]> {
  const response = await request(server.url).get('/api/rooms').set('Authorization', auth(actor));
  expect(response.status).toBe(200);
  return response.body.mine as RoomSummary[];
}

async function storedArchived(roomId: number, userId: number): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT archived FROM room_members WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  return Boolean(rows[0]?.archived);
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

describe('room archive', () => {
  it('stores the archive flag on the membership and reflects it in mine', async () => {
    const owner = await createTestUser('arc_owner');
    const room = await createRoom(owner.id, { name: 'arc-room', isPublic: true });

    expect(await storedArchived(room.id, owner.id)).toBe(false);
    expect((await listMine(owner)).find((entry) => entry.id === room.id)?.archived).toBe(false);

    const archived = await setArchived(room.id, owner, { archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body.archived).toBe(true);
    expect(await storedArchived(room.id, owner.id)).toBe(true);
    expect((await listMine(owner)).find((entry) => entry.id === room.id)?.archived).toBe(true);

    const restored = await setArchived(room.id, owner, { archived: false });
    expect(restored.status).toBe(200);
    expect(restored.body.archived).toBe(false);
    expect(await storedArchived(room.id, owner.id)).toBe(false);
    expect((await listMine(owner)).find((entry) => entry.id === room.id)?.archived).toBe(false);
  });

  it('is idempotent when the same value is set twice', async () => {
    const owner = await createTestUser('arc_idem');
    const room = await createRoom(owner.id, { name: 'arc-idem', isPublic: true });

    const first = await setArchived(room.id, owner, { archived: true });
    expect(first.status).toBe(200);
    expect(first.body.archived).toBe(true);

    const second = await setArchived(room.id, owner, { archived: true });
    expect(second.status).toBe(200);
    expect(second.body.archived).toBe(true);
    expect(await storedArchived(room.id, owner.id)).toBe(true);
  });

  it('rejects a non-member with 403 NOT_MEMBER', async () => {
    const owner = await createTestUser('arc_nm_owner');
    const outsider = await createTestUser('arc_nm_outsider');
    const room = await createRoom(owner.id, { name: 'arc-nm', isPublic: true });

    const response = await setArchived(room.id, outsider, { archived: true });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
    expect(await storedArchived(room.id, outsider.id)).toBe(false);
  });

  it('rejects a non-boolean body with 400', async () => {
    const owner = await createTestUser('arc_bad_owner');
    const room = await createRoom(owner.id, { name: 'arc-bad', isPublic: true });

    for (const body of [{ archived: 'yes' }, { archived: 1 }, {}]) {
      const response = await setArchived(room.id, owner, body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }
    expect(await storedArchived(room.id, owner.id)).toBe(false);
  });

  it('keeps the flag per user', async () => {
    const owner = await createTestUser('arc_pu_owner');
    const member = await createTestUser('arc_pu_member');
    const room = await createRoom(owner.id, { name: 'arc-per-user', isPublic: true });
    await joinRoom(member.id, room.id);

    const response = await setArchived(room.id, owner, { archived: true });
    expect(response.status).toBe(200);

    expect((await listMine(owner)).find((entry) => entry.id === room.id)?.archived).toBe(true);
    expect((await listMine(member)).find((entry) => entry.id === room.id)?.archived).toBe(false);
    expect(await storedArchived(room.id, member.id)).toBe(false);
  });

  it('does not change room ordering', async () => {
    const owner = await createTestUser('arc_order');
    const older = await createRoom(owner.id, { name: 'arc-older', isPublic: true });
    const middle = await createRoom(owner.id, { name: 'arc-middle', isPublic: true });
    const newest = await createRoom(owner.id, { name: 'arc-newest', isPublic: true });

    await backdateRoom(older.id, '2019-01-01 00:00:00.000');
    await backdateRoom(middle.id, '2019-06-01 00:00:00.000');
    await backdateRoom(newest.id, '2019-07-01 00:00:00.000');

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

    const before = (await listMine(owner)).map((entry) => entry.id);
    expect(before).toEqual([newest.id, middle.id, older.id]);

    await setArchived(middle.id, owner, { archived: true });
    const afterArchive = await listMine(owner);
    // Archived rooms stay in `mine` in the same position; the client filters.
    expect(afterArchive.map((entry) => entry.id)).toEqual(before);
    expect(afterArchive.find((entry) => entry.id === middle.id)?.archived).toBe(true);

    await setArchived(middle.id, owner, { archived: false });
    expect((await listMine(owner)).map((entry) => entry.id)).toEqual(before);
  });

  it('reports archived=false for a public room the user has not joined', async () => {
    const owner = await createTestUser('arc_pub_owner');
    const viewer = await createTestUser('arc_pub_viewer');
    const room = await createRoom(owner.id, { name: 'arc-public', isPublic: true });
    await setArchived(room.id, owner, { archived: true });

    const response = await request(server.url)
      .get('/api/rooms')
      .set('Authorization', auth(viewer));
    expect(response.status).toBe(200);
    const entry = (response.body.public as RoomSummary[]).find((row) => row.id === room.id);
    expect(entry?.archived).toBe(false);
  });
});
