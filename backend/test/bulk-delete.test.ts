import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { createMessage, deleteMessage } from '../src/services/message';
import { joinRoom as joinRoomService, setMemberRole } from '../src/services/room';
import type { MessageDTO } from '../src/types';
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

function bulkDelete(roomId: number, token: string, body: unknown) {
  return request(server.url)
    .post(`/api/rooms/${roomId}/messages/bulk-delete`)
    .set('Authorization', `Bearer ${token}`)
    .send(body as object);
}

function bulkDeleteSeqs(roomId: number, token: string, seqs: unknown) {
  return bulkDelete(roomId, token, { seqs });
}

describe('bulk message delete', () => {
  it('lets the room owner delete several messages and broadcasts each update', async () => {
    const owner = await createTestUser('bulk_owner');
    const roomId = await createTestRoom(owner);
    const first = await seedMessage(roomId, owner.id, 'first', 'bulk-1');
    const second = await seedMessage(roomId, owner.id, 'second', 'bulk-2');

    const client = await connectClient(server.url, tokenFor(owner));
    clients.push(client);
    await joinRoom(client, roomId);

    const firstUpdated = waitForEvent<{ roomId: number; message: MessageDTO }>(
      client,
      'message:updated',
      (payload) => payload.message.seq === first.seq && payload.message.deleted,
    );
    const secondUpdated = waitForEvent<{ roomId: number; message: MessageDTO }>(
      client,
      'message:updated',
      (payload) => payload.message.seq === second.seq && payload.message.deleted,
    );

    const response = await bulkDeleteSeqs(roomId, tokenFor(owner), [first.seq, second.seq]);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: 2, skipped: 0 });
    expect((await firstUpdated).message.content).toBe('');
    expect((await secondUpdated).message.content).toBe('');

    const listed = await request(server.url)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`);
    expect(listed.status).toBe(200);
    const bySeq = new Map<number, MessageDTO>(
      (listed.body.messages as MessageDTO[]).map((message) => [message.seq, message]),
    );
    expect(bySeq.get(first.seq)).toMatchObject({ deleted: true, content: '' });
    expect(bySeq.get(second.seq)).toMatchObject({ deleted: true, content: '' });
  });

  it('lets a room admin delete messages sent by others', async () => {
    const owner = await createTestUser('bulk_admin_owner');
    const admin = await createTestUser('bulk_admin_user');
    const roomId = await createTestRoom(owner);
    await joinRoomService(admin.id, roomId);
    await setMemberRole(roomId, owner.id, 'user', admin.id, 'admin');
    const message = await seedMessage(roomId, owner.id, 'spam from owner', 'bulk-3');

    const response = await bulkDeleteSeqs(roomId, tokenFor(admin), [message.seq]);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: 1, skipped: 0 });

    const listed = await request(server.url)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`);
    expect((listed.body.messages as MessageDTO[])[0]).toMatchObject({ deleted: true, content: '' });
  });

  it('rejects plain members and non-members', async () => {
    const owner = await createTestUser('bulk_deny_owner');
    const member = await createTestUser('bulk_deny_member');
    const outsider = await createTestUser('bulk_deny_outsider');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    const message = await seedMessage(roomId, owner.id, 'protected', 'bulk-4');

    const memberResponse = await bulkDeleteSeqs(roomId, tokenFor(member), [message.seq]);
    expect(memberResponse.status).toBe(403);
    expect(memberResponse.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const outsiderResponse = await bulkDeleteSeqs(roomId, tokenFor(outsider), [message.seq]);
    expect(outsiderResponse.status).toBe(403);
    expect(outsiderResponse.body.error.code).toBe('NOT_MEMBER');

    const listed = await request(server.url)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`);
    expect((listed.body.messages as MessageDTO[])[0]).toMatchObject({ deleted: false });
  });

  it('rejects malformed seq lists', async () => {
    const owner = await createTestUser('bulk_invalid_owner');
    const roomId = await createTestRoom(owner);
    const token = tokenFor(owner);

    const tooMany = await bulkDeleteSeqs(
      roomId,
      token,
      Array.from({ length: 51 }, (_, index) => index + 1),
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('INVALID_INPUT');

    for (const seqs of [[], [0], [-1], [1.5], ['3'], [null]]) {
      const response = await bulkDeleteSeqs(roomId, token, seqs);
      expect(response.status, `seqs=${JSON.stringify(seqs)}`).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }

    const missing = await bulkDelete(roomId, token, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_INPUT');
  });

  it('skips unknown and already deleted seqs, deduplicating repeats', async () => {
    const owner = await createTestUser('bulk_skip_owner');
    const roomId = await createTestRoom(owner);
    const live = await seedMessage(roomId, owner.id, 'live one', 'bulk-5');
    const gone = await seedMessage(roomId, owner.id, 'already gone', 'bulk-6');
    await deleteMessage(roomId, gone.seq, owner.id, true);
    const missingSeq = 99_999;

    const client = await connectClient(server.url, tokenFor(owner));
    clients.push(client);
    await joinRoom(client, roomId);
    const broadcastSeqs: number[] = [];
    client.on('message:updated', (payload: { message: MessageDTO }) => {
      broadcastSeqs.push(payload.message.seq);
    });

    const response = await bulkDeleteSeqs(roomId, tokenFor(owner), [
      live.seq,
      live.seq,
      gone.seq,
      missingSeq,
    ]);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: 1, skipped: 2 });

    const deadline = Date.now() + 5000;
    while (broadcastSeqs.length === 0 && Date.now() < deadline) {
      await delay(10);
    }
    await delay(50);
    expect(broadcastSeqs).toEqual([live.seq]);
  });
});
