import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { Message } from '../src/types';
import { joinRoom as joinRoomService } from '../src/services/room';
import { createMessage } from '../src/services/message';
import {
  connectClient,
  createTestRoom,
  createTestUser,
  delay,
  joinRoom,
  sendMessage,
  startTestServer,
  tokenFor,
  waitForEvent,
  type TestServer,
} from './helpers';

interface NewMessagePayload {
  roomId: number;
  message: Message;
}

interface PresencePayload {
  roomId: number;
  onlineUserIds: number[];
}

interface TypingPayload {
  roomId: number;
  userId: number;
  displayName: string;
  isTyping: boolean;
}

let server: TestServer;
const clients: Socket[] = [];

async function openClient(token: string): Promise<Socket> {
  const client = await connectClient(server.url, token);
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
});

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

describe('socket', () => {
  it('rejects a missing token', async () => {
    await expect(connectClient(server.url, '')).rejects.toThrow();
  });

  it('broadcasts a message and deduplicates clientMsgId', async () => {
    const alice = await createTestUser('socket_alice');
    const bob = await createTestUser('socket_bob');
    const roomId = await createTestRoom(alice);
    await joinRoomService(bob.id, roomId);
    const clientA = await openClient(tokenFor(alice));
    const clientB = await openClient(tokenFor(bob));
    await joinRoom(clientA, roomId);
    await joinRoom(clientB, roomId);

    const received: Message[] = [];
    clientB.on('message:new', (payload: NewMessagePayload) => {
      received.push(payload.message);
    });

    const first = await sendMessage(clientA, roomId, 'hello', 'same-client-id');
    expect(first.ok).toBe(true);
    await waitForEvent<NewMessagePayload>(
      clientB,
      'message:new',
      (payload) => payload.message.content === 'hello',
    );
    await sendMessage(clientA, roomId, 'hello', 'same-client-id');
    await delay(250);

    expect(received.filter((message) => message.content === 'hello')).toHaveLength(1);

    clientA.close();
    clientB.close();
  });

  it('tracks presence when clients join and leave', async () => {
    const alice = await createTestUser('presence_alice');
    const bob = await createTestUser('presence_bob');
    const roomId = await createTestRoom(alice);
    await joinRoomService(bob.id, roomId);
    const clientA = await openClient(tokenFor(alice));
    await joinRoom(clientA, roomId);

    const bothOnline = waitForEvent<PresencePayload>(
      clientA,
      'presence',
      (payload) => payload.onlineUserIds.length === 2,
    );
    const clientB = await openClient(tokenFor(bob));
    await joinRoom(clientB, roomId);
    expect((await bothOnline).onlineUserIds.sort()).toEqual([alice.id, bob.id].sort());

    const oneOnline = waitForEvent<PresencePayload>(
      clientA,
      'presence',
      (payload) => payload.onlineUserIds.length === 1,
    );
    clientB.close();
    expect(await oneOnline).toEqual({ roomId, onlineUserIds: [alice.id] });

    clientA.close();
  });

  it('broadcasts typing to other room members', async () => {
    const alice = await createTestUser('typing_alice');
    const bob = await createTestUser('typing_bob');
    const roomId = await createTestRoom(alice);
    await joinRoomService(bob.id, roomId);
    const clientA = await openClient(tokenFor(alice));
    const clientB = await openClient(tokenFor(bob));
    await joinRoom(clientA, roomId);
    await joinRoom(clientB, roomId);

    const typing = waitForEvent<TypingPayload>(
      clientB,
      'typing',
      (payload) => payload.userId === alice.id && payload.isTyping,
    );
    clientA.emit('typing', { roomId, isTyping: true });
    expect(await typing).toMatchObject({
      roomId,
      userId: alice.id,
      displayName: 'typing_alice',
      isTyping: true,
    });

    clientA.close();
    clientB.close();
  });

  it('evicts a user from the socket room after leaving through REST', async () => {
    const alice = await createTestUser('leave_socket_alice');
    const bob = await createTestUser('leave_socket_bob');
    const roomId = await createTestRoom(alice);
    await joinRoomService(bob.id, roomId);
    const clientA = await openClient(tokenFor(alice));
    const clientB = await openClient(tokenFor(bob));
    await joinRoom(clientA, roomId);
    await joinRoom(clientB, roomId);

    const revoked = waitForEvent<{ roomId: number }>(
      clientB,
      'room:revoked',
      (payload) => payload.roomId === roomId,
    );
    const presenceWithoutBob = waitForEvent<PresencePayload>(
      clientA,
      'presence',
      (payload) => payload.roomId === roomId && payload.onlineUserIds.length === 1,
    );

    const response = await request(server.url)
      .post(`/api/rooms/${roomId}/leave`)
      .set('Authorization', `Bearer ${tokenFor(bob)}`);
    expect(response.status).toBe(200);
    expect(await revoked).toEqual({ roomId });
    expect((await presenceWithoutBob).onlineUserIds).toEqual([alice.id]);

    const bobReceived: string[] = [];
    clientB.on('message:new', (payload: NewMessagePayload) => {
      bobReceived.push(payload.message.content);
    });
    const aliceReceives = waitForEvent<NewMessagePayload>(
      clientA,
      'message:new',
      (payload) => payload.message.content === 'after-leave',
    );
    await sendMessage(clientA, roomId, 'after-leave');
    await aliceReceives;
    await delay(250);

    expect(bobReceived).not.toContain('after-leave');
    clientA.close();
    clientB.close();
  });

  it('rejects a reply target from another room', async () => {
    const alice = await createTestUser('reply_socket_alice');
    const roomId = await createTestRoom(alice);
    const otherRoomId = await createTestRoom(alice);
    const otherMessage = await createMessage({
      roomId: otherRoomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'other room',
      clientMsgId: 'other-room-message',
    });
    const client = await openClient(tokenFor(alice));
    await joinRoom(client, roomId);

    const { promise, resolve } = Promise.withResolvers<{ ok: boolean; code?: string }>();
    client.emit(
      'message:send',
      {
        roomId,
        content: 'bad reply',
        clientMsgId: 'bad-reply',
        replyToId: otherMessage.id,
      },
      (payload: { ok: boolean; code?: string }) => resolve(payload),
    );
    const response = await promise;

    expect(response.ok).toBe(false);
    expect(response.code).toBe('INVALID_REPLY_TARGET');
    client.close();
  });
});
