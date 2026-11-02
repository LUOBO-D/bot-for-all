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

async function setGroup(
  roomId: number,
  actor: AuthUser,
  body: unknown,
): Promise<request.Response> {
  return request(server.url)
    .post(`/api/rooms/${roomId}/group`)
    .set('Authorization', auth(actor))
    .send(body as Record<string, unknown>);
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

async function storedGroup(roomId: number, userId: number): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT group_name FROM room_members WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  return rows[0]?.group_name == null ? null : String(rows[0].group_name);
}

async function backdateRoom(roomId: number, createdAt: string): Promise<void> {
  await pool.execute('UPDATE rooms SET created_at = ? WHERE id = ?', [createdAt, roomId]);
}

async function backdateLastMessage(roomId: number, createdAt: string): Promise<void> {
  await pool.execute('UPDATE messages SET created_at = ? WHERE room_id = ?', [createdAt, roomId]);
}

describe('room groups', () => {
  it('stores a trimmed group on the membership and returns it from listRooms', async () => {
    const owner = await createTestUser('grp_owner');
    const room = await createRoom(owner.id, { name: 'grp-room', isPublic: true });

    expect((await listMine(owner))[0]?.group).toBeNull();

    const response = await setGroup(room.id, owner, { group: '  工作  ' });
    expect(response.status).toBe(200);
    expect(response.body.group).toBe('工作');
    expect(await storedGroup(room.id, owner.id)).toBe('工作');
    expect((await listMine(owner)).find((entry) => entry.id === room.id)?.group).toBe('工作');

    // Idempotent: writing the same value again keeps it.
    const again = await setGroup(room.id, owner, { group: '工作' });
    expect(again.status).toBe(200);
    expect(again.body.group).toBe('工作');
    expect(await storedGroup(room.id, owner.id)).toBe('工作');
  });

  it('clears the group with null or a blank string', async () => {
    const owner = await createTestUser('grp_clear');
    const room = await createRoom(owner.id, { name: 'clear-group', isPublic: true });
    await setGroup(room.id, owner, { group: '稍后处理' });
    expect(await storedGroup(room.id, owner.id)).toBe('稍后处理');

    const cleared = await setGroup(room.id, owner, { group: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.group).toBeNull();
    expect(await storedGroup(room.id, owner.id)).toBeNull();
    expect((await listMine(owner)).find((entry) => entry.id === room.id)?.group).toBeNull();

    await setGroup(room.id, owner, { group: 'tmp' });
    const blank = await setGroup(room.id, owner, { group: '   ' });
    expect(blank.status).toBe(200);
    expect(blank.body.group).toBeNull();
    expect(await storedGroup(room.id, owner.id)).toBeNull();
  });

  it('accepts a 32-character group and rejects 33 characters with 400', async () => {
    const owner = await createTestUser('grp_len');
    const room = await createRoom(owner.id, { name: 'len-group', isPublic: true });

    const longest = 'x'.repeat(32);
    const ok = await setGroup(room.id, owner, { group: longest });
    expect(ok.status).toBe(200);
    expect(ok.body.group).toBe(longest);

    const tooLong = await setGroup(room.id, owner, { group: 'x'.repeat(33) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('INVALID_INPUT');
    expect(await storedGroup(room.id, owner.id)).toBe(longest);
  });

  it('rejects a non-member with 403 NOT_MEMBER', async () => {
    const owner = await createTestUser('grp_nm_owner');
    const outsider = await createTestUser('grp_nm_outsider');
    const room = await createRoom(owner.id, { name: 'private-grp', isPublic: true });

    const response = await setGroup(room.id, outsider, { group: 'sneaky' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
    expect(await storedGroup(room.id, outsider.id)).toBeNull();
  });

  it('rejects a missing or non-string group with 400', async () => {
    const owner = await createTestUser('grp_bad_owner');
    const room = await createRoom(owner.id, { name: 'bad-group', isPublic: true });

    for (const body of [{}, { group: 1 }, { group: ['a'] }]) {
      const response = await setGroup(room.id, owner, body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }
    expect(await storedGroup(room.id, owner.id)).toBeNull();
  });

  it('keeps groups per user and does not leak into the public listing', async () => {
    const owner = await createTestUser('grp_pair_owner');
    const member = await createTestUser('grp_pair_member');
    const outsider = await createTestUser('grp_pair_outsider');
    const room = await createRoom(owner.id, { name: 'shared-grp', isPublic: true });
    await joinRoom(member.id, room.id);

    await setGroup(room.id, owner, { group: 'Owner only' });
    await setGroup(room.id, member, { group: 'Member only' });

    expect(await storedGroup(room.id, owner.id)).toBe('Owner only');
    expect(await storedGroup(room.id, member.id)).toBe('Member only');

    expect((await listMine(owner)).find((entry) => entry.id === room.id)?.group).toBe('Owner only');
    expect((await listMine(member)).find((entry) => entry.id === room.id)?.group).toBe(
      'Member only',
    );

    // Non-members never see a group, even for a public room.
    const publicEntry = (await listPublic(outsider)).find((entry) => entry.id === room.id);
    expect(publicEntry?.joined).toBe(false);
    expect(publicEntry?.group).toBeNull();
  });

  it('does not change room ordering', async () => {
    const owner = await createTestUser('grp_order');
    const older = await createRoom(owner.id, { name: 'grp-older', isPublic: true });
    const middle = await createRoom(owner.id, { name: 'grp-middle', isPublic: true });
    const newest = await createRoom(owner.id, { name: 'grp-newest', isPublic: true });

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

    // Grouping is display-only metadata: it must not reorder `mine`.
    await setGroup(older.id, owner, { group: 'A' });
    await setGroup(middle.id, owner, { group: 'A' });
    await setGroup(newest.id, owner, { group: 'B' });

    const after = await listMine(owner);
    expect(after.map((entry) => entry.id)).toEqual(before);
    expect(after.find((entry) => entry.id === older.id)?.group).toBe('A');
    expect(after.find((entry) => entry.id === middle.id)?.group).toBe('A');
    expect(after.find((entry) => entry.id === newest.id)?.group).toBe('B');
  });
});
