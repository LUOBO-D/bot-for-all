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
  delay,
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

function bulkInviteAs(actor: AuthUser, roomId: number, body: unknown) {
  return request(server.url)
    .post(`/api/rooms/${roomId}/members/bulk`)
    .set('Authorization', auth(actor))
    .send(body as object);
}

async function membershipRow(
  roomId: number,
  userId: number,
): Promise<RowDataPacket | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT role, last_read_seq FROM room_members WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  return rows[0];
}

async function memberCount(roomId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM room_members WHERE room_id = ?',
    [roomId],
  );
  return Number(rows[0]?.total ?? 0);
}

async function notificationRows(userId: number): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT type, room_id, message_id, detail, actor_id FROM notifications WHERE user_id = ?',
    [userId],
  );
  return rows;
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

async function ban(userId: number): Promise<void> {
  await pool.execute("UPDATE users SET status = 'banned' WHERE id = ?", [userId]);
}

async function promoteToRoomAdmin(
  roomId: number,
  owner: AuthUser,
  target: AuthUser,
): Promise<void> {
  const response = await request(server.url)
    .patch(`/api/rooms/${roomId}/members/${target.id}`)
    .set('Authorization', auth(owner))
    .send({ role: 'admin' });
  expect(response.status).toBe(200);
}

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

describe('POST /api/rooms/:id/members/bulk', () => {
  it('invites every username in one request and broadcasts the roster once', async () => {
    const owner = await createTestUser('blk_owner1');
    const alpha = await createTestUser('blk_alpha1');
    const beta = await createTestUser('blk_beta1');
    const gamma = await createTestUser('blk_gamma1');
    const roomId = await createTestRoom(owner);

    const ownerClient = await openClient(tokenFor(owner));
    await joinRoomSocket(ownerClient, roomId);
    const events: number[] = [];
    ownerClient.on('members:changed', (payload: { roomId: number }) => {
      events.push(payload.roomId);
    });

    const response = await bulkInviteAs(owner, roomId, {
      usernames: ['blk_alpha1', 'blk_beta1', 'blk_gamma1'],
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ invited: 3 });
    expect(await memberCount(roomId)).toBe(4);

    const expectedDetail = `blk_owner1 邀请你加入「${await roomName(roomId)}」`;
    for (const invitee of [alpha, beta, gamma]) {
      expect(await membershipRow(roomId, invitee.id)).toMatchObject({
        role: 'member',
        last_read_seq: 0,
      });
      const rows = await notificationRows(invitee.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'room_invite',
        room_id: roomId,
        message_id: null,
        actor_id: owner.id,
      });
      expect(String(rows[0].detail)).toBe(expectedDetail);
    }

    const list = await request(server.url)
      .get(`/api/rooms/${roomId}/members`)
      .set('Authorization', auth(owner));
    expect(list.status).toBe(200);
    const members = list.body.members as MemberDTO[];
    expect(members).toHaveLength(4);
    for (const invitee of [alpha, beta, gamma]) {
      expect(members.find((member) => member.userId === invitee.id)).toMatchObject({
        role: 'member',
        type: 'human',
      });
    }

    // One broadcast for the whole batch, not one per invitee.
    await delay(150);
    expect(events).toEqual([roomId]);
  });

  it('trims names, strips @, drops blanks and dedupes case-insensitively', async () => {
    const owner = await createTestUser('blk_owner2');
    const alpha = await createTestUser('blk_alpha2');
    const beta = await createTestUser('blk_beta2');
    const roomId = await createTestRoom(owner);

    const response = await bulkInviteAs(owner, roomId, {
      usernames: [' @BLK_ALPHA2 ', 'blk_alpha2', 'Blk_Alpha2', '', '   ', '@blk_beta2'],
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ invited: 2 });
    expect(await memberCount(roomId)).toBe(3);
    expect(await membershipRow(roomId, alpha.id)).toMatchObject({ role: 'member' });
    expect(await membershipRow(roomId, beta.id)).toMatchObject({ role: 'member' });
    expect(await notificationRows(alpha.id)).toHaveLength(1);
    expect(await notificationRows(beta.id)).toHaveLength(1);
  });

  it('rolls the whole batch back when one username does not exist', async () => {
    const owner = await createTestUser('blk_owner3');
    const known = await createTestUser('blk_known3');
    const roomId = await createTestRoom(owner);

    const ownerClient = await openClient(tokenFor(owner));
    await joinRoomSocket(ownerClient, roomId);
    const events: number[] = [];
    ownerClient.on('members:changed', (payload: { roomId: number }) => {
      events.push(payload.roomId);
    });

    const response = await bulkInviteAs(owner, roomId, {
      usernames: ['blk_known3', 'blk_ghost3'],
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('USER_NOT_FOUND');
    expect(await memberCount(roomId)).toBe(1);
    expect(await membershipRow(roomId, known.id)).toBeUndefined();
    expect(await notificationRows(known.id)).toHaveLength(0);
    await delay(150);
    expect(events).toEqual([]);
  });

  it('rejects the batch when someone is already a member', async () => {
    const owner = await createTestUser('blk_owner4');
    const member = await createTestUser('blk_member4');
    const fresh = await createTestUser('blk_fresh4');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const response = await bulkInviteAs(owner, roomId, {
      usernames: ['blk_fresh4', 'blk_member4'],
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ALREADY_MEMBER');
    expect(await membershipRow(roomId, fresh.id)).toBeUndefined();
    expect(await notificationRows(fresh.id)).toHaveLength(0);
    expect(await memberCount(roomId)).toBe(2);
  });

  it('rejects bots and banned users without touching the batch', async () => {
    const owner = await createTestUser('blk_owner5');
    const bot = await createTestUser('blk_bot5', 'user', 'bot');
    const banned = await createTestUser('blk_banned5');
    const fresh = await createTestUser('blk_fresh5');
    const roomId = await createTestRoom(owner);
    await ban(banned.id);

    const botResponse = await bulkInviteAs(owner, roomId, {
      usernames: ['blk_fresh5', 'blk_bot5'],
    });
    expect(botResponse.status).toBe(400);
    expect(botResponse.body.error.code).toBe('INVALID_TARGET');
    expect(await membershipRow(roomId, bot.id)).toBeUndefined();
    expect(await membershipRow(roomId, fresh.id)).toBeUndefined();

    const bannedResponse = await bulkInviteAs(owner, roomId, {
      usernames: ['blk_fresh5', 'blk_banned5'],
    });
    expect(bannedResponse.status).toBe(400);
    expect(bannedResponse.body.error.code).toBe('INVALID_TARGET');
    expect(await membershipRow(roomId, banned.id)).toBeUndefined();
    expect(await membershipRow(roomId, fresh.id)).toBeUndefined();
    expect(await notificationRows(fresh.id)).toHaveLength(0);
    expect(await memberCount(roomId)).toBe(1);
  });

  it('only lets global admins, the owner and room admins invite', async () => {
    const owner = await createTestUser('blk_owner6');
    const roomAdmin = await createTestUser('blk_radmin6');
    const plain = await createTestUser('blk_plain6');
    const outsider = await createTestUser('blk_outsider6');
    const otherOwner = await createTestUser('blk_other6');
    const otherAdmin = await createTestUser('blk_other_admin6');
    const globalAdmin = await createTestUser('blk_gadmin6', 'admin');
    const targetByAdmin = await createTestUser('blk_target6a');
    const targetByOwner = await createTestUser('blk_target6b');
    const roomId = await createTestRoom(owner);
    await joinRoomService(roomAdmin.id, roomId);
    await promoteToRoomAdmin(roomId, owner, roomAdmin);
    await joinRoomService(plain.id, roomId);

    const otherRoomId = await createTestRoom(otherOwner);
    await joinRoomService(otherAdmin.id, otherRoomId);
    await promoteToRoomAdmin(otherRoomId, otherOwner, otherAdmin);

    const byPlain = await bulkInviteAs(plain, roomId, { usernames: ['blk_target6a'] });
    expect(byPlain.status).toBe(403);
    expect(byPlain.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const byOutsider = await bulkInviteAs(outsider, roomId, { usernames: ['blk_target6a'] });
    expect(byOutsider.status).toBe(403);
    expect(byOutsider.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    // Being a room admin elsewhere grants nothing here.
    const byOtherAdmin = await bulkInviteAs(otherAdmin, roomId, {
      usernames: ['blk_target6a'],
    });
    expect(byOtherAdmin.status).toBe(403);
    expect(byOtherAdmin.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    expect(await membershipRow(roomId, targetByAdmin.id)).toBeUndefined();
    expect(await notificationRows(targetByAdmin.id)).toHaveLength(0);

    const byRoomAdmin = await bulkInviteAs(roomAdmin, roomId, {
      usernames: ['blk_target6a'],
    });
    expect(byRoomAdmin.status).toBe(200);
    expect(byRoomAdmin.body).toEqual({ invited: 1 });
    expect(await membershipRow(roomId, targetByAdmin.id)).toMatchObject({ role: 'member' });

    // A global admin may invite without joining the room.
    const byGlobalAdmin = await bulkInviteAs(globalAdmin, roomId, {
      usernames: ['blk_target6b'],
    });
    expect(byGlobalAdmin.status).toBe(200);
    expect(byGlobalAdmin.body).toEqual({ invited: 1 });
    expect(await membershipRow(roomId, targetByOwner.id)).toMatchObject({ role: 'member' });
    expect(await membershipRow(roomId, globalAdmin.id)).toBeUndefined();
  });

  it('rejects empty batches, blank-only batches and more than 20 usernames', async () => {
    const owner = await createTestUser('blk_owner7');
    const roomId = await createTestRoom(owner);

    const empty = await bulkInviteAs(owner, roomId, { usernames: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('INVALID_INPUT');

    const missing = await bulkInviteAs(owner, roomId, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_INPUT');

    const blanks = await bulkInviteAs(owner, roomId, { usernames: ['', '  ', '@'] });
    expect(blanks.status).toBe(400);
    expect(blanks.body.error.code).toBe('INVALID_INPUT');

    const tooMany = Array.from({ length: 21 }, (_, index) => `blk_many7_${index}`);
    const overLimit = await bulkInviteAs(owner, roomId, { usernames: tooMany });
    expect(overLimit.status).toBe(400);
    expect(overLimit.body.error.code).toBe('INVALID_INPUT');
    expect(await memberCount(roomId)).toBe(1);
  });

  it('notifies each invitee over the socket', async () => {
    const owner = await createTestUser('blk_owner8');
    const alpha = await createTestUser('blk_alpha8');
    const beta = await createTestUser('blk_beta8');
    const roomId = await createTestRoom(owner);

    const ownerClient = await openClient(tokenFor(owner));
    await joinRoomSocket(ownerClient, roomId);
    const alphaClient = await openClient(tokenFor(alpha));
    const betaClient = await openClient(tokenFor(beta));

    const waitingAlpha = nextNotification(alphaClient, 'room_invite');
    const waitingBeta = nextNotification(betaClient, 'room_invite');

    const response = await bulkInviteAs(owner, roomId, {
      usernames: ['blk_alpha8', 'blk_beta8'],
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ invited: 2 });

    const [alphaNotification, betaNotification] = await Promise.all([
      waitingAlpha,
      waitingBeta,
    ]);
    const expectedContent = `blk_owner8 邀请你加入「${await roomName(roomId)}」`;
    expect(alphaNotification).toMatchObject({
      type: 'room_invite',
      roomId,
      messageId: null,
      messageSeq: null,
      actorName: 'blk_owner8',
      readAt: null,
    });
    expect(alphaNotification.content).toBe(expectedContent);
    expect(betaNotification).toMatchObject({ type: 'room_invite', roomId });
    expect(betaNotification.content).toBe(expectedContent);
  });
});
