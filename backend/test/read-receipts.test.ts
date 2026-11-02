import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { createMessage } from '../src/services/message';
import { getRoomMaxSeq, joinRoom as joinRoomService, listMembers } from '../src/services/room';
import {
  connectClient,
  createTestRoom,
  createTestUser,
  startTestServer,
  tokenFor,
  waitForEvent,
  type TestServer,
} from './helpers';
import type { AuthUser, MemberDTO } from '../src/types';

interface ReadUpdatedPayload {
  roomId: number;
  userId: number;
  seq: number;
}

let server: TestServer;
const clients: Socket[] = [];

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

async function openClient(user: AuthUser): Promise<Socket> {
  const client = await connectClient(server.url, tokenFor(user));
  clients.push(client);
  return client;
}

/** `room:join` with an explicit read flag (the shared helper always reads). */
function joinRoomWithRead(
  socket: Socket,
  roomId: number,
  read: boolean,
): Promise<{ ok?: boolean; lastSeq?: number }> {
  const { promise, resolve } = Promise.withResolvers<{ ok?: boolean; lastSeq?: number }>();
  socket.emit('room:join', { roomId, read }, (response: { ok?: boolean; lastSeq?: number }) => {
    resolve(response);
  });
  return promise;
}

async function seedMessage(roomId: number, senderId: number, content: string): Promise<number> {
  const message = await createMessage({
    roomId,
    senderId,
    senderType: 'user',
    content,
    clientMsgId: `read-${roomId}-${senderId}-${content}-${Math.random().toString(16).slice(2)}`,
  });
  return message.seq;
}

async function members(roomId: number, actor: AuthUser): Promise<MemberDTO[]> {
  const response = await request(server.url)
    .get(`/api/rooms/${roomId}/members`)
    .set('Authorization', auth(actor));
  expect(response.status).toBe(200);
  return response.body.members as MemberDTO[];
}

function memberOf(list: MemberDTO[], userId: number): MemberDTO {
  const found = list.find((entry) => entry.userId === userId);
  if (!found) {
    throw new Error(`member ${userId} missing from list`);
  }
  return found;
}

describe('read receipts', () => {
  it('exposes lastReadSeq on every member', async () => {
    const owner = await createTestUser('read_owner');
    const member = await createTestUser('read_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    await seedMessage(roomId, owner.id, 'first');
    await seedMessage(roomId, owner.id, 'second');

    const before = await members(roomId, owner);
    expect(memberOf(before, member.id).lastReadSeq).toBe(0);
    expect(memberOf(before, owner.id).lastReadSeq).toBe(0);

    const response = await request(server.url)
      .post(`/api/rooms/${roomId}/read`)
      .set('Authorization', auth(member))
      .send({ seq: 2 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });

    const after = await members(roomId, owner);
    expect(memberOf(after, member.id).lastReadSeq).toBe(2);
    expect(memberOf(after, owner.id).lastReadSeq).toBe(0);
    expect((await listMembers(roomId)).find((entry) => entry.userId === member.id)?.lastReadSeq).toBe(
      2,
    );
  });

  it('broadcasts read:updated to the room after POST /read', async () => {
    const owner = await createTestUser('read_bc_owner');
    const member = await createTestUser('read_bc_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    await seedMessage(roomId, owner.id, 'hello');
    await seedMessage(roomId, owner.id, 'world');

    const ownerClient = await openClient(owner);
    // read:false keeps this join from broadcasting its own receipt.
    expect((await joinRoomWithRead(ownerClient, roomId, false)).ok).toBe(true);

    const received = waitForEvent<ReadUpdatedPayload>(
      ownerClient,
      'read:updated',
      (payload) => payload.userId === member.id,
    );

    const response = await request(server.url)
      .post(`/api/rooms/${roomId}/read`)
      .set('Authorization', auth(member))
      .send({ seq: 2 });
    expect(response.status).toBe(200);

    expect(await received).toEqual({ roomId, userId: member.id, seq: 2 });
    expect(memberOf(await members(roomId, owner), member.id).lastReadSeq).toBe(2);
  });

  it('marks the room read and broadcasts when a client joins', async () => {
    const owner = await createTestUser('read_join_owner');
    const member = await createTestUser('read_join_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    await seedMessage(roomId, owner.id, 'one');
    await seedMessage(roomId, owner.id, 'two');
    const maxSeq = await getRoomMaxSeq(roomId);
    expect(maxSeq).toBeGreaterThan(0);
    expect(memberOf(await members(roomId, owner), member.id).lastReadSeq).toBe(0);

    const memberClient = await openClient(member);
    const receipt = waitForEvent<ReadUpdatedPayload>(
      memberClient,
      'read:updated',
      (payload) => payload.userId === member.id,
    );
    const ack = await joinRoomWithRead(memberClient, roomId, true);
    expect(ack).toEqual({ ok: true, lastSeq: maxSeq });

    expect(await receipt).toEqual({ roomId, userId: member.id, seq: maxSeq });
    expect(memberOf(await members(roomId, owner), member.id).lastReadSeq).toBe(maxSeq);
  });

  it('does not broadcast or move the cursor when joining with read:false', async () => {
    const owner = await createTestUser('read_skip_owner');
    const member = await createTestUser('read_skip_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    await seedMessage(roomId, owner.id, 'unread');

    const memberClient = await openClient(member);
    const events: ReadUpdatedPayload[] = [];
    memberClient.on('read:updated', (payload: ReadUpdatedPayload) => {
      events.push(payload);
    });

    expect((await joinRoomWithRead(memberClient, roomId, false)).ok).toBe(true);
    // A round trip through the server so any queued broadcast would have landed.
    expect((await members(roomId, owner)).length).toBe(2);

    expect(events).toEqual([]);
    expect(memberOf(await members(roomId, owner), member.id).lastReadSeq).toBe(0);
  });

  it('rejects an invalid seq and leaves the cursor untouched', async () => {
    const owner = await createTestUser('read_bad_owner');
    const member = await createTestUser('read_bad_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    await seedMessage(roomId, owner.id, 'only');

    const negative = await request(server.url)
      .post(`/api/rooms/${roomId}/read`)
      .set('Authorization', auth(member))
      .send({ seq: -1 });
    expect(negative.status).toBe(400);
    expect(negative.body.error.code).toBe('INVALID_INPUT');

    const fractional = await request(server.url)
      .post(`/api/rooms/${roomId}/read`)
      .set('Authorization', auth(member))
      .send({ seq: 1.5 });
    expect(fractional.status).toBe(400);

    const missing = await request(server.url)
      .post(`/api/rooms/${roomId}/read`)
      .set('Authorization', auth(member))
      .send({});
    expect(missing.status).toBe(400);

    expect(memberOf(await members(roomId, owner), member.id).lastReadSeq).toBe(0);
  });

  it('rejects reads from non-members', async () => {
    const owner = await createTestUser('read_out_owner');
    const outsider = await createTestUser('read_out_sider');
    const roomId = await createTestRoom(owner);
    await seedMessage(roomId, owner.id, 'private');

    const response = await request(server.url)
      .post(`/api/rooms/${roomId}/read`)
      .set('Authorization', auth(outsider))
      .send({ seq: 1 });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
  });
});
