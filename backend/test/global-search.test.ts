import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createMessage, deleteMessage } from '../src/services/message';
import { createRoom } from '../src/services/room';
import type { AuthUser } from '../src/types';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

function searchAs(user: AuthUser, query: Record<string, string | number>) {
  return request(app)
    .get('/api/search/messages')
    .query(query)
    .set('Authorization', `Bearer ${tokenFor(user)}`);
}

describe('global message search', () => {
  it('finds messages across every joined room with the room name', async () => {
    const alice = await createTestUser('alice');
    const general = await createRoom(alice.id, { name: 'general' });
    const random = await createRoom(alice.id, { name: 'random' });

    await createMessage({
      roomId: general.id,
      senderId: alice.id,
      senderType: 'user',
      content: 'hello from general',
    });
    await createMessage({
      roomId: random.id,
      senderId: alice.id,
      senderType: 'user',
      content: 'hello from random',
    });

    const res = await searchAs(alice, { q: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(20);
    expect(res.body.offset).toBe(0);
    const found = Object.fromEntries(
      (res.body.messages as Array<{ content: string; roomName: string }>).map((message) => [
        message.content,
        message.roomName,
      ]),
    );
    expect(found).toEqual({
      'hello from general': 'general',
      'hello from random': 'random',
    });
  });

  it('hides messages from rooms the user never joined', async () => {
    const alice = await createTestUser('alice');
    const bob = await createTestUser('bob');
    const publicRoom = await createRoom(alice.id, { name: 'public-room' });
    const privateRoom = await createRoom(bob.id, { name: 'secret-room', isPublic: false });

    await createMessage({
      roomId: publicRoom.id,
      senderId: alice.id,
      senderType: 'user',
      content: 'visible needle',
    });
    await createMessage({
      roomId: privateRoom.id,
      senderId: bob.id,
      senderType: 'user',
      content: 'hidden needle',
    });

    const res = await searchAs(alice, { q: 'needle' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.messages.map((message: { content: string }) => message.content)).toEqual([
      'visible needle',
    ]);
  });

  it('skips deleted and streaming messages', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });

    const deleted = await createMessage({
      roomId: room.id,
      senderId: alice.id,
      senderType: 'user',
      content: 'needle deleted',
    });
    await deleteMessage(room.id, deleted.seq, alice.id, false);
    await createMessage({
      roomId: room.id,
      senderId: alice.id,
      senderType: 'user',
      content: 'needle streaming',
      status: 'streaming',
    });
    await createMessage({
      roomId: room.id,
      senderId: alice.id,
      senderType: 'user',
      content: 'needle done',
    });

    const res = await searchAs(alice, { q: 'needle' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.messages.map((message: { content: string }) => message.content)).toEqual([
      'needle done',
    ]);
  });

  it('treats LIKE wildcards in the query literally', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });

    await createMessage({
      roomId: room.id,
      senderId: alice.id,
      senderType: 'user',
      content: '100% sure',
    });
    await createMessage({
      roomId: room.id,
      senderId: alice.id,
      senderType: 'user',
      content: 'a_b match',
    });
    await createMessage({
      roomId: room.id,
      senderId: alice.id,
      senderType: 'user',
      content: 'plain match',
    });

    const percent = await searchAs(alice, { q: '%' });
    expect(percent.status).toBe(200);
    expect(percent.body.total).toBe(1);
    expect(percent.body.messages[0].content).toBe('100% sure');

    const underscore = await searchAs(alice, { q: '_' });
    expect(underscore.status).toBe(200);
    expect(underscore.body.total).toBe(1);
    expect(underscore.body.messages[0].content).toBe('a_b match');
  });

  it('paginates with limit and offset while reporting the full total', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });

    for (let index = 1; index <= 5; index += 1) {
      await createMessage({
        roomId: room.id,
        senderId: alice.id,
        senderType: 'user',
        content: `page item ${index}`,
      });
    }

    const firstPage = await searchAs(alice, { q: 'page item', limit: 2 });
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.total).toBe(5);
    expect(firstPage.body.limit).toBe(2);
    expect(firstPage.body.offset).toBe(0);
    expect(firstPage.body.messages).toHaveLength(2);
    expect(firstPage.body.messages[0].content).toBe('page item 5');
    expect(firstPage.body.messages[1].content).toBe('page item 4');

    const lastPage = await searchAs(alice, { q: 'page item', limit: 2, offset: 4 });
    expect(lastPage.status).toBe(200);
    expect(lastPage.body.total).toBe(5);
    expect(lastPage.body.messages).toHaveLength(1);
    expect(lastPage.body.messages[0].content).toBe('page item 1');
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/search/messages').query({ q: 'hello' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a missing or empty query', async () => {
    const alice = await createTestUser('alice');

    const missing = await searchAs(alice, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_INPUT');

    const empty = await searchAs(alice, { q: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('INVALID_INPUT');
  });
});
