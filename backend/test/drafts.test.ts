import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { pool, type RowDataPacket } from '../src/db';
import { joinRoom } from '../src/services/room';
import type { AuthUser } from '../src/types';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

// test/setup.ts truncates the core tables but not user_drafts, so clear the
// drafts here: leftover rows would otherwise resurface under recycled ids.
beforeEach(async () => {
  await pool.execute('DELETE FROM user_drafts');
});

afterAll(async () => {
  await pool.execute('DELETE FROM user_drafts');
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

function getDraft(roomId: number, actor: AuthUser): Promise<request.Response> {
  return request(app).get(`/api/rooms/${roomId}/draft`).set('Authorization', auth(actor));
}

function putDraft(
  roomId: number,
  actor: AuthUser,
  content: unknown,
): Promise<request.Response> {
  return request(app)
    .put(`/api/rooms/${roomId}/draft`)
    .set('Authorization', auth(actor))
    .send({ content });
}

async function draftRows(userId: number): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT room_id, content FROM user_drafts WHERE user_id = ? ORDER BY room_id',
    [userId],
  );
  return rows;
}

describe('room drafts', () => {
  it('saves a draft and reads it back with an ISO timestamp', async () => {
    const owner = await createTestUser('draft_owner');
    const roomId = await createTestRoom(owner);

    const saved = await putDraft(roomId, owner, 'hello draft');
    expect(saved.status).toBe(200);
    expect(saved.body.draft.content).toBe('hello draft');
    expect(typeof saved.body.draft.updatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(saved.body.draft.updatedAt))).toBe(false);

    const fetched = await getDraft(roomId, owner);
    expect(fetched.status).toBe(200);
    expect(fetched.body.draft).toEqual(saved.body.draft);

    expect(await draftRows(owner.id)).toHaveLength(1);
  });

  it('answers null when no draft exists', async () => {
    const owner = await createTestUser('draft_empty_owner');
    const roomId = await createTestRoom(owner);

    const response = await getDraft(roomId, owner);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ draft: null });
  });

  it('updates the existing row instead of inserting a second one', async () => {
    const owner = await createTestUser('draft_update_owner');
    const roomId = await createTestRoom(owner);

    const first = await putDraft(roomId, owner, 'first version');
    expect(first.status).toBe(200);
    // Backdate the row so the ON DUPLICATE UPDATE bump is observable without
    // waiting on the millisecond clock.
    const backdated = '2020-01-01T00:00:00.000Z';
    await pool.execute(
      'UPDATE user_drafts SET updated_at = ? WHERE user_id = ? AND room_id = ?',
      [new Date(backdated), owner.id, roomId],
    );
    const second = await putDraft(roomId, owner, 'second version');

    expect(second.status).toBe(200);
    expect(second.body.draft.content).toBe('second version');
    expect(Date.parse(second.body.draft.updatedAt)).toBeGreaterThan(Date.parse(backdated));
    expect(await draftRows(owner.id)).toHaveLength(1);

    const fetched = await getDraft(roomId, owner);
    expect(fetched.body.draft.content).toBe('second version');
  });

  it('deletes the row when the draft is cleared with an empty string', async () => {
    const owner = await createTestUser('draft_clear_owner');
    const roomId = await createTestRoom(owner);

    await putDraft(roomId, owner, 'will be cleared');
    expect(await draftRows(owner.id)).toHaveLength(1);

    const cleared = await putDraft(roomId, owner, '');
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ draft: null });
    expect(await draftRows(owner.id)).toHaveLength(0);

    const fetched = await getDraft(roomId, owner);
    expect(fetched.body).toEqual({ draft: null });

    // Clearing an already-empty draft stays idempotent.
    const again = await putDraft(roomId, owner, '');
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ draft: null });
  });

  it('keeps drafts isolated per user and per room', async () => {
    const owner = await createTestUser('draft_iso_owner');
    const member = await createTestUser('draft_iso_member');
    const otherRoom = await createTestRoom(owner);
    const roomId = await createTestRoom(owner);
    await joinRoom(member.id, roomId);

    await putDraft(roomId, owner, 'owner here');
    await putDraft(roomId, member, 'member here');
    await putDraft(otherRoom, owner, 'owner elsewhere');

    expect((await getDraft(roomId, owner)).body.draft.content).toBe('owner here');
    expect((await getDraft(roomId, member)).body.draft.content).toBe('member here');
    expect((await getDraft(otherRoom, owner)).body.draft.content).toBe('owner elsewhere');

    // The member has no draft in the second room just because the owner does.
    const memberElsewhere = await getDraft(otherRoom, member);
    expect(memberElsewhere.status).toBe(403);
    expect(memberElsewhere.body.error.code).toBe('NOT_MEMBER');

    // Clearing one draft leaves every other draft untouched.
    await putDraft(roomId, owner, '');
    expect((await getDraft(roomId, member)).body.draft.content).toBe('member here');
    expect((await getDraft(otherRoom, owner)).body.draft.content).toBe('owner elsewhere');
  });

  it('rejects non-members on both read and write', async () => {
    const owner = await createTestUser('draft_guard_owner');
    const stranger = await createTestUser('draft_guard_stranger');
    const roomId = await createTestRoom(owner);

    const read = await getDraft(roomId, stranger);
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe('NOT_MEMBER');

    const write = await putDraft(roomId, stranger, 'sneaky');
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('NOT_MEMBER');
    expect(await draftRows(stranger.id)).toHaveLength(0);

    const anonymous = await request(app).get(`/api/rooms/${roomId}/draft`);
    expect(anonymous.status).toBe(401);
  });

  it('rejects content longer than 4000 characters without touching the draft', async () => {
    const owner = await createTestUser('draft_long_owner');
    const roomId = await createTestRoom(owner);
    await putDraft(roomId, owner, 'keep me');

    const tooLong = await putDraft(roomId, owner, 'x'.repeat(4001));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('INVALID_INPUT');
    expect((await getDraft(roomId, owner)).body.draft.content).toBe('keep me');

    const atLimit = await putDraft(roomId, owner, 'x'.repeat(4000));
    expect(atLimit.status).toBe(200);
    expect(atLimit.body.draft.content).toHaveLength(4000);
  });

  it('rejects a missing or non-string content field', async () => {
    const owner = await createTestUser('draft_shape_owner');
    const roomId = await createTestRoom(owner);

    const missing = await request(app)
      .put(`/api/rooms/${roomId}/draft`)
      .set('Authorization', auth(owner))
      .send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_INPUT');

    const wrongType = await putDraft(roomId, owner, 42);
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.code).toBe('INVALID_INPUT');
    expect(await draftRows(owner.id)).toHaveLength(0);
  });

  // Last in the file: the limiter is process-wide and its buckets outlive a
  // single test, so no later test should reuse this user's draft key.
  it('allows 60 saves per user per minute and rejects the 61st', async () => {
    const owner = await createTestUser('draft_rate_owner');
    const roomId = await createTestRoom(owner);
    const original = config.rateLimitEnabled;
    config.rateLimitEnabled = true;
    try {
      for (let hit = 1; hit <= 60; hit += 1) {
        const response = await putDraft(roomId, owner, `draft ${hit}`);
        expect(response.status).toBe(200);
      }
      const limited = await putDraft(roomId, owner, 'one too many');
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      // The rejected write never reached the table.
      expect((await getDraft(roomId, owner)).body.draft.content).toBe('draft 60');
    } finally {
      config.rateLimitEnabled = original;
    }
  });
});
