import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool, type RowDataPacket } from '../src/db';
import type { AuthUser } from '../src/types';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function bulkStatus(actor: AuthUser, body: unknown) {
  return request(app)
    .patch('/api/admin/users/bulk-status')
    .set('Authorization', bearer(tokenFor(actor)))
    .send(body as object);
}

async function statusOf(userId: number): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT status FROM users WHERE id = ?',
    [userId],
  );
  return rows[0] ? String(rows[0].status) : null;
}

async function setStatus(userId: number, status: 'active' | 'banned'): Promise<void> {
  await pool.execute('UPDATE users SET status = ? WHERE id = ?', [status, userId]);
}

function listStatusAudit(token: string) {
  return request(app)
    .get('/api/admin/audit')
    .query({ action: 'user.status' })
    .set('Authorization', bearer(token));
}

describe('admin bulk status', () => {
  it('bans every selected user and audits only the rows that changed', async () => {
    const admin = await createTestUser('bulk_ban_admin', 'admin');
    const first = await createTestUser('bulk_ban_first');
    const second = await createTestUser('bulk_ban_second');
    const already = await createTestUser('bulk_ban_already');
    await setStatus(already.id, 'banned');

    const response = await bulkStatus(admin, {
      userIds: [first.id, second.id, already.id],
      status: 'banned',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: 2, unchanged: 1 });
    expect(await statusOf(first.id)).toBe('banned');
    expect(await statusOf(second.id)).toBe('banned');
    expect(await statusOf(already.id)).toBe('banned');

    const audit = await listStatusAudit(tokenFor(admin));
    expect(audit.status).toBe(200);
    expect(audit.body.total).toBe(2);
    expect(audit.body.entries.map((entry: { targetId: number }) => entry.targetId).sort())
      .toEqual([first.id, second.id].sort());
    for (const entry of audit.body.entries) {
      expect(entry).toMatchObject({
        actorId: admin.id,
        actorName: 'bulk_ban_admin',
        action: 'user.status',
        targetType: 'user',
        detail: { from: 'active', to: 'banned', bulk: true },
      });
    }
  });

  it('unbans every selected user and records the transition back to active', async () => {
    const admin = await createTestUser('bulk_unban_admin', 'admin');
    const first = await createTestUser('bulk_unban_first');
    const second = await createTestUser('bulk_unban_second');
    await setStatus(first.id, 'banned');
    await setStatus(second.id, 'banned');

    const response = await bulkStatus(admin, {
      userIds: [first.id, second.id],
      status: 'active',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: 2, unchanged: 0 });
    expect(await statusOf(first.id)).toBe('active');
    expect(await statusOf(second.id)).toBe('active');

    const audit = await listStatusAudit(tokenFor(admin));
    expect(audit.body.total).toBe(2);
    for (const entry of audit.body.entries) {
      expect(entry.detail).toEqual({ from: 'banned', to: 'active', bulk: true });
    }
  });

  it('deduplicates repeated ids before counting and auditing', async () => {
    const admin = await createTestUser('bulk_dedup_admin', 'admin');
    const first = await createTestUser('bulk_dedup_first');
    const second = await createTestUser('bulk_dedup_second');

    const response = await bulkStatus(admin, {
      userIds: [first.id, first.id, second.id, first.id],
      status: 'banned',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: 2, unchanged: 0 });

    const audit = await listStatusAudit(tokenFor(admin));
    expect(audit.body.total).toBe(2);
    expect(audit.body.entries.map((entry: { targetId: number }) => entry.targetId).sort())
      .toEqual([first.id, second.id].sort());
  });

  it('rolls the whole batch back when one id does not exist', async () => {
    const admin = await createTestUser('bulk_missing_admin', 'admin');
    const first = await createTestUser('bulk_missing_first');
    const second = await createTestUser('bulk_missing_second');

    const response = await bulkStatus(admin, {
      userIds: [first.id, 999_999, second.id],
      status: 'banned',
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('USER_NOT_FOUND');
    expect(await statusOf(first.id)).toBe('active');
    expect(await statusOf(second.id)).toBe('active');
    expect((await listStatusAudit(tokenFor(admin))).body.total).toBe(0);
  });

  it('rejects bot accounts without changing the human targets', async () => {
    const admin = await createTestUser('bulk_bot_admin', 'admin');
    const human = await createTestUser('bulk_bot_human');
    const bot = await createTestUser('bulk_bot_target', 'user', 'bot');

    const response = await bulkStatus(admin, {
      userIds: [human.id, bot.id],
      status: 'banned',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BOT_STATUS_UNSUPPORTED');
    expect(await statusOf(human.id)).toBe('active');
    expect(await statusOf(bot.id)).toBe('active');
    expect((await listStatusAudit(tokenFor(admin))).body.total).toBe(0);
  });

  it('refuses to include the acting admin', async () => {
    const actor = await createTestUser('bulk_self_actor', 'admin');
    await createTestUser('bulk_self_other_admin', 'admin');
    const target = await createTestUser('bulk_self_target');

    const response = await bulkStatus(actor, {
      userIds: [target.id, actor.id],
      status: 'banned',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CANNOT_BAN_SELF');
    expect(await statusOf(target.id)).toBe('active');
    expect(await statusOf(actor.id)).toBe('active');
    expect((await listStatusAudit(tokenFor(actor))).body.total).toBe(0);
  });

  it('refuses a batch that would leave no active admin', async () => {
    const admin = await createTestUser('bulk_last_admin', 'admin');
    const target = await createTestUser('bulk_last_target');

    const response = await bulkStatus(admin, {
      userIds: [target.id, admin.id],
      status: 'banned',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('LAST_ADMIN');
    expect(await statusOf(target.id)).toBe('active');
    expect(await statusOf(admin.id)).toBe('active');
    expect((await listStatusAudit(tokenFor(admin))).body.total).toBe(0);
  });

  it('rejects non-admin callers', async () => {
    const actor = await createTestUser('bulk_plain_actor');
    const target = await createTestUser('bulk_plain_target');

    const response = await bulkStatus(actor, {
      userIds: [target.id],
      status: 'banned',
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ADMIN_REQUIRED');
    expect(await statusOf(target.id)).toBe('active');
  });

  it('rejects malformed payloads', async () => {
    const admin = await createTestUser('bulk_payload_admin', 'admin');
    const target = await createTestUser('bulk_payload_target');

    const bodies: unknown[] = [
      {},
      { userIds: [], status: 'banned' },
      { userIds: [target.id] },
      { userIds: [target.id], status: 'disabled' },
      { userIds: [0], status: 'banned' },
      { userIds: [-1], status: 'banned' },
      { userIds: [1.5], status: 'banned' },
      { userIds: ['1'], status: 'banned' },
      { userIds: [null], status: 'banned' },
      { userIds: Array.from({ length: 101 }, (_, index) => index + 1), status: 'banned' },
    ];

    for (const body of bodies) {
      const response = await bulkStatus(admin, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }
    expect(await statusOf(target.id)).toBe('active');
  });
});
