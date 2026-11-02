import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool, type RowDataPacket } from '../src/db';
import { saveDraft } from '../src/services/drafts';
import { createRoom, joinRoom, leaveRoom } from '../src/services/room';
import type { AuthUser } from '../src/types';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

// test/setup.ts truncates the core tables but not user_drafts, so clear the
// rows here: recycled ids would otherwise surface in the next test.
beforeEach(async () => {
  await pool.execute('DELETE FROM user_drafts');
});

afterAll(async () => {
  await pool.execute('DELETE FROM user_drafts');
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

function getBox(actor: AuthUser): Promise<request.Response> {
  return request(app).get('/api/me/drafts').set('Authorization', auth(actor));
}

describe('draft box', () => {
  it('requires authentication', async () => {
    const response = await request(app).get('/api/me/drafts');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('lists the caller’s drafts newest first with room names and ISO timestamps', async () => {
    const owner = await createTestUser('box_order_owner');
    const alpha = await createRoom(owner.id, { name: 'alpha room', topic: '' });
    const beta = await createRoom(owner.id, { name: 'beta room', topic: '' });
    const gamma = await createRoom(owner.id, { name: 'gamma room', topic: '' });

    await saveDraft(owner.id, alpha.id, 'alpha draft');
    await saveDraft(owner.id, beta.id, 'beta draft');
    await saveDraft(owner.id, gamma.id, 'gamma draft');
    // Backdate each row so the ordering is independent of clock resolution.
    for (const [roomId, stamp] of [
      [alpha.id, '2024-01-01T00:00:00.000Z'],
      [beta.id, '2024-02-01T00:00:00.000Z'],
      [gamma.id, '2024-03-01T00:00:00.000Z'],
    ] as const) {
      await pool.execute(
        'UPDATE user_drafts SET updated_at = ? WHERE user_id = ? AND room_id = ?',
        [new Date(stamp), owner.id, roomId],
      );
    }

    const response = await getBox(owner);
    expect(response.status).toBe(200);
    expect(response.body.drafts.map((draft: { roomId: number }) => draft.roomId)).toEqual([
      gamma.id,
      beta.id,
      alpha.id,
    ]);
    expect(response.body.drafts[0]).toEqual({
      roomId: gamma.id,
      roomName: 'gamma room',
      content: 'gamma draft',
      updatedAt: new Date('2024-03-01T00:00:00.000Z').toISOString(),
    });
    for (const draft of response.body.drafts) {
      expect(Number.isNaN(Date.parse(draft.updatedAt))).toBe(false);
    }
  });

  it('keeps each user’s box private even inside the same room', async () => {
    const owner = await createTestUser('box_iso_owner');
    const member = await createTestUser('box_iso_member');
    const shared = await createRoom(owner.id, { name: 'shared room', topic: '' });
    const other = await createRoom(owner.id, { name: 'other room', topic: '' });
    await joinRoom(member.id, shared.id);
    await joinRoom(member.id, other.id);

    await saveDraft(owner.id, shared.id, 'owner secret');
    await saveDraft(member.id, shared.id, 'member secret');
    await saveDraft(member.id, other.id, 'member elsewhere');

    const ownerBox = await getBox(owner);
    expect(ownerBox.body.drafts).toHaveLength(1);
    expect(ownerBox.body.drafts[0]).toMatchObject({
      roomId: shared.id,
      content: 'owner secret',
    });

    const memberBox = await getBox(member);
    expect(memberBox.body.drafts).toHaveLength(2);
    expect(
      memberBox.body.drafts.map((draft: { content: string }) => draft.content),
    ).toEqual(expect.arrayContaining(['member secret', 'member elsewhere']));
    expect(
      memberBox.body.drafts.some(
        (draft: { content: string }) => draft.content === 'owner secret',
      ),
    ).toBe(false);
  });

  it('hides drafts for rooms the caller no longer belongs to until they rejoin', async () => {
    const owner = await createTestUser('box_member_owner');
    const member = await createTestUser('box_member_leaver');
    const room = await createRoom(owner.id, { name: 'leave room', topic: '' });
    await joinRoom(member.id, room.id);
    await saveDraft(owner.id, room.id, 'owner draft');
    await saveDraft(member.id, room.id, 'member draft');

    await leaveRoom(member.id, room.id);

    const afterLeave = await getBox(member);
    expect(afterLeave.status).toBe(200);
    expect(afterLeave.body.drafts).toEqual([]);

    // The draft row survives the membership removal, so rejoining restores it.
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT content FROM user_drafts WHERE user_id = ?',
      [member.id],
    );
    expect(rows).toHaveLength(1);

    const ownerBox = await getBox(owner);
    expect(ownerBox.body.drafts).toHaveLength(1);
    expect(ownerBox.body.drafts[0].content).toBe('owner draft');

    await joinRoom(member.id, room.id);
    const afterRejoin = await getBox(member);
    expect(afterRejoin.body.drafts).toHaveLength(1);
    expect(afterRejoin.body.drafts[0]).toMatchObject({
      roomId: room.id,
      roomName: 'leave room',
      content: 'member draft',
    });
  });

  it('omits empty content rows', async () => {
    const owner = await createTestUser('box_empty_owner');
    const blankRoom = await createRoom(owner.id, { name: 'blank room', topic: '' });
    const keptRoom = await createRoom(owner.id, { name: 'kept room', topic: '' });
    // saveDraft('') deletes instead of storing; insert directly to pin the
    // defensive filter against legacy/imported blank rows.
    await pool.execute('INSERT INTO user_drafts (user_id, room_id, content) VALUES (?, ?, ?)', [
      owner.id,
      blankRoom.id,
      '',
    ]);
    await saveDraft(owner.id, keptRoom.id, 'keep me');

    const response = await getBox(owner);
    expect(response.status).toBe(200);
    expect(response.body.drafts).toHaveLength(1);
    expect(response.body.drafts[0]).toMatchObject({
      roomId: keptRoom.id,
      content: 'keep me',
    });
  });

  it('returns at most the 50 newest drafts', async () => {
    const owner = await createTestUser('box_limit_owner');
    const roomIds: number[] = [];
    for (let index = 0; index < 55; index += 1) {
      const room = await createRoom(owner.id, { name: `box room ${index}`, topic: '' });
      roomIds.push(room.id);
    }
    const base = Date.parse('2024-01-01T00:00:00.000Z');
    for (const [index, roomId] of roomIds.entries()) {
      await pool.execute(
        'INSERT INTO user_drafts (user_id, room_id, content, updated_at) VALUES (?, ?, ?, ?)',
        [owner.id, roomId, `draft ${index}`, new Date(base + index * 60_000)],
      );
    }

    const response = await getBox(owner);
    expect(response.status).toBe(200);
    expect(response.body.drafts).toHaveLength(50);
    // Newest first: index 54 down to index 5; the five oldest fall outside.
    expect(response.body.drafts[0].content).toBe('draft 54');
    expect(response.body.drafts[49].content).toBe('draft 5');
  });
});
