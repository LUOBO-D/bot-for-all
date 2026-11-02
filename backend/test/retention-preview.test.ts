import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import { joinRoom as joinRoomService, setMemberRole } from '../src/services/room';
import type { AuthUser } from '../src/types';
import { toIso } from '../src/utils';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();
const MINUTES_PER_DAY = 24 * 60;

let owner: AuthUser;
let roomId: number;
let nextSeq: number;

beforeEach(async () => {
  owner = await createTestUser(`preview_owner_${randomBytes(3).toString('hex')}`);
  roomId = await createTestRoom(owner);
  nextSeq = 1;
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

async function setRetention(days: number): Promise<void> {
  await pool.execute('UPDATE rooms SET retention_days = ? WHERE id = ?', [days, roomId]);
}

/** Seeds a message `ageMinutes` old; pinned messages are never candidates. */
async function createMessage(
  ageMinutes: number,
  options: { pinned?: boolean } = {},
): Promise<number> {
  const seq = nextSeq;
  nextSeq += 1;
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO messages
       (room_id, seq, sender_id, sender_type, content, kind, status, created_at, pinned_at, pinned_by)
     VALUES (?, ?, ?, 'user', 'seed', 'text', 'done', TIMESTAMPADD(MINUTE, -?, NOW(3)), ?, ?)`,
    [
      roomId,
      seq,
      owner.id,
      ageMinutes,
      options.pinned ? new Date() : null,
      options.pinned ? owner.id : null,
    ],
  );
  return result.insertId;
}

function getPreview(actor: AuthUser, query = ''): request.Test {
  return request(app)
    .get(`/api/rooms/${roomId}/retention/preview${query}`)
    .set('Authorization', auth(actor));
}

describe('GET /api/rooms/:id/retention/preview', () => {
  it('counts only expired unpinned messages and reports the oldest timestamp', async () => {
    await setRetention(7);
    const oldest = await createMessage(9 * MINUTES_PER_DAY);
    await createMessage(8 * MINUTES_PER_DAY);
    await createMessage(1 * MINUTES_PER_DAY);
    await createMessage(9 * MINUTES_PER_DAY, { pinned: true });

    const response = await getPreview(owner);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ retentionDays: 7, messages: 2 });

    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT created_at FROM messages WHERE id = ?',
      [oldest],
    );
    expect(response.body.oldestAt).toBe(toIso(rows[0]?.created_at));
  });

  it('uses the same strict cutoff as the sweep: older than N days, not equal', async () => {
    await setRetention(7);
    await createMessage(7 * MINUTES_PER_DAY + 1);
    await createMessage(7 * MINUTES_PER_DAY - 1);

    const response = await getPreview(owner);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ retentionDays: 7, messages: 1 });
  });

  it('counts withdrawn messages too, because the sweep deletes them as well', async () => {
    await setRetention(7);
    const withdrawn = await createMessage(8 * MINUTES_PER_DAY);
    await pool.execute('UPDATE messages SET deleted_at = NOW(3) WHERE id = ?', [withdrawn]);

    const response = await getPreview(owner);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ retentionDays: 7, messages: 1 });
  });

  it('returns zeros and a null timestamp when retention is disabled', async () => {
    await setRetention(0);
    await createMessage(4000);

    const response = await getPreview(owner);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ retentionDays: 0, messages: 0, oldestAt: null });
  });

  it('reports no candidates when nothing is expired', async () => {
    await setRetention(7);
    await createMessage(1);
    await createMessage(2 * MINUTES_PER_DAY);

    const response = await getPreview(owner);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ retentionDays: 7, messages: 0, oldestAt: null });
  });

  it('lets the owner, a room admin and a global admin preview; not a plain member', async () => {
    await setRetention(7);
    await createMessage(8 * MINUTES_PER_DAY);

    const ownerView = await getPreview(owner);
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.messages).toBe(1);

    const member = await createTestUser(`preview_member_${randomBytes(3).toString('hex')}`);
    await joinRoomService(member.id, roomId);
    const denied = await getPreview(member);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    await setMemberRole(roomId, owner.id, 'user', member.id, 'admin');
    const roomAdminView = await getPreview(member);
    expect(roomAdminView.status).toBe(200);
    expect(roomAdminView.body.messages).toBe(1);

    const admin = await createTestUser(
      `preview_admin_${randomBytes(3).toString('hex')}`,
      'admin',
    );
    const globalAdminView = await getPreview(admin);
    expect(globalAdminView.status).toBe(200);
    expect(globalAdminView.body.messages).toBe(1);
  });

  it('refuses non-members even for a public room', async () => {
    await setRetention(7);
    await createMessage(8 * MINUTES_PER_DAY);
    const outsider = await createTestUser(`preview_outsider_${randomBytes(3).toString('hex')}`);

    const response = await getPreview(outsider);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
    expect(response.body.error.code).not.toBe('ROOM_OWNER_REQUIRED');
  });

  it('previews an unsaved policy through ?days without touching the stored one', async () => {
    await setRetention(7);
    const expired = await createMessage(10 * MINUTES_PER_DAY);

    const saved = await getPreview(owner);
    expect(saved.body).toMatchObject({ retentionDays: 7, messages: 1 });

    const wider = await getPreview(owner, '?days=30');
    expect(wider.status).toBe(200);
    expect(wider.body).toEqual({ retentionDays: 30, messages: 0, oldestAt: null });

    const narrower = await getPreview(owner, '?days=8');
    expect(narrower.body).toMatchObject({ retentionDays: 8, messages: 1 });

    const off = await getPreview(owner, '?days=0');
    expect(off.body).toEqual({ retentionDays: 0, messages: 0, oldestAt: null });

    const [roomRows] = await pool.execute<RowDataPacket[]>(
      'SELECT retention_days FROM rooms WHERE id = ?',
      [roomId],
    );
    expect(Number(roomRows[0]?.retention_days)).toBe(7);
    const [messageRows] = await pool.execute<RowDataPacket[]>(
      'SELECT id FROM messages WHERE id = ?',
      [expired],
    );
    expect(messageRows).toHaveLength(1);
  });

  it('rejects malformed or out-of-range ?days values', async () => {
    await setRetention(7);

    for (const query of ['?days=-1', '?days=3651', '?days=1.5', '?days=abc']) {
      const response = await getPreview(owner, query);
      expect(response.status, query).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects invalid room ids before touching the database', async () => {
    for (const id of ['abc', '0', '-1', '1.5']) {
      const response = await request(app)
        .get(`/api/rooms/${id}/retention/preview`)
        .set('Authorization', auth(owner));
      expect(response.status, id).toBe(400);
      expect(response.body.error.code).toBe('INVALID_ROOM_ID');
    }
  });

  it('returns 404 for a room that does not exist', async () => {
    const admin = await createTestUser(`preview_admin_${randomBytes(3).toString('hex')}`, 'admin');
    const response = await request(app)
      .get('/api/rooms/999999999/retention/preview')
      .set('Authorization', auth(admin));
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ROOM_NOT_FOUND');
  });
});
