import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool, type RowDataPacket } from '../src/db';
import { createMessage } from '../src/services/message';
import { getRoomMaxSeq, joinRoom, updateReadCursor } from '../src/services/room';
import type { AuthUser, RoomSummary } from '../src/types';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

function bearer(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

function markAllRead(user: AuthUser) {
  return request(app).post('/api/rooms/read-all').set('Authorization', bearer(user));
}

function listMyRooms(user: AuthUser) {
  return request(app).get('/api/rooms').set('Authorization', bearer(user));
}

async function seedMessage(roomId: number, senderId: number, content: string): Promise<number> {
  const message = await createMessage({
    roomId,
    senderId,
    senderType: 'user',
    content,
    clientMsgId: `read-all-${roomId}-${Math.random().toString(16).slice(2)}`,
  });
  return message.seq;
}

/** Membership cursor, or null when the user never joined the room. */
async function cursor(roomId: number, userId: number): Promise<number | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT last_read_seq FROM room_members WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  const row = rows[0];
  return row ? Number(row.last_read_seq) : null;
}

async function unreadCounts(user: AuthUser): Promise<Map<number, number>> {
  const response = await listMyRooms(user).expect(200);
  const counts = new Map<number, number>();
  for (const room of response.body.mine as RoomSummary[]) {
    counts.set(room.id, room.unreadCount);
  }
  return counts;
}

describe('POST /api/rooms/read-all', () => {
  it('marks every joined room read and reports one changed row per room', async () => {
    const owner = await createTestUser('read_all_owner');
    const member = await createTestUser('read_all_member');
    const first = await createTestRoom(owner);
    const second = await createTestRoom(owner);
    await joinRoom(member.id, first);
    await joinRoom(member.id, second);
    await seedMessage(first, owner.id, 'first room message');
    await seedMessage(second, owner.id, 'second room one');
    await seedMessage(second, owner.id, 'second room two');

    expect((await unreadCounts(member)).get(first)).toBe(1);
    expect((await unreadCounts(member)).get(second)).toBe(2);

    const response = await markAllRead(member).expect(200);
    expect(response.body).toEqual({ updated: 2 });

    expect(await cursor(first, member.id)).toBe(await getRoomMaxSeq(first));
    expect(await cursor(second, member.id)).toBe(await getRoomMaxSeq(second));
    const counts = await unreadCounts(member);
    expect(counts.get(first)).toBe(0);
    expect(counts.get(second)).toBe(0);
  });

  it('leaves an already-read room unchanged and only counts rows that moved', async () => {
    const owner = await createTestUser('read_all_kept_owner');
    const member = await createTestUser('read_all_kept_member');
    const readRoom = await createTestRoom(owner);
    const unreadRoom = await createTestRoom(owner);
    await joinRoom(member.id, readRoom);
    await joinRoom(member.id, unreadRoom);
    await seedMessage(readRoom, owner.id, 'already seen');
    await seedMessage(unreadRoom, owner.id, 'still unseen');

    const readMax = await getRoomMaxSeq(readRoom);
    await updateReadCursor(readRoom, member.id, readMax);

    const response = await markAllRead(member).expect(200);
    expect(response.body).toEqual({ updated: 1 });
    expect(await cursor(readRoom, member.id)).toBe(readMax);
    expect(await cursor(unreadRoom, member.id)).toBe(await getRoomMaxSeq(unreadRoom));

    // Once everything is caught up, a second call is a no-op rather than a
    // per-room write that reports rooms as newly read.
    const again = await markAllRead(member).expect(200);
    expect(again.body).toEqual({ updated: 0 });
  });

  it("moves only the caller's cursor and leaves other members unread", async () => {
    const owner = await createTestUser('read_all_scope_owner');
    const member = await createTestUser('read_all_scope_member');
    const roomId = await createTestRoom(owner);
    await joinRoom(member.id, roomId);
    await seedMessage(roomId, owner.id, 'hello team');
    // A message from the member gives the owner an unread count of their own.
    await seedMessage(roomId, member.id, 'hi owner');

    const response = await markAllRead(member).expect(200);
    expect(response.body).toEqual({ updated: 1 });

    expect(await cursor(roomId, member.id)).toBe(await getRoomMaxSeq(roomId));
    expect(await cursor(roomId, owner.id)).toBe(0);
    expect((await unreadCounts(owner)).get(roomId)).toBe(1);
  });

  it('ignores rooms the caller has not joined', async () => {
    const owner = await createTestUser('read_all_join_owner');
    const member = await createTestUser('read_all_join_member');
    const outsider = await createTestUser('read_all_outsider');
    const roomId = await createTestRoom(owner);
    await joinRoom(member.id, roomId);
    await seedMessage(roomId, owner.id, 'members only');

    const response = await markAllRead(outsider).expect(200);
    expect(response.body).toEqual({ updated: 0 });

    expect(await cursor(roomId, outsider.id)).toBeNull();
    expect(await cursor(roomId, member.id)).toBe(0);
    expect((await unreadCounts(member)).get(roomId)).toBe(1);
  });

  it('returns 0 when the user has no rooms', async () => {
    const lonely = await createTestUser('read_all_lonely');

    const response = await markAllRead(lonely).expect(200);
    expect(response.body).toEqual({ updated: 0 });
  });

  it('requires authentication', async () => {
    const response = await request(app).post('/api/rooms/read-all');
    expect(response.status).toBe(401);
  });
});
