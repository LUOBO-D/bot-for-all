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

function postAs(user: AuthUser, path: string, body?: unknown) {
  const pending = request(server.url).post(path).set('Authorization', auth(user));
  return body === undefined ? pending : pending.send(body as object);
}

function getAs(user: AuthUser, path: string) {
  return request(server.url).get(path).set('Authorization', auth(user));
}

function decideAs(
  actor: AuthUser,
  roomId: number,
  userIds: number[],
  action: 'approve' | 'reject',
) {
  return postAs(actor, `/api/rooms/${roomId}/requests/bulk`, { userIds, action });
}

function nextNotification(client: Socket, type: string): Promise<NotificationDTO> {
  return waitForEvent<{ notification: NotificationDTO }>(
    client,
    'notification:new',
    (payload) => payload.notification.type === type,
  ).then((payload) => payload.notification);
}

async function createPrivateRoom(owner: AuthUser) {
  return createRoom(owner.id, { name: 'jrb-private', isPublic: false });
}

async function requestRow(
  roomId: number,
  userId: number,
): Promise<RowDataPacket | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT status FROM room_join_requests WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  return rows[0];
}

async function requestStatus(roomId: number, userId: number): Promise<string | undefined> {
  const row = await requestRow(roomId, userId);
  return row ? String(row.status) : undefined;
}

async function notificationsFor(userId: number): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT type, detail FROM notifications WHERE user_id = ? ORDER BY id',
    [userId],
  );
  return rows;
}

async function requestJoin(applicant: AuthUser, roomId: number): Promise<void> {
  const response = await postAs(applicant, `/api/rooms/${roomId}/request`);
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  server = await startTestServer();
});

beforeEach(async () => {
  await pool.execute('DELETE FROM room_join_requests');
  await pool.execute('DELETE FROM notifications');
});

afterEach(() => {
  while (clients.length > 0) {
    clients.pop()?.close();
  }
});

afterAll(async () => {
  await server.close();
});

describe('POST /api/rooms/:id/requests/bulk', () => {
  it('approves every pending request, notifies each applicant and broadcasts once', async () => {
    const owner = await createTestUser('jrb_owner');
    const first = await createTestUser('jrb_first');
    const second = await createTestUser('jrb_second');
    const third = await createTestUser('jrb_third');
    const untouched = await createTestUser('jrb_untouched');
    const room = await createPrivateRoom(owner);

    for (const applicant of [first, second, third, untouched]) {
      await requestJoin(applicant, room.id);
    }

    const ownerClient = await openClient(tokenFor(owner));
    await joinRoomSocket(ownerClient, room.id);
    const applicantClients = await Promise.all(
      [first, second, third].map((applicant) => openClient(tokenFor(applicant))),
    );

    const changes: number[] = [];
    ownerClient.on('members:changed', (payload: { roomId: number }) => {
      if (payload.roomId === room.id) {
        changes.push(payload.roomId);
      }
    });
    const waiting = applicantClients.map((client) => nextNotification(client, 'join_approved'));

    const response = await decideAs(owner, room.id, [first.id, second.id, third.id], 'approve');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: 3 });
    const notifications = await Promise.all(waiting);
    for (const notification of notifications) {
      expect(notification).toMatchObject({
        type: 'join_approved',
        roomId: room.id,
        actorName: 'jrb_owner',
        messageId: null,
        content: '你的加入申请已通过',
      });
    }

    for (const applicant of [first, second, third]) {
      expect(await isRoomMember(room.id, applicant.id)).toBe(true);
      expect(await requestStatus(room.id, applicant.id)).toBe('approved');
      expect(await notificationsFor(applicant.id)).toEqual([
        { type: 'join_approved', detail: '你的加入申请已通过' },
      ]);
    }

    // Someone outside the batch keeps their pending request.
    expect(await isRoomMember(room.id, untouched.id)).toBe(false);
    expect(await requestStatus(room.id, untouched.id)).toBe('pending');
    expect(await notificationsFor(untouched.id)).toEqual([]);

    const pending = await getAs(owner, `/api/rooms/${room.id}/requests`);
    expect(pending.status).toBe(200);
    expect(pending.body.requests).toEqual([
      expect.objectContaining({ userId: untouched.id, username: 'jrb_untouched' }),
    ]);

    // One broadcast for the whole batch, never one per approved applicant.
    await delay(250);
    expect(changes).toEqual([room.id]);
  });

  it('rejects every pending request without creating membership', async () => {
    const owner = await createTestUser('jrb_owner');
    const first = await createTestUser('jrb_first');
    const second = await createTestUser('jrb_second');
    const room = await createPrivateRoom(owner);
    await requestJoin(first, room.id);
    await requestJoin(second, room.id);

    const firstClient = await openClient(tokenFor(first));
    const secondClient = await openClient(tokenFor(second));
    const waiting = [firstClient, secondClient].map((client) =>
      nextNotification(client, 'join_rejected'),
    );

    const response = await decideAs(owner, room.id, [first.id, second.id], 'reject');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: 2 });
    const notifications = await Promise.all(waiting);
    for (const notification of notifications) {
      expect(notification).toMatchObject({
        type: 'join_rejected',
        roomId: room.id,
        actorName: 'jrb_owner',
        content: '你的加入申请被拒绝',
      });
    }

    for (const applicant of [first, second]) {
      expect(await isRoomMember(room.id, applicant.id)).toBe(false);
      expect(await requestStatus(room.id, applicant.id)).toBe('rejected');
      expect(await notificationsFor(applicant.id)).toEqual([
        { type: 'join_rejected', detail: '你的加入申请被拒绝' },
      ]);
    }

    const pending = await getAs(owner, `/api/rooms/${room.id}/requests`);
    expect(pending.status).toBe(200);
    expect(pending.body.requests).toEqual([]);
  });

  it('deduplicates ids so each request is decided and notified once', async () => {
    const owner = await createTestUser('jrb_owner');
    const first = await createTestUser('jrb_first');
    const second = await createTestUser('jrb_second');
    const room = await createPrivateRoom(owner);
    await requestJoin(first, room.id);
    await requestJoin(second, room.id);

    const response = await decideAs(
      owner,
      room.id,
      [first.id, second.id, first.id, first.id],
      'approve',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: 2 });
    expect(await isRoomMember(room.id, first.id)).toBe(true);
    expect(await isRoomMember(room.id, second.id)).toBe(true);
    expect(await notificationsFor(first.id)).toEqual([
      { type: 'join_approved', detail: '你的加入申请已通过' },
    ]);
    expect(await notificationsFor(second.id)).toEqual([
      { type: 'join_approved', detail: '你的加入申请已通过' },
    ]);
  });

  it('rolls the whole batch back when any request is missing', async () => {
    const owner = await createTestUser('jrb_owner');
    const applicant = await createTestUser('jrb_applicant');
    const otherOwner = await createTestUser('jrb_other_owner');
    const room = await createPrivateRoom(owner);
    const otherRoom = await createPrivateRoom(otherOwner);
    await requestJoin(applicant, room.id);
    await requestJoin(applicant, otherRoom.id);

    const response = await decideAs(owner, room.id, [applicant.id, 999999], 'approve');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('JOIN_REQUEST_NOT_FOUND');
    expect(await requestStatus(room.id, applicant.id)).toBe('pending');
    expect(await requestStatus(otherRoom.id, applicant.id)).toBe('pending');
    expect(await isRoomMember(room.id, applicant.id)).toBe(false);
    expect(await notificationsFor(applicant.id)).toEqual([]);
  });

  it('refuses a batch containing an already-handled request and changes nothing', async () => {
    const owner = await createTestUser('jrb_owner');
    const decided = await createTestUser('jrb_decided');
    const applicant = await createTestUser('jrb_applicant');
    const room = await createPrivateRoom(owner);
    await requestJoin(decided, room.id);
    await requestJoin(applicant, room.id);

    const first = await postAs(owner, `/api/rooms/${room.id}/requests/${decided.id}/reject`);
    expect(first.status).toBe(200);

    const approve = await decideAs(owner, room.id, [decided.id, applicant.id], 'approve');
    expect(approve.status).toBe(400);
    expect(approve.body.error.code).toBe('REQUEST_NOT_PENDING');

    const reject = await decideAs(owner, room.id, [decided.id, applicant.id], 'reject');
    expect(reject.status).toBe(400);
    expect(reject.body.error.code).toBe('REQUEST_NOT_PENDING');

    expect(await requestStatus(room.id, decided.id)).toBe('rejected');
    expect(await requestStatus(room.id, applicant.id)).toBe('pending');
    expect(await isRoomMember(room.id, applicant.id)).toBe(false);
    expect(await notificationsFor(applicant.id)).toEqual([]);
  });

  it('requires moderator rights and lets a room admin decide a batch', async () => {
    const owner = await createTestUser('jrb_owner');
    const roomAdmin = await createTestUser('jrb_admin');
    const outsider = await createTestUser('jrb_outsider');
    const first = await createTestUser('jrb_first');
    const second = await createTestUser('jrb_second');
    const room = await createPrivateRoom(owner);
    await joinRoomService(roomAdmin.id, room.id, room.inviteCode ?? undefined);
    await setMemberRole(room.id, owner.id, 'user', roomAdmin.id, 'admin');
    await requestJoin(first, room.id);
    await requestJoin(second, room.id);

    const forbidden = await decideAs(outsider, room.id, [first.id, second.id], 'approve');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('ROOM_OWNER_REQUIRED');
    expect(await isRoomMember(room.id, first.id)).toBe(false);
    expect(await requestStatus(room.id, first.id)).toBe('pending');

    const allowed = await decideAs(roomAdmin, room.id, [first.id, second.id], 'approve');
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ updated: 2 });
    expect(await isRoomMember(room.id, first.id)).toBe(true);
    expect(await isRoomMember(room.id, second.id)).toBe(true);
  });

  it('validates ids, the batch size and the action', async () => {
    const owner = await createTestUser('jrb_owner');
    const room = await createPrivateRoom(owner);
    const path = `/api/rooms/${room.id}/requests/bulk`;

    const empty = await postAs(owner, path, { userIds: [], action: 'approve' });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('INVALID_INPUT');

    const tooMany = await postAs(owner, path, {
      userIds: Array.from({ length: 101 }, (_, index) => index + 1),
      action: 'approve',
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('INVALID_INPUT');

    const badAction = await postAs(owner, path, { userIds: [1], action: 'maybe' });
    expect(badAction.status).toBe(400);
    expect(badAction.body.error.code).toBe('INVALID_INPUT');

    const badId = await postAs(owner, path, { userIds: ['abc'], action: 'approve' });
    expect(badId.status).toBe(400);
    expect(badId.body.error.code).toBe('INVALID_INPUT');
  });
});
