import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db';
import { getMember, joinRoom as joinRoomService, listMembers } from '../src/services/room';
import {
  createTestRoom,
  createTestUser,
  startTestServer,
  tokenFor,
  type TestServer,
} from './helpers';
import type { AuthUser, MemberDTO } from '../src/types';

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

async function membersViaApi(roomId: number, actor: AuthUser): Promise<MemberDTO[]> {
  const response = await request(server.url)
    .get(`/api/rooms/${roomId}/members`)
    .set('Authorization', auth(actor));
  expect(response.status).toBe(200);
  return response.body.members as MemberDTO[];
}

function memberOf(members: MemberDTO[], userId: number): MemberDTO {
  const found = members.find((m) => m.userId === userId);
  if (!found) {
    throw new Error(`member ${userId} missing from list`);
  }
  return found;
}

describe('member joinedAt', () => {
  it('exposes a parseable joinedAt for every member over HTTP', async () => {
    const owner = await createTestUser('joined_owner');
    const member = await createTestUser('joined_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const members = await membersViaApi(roomId, owner);
    expect(members).toHaveLength(2);
    for (const entry of members) {
      expect(typeof entry.joinedAt).toBe('string');
      const parsed = Date.parse(entry.joinedAt);
      expect(Number.isNaN(parsed)).toBe(false);
      expect(parsed).toBeLessThanOrEqual(Date.now());
    }
    expect(memberOf(members, owner.id).role).toBe('owner');
    expect(memberOf(members, member.id).role).toBe('member');
  });

  it('reports the same joinedAt from getMember and listMembers', async () => {
    const owner = await createTestUser('consistent_owner');
    const member = await createTestUser('consistent_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const single = await getMember(roomId, member.id);
    expect(single).not.toBeNull();
    const listed = memberOf(await listMembers(roomId), member.id);
    const viaApi = memberOf(await membersViaApi(roomId, owner), member.id);

    expect(single?.joinedAt).toBe(listed.joinedAt);
    expect(viaApi.joinedAt).toBe(listed.joinedAt);
  });

  it('keeps the original joinedAt when an existing member joins again', async () => {
    const owner = await createTestUser('rejoin_owner');
    const member = await createTestUser('rejoin_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const before = (await getMember(roomId, member.id))?.joinedAt;
    expect(before).toBeTruthy();

    await joinRoomService(member.id, roomId);
    await joinRoomService(member.id, roomId);

    expect((await getMember(roomId, member.id))?.joinedAt).toBe(before);
  });

  it('stores each membership time independently', async () => {
    const owner = await createTestUser('independent_owner');
    const member = await createTestUser('independent_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const memberJoined = new Date(Date.UTC(2020, 0, 2, 3, 4, 5, 0));
    const ownerJoined = new Date(Date.UTC(2021, 1, 3, 4, 5, 6, 0));
    await pool.execute(
      'UPDATE room_members SET joined_at = ? WHERE room_id = ? AND user_id = ?',
      [memberJoined, roomId, member.id],
    );
    await pool.execute(
      'UPDATE room_members SET joined_at = ? WHERE room_id = ? AND user_id = ?',
      [ownerJoined, roomId, owner.id],
    );

    const members = await listMembers(roomId);
    expect(Date.parse(memberOf(members, member.id).joinedAt)).toBe(memberJoined.getTime());
    expect(Date.parse(memberOf(members, owner.id).joinedAt)).toBe(ownerJoined.getTime());
    expect(memberOf(members, member.id).joinedAt).not.toBe(memberOf(members, owner.id).joinedAt);
  });
});
