import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool } from '../src/db';
import { createMessage } from '../src/services/message';
import { createRoom, joinRoom } from '../src/services/room';
import type { AuthUser } from '../src/types';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

function searchAs(user: AuthUser, query: Record<string, string | number>) {
  return request(app)
    .get('/api/search/messages')
    .query(query)
    .set('Authorization', `Bearer ${tokenFor(user)}`);
}

/** Backdates a message so date-window filters are deterministic. */
async function setCreatedAt(id: number, value: string): Promise<void> {
  await pool.execute('UPDATE messages SET created_at = ? WHERE id = ?', [value, id]);
}

async function seed(
  roomId: number,
  sender: AuthUser,
  content: string,
  createdAt?: string,
): Promise<number> {
  const message = await createMessage({
    roomId,
    senderId: sender.id,
    senderType: 'user',
    content,
  });
  if (createdAt) {
    await setCreatedAt(message.id, createdAt);
  }
  return message.id;
}

function contents(res: request.Response): string[] {
  return (res.body.messages as Array<{ content: string }>).map((message) => message.content);
}

describe('global message search filters', () => {
  it('searches across every joined room and narrows to one roomId', async () => {
    const alice = await createTestUser('alice');
    const general = await createRoom(alice.id, { name: 'general' });
    const random = await createRoom(alice.id, { name: 'random' });
    await seed(general.id, alice, 'needle in general');
    await seed(random.id, alice, 'needle in random');

    const all = await searchAs(alice, { q: 'needle' });
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.limit).toBe(20);
    expect(all.body.offset).toBe(0);
    expect(contents(all).sort()).toEqual(['needle in general', 'needle in random']);

    const scoped = await searchAs(alice, { q: 'needle', roomId: general.id });
    expect(scoped.status).toBe(200);
    expect(scoped.body.total).toBe(1);
    expect(contents(scoped)).toEqual(['needle in general']);
    expect(scoped.body.messages[0].roomName).toBe('general');
  });

  it('matches the sender username exactly', async () => {
    const alice = await createTestUser('alice');
    const bob = await createTestUser('bob');
    const bobby = await createTestUser('bobby');
    const room = await createRoom(alice.id, { name: 'general' });
    await joinRoom(bob.id, room.id);
    await joinRoom(bobby.id, room.id);

    await seed(room.id, alice, 'needle from alice');
    await seed(room.id, bob, 'needle from bob');
    await seed(room.id, bobby, 'needle from bobby');

    const res = await searchAs(alice, { q: 'needle', sender: 'bob' });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(contents(res)).toEqual(['needle from bob']);
    expect(res.body.messages[0].senderName).toBe('bob');

    const unknown = await searchAs(alice, { q: 'needle', sender: 'nobody' });
    expect(unknown.status).toBe(200);
    expect(unknown.body.total).toBe(0);
    expect(unknown.body.messages).toEqual([]);
  });

  it('filters by an exclusive created_at window', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });
    await seed(room.id, alice, 'needle early', '2024-01-10 08:00:00');
    await seed(room.id, alice, 'needle middle', '2024-06-15 12:00:00');
    await seed(room.id, alice, 'needle late', '2024-12-20 18:00:00');

    const window = await searchAs(alice, {
      q: 'needle',
      after: '2024-03-01T00:00:00.000Z',
      before: '2024-12-01T00:00:00.000Z',
    });
    expect(window.status).toBe(200);
    expect(window.body.total).toBe(1);
    expect(contents(window)).toEqual(['needle middle']);

    // Both bounds are exclusive.
    const exclusive = await searchAs(alice, {
      q: 'needle',
      after: '2024-01-10T08:00:00.000Z',
      before: '2024-06-15T12:00:00.000Z',
    });
    expect(exclusive.status).toBe(200);
    expect(exclusive.body.total).toBe(0);
    expect(exclusive.body.messages).toEqual([]);

    // Date-only strings resolve to midnight UTC.
    const dateOnly = await searchAs(alice, { q: 'needle', after: '2024-06-15', before: '2024-12-01' });
    expect(dateOnly.status).toBe(200);
    expect(contents(dateOnly)).toEqual(['needle middle']);
  });

  it('combines room, sender and date filters', async () => {
    const alice = await createTestUser('alice');
    const bob = await createTestUser('bob');
    const general = await createRoom(alice.id, { name: 'general' });
    const random = await createRoom(alice.id, { name: 'random' });
    await joinRoom(bob.id, general.id);

    await seed(general.id, bob, 'needle target', '2024-06-15 12:00:00');
    await seed(general.id, bob, 'needle too old', '2023-06-15 12:00:00');
    await seed(general.id, alice, 'needle wrong sender', '2024-06-15 12:00:00');
    await seed(random.id, bob, 'needle wrong room', '2024-06-15 12:00:00');

    const res = await searchAs(alice, {
      q: 'needle',
      roomId: general.id,
      sender: 'bob',
      after: '2024-01-01T00:00:00.000Z',
      before: '2024-12-01T00:00:00.000Z',
    });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(contents(res)).toEqual(['needle target']);
    expect(res.body.messages[0].roomName).toBe('general');
  });

  it('rejects a roomId the user is not a member of', async () => {
    const alice = await createTestUser('alice');
    const bob = await createTestUser('bob');
    const secret = await createRoom(bob.id, { name: 'secret-room', isPublic: false });
    await seed(secret.id, bob, 'needle secret');

    const res = await searchAs(alice, { q: 'needle', roomId: secret.id });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_MEMBER');
  });

  it('rejects invalid filter values', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });

    const invalid: Array<Record<string, string | number>> = [
      { q: 'needle', roomId: 'abc' },
      { q: 'needle', roomId: 0 },
      { q: 'needle', roomId: -3 },
      { q: 'needle', roomId: 1.5 },
      { q: 'needle', sender: 'ab' },
      { q: 'needle', sender: 'a'.repeat(33) },
      { q: 'needle', before: 'nope' },
      { q: 'needle', before: '2024-13-01' },
      { q: 'needle', before: '20240101' },
      { q: 'needle', after: 'yesterday' },
      { q: 'needle', after: '2024-13-01T00:00:00.000Z' },
    ];

    for (const query of invalid) {
      const res = await searchAs(alice, query);
      expect(res.status, JSON.stringify(query)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    }

    // The valid room is untouched by the rejected requests.
    await seed(room.id, alice, 'needle ok');
    const ok = await searchAs(alice, { q: 'needle' });
    expect(ok.status).toBe(200);
    expect(ok.body.total).toBe(1);
  });

  it('paginates the filtered result while reporting the full total', async () => {
    const alice = await createTestUser('alice');
    const room = await createRoom(alice.id, { name: 'general' });
    const other = await createRoom(alice.id, { name: 'other' });
    for (let index = 1; index <= 5; index += 1) {
      await seed(room.id, alice, `needle ${index}`);
    }
    await seed(other.id, alice, 'needle outside');

    const firstPage = await searchAs(alice, { q: 'needle', roomId: room.id, limit: 2 });
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.total).toBe(5);
    expect(firstPage.body.limit).toBe(2);
    expect(firstPage.body.offset).toBe(0);
    expect(contents(firstPage)).toEqual(['needle 5', 'needle 4']);

    const secondPage = await searchAs(alice, {
      q: 'needle',
      roomId: room.id,
      limit: 2,
      offset: 2,
    });
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.total).toBe(5);
    expect(secondPage.body.offset).toBe(2);
    expect(contents(secondPage)).toEqual(['needle 3', 'needle 2']);
  });
});
