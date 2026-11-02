import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool, type RowDataPacket } from '../src/db';
import { ANNOUNCEMENT_BODY_MAX } from '../src/services/announcements';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

const PASSWORD = 'admin-test-password';

function bearer(token: string): string {
  return `Bearer ${token}`;
}

async function setDisplayName(id: number, displayName: string): Promise<void> {
  await pool.execute('UPDATE users SET display_name = ? WHERE id = ?', [displayName, id]);
}

async function activeAdminCount(): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'",
  );
  return Number(rows[0]?.total ?? 0);
}

function banUser(token: string, targetId: number) {
  return request(app)
    .patch(`/api/admin/users/${targetId}/status`)
    .set('Authorization', bearer(token))
    .send({ status: 'banned' });
}

describe('admin users', () => {
  it('rejects non-admin access to the user list', async () => {
    const user = await createTestUser('plain_user');
    const response = await request(app)
      .get('/api/admin/users')
      .set('Authorization', bearer(tokenFor(user)));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ADMIN_REQUIRED');
  });

  it('lists users newest first with pagination metadata', async () => {
    const admin = await createTestUser('list_admin', 'admin');
    const first = await createTestUser('page_user_1');
    const second = await createTestUser('page_user_2');
    const third = await createTestUser('page_user_3');

    const page1 = await request(app)
      .get('/api/admin/users')
      .query({ limit: 2, offset: 0 })
      .set('Authorization', bearer(tokenFor(admin)));

    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(4);
    expect(page1.body.limit).toBe(2);
    expect(page1.body.offset).toBe(0);
    expect(page1.body.users.map((user: { id: number }) => user.id)).toEqual([
      third.id,
      second.id,
    ]);

    const page2 = await request(app)
      .get('/api/admin/users')
      .query({ limit: 2, offset: 2 })
      .set('Authorization', bearer(tokenFor(admin)));

    expect(page2.status).toBe(200);
    expect(page2.body.users.map((user: { id: number }) => user.id)).toEqual([
      first.id,
      admin.id,
    ]);
  });

  it('returns the documented user shape with default paging', async () => {
    const admin = await createTestUser('shape_admin', 'admin');
    const user = await createTestUser('shape_user');

    const response = await request(app)
      .get('/api/admin/users')
      .set('Authorization', bearer(tokenFor(admin)));

    expect(response.status).toBe(200);
    expect(response.body.limit).toBe(50);
    expect(response.body.offset).toBe(0);

    const found = response.body.users.find((row: { id: number }) => row.id === user.id);
    expect(found).toEqual({
      id: user.id,
      username: 'shape_user',
      displayName: 'shape_user',
      avatar: null,
      type: 'human',
      role: 'user',
      status: 'active',
      statusEmoji: null,
      statusText: null,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(found.createdAt))).toBe(false);
  });

  it('searches username and display name', async () => {
    const admin = await createTestUser('search_admin', 'admin');
    const alice = await createTestUser('alice');
    const bob = await createTestUser('bob');
    await setDisplayName(bob.id, 'Robert Cooper');

    const byUsername = await request(app)
      .get('/api/admin/users')
      .query({ q: 'alice' })
      .set('Authorization', bearer(tokenFor(admin)));

    expect(byUsername.status).toBe(200);
    expect(byUsername.body.total).toBe(1);
    expect(byUsername.body.users[0].id).toBe(alice.id);

    const byDisplayName = await request(app)
      .get('/api/admin/users')
      .query({ q: 'Cooper' })
      .set('Authorization', bearer(tokenFor(admin)));

    expect(byDisplayName.status).toBe(200);
    expect(byDisplayName.body.total).toBe(1);
    expect(byDisplayName.body.users[0].id).toBe(bob.id);

    const noMatch = await request(app)
      .get('/api/admin/users')
      .query({ q: 'nobody' })
      .set('Authorization', bearer(tokenFor(admin)));

    expect(noMatch.status).toBe(200);
    expect(noMatch.body.total).toBe(0);
    expect(noMatch.body.users).toEqual([]);
  });

  it('treats LIKE wildcards as literal characters', async () => {
    const admin = await createTestUser('wildcard_admin', 'admin');
    await createTestUser('pct_100');
    await createTestUser('pctX100');
    await createTestUser('rate%user');
    await createTestUser('rateXuser');

    const underscore = await request(app)
      .get('/api/admin/users')
      .query({ q: 'pct_100' })
      .set('Authorization', bearer(tokenFor(admin)));

    expect(underscore.status).toBe(200);
    expect(underscore.body.total).toBe(1);
    expect(underscore.body.users[0].username).toBe('pct_100');

    const percent = await request(app)
      .get('/api/admin/users')
      .query({ q: 'rate%user' })
      .set('Authorization', bearer(tokenFor(admin)));

    expect(percent.status).toBe(200);
    expect(percent.body.total).toBe(1);
    expect(percent.body.users[0].username).toBe('rate%user');
  });

  it('rejects out-of-range paging parameters', async () => {
    const admin = await createTestUser('paging_admin', 'admin');

    for (const query of [{ limit: 0 }, { limit: 101 }, { offset: -1 }]) {
      const response = await request(app)
        .get('/api/admin/users')
        .query(query)
        .set('Authorization', bearer(tokenFor(admin)));

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }
  });

  it('bans a regular user and blocks their login', async () => {
    const admin = await createTestUser('ban_admin', 'admin');
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ username: 'ban_target', password: PASSWORD });

    expect(registered.status).toBe(201);
    const targetId: number = registered.body.user.id;
    const targetToken: string = registered.body.token;

    const ban = await request(app)
      .patch(`/api/admin/users/${targetId}/status`)
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ status: 'banned' });

    expect(ban.status).toBe(200);
    expect(ban.body).toEqual({ ok: true });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'ban_target', password: PASSWORD });

    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('BANNED');

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', bearer(targetToken));

    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe('BANNED');
  });

  it('rejects banning a bot account', async () => {
    const admin = await createTestUser('bot_admin', 'admin');
    const bot = await createTestUser('status_bot', 'user', 'bot');

    const response = await request(app)
      .patch(`/api/admin/users/${bot.id}/status`)
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ status: 'banned' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BOT_STATUS_UNSUPPORTED');
  });

  it('rejects banning the last active admin', async () => {
    const admin = await createTestUser('solo_admin', 'admin');

    const response = await request(app)
      .patch(`/api/admin/users/${admin.id}/status`)
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ status: 'banned' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('LAST_ADMIN');
  });

  it('rejects self-ban when other admins exist', async () => {
    const admin = await createTestUser('self_admin', 'admin');
    await createTestUser('other_admin', 'admin');

    const response = await request(app)
      .patch(`/api/admin/users/${admin.id}/status`)
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ status: 'banned' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CANNOT_BAN_SELF');
  });

  it('bans another admin when two admins exist', async () => {
    const admin = await createTestUser('actor_admin', 'admin');
    const peer = await createTestUser('peer_admin', 'admin');

    const response = await request(app)
      .patch(`/api/admin/users/${peer.id}/status`)
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ status: 'banned' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT status FROM users WHERE id = ?',
      [peer.id],
    );
    expect(rows[0].status).toBe('banned');
  });

  it('keeps one active admin when two admins ban each other concurrently', async () => {
    const first = await createTestUser('ban_race_first', 'admin');
    const second = await createTestUser('ban_race_second', 'admin');

    const responses = await Promise.all([
      banUser(tokenFor(first), second.id),
      banUser(tokenFor(second), first.id),
    ]);

    // Both requests may pass the auth middleware while both admins are active;
    // the serialized ban check must still refuse the second one.
    expect(await activeAdminCount()).toBe(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
  });

  it('returns 404 for unknown users', async () => {
    const admin = await createTestUser('missing_admin', 'admin');

    const response = await request(app)
      .patch('/api/admin/users/999999/status')
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ status: 'banned' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('USER_NOT_FOUND');
  });
});

describe('admin announcements', () => {
  it('rejects non-admin access to announcement management', async () => {
    const user = await createTestUser('announcement_plain_user');

    const response = await request(app)
      .patch('/api/admin/announcements/1')
      .set('Authorization', bearer(tokenFor(user)))
      .send({ body: 'hello' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ADMIN_REQUIRED');
  });

  it('updates only the body and keeps author, status and timestamp', async () => {
    const admin = await createTestUser('ann_update_admin', 'admin');
    const created = await request(app)
      .post('/api/admin/announcements')
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ body: '原始公告' });

    expect(created.status).toBe(201);
    const id: number = created.body.announcement.id;

    const response = await request(app)
      .patch(`/api/admin/announcements/${id}`)
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ body: '  更新后的公告  ' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      announcement: {
        id,
        body: '更新后的公告',
        actorName: 'ann_update_admin',
        active: true,
        createdAt: created.body.announcement.createdAt,
      },
    });

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT body, active, created_by, created_at FROM announcements WHERE id = ?',
      [id],
    );
    expect(rows[0].body).toBe('更新后的公告');
    expect(Number(rows[0].active)).toBe(1);
    expect(Number(rows[0].created_by)).toBe(admin.id);
    expect(new Date(rows[0].created_at).toISOString()).toBe(
      created.body.announcement.createdAt,
    );

    const listed = await request(app)
      .get('/api/admin/announcements')
      .set('Authorization', bearer(tokenFor(admin)));

    expect(listed.body.announcements).toEqual([
      {
        id,
        body: '更新后的公告',
        actorName: 'ann_update_admin',
        active: true,
        createdAt: created.body.announcement.createdAt,
      },
    ]);
  });

  it('keeps a deactivated announcement hidden after an edit', async () => {
    const admin = await createTestUser('ann_edit_inactive_admin', 'admin');
    const created = await request(app)
      .post('/api/admin/announcements')
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ body: '停用前的公告' });
    const id: number = created.body.announcement.id;

    const removal = await request(app)
      .delete(`/api/admin/announcements/${id}`)
      .set('Authorization', bearer(tokenFor(admin)));
    expect(removal.status).toBe(200);

    const response = await request(app)
      .patch(`/api/admin/announcements/${id}`)
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ body: '停用后编辑的公告' });

    expect(response.status).toBe(200);
    expect(response.body.announcement).toEqual({
      id,
      body: '停用后编辑的公告',
      actorName: 'ann_edit_inactive_admin',
      active: false,
      createdAt: created.body.announcement.createdAt,
    });

    const current = await request(app)
      .get('/api/announcements/current')
      .set('Authorization', bearer(tokenFor(admin)));

    expect(current.body).toEqual({ announcement: null });
  });

  it('returns 404 for unknown announcements without auditing', async () => {
    const admin = await createTestUser('ann_missing_admin', 'admin');

    const response = await request(app)
      .patch('/api/admin/announcements/999999')
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ body: '没有这条公告' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ANNOUNCEMENT_NOT_FOUND');

    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS total FROM admin_audit_log WHERE action = 'announcement.update'",
    );
    expect(Number(rows[0].total)).toBe(0);
  });

  it('rejects empty, missing and overlong bodies without touching the row', async () => {
    const admin = await createTestUser('ann_invalid_admin', 'admin');
    const created = await request(app)
      .post('/api/admin/announcements')
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ body: '合法公告' });
    const id: number = created.body.announcement.id;

    const invalidBodies: unknown[] = [
      '',
      '   ',
      'x'.repeat(ANNOUNCEMENT_BODY_MAX + 1),
      42,
      null,
    ];
    for (const body of invalidBodies) {
      const response = await request(app)
        .patch(`/api/admin/announcements/${id}`)
        .set('Authorization', bearer(tokenFor(admin)))
        .send({ body });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }

    const missing = await request(app)
      .patch(`/api/admin/announcements/${id}`)
      .set('Authorization', bearer(tokenFor(admin)))
      .send({});

    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_INPUT');

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT body FROM announcements WHERE id = ?',
      [id],
    );
    expect(rows[0].body).toBe('合法公告');
  });

  it('records an announcement.update audit entry', async () => {
    const admin = await createTestUser('ann_audit_admin', 'admin');
    const created = await request(app)
      .post('/api/admin/announcements')
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ body: '审计前的公告' });
    const id: number = created.body.announcement.id;

    const response = await request(app)
      .patch(`/api/admin/announcements/${id}`)
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ body: '审计后的公告' });
    expect(response.status).toBe(200);

    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT actor_id, target_type, target_id, detail FROM admin_audit_log WHERE action = 'announcement.update'",
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0].actor_id)).toBe(admin.id);
    expect(rows[0].target_type).toBe('announcement');
    expect(Number(rows[0].target_id)).toBe(id);
    expect(
      typeof rows[0].detail === 'string'
        ? JSON.parse(rows[0].detail)
        : rows[0].detail,
    ).toEqual({ body: '审计后的公告' });
  });
});
