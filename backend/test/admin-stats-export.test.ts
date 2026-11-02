import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

afterEach(() => {
  config.rateLimitEnabled = false;
});

interface TrendPoint {
  date: string;
  users: number;
  messages: number;
  rooms: number;
  bots: number;
}

const CSV_HEADER = ['date', 'users', 'messages', 'rooms', 'bots'];

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function exportStats(token: string, days?: number | string) {
  const call = request(app)
    .get('/api/admin/stats/export')
    .set('Authorization', bearer(token));
  return days === undefined ? call : call.query({ days: String(days) });
}

function getStats(token: string, days?: number | string) {
  const call = request(app)
    .get('/api/admin/stats')
    .set('Authorization', bearer(token));
  return days === undefined ? call : call.query({ days: String(days) });
}

/** The export only carries dates and integers, so a plain split is enough. */
function parseCsv(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split(','));
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
): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO messages (room_id, seq, sender_id, sender_type, content, status)
     VALUES (?, ?, ?, 'user', ?, 'done')`,
    [roomId, seq, senderId, `message-${seq}`],
  );
  if (daysAgo > 0) {
    await shiftCreatedAt('messages', result.insertId, daysAgo);
  }
  return result.insertId;
}

async function insertBot(
  ownerId: number,
  username: string,
  daysAgo: number,
): Promise<{ botUserId: number; botId: number }> {
  const botUser = await createTestUser(username, 'user', 'bot');
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO bots
       (user_id, base_url, api_key_encrypted, model, system_prompt, owner_user_id, scope, enabled)
     VALUES (?, 'http://127.0.0.1:4010', 'encrypted-key', 'fake-ok', '', ?, 'global', 1)`,
    [botUser.id, ownerId],
  );
  const botId = result.insertId;
  if (daysAgo > 0) {
    await shiftCreatedAt('users', botUser.id, daysAgo);
    await shiftCreatedAt('bots', botUser.id, daysAgo, 'user_id');
  }
  return { botUserId: botUser.id, botId };
}

describe('admin stats CSV export', () => {
  it('rejects non-admin access', async () => {
    const plain = await createTestUser('stats_export_plain');

    const response = await exportStats(tokenFor(plain));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ADMIN_REQUIRED');
  });

  it('exports 14 zero-filled consecutive days as a CSV attachment', async () => {
    const admin = await createTestUser('stats_export_empty_admin', 'admin');
    // Park the admin outside the window so the trend is genuinely empty.
    await shiftCreatedAt('users', admin.id, 40);

    const response = await exportStats(tokenFor(admin));

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="admin-trend-14d.csv"',
    );
    expect(response.headers['cache-control']).toBe('no-store');

    const rows = parseCsv(response.text);
    expect(rows[0]).toEqual(CSV_HEADER);
    expect(rows).toHaveLength(15);
    const dates = await expectedDates(14);
    expect(rows.slice(1).map((row) => row[0])).toEqual(dates);
    for (const row of rows.slice(1)) {
      expect(row.slice(1)).toEqual(['0', '0', '0', '0']);
    }
  });

  it('matches the /admin/stats trend row for row', async () => {
    const admin = await createTestUser('stats_export_admin', 'admin');
    await shiftCreatedAt('users', admin.id, 40);

    const todayUser = await createTestUser('stats_export_today_user');
    const threeDayUser = await createTestUser('stats_export_three_user');
    const outsideUser = await createTestUser('stats_export_outside_user');
    await shiftCreatedAt('users', threeDayUser.id, 3);
    await shiftCreatedAt('users', outsideUser.id, 20);

    await insertBot(todayUser.id, 'stats_export_bot_today', 0);
    await insertBot(todayUser.id, 'stats_export_bot_ten', 10);

    const todayRoom = await createTestRoom(todayUser);
    const fiveDayRoom = await createTestRoom(threeDayUser);
    await shiftCreatedAt('rooms', fiveDayRoom, 5);

    await insertMessage(todayRoom, 1, todayUser.id, 0);
    await insertMessage(todayRoom, 2, threeDayUser.id, 0);
    await insertMessage(todayRoom, 3, threeDayUser.id, 6);
    await insertMessage(todayRoom, 4, threeDayUser.id, 25);

    const exportResponse = await exportStats(tokenFor(admin));
    expect(exportResponse.status).toBe(200);
    const rows = parseCsv(exportResponse.text);
    const dates = await expectedDates(14);
    expect(rows.slice(1).map((row) => row[0])).toEqual(dates);

    // Same window, same buckets, same zero-fill as the JSON trend.
    const statsResponse = await getStats(tokenFor(admin));
    expect(statsResponse.status).toBe(200);
    const trend = statsResponse.body.trend as TrendPoint[];
    expect(rows.slice(1)).toEqual(
      trend.map((point) => [
        point.date,
        String(point.users),
        String(point.messages),
        String(point.rooms),
        String(point.bots),
      ]),
    );

    // Quiet days stay in the export at zero.
    const byDate = new Map(rows.slice(1).map((row) => [row[0], row]));
    expect(byDate.get(dates[0])).toEqual([dates[0], '0', '0', '0', '0']);
    // Each series lands on the day the row was created; the 20-day-old user
    // and the 25-day-old message are outside the window and never counted.
    expect(byDate.get(dates[3])).toEqual([dates[3], '1', '0', '0', '1']); // 10 days ago
    expect(byDate.get(dates[7])).toEqual([dates[7], '0', '1', '0', '0']); // 6 days ago
    expect(byDate.get(dates[8])).toEqual([dates[8], '0', '0', '1', '0']); // 5 days ago
    expect(byDate.get(dates[10])).toEqual([dates[10], '1', '0', '0', '0']); // 3 days ago
    expect(byDate.get(dates[13])).toEqual([dates[13], '2', '2', '1', '1']); // today
  });

  it('honours the 7 and 30 day windows and names the file after them', async () => {
    const admin = await createTestUser('stats_export_window_admin', 'admin');
    await shiftCreatedAt('users', admin.id, 40);

    const eightDayUser = await createTestUser('stats_export_eight_user');
    const sixDayUser = await createTestUser('stats_export_six_user');
    const twentyNineDayUser = await createTestUser('stats_export_twenty_nine_user');
    const thirtyDayUser = await createTestUser('stats_export_thirty_user');
    await shiftCreatedAt('users', eightDayUser.id, 8);
    await shiftCreatedAt('users', sixDayUser.id, 6);
    await shiftCreatedAt('users', twentyNineDayUser.id, 29);
    await shiftCreatedAt('users', thirtyDayUser.id, 30);

    const week = await exportStats(tokenFor(admin), 7);
    expect(week.status).toBe(200);
    expect(week.headers['content-disposition']).toBe(
      'attachment; filename="admin-trend-7d.csv"',
    );
    const weekRows = parseCsv(week.text);
    const weekDates = await expectedDates(7);
    expect(weekRows).toHaveLength(8);
    expect(weekRows.slice(1).map((row) => row[0])).toEqual(weekDates);
    const weekUsers = weekRows.slice(1).reduce((sum, row) => sum + Number(row[1]), 0);
    // Only the six-day-old row is inside a 7-day window.
    expect(weekUsers).toBe(1);
    expect(weekRows[1][1]).toBe('1');
    expect(weekRows[2][1]).toBe('0');

    const month = await exportStats(tokenFor(admin), 30);
    expect(month.status).toBe(200);
    expect(month.headers['content-disposition']).toBe(
      'attachment; filename="admin-trend-30d.csv"',
    );
    const monthRows = parseCsv(month.text);
    const monthDates = await expectedDates(30);
    expect(monthRows).toHaveLength(31);
    expect(monthRows.slice(1).map((row) => row[0])).toEqual(monthDates);
    const monthUsers = monthRows.slice(1).reduce((sum, row) => sum + Number(row[1]), 0);
    // 29-day-old row is inside the 30-day window, the 30-day-old one is not.
    expect(monthUsers).toBe(3);
    expect(monthRows[1][1]).toBe('1');
  });

  it('rejects out-of-range days', async () => {
    const admin = await createTestUser('stats_export_days_admin', 'admin');

    for (const days of ['6', '31', '0', '-1', 'abc', '7.5']) {
      const response = await exportStats(tokenFor(admin), days);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }
  });

  it('allows ten exports per minute per admin', async () => {
    config.rateLimitEnabled = true;
    const admin = await createTestUser('stats_export_rate_admin', 'admin');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await exportStats(tokenFor(admin));
      expect(response.status).toBe(200);
    }

    const limited = await exportStats(tokenFor(admin));
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');

    // The bucket is per admin, so a second admin is not affected.
    const other = await createTestUser('stats_export_rate_other', 'admin');
    const otherResponse = await exportStats(tokenFor(other));
    expect(otherResponse.status).toBe(200);
  });
});
