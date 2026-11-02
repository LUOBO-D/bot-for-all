import request from 'supertest';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNotification, markNotificationsRead } from '../src/services/notifications';
import { createRoom, joinRoom as joinRoomService } from '../src/services/room';
import type { AuthUser, NotificationDTO } from '../src/types';
import {
  connectClient,
  createTestUser,
  joinRoom,
  sendMessage,
  startTestServer,
  tokenFor,
  waitForEvent,
  type TestServer,
} from './helpers';

let server: TestServer;
/** Receives every seeded notification. */
let recipient: AuthUser;
let actor: AuthUser;
let roomId: number;
const sockets: Socket[] = [];

function listAs(query: Record<string, string | number> = {}) {
  return request(server.url)
    .get('/api/notifications')
    .query(query)
    .set('Authorization', `Bearer ${tokenFor(recipient)}`);
}

async function seed(type: string, options: { read?: boolean } = {}): Promise<NotificationDTO> {
  const notification = await createNotification({
    userId: recipient.id,
    type,
    roomId,
    actorId: actor.id,
    detail: `${type} 通知`,
  });
  if (options.read) {
    await markNotificationsRead(recipient.id, [notification.id]);
  }
  return notification;
}

async function openClient(user: AuthUser): Promise<Socket> {
  const socket = await connectClient(server.url, tokenFor(user));
  sockets.push(socket);
  return socket;
}

beforeAll(async () => {
  server = await startTestServer();
});

afterEach(() => {
  for (const socket of sockets) {
    socket.close();
  }
  sockets.length = 0;
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  recipient = await createTestUser('nf_recipient');
  actor = await createTestUser('nf_actor');
  const room = await createRoom(recipient.id, { name: 'filter-room' });
  roomId = room.id;
});

describe('notification list filters', () => {
  it('defaults to all and lists every type newest first', async () => {
    await seed('mention');
    await seed('join_request');
    await seed('join_approved');
    await seed('join_rejected');
    await seed('room_invite');

    const implicit = await listAs().expect(200);
    expect(implicit.body.total).toBe(5);
    expect(implicit.body.items.map((item: NotificationDTO) => item.type)).toEqual([
      'room_invite',
      'join_rejected',
      'join_approved',
      'join_request',
      'mention',
    ]);

    const explicit = await listAs({ filter: 'all' }).expect(200);
    expect(explicit.body).toEqual(implicit.body);
  });

  it('keeps only mention notifications for filter=mention', async () => {
    const first = await seed('mention');
    await seed('join_request');
    await seed('room_invite');
    const second = await seed('mention');

    const response = await listAs({ filter: 'mention' }).expect(200);
    expect(response.body.total).toBe(2);
    expect(response.body.items.map((item: NotificationDTO) => item.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(
      response.body.items.every((item: NotificationDTO) => item.type === 'mention'),
    ).toBe(true);
  });

  it('groups the three join types under filter=join', async () => {
    await seed('mention');
    const request = await seed('join_request');
    const approved = await seed('join_approved');
    const rejected = await seed('join_rejected');
    await seed('room_invite');

    const response = await listAs({ filter: 'join' }).expect(200);
    expect(response.body.total).toBe(3);
    expect(response.body.items.map((item: NotificationDTO) => item.id)).toEqual([
      rejected.id,
      approved.id,
      request.id,
    ]);
    expect(
      response.body.items.every((item: NotificationDTO) =>
        ['join_request', 'join_approved', 'join_rejected'].includes(item.type),
      ),
    ).toBe(true);
  });

  it('keeps only room_invite notifications for filter=invite', async () => {
    await seed('mention');
    await seed('join_request');
    const invite = await seed('room_invite');

    const response = await listAs({ filter: 'invite' }).expect(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({ id: invite.id, type: 'room_invite' });
  });

  it('reports unread across the whole account regardless of filter', async () => {
    await seed('mention', { read: true });
    await seed('mention');
    await seed('join_request');
    await seed('room_invite', { read: true });

    const all = await listAs({ filter: 'all' }).expect(200);
    expect(all.body).toMatchObject({ total: 4, unread: 2 });

    const mention = await listAs({ filter: 'mention' }).expect(200);
    expect(mention.body).toMatchObject({ total: 2, unread: 2 });

    const join = await listAs({ filter: 'join' }).expect(200);
    expect(join.body).toMatchObject({ total: 1, unread: 2 });

    const invite = await listAs({ filter: 'invite' }).expect(200);
    expect(invite.body).toMatchObject({ total: 1, unread: 2 });
  });

  it('counts only the filtered set while paginating', async () => {
    const mentions: NotificationDTO[] = [];
    for (let index = 0; index < 5; index += 1) {
      mentions.push(await seed('mention'));
    }
    await seed('room_invite');
    await seed('room_invite');

    const response = await listAs({ filter: 'mention', limit: 2, offset: 1 }).expect(200);
    expect(response.body.total).toBe(5);
    expect(response.body.items.map((item: NotificationDTO) => item.id)).toEqual([
      mentions[3]!.id,
      mentions[2]!.id,
    ]);

    const past = await listAs({ filter: 'mention', limit: 2, offset: 10 }).expect(200);
    expect(past.body.total).toBe(5);
    expect(past.body.items).toEqual([]);
  });

  it('rejects an unknown filter with 400 and accepts every known one', async () => {
    const invalid = await listAs({ filter: 'mentions' }).expect(400);
    expect(invalid.body.error.code).toBe('INVALID_INPUT');

    for (const filter of ['all', 'mention', 'join', 'invite']) {
      await listAs({ filter }).expect(200);
    }
  });

  it('lists a mention produced by the message pipeline under filter=mention', async () => {
    const owner = await createTestUser('nf_owner');
    const room = await createRoom(owner.id, { name: 'mention-room' });
    await joinRoomService(recipient.id, room.id);

    const ownerSocket = await openClient(owner);
    const recipientSocket = await openClient(recipient);
    await joinRoom(ownerSocket, room.id);

    const pushed = waitForEvent<{ notification: NotificationDTO }>(
      recipientSocket,
      'notification:new',
      (payload) => payload.notification.type === 'mention',
    );
    await sendMessage(ownerSocket, room.id, `@${recipient.username} hi`);
    const notification = (await pushed).notification;

    const mention = await listAs({ filter: 'mention' }).expect(200);
    expect(mention.body.total).toBe(1);
    expect(mention.body.items[0]).toMatchObject({
      id: notification.id,
      type: 'mention',
      roomId: room.id,
    });

    const invite = await listAs({ filter: 'invite' }).expect(200);
    expect(invite.body).toMatchObject({ total: 0, items: [], unread: 1 });
  });
});
