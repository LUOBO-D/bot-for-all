import request from 'supertest';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, type RowDataPacket } from '../src/db';
import {
  createRoom,
  isRoomMember,
  joinRoom as joinRoomService,
  setMemberRole,
} from '../src/services/room';
import type { AuthUser, NotificationDTO } from '../src/types';
import {
  connectClient,
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

function postAs(user: AuthUser, path: string) {
  return request(server.url).post(path).set('Authorization', `Bearer ${tokenFor(user)}`);
}

function getAs(user: AuthUser, path: string) {
  return request(server.url).get(path).set('Authorization', `Bearer ${tokenFor(user)}`);
}

function nextNotification(client: Socket, type: string): Promise<NotificationDTO> {
  return waitForEvent<{ notification: NotificationDTO }>(
    client,
    'notification:new',
    (payload) => payload.notification.type === type,
  ).then((payload) => payload.notification);
}

async function requestRow(
  roomId: number,
  userId: number,
): Promise<RowDataPacket | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT status, created_at, updated_at FROM room_join_requests WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  return rows[0];
}

async function notificationCount(userId: number, type: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND type = ?',
    [userId, type],
  );
  return Number(rows[0]?.total ?? 0);
}

async function createPrivateRoom(owner: AuthUser) {
  return createRoom(owner.id, { name: 'jr-private', isPublic: false });
}

beforeAll(async () => {
  server = await startTestServer();
});

beforeEach(async () => {
  // The shared setup truncates users/rooms with FK checks off, so leftover
  // join requests would otherwise survive with stale (reused) ids.
  await pool.execute('DELETE FROM room_join_requests');
  await pool.execute('DELETE FROM notifications');
});

afterEach(() => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
});

afterAll(async () => {
  await server.close();
});

describe('room join requests', () => {
  it('creates a pending request and notifies the owner', async () => {
    const owner = await createTestUser('jr_owner');
    const applicant = await createTestUser('jr_applicant');
    const room = await createPrivateRoom(owner);

    const ownerClient = await openClient(tokenFor(owner));
    await joinRoomSocket(ownerClient, room.id);
    const waiting = nextNotification(ownerClient, 'join_request');

    const response = await postAs(applicant, `/api/rooms/${room.id}/request`);
    expect(response.status).toBe(200);
    expect(response.body.request).toMatchObject({
      userId: applicant.id,
      username: 'jr_applicant',
      displayName: 'jr_applicant',
    });
    expect(typeof response.body.request.createdAt).toBe('string');

    const notification = await waiting;
    expect(notification).toMatchObject({
      type: 'join_request',
      roomId: room.id,
      roomName: 'jr-private',
      messageId: null,
      messageSeq: null,
      actorName: 'jr_applicant',
      content: 'jr_applicant 请求加入房间',
      readAt: null,
    });

    const list = await getAs(owner, '/api/notifications');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.unread).toBe(1);
    expect(list.body.items[0]).toMatchObject({
      id: notification.id,
      type: 'join_request',
      messageId: null,
      messageSeq: null,
      content: 'jr_applicant 请求加入房间',
    });

    const pending = await getAs(owner, `/api/rooms/${room.id}/requests`);
    expect(pending.status).toBe(200);
    expect(pending.body.requests).toEqual([
      expect.objectContaining({
        userId: applicant.id,
        username: 'jr_applicant',
        displayName: 'jr_applicant',
      }),
    ]);

    expect((await requestRow(room.id, applicant.id))?.status).toBe('pending');
    expect(await isRoomMember(room.id, applicant.id)).toBe(false);
  });

  it('does not duplicate a request or its notification while pending', async () => {
    const owner = await createTestUser('jr_owner');
    const applicant = await createTestUser('jr_applicant');
    const room = await createPrivateRoom(owner);

    const first = await postAs(applicant, `/api/rooms/${room.id}/request`);
    const second = await postAs(applicant, `/api/rooms/${room.id}/request`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.request.userId).toBe(applicant.id);

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM room_join_requests WHERE room_id = ? AND user_id = ?',
      [room.id, applicant.id],
    );
    expect(Number(rows[0]?.total)).toBe(1);
    expect(await notificationCount(owner.id, 'join_request')).toBe(1);

    const pending = await getAs(owner, `/api/rooms/${room.id}/requests`);
    expect(pending.body.requests).toHaveLength(1);
  });

  it('rejects public rooms and existing members', async () => {
    const owner = await createTestUser('jr_owner');
    const outsider = await createTestUser('jr_outsider');
    const member = await createTestUser('jr_member');

    const publicRoom = await createRoom(owner.id, { name: 'jr-public', isPublic: true });
    const publicResponse = await postAs(outsider, `/api/rooms/${publicRoom.id}/request`);
    expect(publicResponse.status).toBe(400);
    expect(publicResponse.body.error.code).toBe('PUBLIC_ROOM');

    const privateRoom = await createPrivateRoom(owner);
    const ownerResponse = await postAs(owner, `/api/rooms/${privateRoom.id}/request`);
    expect(ownerResponse.status).toBe(400);
    expect(ownerResponse.body.error.code).toBe('ALREADY_MEMBER');

    await joinRoomService(member.id, privateRoom.id, privateRoom.inviteCode ?? undefined);
    const memberResponse = await postAs(member, `/api/rooms/${privateRoom.id}/request`);
    expect(memberResponse.status).toBe(400);
    expect(memberResponse.body.error.code).toBe('ALREADY_MEMBER');

    const missingRoom = await postAs(outsider, '/api/rooms/999999/request');
    expect(missingRoom.status).toBe(404);
    expect(missingRoom.body.error.code).toBe('ROOM_NOT_FOUND');
  });

  it('denies non-moderators the request list and decisions', async () => {
    const owner = await createTestUser('jr_owner');
    const applicant = await createTestUser('jr_applicant');
    const outsider = await createTestUser('jr_outsider');
    const room = await createPrivateRoom(owner);

    await postAs(applicant, `/api/rooms/${room.id}/request`);

    const list = await getAs(outsider, `/api/rooms/${room.id}/requests`);
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const approve = await postAs(outsider, `/api/rooms/${room.id}/requests/${applicant.id}/approve`);
    expect(approve.status).toBe(403);
    expect(approve.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const reject = await postAs(outsider, `/api/rooms/${room.id}/requests/${applicant.id}/reject`);
    expect(reject.status).toBe(403);
    expect(reject.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    expect(await isRoomMember(room.id, applicant.id)).toBe(false);
    expect((await requestRow(room.id, applicant.id))?.status).toBe('pending');
  });

  it('lets a room admin (not only the owner) list and approve', async () => {
    const owner = await createTestUser('jr_owner');
    const roomAdmin = await createTestUser('jr_admin');
    const applicant = await createTestUser('jr_applicant');
    const room = await createPrivateRoom(owner);
    await joinRoomService(roomAdmin.id, room.id, room.inviteCode ?? undefined);
    await setMemberRole(room.id, owner.id, 'user', roomAdmin.id, 'admin');

    await postAs(applicant, `/api/rooms/${room.id}/request`);

    const list = await getAs(roomAdmin, `/api/rooms/${room.id}/requests`);
    expect(list.status).toBe(200);
    expect(list.body.requests).toHaveLength(1);

    const approve = await postAs(
      roomAdmin,
      `/api/rooms/${room.id}/requests/${applicant.id}/approve`,
    );
    expect(approve.status).toBe(200);
    expect(approve.body.member).toMatchObject({
      userId: applicant.id,
      role: 'member',
    });
    expect(await isRoomMember(room.id, applicant.id)).toBe(true);
    expect(await notificationCount(applicant.id, 'join_approved')).toBe(1);
  });

  it('approves a request: member, applicant notification, members:changed', async () => {
    const owner = await createTestUser('jr_owner');
    const applicant = await createTestUser('jr_applicant');
    const room = await createPrivateRoom(owner);

    const ownerClient = await openClient(tokenFor(owner));
    await joinRoomSocket(ownerClient, room.id);
    const applicantClient = await openClient(tokenFor(applicant));

    const waitingRequest = nextNotification(ownerClient, 'join_request');
    await postAs(applicant, `/api/rooms/${room.id}/request`);
    await waitingRequest;

    const waitingApproved = nextNotification(applicantClient, 'join_approved');
    const waitingMembers = waitForEvent<{ roomId: number }>(
      ownerClient,
      'members:changed',
      (payload) => payload.roomId === room.id,
    );

    const approve = await postAs(owner, `/api/rooms/${room.id}/requests/${applicant.id}/approve`);
    expect(approve.status).toBe(200);
    expect(approve.body.member).toMatchObject({
      userId: applicant.id,
      username: 'jr_applicant',
      role: 'member',
    });

    const notification = await waitingApproved;
    expect(notification).toMatchObject({
      type: 'join_approved',
      roomId: room.id,
      roomName: 'jr-private',
      messageId: null,
      messageSeq: null,
      actorName: 'jr_owner',
      content: '你的加入申请已通过',
    });
    expect(await waitingMembers).toEqual({ roomId: room.id });

    expect(await isRoomMember(room.id, applicant.id)).toBe(true);
    expect((await requestRow(room.id, applicant.id))?.status).toBe('approved');

    const pending = await getAs(owner, `/api/rooms/${room.id}/requests`);
    expect(pending.body.requests).toEqual([]);

    const members = await getAs(applicant, `/api/rooms/${room.id}/members`);
    expect(members.status).toBe(200);
    expect(members.body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: applicant.id, role: 'member' }),
        expect.objectContaining({ userId: owner.id, role: 'owner' }),
      ]),
    );
  });

  it('rejects a request: stays a non-member and notifies the applicant', async () => {
    const owner = await createTestUser('jr_owner');
    const applicant = await createTestUser('jr_applicant');
    const room = await createPrivateRoom(owner);
    const applicantClient = await openClient(tokenFor(applicant));

    await postAs(applicant, `/api/rooms/${room.id}/request`);

    const waiting = nextNotification(applicantClient, 'join_rejected');
    const reject = await postAs(owner, `/api/rooms/${room.id}/requests/${applicant.id}/reject`);
    expect(reject.status).toBe(200);
    expect(reject.body).toEqual({ ok: true });

    const notification = await waiting;
    expect(notification).toMatchObject({
      type: 'join_rejected',
      roomId: room.id,
      messageId: null,
      messageSeq: null,
      actorName: 'jr_owner',
      content: '你的加入申请被拒绝',
    });

    expect(await isRoomMember(room.id, applicant.id)).toBe(false);
    expect((await requestRow(room.id, applicant.id))?.status).toBe('rejected');

    const pending = await getAs(owner, `/api/rooms/${room.id}/requests`);
    expect(pending.body.requests).toEqual([]);

    const forbidden = await getAs(applicant, `/api/rooms/${room.id}/requests`);
    expect(forbidden.status).toBe(403);
  });

  it('validates the applicant id and missing requests', async () => {
    const owner = await createTestUser('jr_owner');
    const room = await createPrivateRoom(owner);

    const notANumber = await postAs(owner, `/api/rooms/${room.id}/requests/abc/approve`);
    expect(notANumber.status).toBe(400);
    expect(notANumber.body.error.code).toBe('INVALID_USER_ID');

    const negative = await postAs(owner, `/api/rooms/${room.id}/requests/-1/reject`);
    expect(negative.status).toBe(400);
    expect(negative.body.error.code).toBe('INVALID_USER_ID');

    const missing = await postAs(owner, `/api/rooms/${room.id}/requests/999999/approve`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('JOIN_REQUEST_NOT_FOUND');
  });
});
