import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createRoom, joinRoom, listRooms, searchPublicRooms } from '../src/services/room';
import type { AuthUser } from '../src/types';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function getRooms(token: string) {
  return request(app).get('/api/rooms').set('Authorization', bearer(token));
}

function getPublicRooms(
  token: string,
  query: Record<string, string | number> = {},
) {
  return request(app)
    .get('/api/rooms/public')
    .query(query)
    .set('Authorization', bearer(token));
}

async function createPublicRooms(
  owner: AuthUser,
  prefix: string,
  count: number,
): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const room = await createRoom(owner.id, { name: `${prefix}-${i}`, isPublic: true });
    ids.push(room.id);
  }
  return ids;
}

describe('public room discovery', () => {
  it('caps the public list at 100 rooms and reports the real total', async () => {
    const owner = await createTestUser('public_cap_owner');
    const viewer = await createTestUser('public_cap_viewer');
    const ids = await createPublicRooms(owner, 'cap', 120);
    await createRoom(owner.id, { name: 'cap-private', isPublic: false });

    const res = await getRooms(tokenFor(viewer)).expect(200);
    expect(res.body.publicTotal).toBe(120);
    expect(res.body.public).toHaveLength(100);
    expect(res.body.mine).toEqual([]);

    const returned = (res.body.public as Array<{ id: number }>).map((room) => room.id);
    // Newest first: the 20 oldest rooms are the ones cut off.
    expect(returned).toEqual([...ids].sort((a, b) => b - a).slice(0, 100));
    expect(returned).not.toContain(ids[0]);
  });

  it('excludes private rooms and rooms the caller already joined', async () => {
    const owner = await createTestUser('public_filter_owner');
    const viewer = await createTestUser('public_filter_viewer');
    const open = await createRoom(owner.id, { name: 'filter-open', isPublic: true });
    const joined = await createRoom(owner.id, { name: 'filter-joined', isPublic: true });
    await createRoom(owner.id, { name: 'filter-private', isPublic: false });
    await joinRoom(viewer.id, joined.id);

    const list = await listRooms(viewer.id);
    expect(list.public.map((room) => room.id)).toEqual([open.id]);
    expect(list.publicTotal).toBe(1);

    const res = await getPublicRooms(tokenFor(viewer)).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rooms.map((room: { id: number }) => room.id)).toEqual([open.id]);
  });

  it('searches public rooms by name', async () => {
    const owner = await createTestUser('public_search_owner');
    const viewer = await createTestUser('public_search_viewer');
    const alpha = await createRoom(owner.id, { name: 'alpha-team', isPublic: true });
    await createRoom(owner.id, { name: 'beta-room', isPublic: true });
    await createRoom(owner.id, { name: 'alpha-private', isPublic: false });

    const res = await getPublicRooms(tokenFor(viewer), { q: 'alpha' }).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(res.body.rooms.map((room: { id: number }) => room.id)).toEqual([alpha.id]);

    const none = await getPublicRooms(tokenFor(viewer), { q: 'zzz' }).expect(200);
    expect(none.body.total).toBe(0);
    expect(none.body.rooms).toEqual([]);
  });

  it('treats LIKE wildcards as literal characters', async () => {
    const owner = await createTestUser('public_like_owner');
    const viewer = await createTestUser('public_like_viewer');
    await createRoom(owner.id, { name: 'plain room', isPublic: true });
    const percent = await createRoom(owner.id, { name: '100% real', isPublic: true });
    const underscore = await createRoom(owner.id, { name: 'under_score', isPublic: true });

    const byPercent = await searchPublicRooms(viewer.id, { q: '%' });
    expect(byPercent.total).toBe(1);
    expect(byPercent.rooms.map((room) => room.id)).toEqual([percent.id]);

    const byUnderscore = await searchPublicRooms(viewer.id, { q: '_' });
    expect(byUnderscore.total).toBe(1);
    expect(byUnderscore.rooms.map((room) => room.id)).toEqual([underscore.id]);

    const both = await searchPublicRooms(viewer.id, { q: '%_' });
    expect(both.total).toBe(0);
    expect(both.rooms).toEqual([]);
  });

  it('pages results with a stable total', async () => {
    const owner = await createTestUser('public_page_owner');
    const viewer = await createTestUser('public_page_viewer');
    const ids = await createPublicRooms(owner, 'page', 5);
    const newestFirst = [...ids].sort((a, b) => b - a);

    const first = await getPublicRooms(tokenFor(viewer), { limit: 2 }).expect(200);
    expect(first.body.total).toBe(5);
    expect(first.body.limit).toBe(2);
    expect(first.body.offset).toBe(0);
    expect(first.body.rooms.map((room: { id: number }) => room.id)).toEqual(
      newestFirst.slice(0, 2),
    );

    const second = await getPublicRooms(tokenFor(viewer), { limit: 2, offset: 2 }).expect(200);
    expect(second.body.total).toBe(5);
    expect(second.body.rooms.map((room: { id: number }) => room.id)).toEqual(
      newestFirst.slice(2, 4),
    );

    const last = await getPublicRooms(tokenFor(viewer), { limit: 2, offset: 4 }).expect(200);
    expect(last.body.rooms.map((room: { id: number }) => room.id)).toEqual(
      newestFirst.slice(4),
    );

    const past = await getPublicRooms(tokenFor(viewer), { limit: 2, offset: 10 }).expect(200);
    expect(past.body.total).toBe(5);
    expect(past.body.rooms).toEqual([]);
  });

  it('requires authentication', async () => {
    await request(app).get('/api/rooms/public').expect(401);
    await request(app).get('/api/rooms/public').query({ q: 'x' }).expect(401);
  });

  it('rejects invalid search parameters', async () => {
    const viewer = await createTestUser('public_invalid_viewer');
    const token = tokenFor(viewer);

    await getPublicRooms(token, { limit: 0 }).expect(400);
    await getPublicRooms(token, { limit: 101 }).expect(400);
    await getPublicRooms(token, { limit: 'abc' }).expect(400);
    await getPublicRooms(token, { offset: -1 }).expect(400);
    await getPublicRooms(token, { q: 'x'.repeat(65) }).expect(400);
  });
});
