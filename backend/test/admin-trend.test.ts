import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

interface TrendPoint {
  date: string;
  users: number;
  messages: number;
  rooms: number;
  bots: number;
}

interface StatsBody {
  users: { total: number; active: number; banned: number; admins: number };
  rooms: { total: number; public: number; private: number };
  messages: { total: number; deleted: number };
  bots: { total: number; enabled: number };
  trend: TrendPoint[];
  previous: { users: number; messages: number; rooms: number; bots: number };
}

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function getStats(token: string, days?: number | string) {
  const call = request(app).get('/api/admin/stats').set('Authorization', bearer(token));
  return days === undefined ? call : call.query({ days: String(days) });
}

// The trend axis is anchored on MySQL's CURDATE(), so expectations have to use
// the same clock instead of the Node process timezone.
async function dbToday(): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today",
  );
  return String(rows[0]?.today ?? '');
}

async function expectedDates(days: number): Promise<string[]> {
  const today = await dbToday();
  const base = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: days }, (_unused, index) =>
    new Date(base - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10),
  );
}

type DatedTable = 'users' | 'rooms' | 'messages' | 'bots';

// Backdates a row relative to the database clock so it lands in a known bucket.
// `bots` is keyed by `user_id` rather than `id`, hence the override.
async function shiftCreatedAt(
  table: DatedTable,
  id: number,
  daysAgo: number,
  keyColumn = 'id',
): Promise<void> {
  await pool.execute(
    `UPDATE ${table}
        SET created_at = DATE_ADD(CURDATE() - INTERVAL ? DAY, INTERVAL 9 HOUR)
      WHERE ${keyColumn} = ?`,
    [daysAgo, id],
  );
}

async function insertMessage(
  roomId: number,
  seq: number,
  senderId: number,
  daysAgo: number,
  deleted = false,
): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO messages (room_id, seq, sender_id, sender_type, content, status, deleted_at)
     VALUES (?, ?, ?, 'user', ?, 'done', ?)`,
    [roomId, seq, senderId, `message-${seq}`, deleted ? new Date() : null],
  );
  if (daysAgo > 0) {
    await shiftCreatedAt('messages', result.insertId, daysAgo);
  }
  return result.insertId;
}

async function insertBot(
  ownerId: number,
  username: string,
  enabled: boolean,
  daysAgo: number,
): Promise<{ botUserId: number; botId: number }> {
  const botUser = await createTestUser(username, 'user', 'bot');
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO bots
       (user_id, base_url, api_key_encrypted, model, system_prompt, owner_user_id, scope, enabled)
     VALUES (?, 'http://127.0.0.1:4010', 'encrypted-key', 'fake-ok', '', ?, 'global', ?)`,
    [botUser.id, ownerId, enabled ? 1 : 0],
  );
  const botId = result.insertId;
  if (daysAgo > 0) {
    await shiftCreatedAt('users', botUser.id, daysAgo);
    await shiftCreatedAt('bots', botUser.id, daysAgo, 'user_id');
  }
  return { botUserId: botUser.id, botId };
}

function byDate(trend: TrendPoint[]): Map<string, TrendPoint> {
  return new Map(trend.map((point) => [point.date, point]));
}

describe('admin stats trend', () => {
  it('rejects non-admin access', async () => {
    const plain = await createTestUser('trend_plain');

    const response = await getStats(tokenFor(plain));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ADMIN_REQUIRED');
  });

  it('returns 14 zero-filled consecutive days on an empty database', async () => {
    const admin = await createTestUser('trend_empty_admin', 'admin');
    // Park the admin outside the window so the trend is genuinely empty.
    await shiftCreatedAt('users', admin.id, 40);

    const response = await getStats(tokenFor(admin));

    expect(response.status).toBe(200);
    const dates = await expectedDates(14);
    expect(response.body.trend.map((point: TrendPoint) => point.date)).toEqual(dates);
    expect(response.body.trend).toEqual(
      dates.map((date) => ({ date, users: 0, messages: 0, rooms: 0, bots: 0 })),
    );
    expect(response.body.trend).toHaveLength(14);
  });

  it('counts each series on the day the row was created', async () => {
    const admin = await createTestUser('trend_admin', 'admin');
    await shiftCreatedAt('users', admin.id, 40);

    const todayUser = await createTestUser('trend_today_user');
    const threeDayUser = await createTestUser('trend_three_user');
    const thirteenDayUser = await createTestUser('trend_thirteen_user');
    const outsideUser = await createTestUser('trend_outside_user');
    await shiftCreatedAt('users', threeDayUser.id, 3);
    await shiftCreatedAt('users', thirteenDayUser.id, 13);
    await shiftCreatedAt('users', outsideUser.id, 15);

    await insertBot(todayUser.id, 'trend_bot_today', true, 0);
    await insertBot(todayUser.id, 'trend_bot_ten', true, 10);

    const todayRoom = await createTestRoom(todayUser);
    const fiveDayRoom = await createTestRoom(threeDayUser);
    await shiftCreatedAt('rooms', fiveDayRoom, 5);

    await insertMessage(todayRoom, 1, todayUser.id, 0);
    await insertMessage(todayRoom, 2, threeDayUser.id, 0);
    await insertMessage(fiveDayRoom, 1, threeDayUser.id, 6);
    await insertMessage(fiveDayRoom, 2, threeDayUser.id, 20);

    const response = await getStats(tokenFor(admin));
    expect(response.status).toBe(200);

    const dates = await expectedDates(14);
    const trend = response.body.trend as TrendPoint[];
    expect(trend.map((point) => point.date)).toEqual(dates);
    expect(trend).toEqual(
      dates.map((date, index) => {
        const daysAgo = dates.length - 1 - index;
        const point: TrendPoint = { date, users: 0, messages: 0, rooms: 0, bots: 0 };
        if (daysAgo === 13) {
          point.users = 1; // thirteenDayUser
        } else if (daysAgo === 10) {
          point.users = 1; // bot account behind trend_bot_ten
          point.bots = 1;
        } else if (daysAgo === 6) {
          point.messages = 1;
        } else if (daysAgo === 5) {
          point.rooms = 1;
        } else if (daysAgo === 3) {
          point.users = 1;
        } else if (daysAgo === 0) {
          point.users = 2; // todayUser + bot account behind trend_bot_today
          point.rooms = 1;
          point.messages = 2;
          point.bots = 1;
        }
        return point;
      }),
    );
    // Rows older than the window are dropped, not folded into the first bucket.
    expect(byDate(trend).get(dates[0])).toEqual({
      date: dates[0],
      users: 1,
      messages: 0,
      rooms: 0,
      bots: 0,
    });
  });

  it('honours days=7 and days=30 windows', async () => {
    const admin = await createTestUser('trend_window_admin', 'admin');
    await shiftCreatedAt('users', admin.id, 40);

    const eightDayUser = await createTestUser('trend_eight_user');
    const sixDayUser = await createTestUser('trend_six_user');
    const twentyNineDayUser = await createTestUser('trend_twenty_nine_user');
    const thirtyDayUser = await createTestUser('trend_thirty_user');
    await shiftCreatedAt('users', eightDayUser.id, 8);
    await shiftCreatedAt('users', sixDayUser.id, 6);
    await shiftCreatedAt('users', twentyNineDayUser.id, 29);
    await shiftCreatedAt('users', thirtyDayUser.id, 30);

    const week = await getStats(tokenFor(admin), 7);
    expect(week.status).toBe(200);
    const weekDates = await expectedDates(7);
    expect(week.body.trend.map((point: TrendPoint) => point.date)).toEqual(weekDates);
    expect(week.body.trend).toHaveLength(7);
    const weekTotals = (week.body.trend as TrendPoint[]).reduce(
      (sum, point) => sum + point.users,
      0,
    );
    expect(weekTotals).toBe(1);
    // Six days ago is the oldest bucket of the 7-day window; the 8-day row is out.
    expect(byDate(week.body.trend).get(weekDates[0])?.users).toBe(1);
    expect(byDate(week.body.trend).get(weekDates[1])?.users).toBe(0);

    const month = await getStats(tokenFor(admin), 30);
    expect(month.status).toBe(200);
    const monthDates = await expectedDates(30);
    expect(month.body.trend.map((point: TrendPoint) => point.date)).toEqual(monthDates);
    expect(month.body.trend).toHaveLength(30);
    const monthTotals = (month.body.trend as TrendPoint[]).reduce(
      (sum, point) => sum + point.users,
      0,
    );
    // 29-day-old row is inside the 30-day window, the 30-day-old one is not.
    expect(monthTotals).toBe(3);
    expect(byDate(month.body.trend).get(monthDates[0])?.users).toBe(1);
  });

  it('counts the equally long window before the trend as previous', async () => {
    const admin = await createTestUser('trend_previous_admin', 'admin');
    // Park the admin far outside both windows.
    await shiftCreatedAt('users', admin.id, 60);

    // For days=14 the current window is 0..13 days ago and the previous one
    // is 14..27 days ago, so 13/14 and 27/28 are the two edges under test.
    const oldestCurrent = await createTestUser('trend_prev_current_edge');
    const newestPrevious = await createTestUser('trend_prev_previous_edge');
    const oldestPrevious = await createTestUser('trend_prev_previous_old');
    const tooOld = await createTestUser('trend_prev_too_old');
    await shiftCreatedAt('users', oldestCurrent.id, 13);
    await shiftCreatedAt('users', newestPrevious.id, 14);
    await shiftCreatedAt('users', oldestPrevious.id, 27);
    await shiftCreatedAt('users', tooOld.id, 28);

    const previousRoom = await createTestRoom(newestPrevious);
    await shiftCreatedAt('rooms', previousRoom, 20);
    await insertMessage(previousRoom, 1, newestPrevious.id, 20);
    await insertBot(newestPrevious.id, 'trend_prev_bot', true, 25);

    const response = await getStats(tokenFor(admin));
    expect(response.status).toBe(200);

    // Two humans (14 and 27 days ago) plus the bot account (25 days ago); the
    // 13-day-old user belongs to the current window and the 28-day-old one to
    // neither.
    expect((response.body as StatsBody).previous).toEqual({
      users: 3,
      messages: 1,
      rooms: 1,
      bots: 1,
    });
    const currentUsers = (response.body.trend as TrendPoint[]).reduce(
      (sum, point) => sum + point.users,
      0,
    );
    expect(currentUsers).toBe(1);

    // The same rows under a 7-day window: the previous window becomes 7..13
    // days ago, so only the 13-day-old user is still counted there.
    const week = await getStats(tokenFor(admin), 7);
    expect(week.status).toBe(200);
    expect((week.body as StatsBody).previous).toEqual({
      users: 1,
      messages: 0,
      rooms: 0,
      bots: 0,
    });
  });

  it('defaults to 14 days and rejects out-of-range values', async () => {
    const admin = await createTestUser('trend_days_admin', 'admin');

    const defaulted = await getStats(tokenFor(admin));
    expect(defaulted.status).toBe(200);
    expect(defaulted.body.trend).toHaveLength(14);

    for (const days of ['6', '31', '0', '-1', 'abc', '7.5']) {
      const response = await getStats(tokenFor(admin), days);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }
  });

  it('keeps the existing summary figures intact', async () => {
    const admin = await createTestUser('trend_summary_admin', 'admin');
    const active = await createTestUser('trend_summary_active');
    const banned = await createTestUser('trend_summary_banned');
    await pool.execute("UPDATE users SET status = 'banned' WHERE id = ?", [banned.id]);

    const publicRoom = await createTestRoom(admin);
    const privateRoom = await createTestRoom(active);
    await pool.execute('UPDATE rooms SET is_public = 0 WHERE id = ?', [privateRoom]);

    await insertMessage(publicRoom, 1, active.id, 0);
    await insertMessage(publicRoom, 2, active.id, 0, true);
    await insertMessage(privateRoom, 1, admin.id, 0);
    await insertBot(active.id, 'trend_summary_bot_on', true, 0);
    await insertBot(active.id, 'trend_summary_bot_off', false, 0);

    const response = await getStats(tokenFor(admin));

    expect(response.status).toBe(200);
    expect(response.body.users).toEqual({ total: 5, active: 4, banned: 1, admins: 1 });
    expect(response.body.rooms).toEqual({ total: 2, public: 1, private: 1 });
    expect(response.body.messages).toEqual({ total: 3, deleted: 1 });
    expect(response.body.bots).toEqual({ total: 2, enabled: 1 });
    expect(response.body.trend).toHaveLength(14);
    expect((response.body as StatsBody).trend.at(-1)?.users).toBe(5);
  });
});
