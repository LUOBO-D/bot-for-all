import request from 'supertest';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pool, type RowDataPacket } from '../src/db';
import { joinRoom as joinRoomService } from '../src/services/room';
import type { AuthUser, MemberDTO, NotificationDTO } from '../src/types';
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

async function openClient(token: string): Promise<Socket> {
  const client = await connectClient(server.url, token);
  clients.push(client);
  return client;
}

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

function inviteAs(actor: AuthUser, roomId: number, body: unknown) {
  return request(server.url)
    .post(`/api/rooms/${roomId}/members`)
    .set('Authorization', auth(actor))
    .send(body as object);
}

async function membersViaApi(roomId: number, actor: AuthUser): Promise<MemberDTO[]> {
  const response = await request(server.url)
    .get(`/api/rooms/${roomId}/members`)
    .set('Authorization', auth(actor));
  expect(response.status).toBe(200);
  return response.body.members as MemberDTO[];
}

function nextNotification(client: Socket, type: string): Promise<NotificationDTO> {
  return waitForEvent<{ notification: NotificationDTO }>(
    client,
    'notification:new',
    (payload) => payload.notification.type === type,
  ).then((payload) => payload.notification);
}

async function roomName(roomId: number): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT name FROM rooms WHERE id = ?', [
    roomId,
  ]);
  return String(rows[0]?.name ?? '');
}

async function membershipRow(
  roomId: number,
  userId: number,
): Promise<RowDataPacket | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT role, last_read_seq, joined_at FROM room_members WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  return rows[0];
}

async function notificationRows(userId: number): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT type, room_id, message_id, detail, actor_id FROM notifications WHERE user_id = ?',
    [userId],
  );
  return rows;
}

async function ban(userId: number): Promise<void> {
  await pool.execute("UPDATE users SET status = 'banned' WHERE id = ?", [userId]);
}

beforeAll(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  while (clients.length > 0) {
    clients.pop()?.close();
  }
  await pool.execute('DELETE FROM notifications');
});

afterAll(async () => {
  await server.close();
});

describe('POST /api/rooms/:id/members', () => {
  it('lets the owner invite a human user, notifies them and broadcasts members:changed', async () => {
    const owner = await createTestUser('inv_owner');
    const invitee = await createTestUser('inv_guest');
    const roomId = await createTestRoom(owner);

    const ownerClient = await openClient(tokenFor(owner));
    await joinRoomSocket(ownerClient, roomId);
    const inviteeClient = await openClient(tokenFor(invitee));

    const waitingNotification = nextNotification(inviteeClient, 'room_invite');
    const waitingMembers = waitForEvent<{ roomId: number }>(
      ownerClient,
      'members:changed',
      (payload) => payload.roomId === roomId,
    );

    const response = await inviteAs(owner, roomId, { username: 'inv_guest' });

    expect(response.status).toBe(200);
    expect(response.body.member).toMatchObject({
      userId: invitee.id,
      username: 'inv_guest',
      displayName: 'inv_guest',
      role: 'member',
      type: 'human',
      lastReadSeq: 0,
    });
    expect(Number.isNaN(Date.parse(response.body.member.joinedAt))).toBe(false);

    const notification = await waitingNotification;
    expect(notification).toMatchObject({
      type: 'room_invite',
      roomId,
      messageId: null,
      messageSeq: null,
      actorName: 'inv_owner',
      readAt: null,
    });
    expect(notification.content).toBe(
      `inv_owner 邀请你加入「${await roomName(roomId)}」`,
    );

    expect(await waitingMembers).toEqual({ roomId });

    const list = await membersViaApi(roomId, owner);
    const invited = list.find((entry) => entry.userId === invitee.id);
    expect(invited).toMatchObject({ role: 'member', username: 'inv_guest' });
    expect(list).toHaveLength(2);

    const membership = await membershipRow(roomId, invitee.id);
    expect(membership).toMatchObject({ role: 'member', last_read_seq: 0 });
    expect(membership?.joined_at).not.toBeNull();

    const rows = await notificationRows(invitee.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'room_invite',
      room_id: roomId,
      message_id: null,
      actor_id: owner.id,
    });
    expect(String(rows[0].detail)).toBe(
      `inv_owner 邀请你加入「${await roomName(roomId)}」`,
    );
  });

  it('lets a room admin invite', async () => {
    const owner = await createTestUser('inv_owner2');
    const roomAdmin = await createTestUser('inv_radmin2');
    const invitee = await createTestUser('inv_guest2');
    const roomId = await createTestRoom(owner);
    await joinRoomService(roomAdmin.id, roomId);

    const promoted = await request(server.url)
      .patch(`/api/rooms/${roomId}/members/${roomAdmin.id}`)
      .set('Authorization', auth(owner))
      .send({ role: 'admin' });
    expect(promoted.status).toBe(200);

    const response = await inviteAs(roomAdmin, roomId, { username: 'inv_guest2' });

    expect(response.status).toBe(200);
    expect(response.body.member).toMatchObject({ userId: invitee.id, role: 'member' });
    expect(await membershipRow(roomId, invitee.id)).toMatchObject({ role: 'member' });
    const rows = await notificationRows(invitee.id);
    expect(rows[0]).toMatchObject({ type: 'room_invite', actor_id: roomAdmin.id });
  });

  it('lets a global admin invite without being a member', async () => {
    const admin = await createTestUser('inv_gadmin3', 'admin');
    const owner = await createTestUser('inv_owner3');
    const invitee = await createTestUser('inv_guest3');
    const roomId = await createTestRoom(owner);

    const response = await inviteAs(admin, roomId, { username: 'inv_guest3' });

    expect(response.status).toBe(200);
    expect(response.body.member).toMatchObject({ userId: invitee.id, role: 'member' });
    expect(await membershipRow(roomId, invitee.id)).toMatchObject({ role: 'member' });
    expect((await notificationRows(invitee.id))[0]).toMatchObject({
      type: 'room_invite',
      room_id: roomId,
      actor_id: admin.id,
    });
    // The global admin is not silently added to the room.
    expect(await membershipRow(roomId, admin.id)).toBeUndefined();
  });

  it('rejects plain members, outsiders and moderators of another room', async () => {
    const owner = await createTestUser('inv_owner4');
    const plain = await createTestUser('inv_plain4');
    const outsider = await createTestUser('inv_outsider4');
    const otherOwner = await createTestUser('inv_other4');
    const otherAdmin = await createTestUser('inv_other_admin4');
    const roomId = await createTestRoom(owner);
    const otherRoomId = await createTestRoom(otherOwner);
    await joinRoomService(plain.id, roomId);
    await joinRoomService(otherAdmin.id, otherRoomId);
    await request(server.url)
      .patch(`/api/rooms/${otherRoomId}/members/${otherAdmin.id}`)
      .set('Authorization', auth(otherOwner))
      .send({ role: 'admin' });

    const byPlain = await inviteAs(plain, roomId, { username: 'inv_outsider4' });
    expect(byPlain.status).toBe(403);
    expect(byPlain.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const byOutsider = await inviteAs(outsider, roomId, { username: 'inv_plain4' });
    expect(byOutsider.status).toBe(403);
    expect(byOutsider.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    // Being an admin of another room grants nothing here.
    const byOtherAdmin = await inviteAs(otherAdmin, roomId, { username: 'inv_outsider4' });
    expect(byOtherAdmin.status).toBe(403);
    expect(byOtherAdmin.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    expect(await membershipRow(roomId, outsider.id)).toBeUndefined();
    expect(await notificationRows(outsider.id)).toHaveLength(0);
  });

  it('returns 404 for an unknown username', async () => {
    const owner = await createTestUser('inv_owner5');
    const roomId = await createTestRoom(owner);

    const response = await inviteAs(owner, roomId, { username: 'nobody_here' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('rejects bot accounts and banned users', async () => {
    const owner = await createTestUser('inv_owner6');
    const bot = await createTestUser('inv_bot6', 'user', 'bot');
    const banned = await createTestUser('inv_banned6');
    const roomId = await createTestRoom(owner);
    await ban(banned.id);

    const botResponse = await inviteAs(owner, roomId, { username: bot.username });
    expect(botResponse.status).toBe(400);
    expect(botResponse.body.error.code).toBe('INVALID_TARGET');

    const bannedResponse = await inviteAs(owner, roomId, { username: 'inv_banned6' });
    expect(bannedResponse.status).toBe(400);
    expect(bannedResponse.body.error.code).toBe('INVALID_TARGET');

    expect(await membershipRow(roomId, bot.id)).toBeUndefined();
    expect(await membershipRow(roomId, banned.id)).toBeUndefined();
    expect(await notificationRows(banned.id)).toHaveLength(0);
  });

  it('rejects inviting someone who is already a member', async () => {
    const owner = await createTestUser('inv_owner7');
    const member = await createTestUser('inv_member7');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const response = await inviteAs(owner, roomId, { username: 'inv_member7' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ALREADY_MEMBER');
    expect(await notificationRows(member.id)).toHaveLength(0);

    const selfInvite = await inviteAs(owner, roomId, { username: 'inv_owner7' });
    expect(selfInvite.status).toBe(400);
    expect(selfInvite.body.error.code).toBe('ALREADY_MEMBER');
  });

  it('validates the username length', async () => {
    const owner = await createTestUser('inv_owner8');
    const roomId = await createTestRoom(owner);

    const tooShort = await inviteAs(owner, roomId, { username: 'ab' });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error.code).toBe('INVALID_INPUT');

    const tooLong = await inviteAs(owner, roomId, { username: 'x'.repeat(33) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('INVALID_INPUT');

    const missing = await inviteAs(owner, roomId, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_INPUT');
  });
});
