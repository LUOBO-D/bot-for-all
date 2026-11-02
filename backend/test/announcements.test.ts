import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool } from '../src/db';
import type { AuthUser } from '../src/types';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function publish(admin: AuthUser, body: unknown) {
  return request(app)
    .post('/api/admin/announcements')
    .set('Authorization', bearer(tokenFor(admin)))
    .send({ body });
}

function current(token?: string) {
  const req = request(app).get('/api/announcements/current');
  return token ? req.set('Authorization', bearer(token)) : req;
}

function listAnnouncements(token: string) {
  return request(app)
    .get('/api/admin/announcements')
    .set('Authorization', bearer(token));
}

function deactivate(token: string, id: number | string) {
  return request(app)
    .delete(`/api/admin/announcements/${id}`)
    .set('Authorization', bearer(token));
}

function auditEntries(token: string, action: string) {
  return request(app)
    .get('/api/admin/audit')
    .query({ action })
    .set('Authorization', bearer(token));
}

// `announcements` is not part of the shared TRUNCATE list in test/setup.ts, so
// this file clears it itself: leftover rows would otherwise point at user ids
// that the next test's TRUNCATE hands out again.
beforeEach(async () => {
  await pool.execute('DELETE FROM announcements');
});

describe('platform announcements', () => {
  it('requires a signed-in user for the banner and an admin for management', async () => {
    const anonymous = await current();
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHORIZED');

    const anonymousPublish = await request(app)
      .post('/api/admin/announcements')
      .send({ body: 'hello' });
    expect(anonymousPublish.status).toBe(401);
  });

  it('answers null while nothing is published', async () => {
    const user = await createTestUser('ann_user');

    const response = await current(tokenFor(user));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ announcement: null });
  });

  it('exposes the newest active announcement with its author', async () => {
    const admin = await createTestUser('ann_admin', 'admin');
    const user = await createTestUser('ann_reader');

    const first = await publish(admin, '  平台将于今晚维护  ');
    expect(first.status).toBe(201);
    expect(first.body.announcement).toEqual({
      id: expect.any(Number),
      body: '平台将于今晚维护',
      actorName: 'ann_admin',
      active: true,
      createdAt: expect.any(String),
    });

    const second = await publish(admin, '第二条公告');
    expect(second.status).toBe(201);

    const response = await current(tokenFor(user));

    expect(response.status).toBe(200);
    expect(response.body.announcement.id).toBe(second.body.announcement.id);
    expect(response.body.announcement.body).toBe('第二条公告');
    expect(response.body.announcement.actorName).toBe('ann_admin');
    expect(response.body.announcement.active).toBe(true);
    expect(Number.isNaN(Date.parse(response.body.announcement.createdAt))).toBe(false);
  });

  it('lists the newest twenty posts, deactivated ones included', async () => {
    const admin = await createTestUser('ann_list_admin', 'admin');
    const kept = await publish(admin, '保留的公告');
    const dropped = await publish(admin, '将被停用的公告');

    const removal = await deactivate(tokenFor(admin), dropped.body.announcement.id);
    expect(removal.status).toBe(200);
    expect(removal.body).toEqual({ ok: true });

    const response = await listAnnouncements(tokenFor(admin));

    expect(response.status).toBe(200);
    expect(response.body.announcements).toEqual([
      {
        id: dropped.body.announcement.id,
        body: '将被停用的公告',
        actorName: 'ann_list_admin',
        active: false,
        createdAt: expect.any(String),
      },
      {
        id: kept.body.announcement.id,
        body: '保留的公告',
        actorName: 'ann_list_admin',
        active: true,
        createdAt: expect.any(String),
      },
    ]);
  });

  it('falls back to the previous announcement once the newest is deactivated', async () => {
    const admin = await createTestUser('ann_fallback_admin', 'admin');
    const user = await createTestUser('ann_fallback_reader');
    const first = await publish(admin, '第一条');
    const second = await publish(admin, '第二条');

    expect((await deactivate(tokenFor(admin), second.body.announcement.id)).status).toBe(200);
    const fallback = await current(tokenFor(user));
    expect(fallback.body.announcement.id).toBe(first.body.announcement.id);
    expect(fallback.body.announcement.body).toBe('第一条');

    expect((await deactivate(tokenFor(admin), first.body.announcement.id)).status).toBe(200);
    const empty = await current(tokenFor(user));
    expect(empty.body).toEqual({ announcement: null });
  });

  it('rejects empty, missing and oversized bodies', async () => {
    const admin = await createTestUser('ann_body_admin', 'admin');

    for (const body of ['', '   ', undefined, null]) {
      const response = await publish(admin, body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }

    const tooLong = await publish(admin, 'x'.repeat(1001));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('INVALID_INPUT');

    const exact = await publish(admin, 'y'.repeat(1000));
    expect(exact.status).toBe(201);
    expect(exact.body.announcement.body).toHaveLength(1000);
  });

  it('answers 404 for an unknown announcement and 400 for a malformed id', async () => {
    const admin = await createTestUser('ann_missing_admin', 'admin');

    const missing = await deactivate(tokenFor(admin), 999_999);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('ANNOUNCEMENT_NOT_FOUND');

    const malformed = await deactivate(tokenFor(admin), 'abc');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_ID');
  });

  it('rejects every management endpoint for non-admins', async () => {
    const admin = await createTestUser('ann_guard_admin', 'admin');
    const user = await createTestUser('ann_guard_user');
    const created = await publish(admin, '只有管理员能动');
    const token = tokenFor(user);

    const publishResponse = await publish(user, '越权发布');
    expect(publishResponse.status).toBe(403);
    expect(publishResponse.body.error.code).toBe('ADMIN_REQUIRED');

    const listResponse = await listAnnouncements(token);
    expect(listResponse.status).toBe(403);
    expect(listResponse.body.error.code).toBe('ADMIN_REQUIRED');

    const deleteResponse = await deactivate(token, created.body.announcement.id);
    expect(deleteResponse.status).toBe(403);
    expect(deleteResponse.body.error.code).toBe('ADMIN_REQUIRED');

    const stillActive = await current(token);
    expect(stillActive.body.announcement.id).toBe(created.body.announcement.id);
  });

  it('records publication and deactivation in the audit log', async () => {
    const admin = await createTestUser('ann_audit_admin', 'admin');
    const created = await publish(admin, '审计公告');
    const id = created.body.announcement.id;

    expect((await deactivate(tokenFor(admin), id)).status).toBe(200);

    const createEntries = await auditEntries(tokenFor(admin), 'announcement.create');
    expect(createEntries.status).toBe(200);
    expect(createEntries.body.entries).toEqual([
      {
        id: expect.any(Number),
        actorId: admin.id,
        actorName: 'ann_audit_admin',
        action: 'announcement.create',
        targetType: 'announcement',
        targetId: id,
        detail: { body: '审计公告' },
        createdAt: expect.any(String),
      },
    ]);

    const deleteEntries = await auditEntries(tokenFor(admin), 'announcement.delete');
    expect(deleteEntries.body.entries).toEqual([
      {
        id: expect.any(Number),
        actorId: admin.id,
        actorName: 'ann_audit_admin',
        action: 'announcement.delete',
        targetType: 'announcement',
        targetId: id,
        detail: null,
        createdAt: expect.any(String),
      },
    ]);
  });
});
