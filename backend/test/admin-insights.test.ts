import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool, type ResultSetHeader } from '../src/db';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function getStats(token: string) {
  return request(app).get('/api/admin/stats').set('Authorization', bearer(token));
}

function getUserDetail(token: string, userId: number) {
  return request(app)
    .get(`/api/admin/users/${userId}`)
    .set('Authorization', bearer(token));
}

async function banUser(userId: number): Promise<void> {
  await pool.execute("UPDATE users SET status = 'banned' WHERE id = ?", [userId]);
}

async function insertMessage(
  roomId: number,
  seq: number,
  senderId: number,
  deleted = false,
): Promise<void> {
  await pool.execute<ResultSetHeader>(
    `INSERT INTO messages (room_id, seq, sender_id, sender_type, content, status, deleted_at)
     VALUES (?, ?, ?, 'user', ?, 'done', ?)`,
    [roomId, seq, senderId, `message-${seq}`, deleted ? new Date() : null],
  );
}

async function insertBot(ownerId: number, username: string, enabled: boolean): Promise<number> {
  const botUser = await createTestUser(username, 'user', 'bot');
  await pool.execute<ResultSetHeader>(
    `INSERT INTO bots
       (user_id, base_url, api_key_encrypted, model, system_prompt, owner_user_id, scope, enabled)
     VALUES (?, 'http://127.0.0.1:4010', 'encrypted-key', 'fake-ok', '', ?, 'global', ?)`,
    [botUser.id, ownerId, enabled ? 1 : 0],
  );
  return botUser.id;
}

async function joinRoomWithRole(
  roomId: number,
  userId: number,
  role: 'owner' | 'admin' | 'member' | 'bot',
  joinedAt: string,
): Promise<void> {
  await pool.execute<ResultSetHeader>(
    `INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role), joined_at = VALUES(joined_at)`,
    [roomId, userId, role, joinedAt],
  );
}

describe('admin overview stats', () => {
  it('rejects non-admin access', async () => {
    const plain = await createTestUser('insights_plain');

    const stats = await getStats(tokenFor(plain));
    expect(stats.status).toBe(403);
    expect(stats.body.error.code).toBe('ADMIN_REQUIRED');

    const detail = await getUserDetail(tokenFor(plain), plain.id);
    expect(detail.status).toBe(403);
    expect(detail.body.error.code).toBe('ADMIN_REQUIRED');
  });

  it('reports zeroed collections on an otherwise empty database', async () => {
    const admin = await createTestUser('insights_empty_admin', 'admin');

    const response = await getStats(tokenFor(admin));

    expect(response.status).toBe(200);
    const { trend, previous, ...collections } = response.body;
    expect(collections).toEqual({
      users: { total: 1, active: 1, banned: 0, admins: 1 },
      rooms: { total: 0, public: 0, private: 0 },
      messages: { total: 0, deleted: 0 },
      bots: { total: 0, enabled: 0 },
      reports: { open: 0, resolved: 0, dismissed: 0, total: 0 },
    });
    expect(trend).toHaveLength(14);
    // Every row was created today, so the window before the trend is empty.
    expect(previous).toEqual({ users: 0, messages: 0, rooms: 0, bots: 0 });
  });

  it('counts users, rooms, messages and bots including soft-deleted messages', async () => {
    const admin = await createTestUser('insights_admin', 'admin');
    const active = await createTestUser('insights_active');
    const banned = await createTestUser('insights_banned');
    await banUser(banned.id);

    const publicRoom = await createTestRoom(admin);
    const privateRoom = await createTestRoom(active);
    await pool.execute('UPDATE rooms SET is_public = 0 WHERE id = ?', [privateRoom]);

    await insertMessage(publicRoom, 1, active.id);
    await insertMessage(publicRoom, 2, active.id, true);
    await insertMessage(publicRoom, 3, admin.id);
    await insertMessage(privateRoom, 1, active.id, true);

    await insertBot(active.id, 'insights_bot_enabled', true);
    await insertBot(active.id, 'insights_bot_disabled', false);

    const response = await getStats(tokenFor(admin));

    expect(response.status).toBe(200);
    const { trend, previous, ...collections } = response.body;
    expect(collections).toEqual({
      // admin + active + banned + the two bot accounts
      users: { total: 5, active: 4, banned: 1, admins: 1 },
      rooms: { total: 2, public: 1, private: 1 },
      messages: { total: 4, deleted: 2 },
      bots: { total: 2, enabled: 1 },
      reports: { open: 0, resolved: 0, dismissed: 0, total: 0 },
    });
    expect(trend).toHaveLength(14);
    // All fixtures were created today, so nothing predates the trend window.
    expect(previous).toEqual({ users: 0, messages: 0, rooms: 0, bots: 0 });
  });
});

describe('admin user detail', () => {
  it('returns the user, their totals and joined rooms ordered by join time', async () => {
    const admin = await createTestUser('detail_admin', 'admin');
    const target = await createTestUser('detail_target');
    const peer = await createTestUser('detail_peer');

    const newest = await createTestRoom(target);
    const middle = await createTestRoom(peer);
    const oldest = await createTestRoom(peer);

    await joinRoomWithRole(newest, target.id, 'owner', '2024-03-01 00:00:00.000');
    await joinRoomWithRole(newest, peer.id, 'member', '2024-03-02 00:00:00.000');
    await joinRoomWithRole(middle, target.id, 'admin', '2024-02-01 00:00:00.000');
    await joinRoomWithRole(middle, peer.id, 'owner', '2024-02-02 00:00:00.000');
    await joinRoomWithRole(oldest, target.id, 'member', '2024-01-01 00:00:00.000');
    await joinRoomWithRole(oldest, peer.id, 'owner', '2024-01-02 00:00:00.000');

    await insertMessage(newest, 1, target.id);
    await insertMessage(newest, 2, target.id, true);
    await insertMessage(newest, 3, peer.id);

    await insertBot(target.id, 'detail_bot', true);

    const response = await getUserDetail(tokenFor(admin), target.id);

    expect(response.status).toBe(200);
    expect(response.body.user).toEqual({
      id: target.id,
      username: 'detail_target',
      displayName: 'detail_target',
      avatar: null,
      type: 'human',
      role: 'user',
      status: 'active',
      statusEmoji: null,
      statusText: null,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(response.body.user.createdAt))).toBe(false);

    expect(response.body.stats).toEqual({ rooms: 3, messages: 2, bots: 1 });

    expect(response.body.rooms).toEqual([
      {
        id: newest,
        name: expect.any(String),
        role: 'owner',
        joinedAt: '2024-03-01T00:00:00.000Z',
        memberCount: 2,
      },
      {
        id: middle,
        name: expect.any(String),
        role: 'admin',
        joinedAt: '2024-02-01T00:00:00.000Z',
        memberCount: 2,
      },
      {
        id: oldest,
        name: expect.any(String),
        role: 'member',
        joinedAt: '2024-01-01T00:00:00.000Z',
        memberCount: 2,
      },
    ]);
  });

  it('returns 404 for unknown users', async () => {
    const admin = await createTestUser('detail_missing_admin', 'admin');

    const response = await getUserDetail(tokenFor(admin), 999999);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('USER_NOT_FOUND');
  });
});
