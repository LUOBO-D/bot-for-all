import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { buildContext } from '../src/bot/context';
import { pool, type RowDataPacket } from '../src/db';
import {
  createMessage,
  deleteMessage,
  editMessage,
  listMessages,
  listPinned,
  pinMessage,
  searchMessages,
  toggleReaction,
  unpinMessage,
} from '../src/services/message';
import { joinRoom as joinRoomService } from '../src/services/room';
import type { BotRow, MessageDTO } from '../src/types';
import {
  connectClient,
  createTestRoom,
  createTestUser,
  delay,
  joinRoom,
  startTestServer,
  tokenFor,
  waitForEvent,
  type TestServer,
} from './helpers';

let server: TestServer;
const clients: Socket[] = [];

beforeAll(async () => {
  server = await startTestServer();
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

async function seedMessage(
  roomId: number,
  senderId: number,
  content: string,
  clientMsgId: string,
): Promise<MessageDTO> {
  return createMessage({ roomId, senderId, senderType: 'user', content, clientMsgId });
}

function botRow(roomId: number, ownerUserId: number): BotRow {
  return {
    userId: 999_999,
    username: 'bot_test',
    name: 'bot_test',
    baseUrl: 'http://127.0.0.1:1',
    apiKeyEncrypted: '',
    apiKey: '',
    model: 'test',
    systemPrompt: '',
    triggerMode: 'mention',
    scope: 'room',
    roomId,
    temperature: 0.7,
    maxTokens: 100,
    extraBody: null,
    enabled: true,
    ownerUserId,
    createdAt: '',
  };
}

describe('message edit', () => {
  it('lets the sender edit and stamps editedAt', async () => {
    const alice = await createTestUser('edit_alice');
    const roomId = await createTestRoom(alice);
    const message = await seedMessage(roomId, alice.id, 'before', 'edit-1');

    const edited = await editMessage(roomId, message.seq, alice.id, 'after');

    expect(edited.content).toBe('after');
    expect(edited.editedAt).not.toBeNull();
    expect(edited.deleted).toBe(false);
  });

  it('rejects edits from another user', async () => {
    const alice = await createTestUser('edit_owner');
    const bob = await createTestUser('edit_other');
    const roomId = await createTestRoom(alice);
    await joinRoomService(bob.id, roomId);
    const message = await seedMessage(roomId, alice.id, 'mine', 'edit-2');

    await expect(editMessage(roomId, message.seq, bob.id, 'hijacked')).rejects.toMatchObject({
      code: 'NOT_SENDER',
      status: 403,
    });
  });

  it('rejects edits of a deleted message', async () => {
    const alice = await createTestUser('edit_deleted');
    const roomId = await createTestRoom(alice);
    const message = await seedMessage(roomId, alice.id, 'gone', 'edit-3');
    await deleteMessage(roomId, message.seq, alice.id, false);

    await expect(editMessage(roomId, message.seq, alice.id, 'again')).rejects.toMatchObject({
      code: 'MESSAGE_DELETED',
      status: 409,
    });
  });
});

describe('message delete', () => {
  it('soft deletes own message and hides content', async () => {
    const alice = await createTestUser('del_alice');
    const roomId = await createTestRoom(alice);
    const message = await seedMessage(roomId, alice.id, 'oops', 'del-1');

    const deleted = await deleteMessage(roomId, message.seq, alice.id, false);

    expect(deleted.deleted).toBe(true);
    expect(deleted.content).toBe('');

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT content, deleted_at FROM messages WHERE id = ?',
      [message.id],
    );
    expect(String(rows[0].content)).toBe('oops');
    expect(rows[0].deleted_at).not.toBeNull();

    const listed = await listMessages(roomId, { limit: 10 });
    expect(listed.messages[0].content).toBe('');
    expect(listed.messages[0].deleted).toBe(true);
  });

  it('is idempotent for repeated deletes', async () => {
    const alice = await createTestUser('del_twice');
    const roomId = await createTestRoom(alice);
    const message = await seedMessage(roomId, alice.id, 'twice', 'del-2');

    const first = await deleteMessage(roomId, message.seq, alice.id, false);
    const second = await deleteMessage(roomId, message.seq, alice.id, false);

    expect(second.deleted).toBe(true);
    expect(second.content).toBe('');
    expect(first.deleted).toBe(true);
  });

  it('lets a moderator delete another user message', async () => {
    const owner = await createTestUser('del_owner');
    const bob = await createTestUser('del_bob');
    const roomId = await createTestRoom(owner);
    await joinRoomService(bob.id, roomId);
    const message = await seedMessage(roomId, bob.id, 'spam', 'del-3');

    const deleted = await deleteMessage(roomId, message.seq, owner.id, true);
    expect(deleted.deleted).toBe(true);
    expect(deleted.content).toBe('');
  });

  it('rejects deletes from a non-moderator', async () => {
    const alice = await createTestUser('del_alice2');
    const bob = await createTestUser('del_bob2');
    const roomId = await createTestRoom(alice);
    await joinRoomService(bob.id, roomId);
    const message = await seedMessage(roomId, alice.id, 'keep me', 'del-4');

    await expect(deleteMessage(roomId, message.seq, bob.id, false)).rejects.toMatchObject({
      code: 'NOT_PERMITTED',
      status: 403,
    });
  });

  it('excludes deleted messages from search and bot context', async () => {
    const alice = await createTestUser('del_search');
    const roomId = await createTestRoom(alice);
    await seedMessage(roomId, alice.id, 'needle kept', 'del-5');
    const removed = await seedMessage(roomId, alice.id, 'needle removed', 'del-6');
    await deleteMessage(roomId, removed.seq, alice.id, false);

    const results = await searchMessages(roomId, 'needle');
    expect(results.map((message) => message.content)).toEqual(['needle kept']);

    const context = await buildContext(roomId, botRow(roomId, alice.id));
    expect(context.some((entry) => entry.content.includes('needle removed'))).toBe(false);
    expect(context.some((entry) => entry.content.includes('needle kept'))).toBe(true);
  });
});

describe('message reactions', () => {
  it('toggles a reaction on and off with counts and user ids', async () => {
    const alice = await createTestUser('react_alice');
    const bob = await createTestUser('react_bob');
    const roomId = await createTestRoom(alice);
    await joinRoomService(bob.id, roomId);
    const message = await seedMessage(roomId, alice.id, 'react to me', 'react-1');

    const added = await toggleReaction(roomId, message.seq, bob.id, '👍');
    expect(added.reactions).toHaveLength(1);
    expect(added.reactions[0]).toMatchObject({ emoji: '👍', count: 1, userIds: [bob.id] });

    const both = await toggleReaction(roomId, message.seq, alice.id, '👍');
    expect(both.reactions[0].count).toBe(2);
    expect(both.reactions[0].userIds.sort()).toEqual([alice.id, bob.id].sort());

    const removed = await toggleReaction(roomId, message.seq, bob.id, '👍');
    expect(removed.reactions).toHaveLength(1);
    expect(removed.reactions[0].count).toBe(1);
    expect(removed.reactions[0].userIds).toEqual([alice.id]);

    const cleared = await toggleReaction(roomId, message.seq, alice.id, '👍');
    expect(cleared.reactions).toEqual([]);
  });

  it('rejects reactions on a deleted message', async () => {
    const alice = await createTestUser('react_deleted');
    const roomId = await createTestRoom(alice);
    const message = await seedMessage(roomId, alice.id, 'bye', 'react-2');
    await deleteMessage(roomId, message.seq, alice.id, false);

    await expect(toggleReaction(roomId, message.seq, alice.id, '🔥')).rejects.toMatchObject({
      code: 'MESSAGE_DELETED',
      status: 409,
    });
  });
});

describe('pinned messages', () => {
  it('pins, lists and unpins messages', async () => {
    const alice = await createTestUser('pin_alice');
    const roomId = await createTestRoom(alice);
    const first = await seedMessage(roomId, alice.id, 'first', 'pin-1');
    const second = await seedMessage(roomId, alice.id, 'second', 'pin-2');

    const pinned = await pinMessage(roomId, first.seq, alice.id);
    expect(pinned.pinned).toBe(true);
    expect(pinned.pinnedBy).toBe(alice.id);

    await delay(20);
    await pinMessage(roomId, second.seq, alice.id);

    const list = await listPinned(roomId);
    expect(list.map((message) => message.seq)).toEqual([second.seq, first.seq]);

    const unpinned = await unpinMessage(roomId, second.seq);
    expect(unpinned.pinned).toBe(false);
    expect(unpinned.pinnedBy).toBeNull();
    expect((await listPinned(roomId)).map((message) => message.seq)).toEqual([first.seq]);
  });
});

describe('message action routes', () => {
  it('edits via PATCH and broadcasts message:updated', async () => {
    const alice = await createTestUser('route_alice');
    const bob = await createTestUser('route_bob');
    const roomId = await createTestRoom(alice);
    await joinRoomService(bob.id, roomId);
    const message = await seedMessage(roomId, alice.id, 'route before', 'route-1');

    const client = await connectClient(server.url, tokenFor(bob));
    clients.push(client);
    await joinRoom(client, roomId);

    const updated = waitForEvent<{ roomId: number; message: MessageDTO }>(
      client,
      'message:updated',
      (payload) => payload.message.seq === message.seq && payload.message.content === 'route after',
    );

    const response = await request(server.url)
      .patch(`/api/rooms/${roomId}/messages/${message.seq}`)
      .set('Authorization', `Bearer ${tokenFor(alice)}`)
      .send({ content: 'route after' });

    expect(response.status).toBe(200);
    expect(response.body.message.content).toBe('route after');
    expect(response.body.message.editedAt).not.toBeNull();
    expect((await updated).message.editedAt).not.toBeNull();
  });

  it('rejects a foreign edit and an empty content body', async () => {
    const alice = await createTestUser('route_owner2');
    const bob = await createTestUser('route_bob2');
    const roomId = await createTestRoom(alice);
    await joinRoomService(bob.id, roomId);
    const message = await seedMessage(roomId, alice.id, 'protected', 'route-2');

    const foreign = await request(server.url)
      .patch(`/api/rooms/${roomId}/messages/${message.seq}`)
      .set('Authorization', `Bearer ${tokenFor(bob)}`)
      .send({ content: 'nope' });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('NOT_SENDER');

    const empty = await request(server.url)
      .patch(`/api/rooms/${roomId}/messages/${message.seq}`)
      .set('Authorization', `Bearer ${tokenFor(alice)}`)
      .send({ content: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('INVALID_INPUT');
  });

  it('toggles a reaction via POST and pins via POST/DELETE', async () => {
    const alice = await createTestUser('route_pin_alice');
    const bob = await createTestUser('route_pin_bob');
    const roomId = await createTestRoom(alice);
    await joinRoomService(bob.id, roomId);
    const message = await seedMessage(roomId, alice.id, 'pin me', 'route-3');
    const bobToken = `Bearer ${tokenFor(bob)}`;
    const aliceToken = `Bearer ${tokenFor(alice)}`;

    const reacted = await request(server.url)
      .post(`/api/rooms/${roomId}/messages/${message.seq}/reactions`)
      .set('Authorization', bobToken)
      .send({ emoji: '🎉' });
    expect(reacted.status).toBe(200);
    expect(reacted.body.message.reactions[0]).toMatchObject({ emoji: '🎉', count: 1 });

    const removed = await request(server.url)
      .post(`/api/rooms/${roomId}/messages/${message.seq}/reactions`)
      .set('Authorization', bobToken)
      .send({ emoji: '🎉' });
    expect(removed.body.message.reactions).toEqual([]);

    const pinDenied = await request(server.url)
      .post(`/api/rooms/${roomId}/messages/${message.seq}/pin`)
      .set('Authorization', bobToken);
    expect(pinDenied.status).toBe(403);
    expect(pinDenied.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const pinned = await request(server.url)
      .post(`/api/rooms/${roomId}/messages/${message.seq}/pin`)
      .set('Authorization', aliceToken);
    expect(pinned.status).toBe(200);
    expect(pinned.body.message.pinned).toBe(true);

    const pins = await request(server.url)
      .get(`/api/rooms/${roomId}/pins`)
      .set('Authorization', bobToken);
    expect(pins.status).toBe(200);
    expect(pins.body.messages.map((entry: MessageDTO) => entry.seq)).toEqual([message.seq]);

    const unpinned = await request(server.url)
      .delete(`/api/rooms/${roomId}/messages/${message.seq}/pin`)
      .set('Authorization', aliceToken);
    expect(unpinned.status).toBe(200);
    expect(unpinned.body.message.pinned).toBe(false);

    const emptyPins = await request(server.url)
      .get(`/api/rooms/${roomId}/pins`)
      .set('Authorization', bobToken);
    expect(emptyPins.body.messages).toEqual([]);
  });

  it('deletes via DELETE and hides content for members', async () => {
    const alice = await createTestUser('route_del_alice');
    const roomId = await createTestRoom(alice);
    const message = await seedMessage(roomId, alice.id, 'remove me', 'route-4');

    const response = await request(server.url)
      .delete(`/api/rooms/${roomId}/messages/${message.seq}`)
      .set('Authorization', `Bearer ${tokenFor(alice)}`);

    expect(response.status).toBe(200);
    expect(response.body.message.deleted).toBe(true);
    expect(response.body.message.content).toBe('');

    const listed = await request(server.url)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${tokenFor(alice)}`);
    expect(listed.body.messages[0].deleted).toBe(true);
    expect(listed.body.messages[0].content).toBe('');
  });
});
