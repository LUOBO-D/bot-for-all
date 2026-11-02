import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool, type RowDataPacket } from '../src/db';
import { createTestUser, tokenFor } from './helpers';
import type { AuthUser } from '../src/types';

const app = createApp();

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function patchRole(actor: AuthUser, targetId: number, role: string) {
  return request(app)
    .patch(`/api/admin/users/${targetId}/role`)
    .set('Authorization', bearer(tokenFor(actor)))
    .send({ role });
}

function listAudit(token: string, query: Record<string, string> = {}) {
  return request(app)
    .get('/api/admin/audit')
    .query(query)
    .set('Authorization', bearer(token));
}

function getUser(token: string, userId: number) {
  return request(app)
    .get(`/api/admin/users/${userId}`)
    .set('Authorization', bearer(token));
}

async function roleOf(userId: number): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT role FROM users WHERE id = ?',
    [userId],
  );
  return rows[0] ? String(rows[0].role) : null;
}

describe('admin user role', () => {
  it('promotes a regular user to admin, records it and returns the list row', async () => {
    const admin = await createTestUser('role_promote_admin', 'admin');
    const target = await createTestUser('role_promote_target');

    const response = await patchRole(admin, target.id, 'admin');

    expect(response.status).toBe(200);
    expect(response.body.user.role).toBe('admin');
    expect(response.body.user.id).toBe(target.id);
    expect(await roleOf(target.id)).toBe('admin');

    // The response is exactly the shape of one row of GET /api/admin/users.
    const list = await request(app)
      .get('/api/admin/users')
      .query({ q: 'role_promote_target' })
      .set('Authorization', bearer(tokenFor(admin)));
    expect(list.status).toBe(200);
    expect(response.body.user).toEqual(list.body.users[0]);

    const detail = await getUser(tokenFor(admin), target.id);
    expect(detail.status).toBe(200);
    expect(detail.body.user).toEqual(response.body.user);

    const audit = await listAudit(tokenFor(admin), { action: 'user.role' });
    expect(audit.status).toBe(200);
    expect(audit.body.total).toBe(1);
    expect(audit.body.entries[0]).toEqual({
      id: expect.any(Number),
      actorId: admin.id,
      actorName: 'role_promote_admin',
      action: 'user.role',
      targetType: 'user',
      targetId: target.id,
      detail: { from: 'user', to: 'admin' },
      createdAt: expect.any(String),
    });
  });

  it('demotes another admin back to user', async () => {
    const actor = await createTestUser('role_demote_actor', 'admin');
    const target = await createTestUser('role_demote_target', 'admin');

    const response = await patchRole(actor, target.id, 'user');

    expect(response.status).toBe(200);
    expect(response.body.user.role).toBe('user');
    expect(await roleOf(target.id)).toBe('user');
    expect(await roleOf(actor.id)).toBe('admin');

    const audit = await listAudit(tokenFor(actor), { action: 'user.role' });
    expect(audit.body.total).toBe(1);
    expect(audit.body.entries[0]).toMatchObject({
      actorId: actor.id,
      action: 'user.role',
      targetType: 'user',
      targetId: target.id,
      detail: { from: 'admin', to: 'user' },
    });
  });

  it('refuses to demote the last active admin', async () => {
    const admin = await createTestUser('role_last_admin', 'admin');

    const response = await patchRole(admin, admin.id, 'user');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('LAST_ADMIN');
    expect(await roleOf(admin.id)).toBe('admin');
    expect((await listAudit(tokenFor(admin), { action: 'user.role' })).body.total).toBe(0);
  });

  it('refuses to change your own role', async () => {
    const actor = await createTestUser('role_self_actor', 'admin');
    await createTestUser('role_self_other', 'admin');

    const demote = await patchRole(actor, actor.id, 'user');
    expect(demote.status).toBe(400);
    expect(demote.body.error.code).toBe('CANNOT_CHANGE_SELF_ROLE');

    const promote = await patchRole(actor, actor.id, 'admin');
    expect(promote.status).toBe(400);
    expect(promote.body.error.code).toBe('CANNOT_CHANGE_SELF_ROLE');

    expect(await roleOf(actor.id)).toBe('admin');
  });

  it('rejects bot accounts as targets', async () => {
    const admin = await createTestUser('role_bot_admin', 'admin');
    const bot = await createTestUser('role_bot_target', 'user', 'bot');

    const response = await patchRole(admin, bot.id, 'admin');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_TARGET');
    expect(await roleOf(bot.id)).toBe('user');
  });

  it('rejects an unknown target', async () => {
    const admin = await createTestUser('role_missing_admin', 'admin');

    const response = await patchRole(admin, 999999, 'admin');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('rejects an invalid role payload', async () => {
    const admin = await createTestUser('role_payload_admin', 'admin');
    const target = await createTestUser('role_payload_target');

    const response = await patchRole(admin, target.id, 'owner');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_INPUT');
    expect(await roleOf(target.id)).toBe('user');
  });

  it('rejects non-admin callers', async () => {
    const actor = await createTestUser('role_plain_actor');
    const target = await createTestUser('role_plain_target');

    const response = await patchRole(actor, target.id, 'admin');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ADMIN_REQUIRED');
    expect(await roleOf(target.id)).toBe('user');
  });
});
