import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import { createBot } from '../src/services/bot';
import { deleteMessage } from '../src/services/message';
import { createNotification } from '../src/services/notifications';
import { createRoom, joinRoom as joinRoomService } from '../src/services/room';
import type { AuthUser, NotificationDTO } from '../src/types';
import {
  connectClient,
  createTestUser,
  delay,
  joinRoom,
  sendMessage,
  startTestServer,
  tokenFor,
  waitForEvent,
  type TestServer,
} from './helpers';

const NOTIFICATION_KEYS = [
  'id',
  'type',
  'roomId',
  'roomName',
  'messageId',
  'messageSeq',
  'actorName',
  'content',
  'createdAt',
  'readAt',
];

let server: TestServer;
const clients: Socket[] = [];

async function openClient(token: string): Promise<Socket> {
  const client = await connectClient(server.url, token);
  clients.push(client);
  return client;
}

function listAs(user: AuthUser, query: Record<string, string | number> = {}) {
  return request(server.url)
    .get('/api/notifications')
    .query(query)
    .set('Authorization', `Bearer ${tokenFor(user)}`);
}

function summaryAs(user: AuthUser) {
  return request(server.url)
    .get('/api/notifications/summary')
    .set('Authorization', `Bearer ${tokenFor(user)}`);
}

/** Seeds unread rows directly; the summary only cares about their room and type. */
async function seedUnread(
  userId: number,
  actorId: number,
  roomId: number,
  count = 1,
  type = 'mention',
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await createNotification({
      userId,
      type,
      roomId,
      actorId,
      detail: '',
    });
  }
}

/**
 * Seeds a message-backed notification directly. Search only needs the rows and
 * their join targets (message, actor, room), not the socket push that
 * `notifyMentions` exists to exercise.
 */
async function seedMessageNotification(
  userId: number,
  actorId: number,
  roomId: number,
  seq: number,
  content: string,
  deleted = false,
): Promise<number> {
  const [message] = await pool.execute<ResultSetHeader>(
    `INSERT INTO messages (room_id, seq, sender_id, sender_type, content, status, deleted_at)
     VALUES (?, ?, ?, 'user', ?, 'done', ?)`,
    [roomId, seq, actorId, content, deleted ? new Date() : null],
  );
  const [notification] = await pool.execute<ResultSetHeader>(
    `INSERT INTO notifications (user_id, type, room_id, message_id, actor_id)
     VALUES (?, 'mention', ?, ?, ?)`,
    [userId, roomId, message.insertId, actorId],
  );
  return notification.insertId;
}

function readAs(user: AuthUser, body: unknown) {
  return request(server.url)
    .post('/api/notifications/read')
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .send(body as object);
}

function deleteAs(user: AuthUser, id: number | string) {
  return request(server.url)
    .delete(`/api/notifications/${id}`)
    .set('Authorization', `Bearer ${tokenFor(user)}`);
}

function clearReadAs(user: AuthUser) {
  return request(server.url)
    .delete('/api/notifications/read')
    .set('Authorization', `Bearer ${tokenFor(user)}`);
}

function deleteManyAs(user: AuthUser, body: unknown) {
  return request(server.url)
    .post('/api/notifications/delete')
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .send(body as object);
}

function nextNotification(
  client: Socket,
  predicate: (notification: NotificationDTO) => boolean,
): Promise<NotificationDTO> {
  return waitForEvent<{ notification: NotificationDTO }>(
    client,
    'notification:new',
    (payload) => predicate(payload.notification),
  ).then((payload) => payload.notification);
}

async function countNotifications(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM notifications WHERE user_id = ?',
    [userId],
  );
  return Number(rows[0]?.total ?? 0);
}

interface Fixture {
  sender: AuthUser;
  member: AuthUser;
  roomId: number;
  clientSender: Socket;
  clientMember: Socket;
}

/** Sender owns a room, `member` joins it, both have a live socket. */
async function setupRoom(): Promise<Fixture> {
  const sender = await createTestUser('notif_sender');
  const member = await createTestUser('notif_member');
  const room = await createRoom(sender.id, { name: 'mention-room' });
  await joinRoomService(member.id, room.id);
  const clientSender = await openClient(tokenFor(sender));
  const clientMember = await openClient(tokenFor(member));
  await joinRoom(clientSender, room.id);
  return { sender, member, roomId: room.id, clientSender, clientMember };
}

beforeAll(async () => {
  server = await startTestServer();
});

afterEach(() => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
  config.rateLimitEnabled = false;
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  // The shared test setup truncates users/messages but not notifications, so
  // clear leftovers explicitly to keep per-file isolation.
  await pool.execute('DELETE FROM notifications');
});

describe('mention notifications', () => {
  it('notifies a mentioned member over the user socket and skips sender, non-members and bots', async () => {
    const sender = await createTestUser('notif_sender');
    const member = await createTestUser('notif_member');
    const outsider = await createTestUser('notif_outsider');
    const botMember = await createTestUser('notif_bot', 'user', 'bot');
    const room = await createRoom(sender.id, { name: 'mention-room' });
    await joinRoomService(member.id, room.id);
    await joinRoomService(botMember.id, room.id);

    const clientSender = await openClient(tokenFor(sender));
    // The member never joins a chat room: the push must reach `user:<id>`.
    const clientMember = await openClient(tokenFor(member));
    await joinRoom(clientSender, room.id);

    const waiting = nextNotification(clientMember, (notification) => notification.type === 'mention');
    const sent = await sendMessage(
      clientSender,
      room.id,
      '@notif_member @notif_sender @notif_outsider @notif_bot hi',
    );
    const notification = await waiting;

    expect(Object.keys(notification).sort()).toEqual([...NOTIFICATION_KEYS].sort());
    expect(notification).toMatchObject({
      type: 'mention',
      roomId: room.id,
      roomName: 'mention-room',
      messageSeq: sent.message?.seq,
      actorName: 'notif_sender',
      readAt: null,
    });
    expect(notification.messageId).toBeGreaterThan(0);
    expect(notification.content).toBe('@notif_member @notif_sender @notif_outsider @notif_bot hi');

    const memberList = await listAs(member);
    expect(memberList.status).toBe(200);
    expect(memberList.body.total).toBe(1);
    expect(memberList.body.unread).toBe(1);
    expect(memberList.body.items[0]).toMatchObject({ id: notification.id });

    const senderList = await listAs(sender);
    expect(senderList.status).toBe(200);
    expect(senderList.body.total).toBe(0);

    const outsiderList = await listAs(outsider);
    expect(outsiderList.status).toBe(200);
    expect(outsiderList.body.total).toBe(0);

    expect(await countNotifications(botMember.id)).toBe(0);
  });

  it('creates a single notification when the same user is mentioned repeatedly', async () => {
    const { sender, member, roomId, clientSender, clientMember } = await setupRoom();

    const waiting = nextNotification(clientMember, () => true);
    await sendMessage(clientSender, roomId, '@notif_member @notif_member @notif_member hello');
    await waiting;
    await delay(200);

    const list = await listAs(member);
    expect(list.body.total).toBe(1);
    expect(list.body.items).toHaveLength(1);
    expect(await countNotifications(member.id)).toBe(1);
    expect(await countNotifications(sender.id)).toBe(0);
  });

  it('lists newest first with pagination, truncation and deleted previews', async () => {
    const { sender, member, roomId, clientSender, clientMember } = await setupRoom();
    const longContent = `${'x'.repeat(200)} @notif_member`;
    const contents = ['first @notif_member', longContent, 'third @notif_member'];
    const seqs: number[] = [];

    for (const content of contents) {
      const waiting = nextNotification(clientMember, () => true);
      const sent = await sendMessage(clientSender, roomId, content);
      seqs.push(Number(sent.message?.seq));
      await waiting;
    }
    await deleteMessage(roomId, seqs[2], sender.id, false);

    const page1 = await listAs(member, { limit: 2, offset: 0 });
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(3);
    expect(page1.body.unread).toBe(3);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.items[0].messageSeq).toBe(seqs[2]);
    expect(page1.body.items[0].content).toBe('消息已撤回');
    expect(page1.body.items[1].messageSeq).toBe(seqs[1]);

    const truncated = page1.body.items[1].content as string;
    expect(Array.from(truncated)).toHaveLength(140);
    expect(truncated.startsWith('x'.repeat(139))).toBe(true);
    expect(truncated.endsWith('…')).toBe(true);

    const page2 = await listAs(member, { limit: 2, offset: 2 });
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].messageSeq).toBe(seqs[0]);
    expect(page2.body.items[0].content).toBe('first @notif_member');
    expect(page2.body.items[0].roomName).toBe('mention-room');
    expect(page2.body.items[0].actorName).toBe('notif_sender');
  });

  it('marks selected notifications read, then everything', async () => {
    const { member, roomId, clientSender, clientMember } = await setupRoom();
    for (const content of ['one @notif_member', 'two @notif_member', 'three @notif_member']) {
      const waiting = nextNotification(clientMember, () => true);
      await sendMessage(clientSender, roomId, content);
      await waiting;
    }

    const initial = await listAs(member);
    const ids = initial.body.items.map((item: NotificationDTO) => item.id) as number[];
    expect(ids).toHaveLength(3);

    const partial = await readAs(member, { ids: [ids[1]] });
    expect(partial.status).toBe(200);
    expect(partial.body).toEqual({ updated: 1, unread: 2 });

    const afterPartial = await listAs(member);
    expect(afterPartial.body.items.find((item: NotificationDTO) => item.id === ids[1]).readAt).not.toBeNull();
    expect(
      afterPartial.body.items.filter((item: NotificationDTO) => item.readAt === null),
    ).toHaveLength(2);

    const all = await readAs(member, {});
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ updated: 2, unread: 0 });

    const again = await readAs(member, {});
    expect(again.body).toEqual({ updated: 0, unread: 0 });

    const done = await listAs(member);
    expect(done.body.unread).toBe(0);
    expect(done.body.items.every((item: NotificationDTO) => item.readAt !== null)).toBe(true);
  });

  it('does not mark another user\'s notifications read', async () => {
    const owner = await createTestUser('notif_owner');
    const other = await createTestUser('notif_other');
    const room = await createRoom(owner.id, { name: 'mention-room' });
    await joinRoomService(other.id, room.id);
    const clientOwner = await openClient(tokenFor(owner));
    const clientOther = await openClient(tokenFor(other));

    const waiting = nextNotification(clientOwner, () => true);
    await sendMessage(clientOther, room.id, '@notif_owner ping');
    const notification = await waiting;

    const foreign = await readAs(other, { ids: [notification.id] });
    expect(foreign.status).toBe(200);
    expect(foreign.body).toEqual({ updated: 0, unread: 0 });

    const ownerList = await listAs(owner);
    expect(ownerList.body.unread).toBe(1);
    expect(ownerList.body.items[0].readAt).toBeNull();
    void clientOther;
  });

  it('creates a mention notification from a bot final message', async () => {
    const provider = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '@notif_member 你好' } }] })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const listening = Promise.withResolvers<void>();
    provider.listen(0, listening.resolve);
    await listening.promise;
    const port = (provider.address() as AddressInfo).port;

    try {
      const owner = await createTestUser('notif_bot_owner');
      const member = await createTestUser('notif_member');
      const room = await createRoom(owner.id, { name: 'bot-room' });
      await joinRoomService(member.id, room.id);
      const bot = await createBot({
        actor: owner,
        scope: 'room',
        roomId: room.id,
        name: 'notif-testbot',
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'test-key',
        model: 'fake',
        triggerMode: 'mention',
      });
      const clientOwner = await openClient(tokenFor(owner));
      const clientMember = await openClient(tokenFor(member));
      await joinRoom(clientOwner, room.id);

      const waiting = waitForEvent<{ notification: NotificationDTO }>(
        clientMember,
        'notification:new',
        (payload) => payload.notification.actorName === 'notif-testbot',
        10000,
      ).then((payload) => payload.notification);

      await sendMessage(clientOwner, room.id, `@${bot.username} 请回复`);
      const notification = await waiting;

      expect(notification).toMatchObject({
        type: 'mention',
        roomId: room.id,
        roomName: 'bot-room',
        actorName: 'notif-testbot',
        content: '@notif_member 你好',
        readAt: null,
      });

      const memberList = await listAs(member);
      expect(memberList.body.total).toBe(1);
      expect(memberList.body.items[0].content).toBe('@notif_member 你好');
    } finally {
      provider.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      provider.close(() => closed.resolve());
      await closed.promise;
    }
  });

  it('requires authentication', async () => {
    const list = await request(server.url).get('/api/notifications');
    expect(list.status).toBe(401);
    expect(list.body.error.code).toBe('UNAUTHORIZED');

    const read = await request(server.url).post('/api/notifications/read').send({});
    expect(read.status).toBe(401);
  });

  it('validates query and body bounds', async () => {
    const user = await createTestUser('notif_bounds');

    expect((await listAs(user, { limit: 0 })).status).toBe(400);
    expect((await listAs(user, { limit: 51 })).status).toBe(400);
    expect((await listAs(user, { offset: -1 })).status).toBe(400);
    expect((await readAs(user, { ids: [0] })).status).toBe(400);
    expect((await readAs(user, { ids: ['x'] })).status).toBe(400);
    expect(
      (await readAs(user, { ids: Array.from({ length: 101 }, (_value, index) => index + 1) }))
        .status,
    ).toBe(400);

    const empty = await readAs(user, {});
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ updated: 0, unread: 0 });
  });
});

describe('notification summary', () => {
  it('groups unread notifications by room, busiest room first', async () => {
    const sender = await createTestUser('notif_sum_sender');
    const member = await createTestUser('notif_sum_member');
    const quiet = await createRoom(sender.id, { name: 'summary-quiet' });
    const busy = await createRoom(sender.id, { name: 'summary-busy' });
    const newest = await createRoom(sender.id, { name: 'summary-newest' });

    await seedUnread(member.id, sender.id, quiet.id);
    await seedUnread(member.id, sender.id, busy.id, 2);
    await seedUnread(member.id, sender.id, newest.id, 2);

    const summary = await summaryAs(member);
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual({
      unread: 5,
      types: { mention: 5, join: 0, invite: 0 },
      rooms: [
        // Equal counts rank by the newer room id.
        { roomId: newest.id, roomName: 'summary-newest', count: 2 },
        { roomId: busy.id, roomName: 'summary-busy', count: 2 },
        { roomId: quiet.id, roomName: 'summary-quiet', count: 1 },
      ],
    });
  });

  it('excludes read rows and empties the strip once everything is read', async () => {
    const sender = await createTestUser('notif_sum_read_sender');
    const member = await createTestUser('notif_sum_read_member');
    const first = await createRoom(sender.id, { name: 'summary-read-a' });
    const second = await createRoom(sender.id, { name: 'summary-read-b' });
    await seedUnread(member.id, sender.id, first.id, 2);
    await seedUnread(member.id, sender.id, second.id);

    const list = await listAs(member);
    const target = (list.body.items as NotificationDTO[]).find(
      (item) => item.roomId === first.id,
    );
    expect(target).toBeDefined();
    await readAs(member, { ids: [target!.id] });

    const partial = await summaryAs(member);
    expect(partial.body).toEqual({
      unread: 2,
      types: { mention: 2, join: 0, invite: 0 },
      rooms: [
        { roomId: second.id, roomName: 'summary-read-b', count: 1 },
        { roomId: first.id, roomName: 'summary-read-a', count: 1 },
      ],
    });

    await readAs(member, {});
    const cleared = await summaryAs(member);
    expect(cleared.body).toEqual({
      unread: 0,
      types: { mention: 0, join: 0, invite: 0 },
      rooms: [],
    });
  });

  it("never counts another account's unread notifications", async () => {
    const sender = await createTestUser('notif_sum_iso_sender');
    const owner = await createTestUser('notif_sum_iso_owner');
    const other = await createTestUser('notif_sum_iso_other');
    const ownerRoom = await createRoom(sender.id, { name: 'summary-owner' });
    const otherRoom = await createRoom(sender.id, { name: 'summary-other' });

    await seedUnread(owner.id, sender.id, ownerRoom.id, 2);
    await seedUnread(other.id, sender.id, otherRoom.id);

    const ownerSummary = await summaryAs(owner);
    expect(ownerSummary.body).toEqual({
      unread: 2,
      types: { mention: 2, join: 0, invite: 0 },
      rooms: [{ roomId: ownerRoom.id, roomName: 'summary-owner', count: 2 }],
    });

    const otherSummary = await summaryAs(other);
    expect(otherSummary.body).toEqual({
      unread: 1,
      types: { mention: 1, join: 0, invite: 0 },
      rooms: [{ roomId: otherRoom.id, roomName: 'summary-other', count: 1 }],
    });
  });

  it('caps the strip at ten rooms while keeping the account-wide unread total', async () => {
    const sender = await createTestUser('notif_sum_limit_sender');
    const member = await createTestUser('notif_sum_limit_member');
    const rooms = [];
    for (let index = 0; index < 12; index += 1) {
      rooms.push(await createRoom(sender.id, { name: `summary-limit-${index}` }));
    }
    for (const room of rooms) {
      await seedUnread(member.id, sender.id, room.id);
    }
    // The newest room gets one extra unread, so it must lead the strip.
    await seedUnread(member.id, sender.id, rooms[11].id);

    const summary = await summaryAs(member);
    expect(summary.status).toBe(200);
    expect(summary.body.unread).toBe(13);
    expect(summary.body.types).toEqual({ mention: 13, join: 0, invite: 0 });
    expect(summary.body.rooms).toHaveLength(10);
    expect(summary.body.rooms[0]).toEqual({
      roomId: rooms[11].id,
      roomName: 'summary-limit-11',
      count: 2,
    });
    // The remaining nine are the highest room ids, newest first.
    expect(
      (summary.body.rooms as { roomId: number }[]).slice(1).map((room) => room.roomId),
    ).toEqual(
      rooms
        .slice(2, 11)
        .map((room) => room.id)
        .reverse(),
    );
  });

  it('counts unread rows per chip, folding the three join types into join', async () => {
    const sender = await createTestUser('notif_sum_types_sender');
    const member = await createTestUser('notif_sum_types_member');
    const room = await createRoom(sender.id, { name: 'summary-types' });
    const inviteRoom = await createRoom(sender.id, { name: 'summary-types-invite' });

    await seedUnread(member.id, sender.id, room.id, 2, 'mention');
    await seedUnread(member.id, sender.id, room.id, 1, 'join_request');
    await seedUnread(member.id, sender.id, room.id, 2, 'join_approved');
    await seedUnread(member.id, sender.id, room.id, 1, 'join_rejected');
    // room_invite is idempotent per (recipient, room), hence its own room.
    await seedUnread(member.id, sender.id, inviteRoom.id, 1, 'room_invite');

    const summary = await summaryAs(member);
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual({
      unread: 7,
      types: { mention: 2, join: 4, invite: 1 },
      rooms: [
        { roomId: room.id, roomName: 'summary-types', count: 6 },
        { roomId: inviteRoom.id, roomName: 'summary-types-invite', count: 1 },
      ],
    });
  });

  it('drops read rows from the per-chip counts as well', async () => {
    const sender = await createTestUser('notif_sum_types_read_sender');
    const member = await createTestUser('notif_sum_types_read_member');
    const room = await createRoom(sender.id, { name: 'summary-types-read' });

    await seedUnread(member.id, sender.id, room.id, 2, 'mention');
    await seedUnread(member.id, sender.id, room.id, 1, 'join_request');

    const list = await listAs(member);
    const mention = (list.body.items as NotificationDTO[]).find(
      (item) => item.type === 'mention',
    );
    expect(mention).toBeDefined();
    await readAs(member, { ids: [mention!.id] });

    const summary = await summaryAs(member);
    expect(summary.body.unread).toBe(2);
    expect(summary.body.types).toEqual({ mention: 1, join: 1, invite: 0 });
  });

  it('counts unread rows of unknown types in unread but in no chip bucket', async () => {
    const sender = await createTestUser('notif_sum_types_other_sender');
    const member = await createTestUser('notif_sum_types_other_member');
    const room = await createRoom(sender.id, { name: 'summary-types-other' });

    await seedUnread(member.id, sender.id, room.id, 2, 'system_announcement');
    await seedUnread(member.id, sender.id, room.id, 1, 'mention');

    const summary = await summaryAs(member);
    expect(summary.body.unread).toBe(3);
    expect(summary.body.types).toEqual({ mention: 1, join: 0, invite: 0 });
    // Unknown types still belong to their room's unread count.
    expect(summary.body.rooms).toEqual([
      { roomId: room.id, roomName: 'summary-types-other', count: 3 },
    ]);
  });

  it('requires authentication', async () => {
    const summary = await request(server.url).get('/api/notifications/summary');
    expect(summary.status).toBe(401);
    expect(summary.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('notification deletion', () => {
  it('deletes one own notification and reports the remaining unread count', async () => {
    const { member, roomId, clientSender, clientMember } = await setupRoom();
    for (const content of ['one @notif_member', 'two @notif_member']) {
      const waiting = nextNotification(clientMember, () => true);
      await sendMessage(clientSender, roomId, content);
      await waiting;
    }

    const list = await listAs(member);
    const items = list.body.items as NotificationDTO[];
    expect(list.body.unread).toBe(2);
    const [newest, older] = items;

    const removed = await deleteAs(member, newest.id);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ deleted: 1, unread: 1 });

    expect(await countNotifications(member.id)).toBe(1);
    const after = await listAs(member);
    expect(after.body.total).toBe(1);
    expect(after.body.unread).toBe(1);
    expect(after.body.items.map((item: NotificationDTO) => item.id)).toEqual([older.id]);

    // A row that is already gone and an id that never existed answer alike.
    const again = await deleteAs(member, newest.id);
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('NOTIFICATION_NOT_FOUND');

    const missing = await deleteAs(member, 999_999_999);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOTIFICATION_NOT_FOUND');

    const invalid = await deleteAs(member, 'abc');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_INPUT');
  });

  it("does not delete another user's notification", async () => {
    const owner = await createTestUser('notif_del_owner');
    const other = await createTestUser('notif_del_other');
    const room = await createRoom(owner.id, { name: 'mention-room' });
    await joinRoomService(other.id, room.id);
    const clientOwner = await openClient(tokenFor(owner));
    const clientOther = await openClient(tokenFor(other));

    const waiting = nextNotification(clientOwner, () => true);
    await sendMessage(clientOther, room.id, '@notif_del_owner ping');
    const notification = await waiting;

    const foreign = await deleteAs(other, notification.id);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('NOTIFICATION_NOT_FOUND');

    expect(await countNotifications(owner.id)).toBe(1);
    const ownerList = await listAs(owner);
    expect(ownerList.body.total).toBe(1);
    expect(ownerList.body.items[0].id).toBe(notification.id);
    expect(ownerList.body.unread).toBe(1);
  });

  it('clears only read notifications and keeps unread ones', async () => {
    const { member, roomId, clientSender, clientMember } = await setupRoom();
    for (const content of ['one @notif_member', 'two @notif_member', 'three @notif_member']) {
      const waiting = nextNotification(clientMember, () => true);
      await sendMessage(clientSender, roomId, content);
      await waiting;
    }

    const list = await listAs(member);
    const ids = (list.body.items as NotificationDTO[]).map((item) => item.id);
    expect(ids).toHaveLength(3);

    const marked = await readAs(member, { ids: [ids[0], ids[1]] });
    expect(marked.body).toEqual({ updated: 2, unread: 1 });

    const cleared = await clearReadAs(member);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ deleted: 2, unread: 1 });

    expect(await countNotifications(member.id)).toBe(1);
    const after = await listAs(member);
    expect(after.body.total).toBe(1);
    expect(after.body.unread).toBe(1);
    expect(after.body.items[0].id).toBe(ids[2]);
    expect(after.body.items[0].readAt).toBeNull();

    const again = await clearReadAs(member);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ deleted: 0, unread: 1 });
  });

  it("leaves another user's read notifications untouched when clearing", async () => {
    const owner = await createTestUser('notif_clear_owner');
    const other = await createTestUser('notif_clear_other');
    const room = await createRoom(owner.id, { name: 'mention-room' });
    await joinRoomService(other.id, room.id);
    const clientOwner = await openClient(tokenFor(owner));
    const clientOther = await openClient(tokenFor(other));

    const waitingOther = nextNotification(clientOther, () => true);
    await sendMessage(clientOwner, room.id, '@notif_clear_other ping');
    const otherNotification = await waitingOther;

    const waitingOwner = nextNotification(clientOwner, () => true);
    await sendMessage(clientOther, room.id, '@notif_clear_owner pong');
    const ownerNotification = await waitingOwner;

    expect((await readAs(owner, { ids: [ownerNotification.id] })).body).toEqual({
      updated: 1,
      unread: 0,
    });
    expect((await readAs(other, { ids: [otherNotification.id] })).body).toEqual({
      updated: 1,
      unread: 0,
    });

    const cleared = await clearReadAs(owner);
    expect(cleared.body).toEqual({ deleted: 1, unread: 0 });

    expect(await countNotifications(owner.id)).toBe(0);
    expect(await countNotifications(other.id)).toBe(1);
    const otherList = await listAs(other);
    expect(otherList.body.items[0].id).toBe(otherNotification.id);
    expect(otherList.body.items[0].readAt).not.toBeNull();
  });

  it('requires authentication', async () => {
    const remove = await request(server.url).delete('/api/notifications/1');
    expect(remove.status).toBe(401);
    expect(remove.body.error.code).toBe('UNAUTHORIZED');

    const clear = await request(server.url).delete('/api/notifications/read');
    expect(clear.status).toBe(401);
    expect(clear.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('bulk notification deletion', () => {
  it('deletes selected own notifications, collapses duplicate ids and reports counts', async () => {
    const { member, roomId, clientSender, clientMember } = await setupRoom();
    for (const content of ['one @notif_member', 'two @notif_member', 'three @notif_member']) {
      const waiting = nextNotification(clientMember, () => true);
      await sendMessage(clientSender, roomId, content);
      await waiting;
    }

    const list = await listAs(member);
    const ids = (list.body.items as NotificationDTO[]).map((item) => item.id);
    expect(ids).toHaveLength(3);

    // The duplicate is deleted once, not counted twice.
    const removed = await deleteManyAs(member, { ids: [ids[0], ids[1], ids[1]] });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ deleted: 2, unread: 1, total: 1 });

    expect(await countNotifications(member.id)).toBe(1);
    const after = await listAs(member);
    expect(after.body.total).toBe(1);
    expect(after.body.unread).toBe(1);
    expect(after.body.items.map((item: NotificationDTO) => item.id)).toEqual([ids[2]]);

    // Replaying the same batch is a no-op, not an error: the rows are gone.
    const again = await deleteManyAs(member, { ids: [ids[0], ids[1]] });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ deleted: 0, unread: 1, total: 1 });
  });

  it("ignores ids that belong to another account or do not exist", async () => {
    const { sender, member, roomId, clientSender, clientMember } = await setupRoom();
    const other = await createTestUser('notif_bulk_other');
    const waiting = nextNotification(clientMember, () => true);
    await sendMessage(clientSender, roomId, 'keep @notif_member');
    const own = await waiting;
    const foreign = await createNotification({
      userId: other.id,
      type: 'mention',
      roomId,
      actorId: sender.id,
      detail: 'foreign',
    });

    const removed = await deleteManyAs(member, {
      ids: [own.id, foreign.id, 999_999_999],
    });
    expect(removed.status).toBe(200);
    // One of the three ids was the caller's; the rest are silently skipped.
    expect(removed.body).toEqual({ deleted: 1, unread: 0, total: 0 });

    expect(await countNotifications(member.id)).toBe(0);
    expect(await countNotifications(other.id)).toBe(1);
    const otherList = await listAs(other);
    expect(otherList.body.total).toBe(1);
    expect(otherList.body.items[0].id).toBe(foreign.id);
  });

  it('accepts exactly 100 ids and rejects an empty or oversized batch', async () => {
    const member = await createTestUser('notif_bulk_bounds');

    const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
    const boundary = await deleteManyAs(member, { ids: hundred });
    expect(boundary.status).toBe(200);
    // None of them exist: the batch succeeds and deletes nothing.
    expect(boundary.body).toEqual({ deleted: 0, unread: 0, total: 0 });

    const empty = await deleteManyAs(member, { ids: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('INVALID_INPUT');

    const oversized = await deleteManyAs(member, {
      ids: Array.from({ length: 101 }, (_, index) => index + 1),
    });
    expect(oversized.status).toBe(400);
    expect(oversized.body.error.code).toBe('INVALID_INPUT');

    const fractional = await deleteManyAs(member, { ids: [1.5] });
    expect(fractional.status).toBe(400);
    expect(fractional.body.error.code).toBe('INVALID_INPUT');

    const nonPositive = await deleteManyAs(member, { ids: [0] });
    expect(nonPositive.status).toBe(400);
    expect(nonPositive.body.error.code).toBe('INVALID_INPUT');

    const missing = await deleteManyAs(member, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_INPUT');
  });

  it('requires authentication', async () => {
    const unauthenticated = await request(server.url)
      .post('/api/notifications/delete')
      .send({ ids: [1] });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('notification search', () => {
  it('matches detail, message content, actor and room name; a blank q does not filter', async () => {
    const recipient = await createTestUser('notif_search_recipient');
    const owner = await createTestUser('notif_search_owner');
    const alphaActor = await createTestUser('searchactoralpha');
    const betaActor = await createTestUser('searchactorbeta');
    const alphaRoom = await createRoom(owner.id, { name: 'search-alpha-room' });
    const betaRoom = await createRoom(owner.id, { name: 'search-beta-room' });
    await joinRoomService(recipient.id, alphaRoom.id);

    const invite = await createNotification({
      userId: recipient.id,
      type: 'room_invite',
      roomId: alphaRoom.id,
      actorId: alphaActor.id,
      detail: 'invite-note 欢迎加入',
    });
    const request = await createNotification({
      userId: recipient.id,
      type: 'join_request',
      roomId: betaRoom.id,
      actorId: betaActor.id,
      detail: 'request-note 想加入',
    });
    const mentionId = await seedMessageNotification(
      recipient.id,
      betaActor.id,
      alphaRoom.id,
      1,
      'mention-body 你好',
    );
    const deletedId = await seedMessageNotification(
      recipient.id,
      betaActor.id,
      alphaRoom.id,
      2,
      'deleted-body secret',
      true,
    );

    const byDetail = await listAs(recipient, { q: 'invite-note' });
    expect(byDetail.status).toBe(200);
    expect(byDetail.body.total).toBe(1);
    expect(byDetail.body.items[0]).toMatchObject({ id: invite.id, type: 'room_invite' });

    const byContent = await listAs(recipient, { q: 'mention-body' });
    expect(byContent.status).toBe(200);
    expect(byContent.body.total).toBe(1);
    expect(byContent.body.items[0]).toMatchObject({
      id: mentionId,
      type: 'mention',
      content: 'mention-body 你好',
    });

    const byActor = await listAs(recipient, { q: 'searchactoralpha' });
    expect(byActor.body.total).toBe(1);
    expect(byActor.body.items[0].id).toBe(invite.id);

    const byRoom = await listAs(recipient, { q: 'search-beta-room' });
    expect(byRoom.body.total).toBe(1);
    expect(byRoom.body.items[0].id).toBe(request.id);

    // Deleted bodies match neither their text nor their preview: the row still
    // lists as 消息已撤回, so a content hit would have no visible explanation.
    expect((await listAs(recipient, { q: 'deleted-body' })).body.total).toBe(0);

    const unfiltered = await listAs(recipient, { limit: 50 });
    expect(unfiltered.body.total).toBe(4);
    expect(
      (unfiltered.body.items as NotificationDTO[]).map((item) => item.id),
    ).toEqual(expect.arrayContaining([invite.id, request.id, mentionId, deletedId]));

    // Absent, empty and whitespace-only q all mean "no search".
    expect((await listAs(recipient, { limit: 50, q: '' })).body).toEqual(unfiltered.body);
    expect((await listAs(recipient, { limit: 50, q: '   ' })).body).toEqual(unfiltered.body);
  });

  it('escapes LIKE metacharacters in q', async () => {
    const recipient = await createTestUser('notif_escape_recipient');
    const owner = await createTestUser('notif_escape_owner');
    const actor = await createTestUser('notifescapeactor');
    const room = await createRoom(owner.id, { name: 'escape-room' });

    const percent = await createNotification({
      userId: recipient.id,
      type: 'join_request',
      roomId: room.id,
      actorId: actor.id,
      detail: '进度 100% 完成',
    });
    const underscore = await createNotification({
      userId: recipient.id,
      type: 'join_approved',
      roomId: room.id,
      actorId: actor.id,
      detail: 'file_plan_v2',
    });
    // `_` would match the X here if it were still a wildcard.
    await createNotification({
      userId: recipient.id,
      type: 'join_rejected',
      roomId: room.id,
      actorId: actor.id,
      detail: 'fileXplanXv2',
    });
    const backslash = await createNotification({
      userId: recipient.id,
      type: 'room_invite',
      roomId: room.id,
      actorId: actor.id,
      detail: 'C:\\temp\\notice',
    });

    const literalPercent = await listAs(recipient, { q: '100%' });
    expect(literalPercent.body.total).toBe(1);
    expect(literalPercent.body.items[0].id).toBe(percent.id);

    // A bare `%` would match every row if it were not escaped.
    const percentOnly = await listAs(recipient, { q: '%' });
    expect(percentOnly.body.total).toBe(1);
    expect(percentOnly.body.items[0].id).toBe(percent.id);

    const literalUnderscore = await listAs(recipient, { q: 'file_plan' });
    expect(literalUnderscore.body.total).toBe(1);
    expect(literalUnderscore.body.items[0].id).toBe(underscore.id);

    const literalBackslash = await listAs(recipient, { q: 'C:\\temp' });
    expect(literalBackslash.body.total).toBe(1);
    expect(literalBackslash.body.items[0].id).toBe(backslash.id);

    const singleBackslash = await listAs(recipient, { q: '\\' });
    expect(singleBackslash.body.total).toBe(1);
    expect(singleBackslash.body.items[0].id).toBe(backslash.id);
  });

  it('combines q with the type filter and paginates the matched total', async () => {
    const recipient = await createTestUser('notif_combo_recipient');
    const owner = await createTestUser('notif_combo_owner');
    const actor = await createTestUser('notifcomboactor');
    const alphaRoom = await createRoom(owner.id, { name: 'alpha-hub' });
    const betaRoom = await createRoom(owner.id, { name: 'beta-hub' });

    const invite = await createNotification({
      userId: recipient.id,
      type: 'room_invite',
      roomId: alphaRoom.id,
      actorId: actor.id,
      detail: 'alpha invite',
    });
    const joinOne = await createNotification({
      userId: recipient.id,
      type: 'join_request',
      roomId: alphaRoom.id,
      actorId: actor.id,
      detail: 'alpha request one',
    });
    const joinTwo = await createNotification({
      userId: recipient.id,
      type: 'join_approved',
      roomId: alphaRoom.id,
      actorId: actor.id,
      detail: 'alpha approved two',
    });
    await createNotification({
      userId: recipient.id,
      type: 'join_request',
      roomId: betaRoom.id,
      actorId: actor.id,
      detail: 'beta request',
    });

    const page1 = await listAs(recipient, { q: 'alpha', limit: 2, offset: 0 });
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(3);
    // unread never narrows with the query or the chip.
    expect(page1.body.unread).toBe(4);
    expect((page1.body.items as NotificationDTO[]).map((item) => item.id)).toEqual([
      joinTwo.id,
      joinOne.id,
    ]);

    const page2 = await listAs(recipient, { q: 'alpha', limit: 2, offset: 2 });
    expect(page2.body.total).toBe(3);
    expect((page2.body.items as NotificationDTO[]).map((item) => item.id)).toEqual([
      invite.id,
    ]);

    const invitesOnly = await listAs(recipient, { q: 'alpha', filter: 'invite' });
    expect(invitesOnly.body.total).toBe(1);
    expect(invitesOnly.body.items[0].id).toBe(invite.id);
    expect(invitesOnly.body.unread).toBe(4);

    const mentionsOnly = await listAs(recipient, { q: 'alpha', filter: 'mention' });
    expect(mentionsOnly.body.total).toBe(0);
    expect(mentionsOnly.body.unread).toBe(4);
  });

  it('isolates q results by account and enforces the 100-character bound', async () => {
    const recipient = await createTestUser('notif_search_scope_a');
    const outsider = await createTestUser('notif_search_scope_b');
    const actor = await createTestUser('notifsearchsharedactor');
    const room = await createRoom(actor.id, { name: 'isolation-room' });

    await createNotification({
      userId: recipient.id,
      type: 'join_request',
      roomId: room.id,
      actorId: actor.id,
      detail: 'shared-token mine',
    });
    await createNotification({
      userId: outsider.id,
      type: 'join_request',
      roomId: room.id,
      actorId: actor.id,
      detail: 'shared-token theirs',
    });

    const mine = await listAs(recipient, { q: 'shared-token' });
    expect(mine.body.total).toBe(1);
    expect(mine.body.items[0].content).toBe('shared-token mine');

    expect((await listAs(recipient, { q: 'theirs' })).body.total).toBe(0);

    const theirs = await listAs(outsider, { q: 'shared-token' });
    expect(theirs.body.total).toBe(1);
    expect(theirs.body.items[0].content).toBe('shared-token theirs');

    const tooLong = await listAs(recipient, { q: 'x'.repeat(101) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('INVALID_INPUT');

    const boundary = await listAs(recipient, { q: 'x'.repeat(100) });
    expect(boundary.status).toBe(200);
    expect(boundary.body.total).toBe(0);
  });
});

describe('notification CSV export', () => {
  const EXPORT_HEADER = [
    'id',
    'type',
    'roomName',
    'actorName',
    'content',
    'createdAt',
    'readAt',
  ];

  function exportAs(user: AuthUser, query: Record<string, string | number> = {}) {
    return request(server.url)
      .get('/api/notifications/export')
      .query(query)
      .set('Authorization', `Bearer ${tokenFor(user)}`);
  }

  /** Minimal RFC 4180 reader: quoted cells, doubled quotes, CRLF or LF. */
  function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    const endField = (): void => {
      row.push(field);
      field = '';
    };
    const endRow = (): void => {
      endField();
      // A trailing terminator must not produce a phantom record.
      if (row.length > 1 || row[0] !== '') {
        rows.push(row);
      }
      row = [];
    };
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (char === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            quoted = false;
          }
        } else {
          field += char;
        }
        continue;
      }
      if (char === '"') {
        quoted = true;
      } else if (char === ',') {
        endField();
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && text[index + 1] === '\n') {
          index += 1;
        }
        endRow();
      } else {
        field += char;
      }
    }
    if (field !== '' || row.length > 0) {
      endRow();
    }
    return rows;
  }

  function toObjects(text: string): Record<string, string>[] {
    const rows = parseCsv(text);
    expect(rows[0]).toEqual(EXPORT_HEADER);
    return rows.slice(1).map((cells) => {
      expect(cells).toHaveLength(EXPORT_HEADER.length);
      return Object.fromEntries(EXPORT_HEADER.map((name, index) => [name, cells[index]]));
    });
  }

  /** Bulk-seeds `count` plain join notifications for the cap test. */
  async function seedBulkNotifications(
    userId: number,
    actorId: number,
    roomId: number,
    count: number,
  ): Promise<{ minId: number; maxId: number }> {
    const batchSize = 500;
    for (let start = 0; start < count; start += batchSize) {
      const size = Math.min(batchSize, count - start);
      const values: unknown[][] = [];
      for (let offset = 0; offset < size; offset += 1) {
        const seq = start + offset + 1;
        values.push([userId, 'join_request', roomId, actorId, `bulk notice ${seq}`]);
      }
      await pool.query(
        `INSERT INTO notifications (user_id, type, room_id, actor_id, detail)
         VALUES ?`,
        [values],
      );
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM notifications WHERE user_id = ?',
      [userId],
    );
    return { minId: Number(rows[0]?.min_id), maxId: Number(rows[0]?.max_id) };
  }

  it('exports the same rows as the list with the documented CSV header', async () => {
    const recipient = await createTestUser('notif_export_recipient');
    const owner = await createTestUser('notif_export_owner');
    const actor = await createTestUser('notif_export_actor');
    const room = await createRoom(owner.id, { name: 'export-room' });
    // Membership is what makes a message-backed row readable: without it the
    // export must blank the content, exactly like the list.
    await joinRoomService(recipient.id, room.id);

    const invite = await createNotification({
      userId: recipient.id,
      type: 'room_invite',
      roomId: room.id,
      actorId: actor.id,
      detail: 'invite note',
    });
    const join = await createNotification({
      userId: recipient.id,
      type: 'join_request',
      roomId: room.id,
      actorId: actor.id,
      detail: 'join note',
    });
    const mentionId = await seedMessageNotification(
      recipient.id,
      actor.id,
      room.id,
      1,
      'mention body',
    );
    const deletedId = await seedMessageNotification(
      recipient.id,
      actor.id,
      room.id,
      2,
      'deleted body',
      true,
    );
    await pool.execute('UPDATE notifications SET read_at = NOW() WHERE id = ?', [join.id]);

    const response = await exportAs(recipient);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="notifications.csv"',
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-notifications-truncated']).toBeUndefined();

    const rows = toObjects(response.text);
    expect(rows.map((row) => Number(row.id))).toEqual([
      deletedId,
      mentionId,
      join.id,
      invite.id,
    ]);
    expect(rows[0]).toMatchObject({
      type: 'mention',
      roomName: 'export-room',
      actorName: 'notif_export_actor',
      content: '消息已撤回',
      readAt: '',
    });
    expect(rows[1].content).toBe('mention body');
    expect(rows[2]).toMatchObject({ type: 'join_request', content: 'join note' });
    expect(rows[2].readAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(rows[3]).toMatchObject({
      type: 'room_invite',
      content: 'invite note',
      readAt: '',
    });
    for (const row of rows) {
      expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }

    // Row identity and order must match the list endpoint the panel renders.
    const list = await listAs(recipient, { limit: 50 });
    expect(rows.map((row) => Number(row.id))).toEqual(
      (list.body.items as NotificationDTO[]).map((item) => item.id),
    );
  });

  it('applies the filter chip and q exactly like the list', async () => {
    const recipient = await createTestUser('notif_export_combo_recipient');
    const owner = await createTestUser('notif_export_combo_owner');
    const actor = await createTestUser('notifexportcomboactor');
    const alphaRoom = await createRoom(owner.id, { name: 'alpha-hub' });
    const betaRoom = await createRoom(owner.id, { name: 'beta-hub' });

    const invite = await createNotification({
      userId: recipient.id,
      type: 'room_invite',
      roomId: alphaRoom.id,
      actorId: actor.id,
      detail: 'alpha invite',
    });
    const joinOne = await createNotification({
      userId: recipient.id,
      type: 'join_request',
      roomId: alphaRoom.id,
      actorId: actor.id,
      detail: 'alpha request one',
    });
    const joinTwo = await createNotification({
      userId: recipient.id,
      type: 'join_approved',
      roomId: alphaRoom.id,
      actorId: actor.id,
      detail: 'alpha approved two',
    });
    const betaJoin = await createNotification({
      userId: recipient.id,
      type: 'join_request',
      roomId: betaRoom.id,
      actorId: actor.id,
      detail: 'beta request',
    });

    const all = await exportAs(recipient, { q: 'alpha' });
    expect(all.status).toBe(200);
    expect(toObjects(all.text).map((row) => Number(row.id))).toEqual([
      joinTwo.id,
      joinOne.id,
      invite.id,
    ]);

    const invites = await exportAs(recipient, { filter: 'invite', q: 'alpha' });
    expect(toObjects(invites.text).map((row) => Number(row.id))).toEqual([invite.id]);

    const joins = await exportAs(recipient, { filter: 'join', q: 'alpha' });
    expect(toObjects(joins.text).map((row) => Number(row.id))).toEqual([
      joinTwo.id,
      joinOne.id,
    ]);

    const mentions = await exportAs(recipient, { filter: 'mention', q: 'alpha' });
    expect(mentions.status).toBe(200);
    expect(mentions.text).toBe(`${EXPORT_HEADER.join(',')}\r\n`);

    // Absent, empty and whitespace-only q all mean "no search", exactly as the
    // list treats them.
    const blank = await exportAs(recipient, { q: '   ' });
    const blankIds = toObjects(blank.text).map((row) => Number(row.id));
    expect(blankIds).toEqual([betaJoin.id, joinTwo.id, joinOne.id, invite.id]);
    const list = await listAs(recipient, { limit: 50 });
    expect(blankIds).toEqual(
      (list.body.items as NotificationDTO[]).map((item) => item.id),
    );
  });

  it('never exports another account rows', async () => {
    const recipient = await createTestUser('notif_export_scope_a');
    const outsider = await createTestUser('notif_export_scope_b');
    const actor = await createTestUser('notifexportsharedactor');
    const room = await createRoom(actor.id, { name: 'export-isolation-room' });

    await createNotification({
      userId: recipient.id,
      type: 'join_request',
      roomId: room.id,
      actorId: actor.id,
      detail: 'shared-token mine',
    });
    await createNotification({
      userId: outsider.id,
      type: 'join_request',
      roomId: room.id,
      actorId: actor.id,
      detail: 'shared-token theirs',
    });

    const mine = await exportAs(recipient, { q: 'shared-token' });
    expect(toObjects(mine.text)).toHaveLength(1);
    expect(toObjects(mine.text)[0].content).toBe('shared-token mine');

    const theirs = await exportAs(outsider, { q: 'shared-token' });
    expect(toObjects(theirs.text)).toHaveLength(1);
    expect(toObjects(theirs.text)[0].content).toBe('shared-token theirs');

    // Another account's row is invisible even by id-shaped query terms.
    expect(toObjects((await exportAs(recipient, { q: 'theirs' })).text)).toHaveLength(0);
  });

  it('quotes RFC 4180 cells and neutralizes spreadsheet formulas', async () => {
    const recipient = await createTestUser('notif_export_escape_recipient');
    const owner = await createTestUser('notif_export_escape_owner');
    const formulaActor = await createTestUser('notif_export_formula_actor');
    const mentionActor = await createTestUser('notif_export_mention_actor');
    const room = await createRoom(owner.id, { name: 'escape-room' });
    await joinRoomService(recipient.id, room.id);

    const invite = await createNotification({
      userId: recipient.id,
      type: 'room_invite',
      roomId: room.id,
      actorId: formulaActor.id,
      detail: '-cmd|calc',
    });
    const mentionId = await seedMessageNotification(
      recipient.id,
      mentionActor.id,
      room.id,
      1,
      'line1\nline2, "quoted"',
    );
    await pool.execute('UPDATE rooms SET name = ? WHERE id = ?', [
      '=export, "room"',
      room.id,
    ]);
    await pool.execute('UPDATE users SET display_name = ? WHERE id = ?', [
      '=2+2',
      formulaActor.id,
    ]);
    await pool.execute('UPDATE users SET display_name = ? WHERE id = ?', [
      '@actor',
      mentionActor.id,
    ]);

    const response = await exportAs(recipient);
    expect(response.status).toBe(200);
    const rows = toObjects(response.text);
    expect(rows.map((row) => Number(row.id))).toEqual([mentionId, invite.id]);
    // Quoted cells round-trip exactly; a leading formula trigger gets an
    // apostrophe so Excel/Sheets show the text instead of evaluating it.
    expect(rows[0].roomName).toBe(`'=export, "room"`);
    expect(rows[0].actorName).toBe(`'@actor`);
    expect(rows[0].content).toBe('line1\nline2, "quoted"');
    expect(rows[1].content).toBe(`'-cmd|calc`);

    // Raw bytes carry the same guard and RFC 4180 quoting.
    expect(response.text).toContain(`"'=export, ""room"""`);
    expect(response.text).toContain(`"line1\nline2, ""quoted"""`);
    expect(response.text).toContain(`'-cmd|calc`);
    expect(response.text).toContain(`'@actor`);
  });

  it('caps the CSV at 5000 rows and flags truncation only when more exist', async () => {
    const user = await createTestUser('notif_export_cap_user');
    const actor = await createTestUser('notif_export_cap_actor');
    const room = await createRoom(actor.id, { name: 'export-cap-room' });
    const seeded = await seedBulkNotifications(user.id, actor.id, room.id, 5000);

    const exact = await exportAs(user);
    expect(exact.status).toBe(200);
    expect(exact.headers['x-notifications-truncated']).toBeUndefined();
    const exactRows = toObjects(exact.text);
    expect(exactRows).toHaveLength(5000);
    expect(Number(exactRows[0].id)).toBe(seeded.maxId);
    expect(Number(exactRows[4999].id)).toBe(seeded.minId);
    expect(exactRows[0].content).toBe('bulk notice 5000');

    // One more row pushes the set past the cap: the newest 5000 survive and
    // the header tells the client that older rows were dropped.
    const extra = await createNotification({
      userId: user.id,
      type: 'join_request',
      roomId: room.id,
      actorId: actor.id,
      detail: 'extra notice',
    });
    const capped = await exportAs(user);
    expect(capped.status).toBe(200);
    expect(capped.headers['x-notifications-truncated']).toBe('true');
    const cappedRows = toObjects(capped.text);
    expect(cappedRows).toHaveLength(5000);
    expect(Number(cappedRows[0].id)).toBe(extra.id);
    expect(cappedRows.map((row) => Number(row.id))).not.toContain(seeded.minId);
    const ids = cappedRows.map((row) => Number(row.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it('allows five exports per hour per user', async () => {
    config.rateLimitEnabled = true;
    const user = await createTestUser('notif_export_rate_user');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await exportAs(user);
      expect(response.status).toBe(200);
    }

    const limited = await exportAs(user);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');

    // The bucket is per user, so another account is unaffected.
    const other = await createTestUser('notif_export_rate_other');
    const otherResponse = await exportAs(other);
    expect(otherResponse.status).toBe(200);
  });

  it('requires authentication and rejects invalid filter or q', async () => {
    const anonymous = await request(server.url).get('/api/notifications/export');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHORIZED');

    const user = await createTestUser('notif_export_validation_user');
    for (const filter of ['bogus', 'MENTION', '']) {
      const response = await exportAs(user, { filter });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }

    const tooLong = await exportAs(user, { q: 'x'.repeat(101) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('INVALID_INPUT');

    const boundary = await exportAs(user, { q: 'x'.repeat(100) });
    expect(boundary.status).toBe(200);
    expect(boundary.text).toBe(`${EXPORT_HEADER.join(',')}\r\n`);
  });
});
