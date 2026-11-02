import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { config } from '../src/config';
import { pool, type RowDataPacket } from '../src/db';
import { createRoom } from '../src/services/room';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

afterEach(() => {
  config.rateLimitEnabled = false;
});

const USERS_HEADER = [
  'id',
  'username',
  'displayName',
  'type',
  'role',
  'status',
  'statusEmoji',
  'statusText',
  'createdAt',
];
const ROOMS_HEADER = [
  'id',
  'name',
  'ownerId',
  'ownerName',
  'isPublic',
  'memberCount',
  'messageCount',
  'retentionDays',
  'createdAt',
];

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function exportUsers(token: string, q?: string) {
  const call = request(app)
    .get('/api/admin/users/export')
    .set('Authorization', bearer(token));
  return q === undefined ? call : call.query({ q });
}

function exportRooms(token: string, q?: string) {
  const call = request(app)
    .get('/api/admin/rooms/export')
    .set('Authorization', bearer(token));
  return q === undefined ? call : call.query({ q });
}

/**
 * Minimal RFC 4180 reader: quoted cells (including embedded commas, quotes and
 * newlines), doubled quotes, and both CRLF and LF record terminators.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    // A trailing terminator must not produce a phantom record.
    if (row.length > 1 || row[0] !== '') {
      rows.push(row);
    }
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      endField();
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      endRow();
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    endRow();
  }
  return rows;
}

function toObjects(text: string, header: string[]): Record<string, string>[] {
  const rows = parseCsv(text);
  expect(rows[0]).toEqual(header);
  return rows.slice(1).map((cells) => {
    expect(cells).toHaveLength(header.length);
    return Object.fromEntries(header.map((name, index) => [name, cells[index]]));
  });
}

/** Bulk-inserts `count` users sharing `prefix`, named `<prefix>0001` upward. */
async function seedUsers(prefix: string, count: number): Promise<void> {
  const passwordHash = await hashPassword('bulk-export-password');
  const batchSize = 500;
  for (let start = 0; start < count; start += batchSize) {
    const size = Math.min(batchSize, count - start);
    const values = Array.from({ length: size }, (_unused, offset) => {
      const username = `${prefix}${String(start + offset + 1).padStart(4, '0')}`;
      return [username, passwordHash, username, 'human', 'user', 'active'];
    });
    await pool.query(
      `INSERT INTO users (username, password_hash, display_name, type, role, status)
       VALUES ?`,
      [values],
    );
  }
}

/** Bulk-inserts `count` public rooms owned by `ownerId`, named `<prefix>0001`. */
async function seedRooms(prefix: string, count: number, ownerId: number): Promise<void> {
  const batchSize = 500;
  for (let start = 0; start < count; start += batchSize) {
    const size = Math.min(batchSize, count - start);
    const values = Array.from({ length: size }, (_unused, offset) => [
      `${prefix}${String(start + offset + 1).padStart(4, '0')}`,
      ownerId,
      1,
    ]);
    await pool.query('INSERT INTO rooms (name, owner_id, is_public) VALUES ?', [values]);
  }
}

async function idBounds(
  table: 'users' | 'rooms',
  column: 'username' | 'name',
  prefix: string,
): Promise<{ minId: number; maxId: number }> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM ${table} WHERE ${column} LIKE ?`,
    [`${prefix}%`],
  );
  return {
    minId: Number(rows[0]?.min_id ?? 0),
    maxId: Number(rows[0]?.max_id ?? 0),
  };
}

describe('admin user/room data exports', () => {
  it('rejects non-admin access on both exports', async () => {
    const plain = await createTestUser('data_export_plain');

    for (const response of await Promise.all([
      exportUsers(tokenFor(plain)),
      exportRooms(tokenFor(plain)),
    ])) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ADMIN_REQUIRED');
    }
  });

  it('exports users with the documented columns and the table search', async () => {
    const admin = await createTestUser('data_export_users_admin', 'admin');
    const alice = await createTestUser('data_export_users_alice');
    await createTestUser('data_export_users_bob');
    const bot = await createTestUser('data_export_users_bot', 'user', 'bot');

    await pool.execute(
      'UPDATE users SET display_name = ?, status_emoji = ?, status_text = ? WHERE id = ?',
      ['Alice A', '🔥', 'busy', alice.id],
    );

    // Username/display-name search means the same thing as the list endpoint.
    const filtered = await exportUsers(tokenFor(admin), 'data_export_users_');
    expect(filtered.status).toBe(200);
    expect(filtered.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(filtered.headers['content-disposition']).toBe(
      'attachment; filename="users.csv"',
    );
    expect(filtered.headers['cache-control']).toBe('no-store');
    expect(filtered.headers['x-users-truncated']).toBeUndefined();

    const rows = toObjects(filtered.text, USERS_HEADER);
    // Newest id first, exactly like the admin table.
    const list = await request(app)
      .get('/api/admin/users')
      .set('Authorization', bearer(tokenFor(admin)))
      .query({ q: 'data_export_users_' });
    expect(list.status).toBe(200);
    expect(rows.map((row) => Number(row.id))).toEqual(
      (list.body.users as { id: number }[]).map((user) => user.id),
    );

    const aliceRow = rows.find((row) => row.id === String(alice.id));
    expect(aliceRow).toMatchObject({
      username: 'data_export_users_alice',
      displayName: 'Alice A',
      type: 'human',
      role: 'user',
      status: 'active',
      statusEmoji: '🔥',
      statusText: 'busy',
    });
    expect(aliceRow?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

    // A bot account keeps its type; unset statuses are blank, not "null".
    const botRow = rows.find((row) => row.id === String(bot.id));
    expect(botRow?.type).toBe('bot');
    expect(botRow?.statusEmoji).toBe('');
    expect(botRow?.statusText).toBe('');

    // Display-name matches count too, exactly like the list search.
    const byDisplayName = await exportUsers(tokenFor(admin), 'Alice A');
    expect(toObjects(byDisplayName.text, USERS_HEADER).map((row) => row.id)).toEqual([
      String(alice.id),
    ]);
  });

  it('returns just the user header when nothing matches', async () => {
    const admin = await createTestUser('data_export_users_empty_admin', 'admin');

    const response = await exportUsers(tokenFor(admin), 'no-such-user');

    expect(response.status).toBe(200);
    expect(response.headers['x-users-truncated']).toBeUndefined();
    expect(response.text).toBe(`${USERS_HEADER.join(',')}\r\n`);
    expect(parseCsv(response.text)).toEqual([USERS_HEADER]);
  });

  it('quotes RFC 4180 cells and neutralizes spreadsheet formulas in user data', async () => {
    const admin = await createTestUser('data_export_users_escape_admin', 'admin');
    const target = await createTestUser('data_export_users_escape_target');
    await pool.execute(
      'UPDATE users SET display_name = ?, status_emoji = ?, status_text = ? WHERE id = ?',
      ['=1+1, "x"', '-2+3', 'line1\nline2', target.id],
    );

    const response = await exportUsers(tokenFor(admin), 'escape_target');
    expect(response.status).toBe(200);

    const rows = toObjects(response.text, USERS_HEADER);
    expect(rows).toHaveLength(1);
    // Quoted cells round-trip; formula triggers get an apostrophe so Excel and
    // Sheets display the text instead of evaluating it.
    expect(rows[0].displayName).toBe(`'=1+1, "x"`);
    expect(rows[0].statusEmoji).toBe(`'-2+3`);
    expect(rows[0].statusText).toBe('line1\nline2');

    // Raw bytes carry the same guard and RFC 4180 quoting.
    expect(response.text).toContain(`"'=1+1, ""x"""`);
    expect(response.text).toContain(`"line1\nline2"`);
    expect(response.text).toContain(`'-2+3`);
  });

  it('caps the user CSV at 5000 rows and flags truncation only when more exist', async () => {
    const admin = await createTestUser('data_export_users_cap_admin', 'admin');
    const prefix = 'data_export_users_cap_u_';
    await seedUsers(prefix, 5001);
    const bounds = await idBounds('users', 'username', prefix);

    const capped = await exportUsers(tokenFor(admin), prefix);
    expect(capped.status).toBe(200);
    expect(capped.headers['x-users-truncated']).toBe('true');
    const cappedRows = toObjects(capped.text, USERS_HEADER);
    expect(cappedRows).toHaveLength(5000);
    expect(cappedRows[0].id).toBe(String(bounds.maxId));
    expect(cappedRows.map((row) => row.id)).not.toContain(String(bounds.minId));
    const ids = cappedRows.map((row) => Number(row.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));

    // Dropping the oldest row leaves exactly the cap: no header.
    await pool.execute('DELETE FROM users WHERE id = ?', [bounds.minId]);
    const exact = await exportUsers(tokenFor(admin), prefix);
    expect(exact.status).toBe(200);
    expect(exact.headers['x-users-truncated']).toBeUndefined();
    expect(toObjects(exact.text, USERS_HEADER)).toHaveLength(5000);
  });

  it('exports rooms with counts, retention and the table search', async () => {
    const admin = await createTestUser('data_export_rooms_admin', 'admin');
    const owner = await createTestUser('data_export_rooms_owner');
    const member = await createTestUser('data_export_rooms_member');
    // The owner name falls back to the username when the display name is blank.
    await pool.execute("UPDATE users SET display_name = '' WHERE id = ?", [owner.id]);

    const privateRoom = await createRoom(owner.id, {
      name: 'data_export_room_private',
      isPublic: false,
    });
    await pool.execute('UPDATE rooms SET retention_days = 7 WHERE id = ?', [
      privateRoom.id,
    ]);
    await pool.execute(
      "INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, 'member')",
      [privateRoom.id, member.id],
    );
    await pool.query(
      `INSERT INTO messages (room_id, seq, sender_id, sender_type, content, status)
       VALUES (?, 1, ?, 'user', 'first', 'done'), (?, 2, ?, 'user', 'second', 'done')`,
      [privateRoom.id, owner.id, privateRoom.id, owner.id],
    );
    const publicRoom = await createRoom(owner.id, {
      name: 'data_export_room_public',
      isPublic: true,
    });

    const response = await exportRooms(tokenFor(admin), 'data_export_room_');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="rooms.csv"',
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-rooms-truncated']).toBeUndefined();

    const rows = toObjects(response.text, ROOMS_HEADER);
    expect(rows.map((row) => Number(row.id))).toEqual([
      publicRoom.id,
      privateRoom.id,
    ]);
    const list = await request(app)
      .get('/api/admin/rooms')
      .set('Authorization', bearer(tokenFor(admin)))
      .query({ q: 'data_export_room_' });
    expect(list.status).toBe(200);
    expect(rows.map((row) => Number(row.id))).toEqual(
      (list.body.rooms as { id: number }[]).map((room) => room.id),
    );

    const publicRow = rows[0];
    expect(publicRow).toMatchObject({
      name: 'data_export_room_public',
      ownerId: String(owner.id),
      ownerName: 'data_export_rooms_owner',
      isPublic: 'true',
      memberCount: '1',
      messageCount: '0',
      retentionDays: '0',
    });
    expect(publicRow.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

    const privateRow = rows[1];
    expect(privateRow).toMatchObject({
      name: 'data_export_room_private',
      isPublic: 'false',
      memberCount: '2',
      messageCount: '2',
      retentionDays: '7',
    });
  });

  it('returns just the room header when nothing matches', async () => {
    const admin = await createTestUser('data_export_rooms_empty_admin', 'admin');

    const response = await exportRooms(tokenFor(admin), 'no-such-room');

    expect(response.status).toBe(200);
    expect(response.headers['x-rooms-truncated']).toBeUndefined();
    expect(response.text).toBe(`${ROOMS_HEADER.join(',')}\r\n`);
    expect(parseCsv(response.text)).toEqual([ROOMS_HEADER]);
  });

  it('quotes RFC 4180 cells and neutralizes formulas in room and owner names', async () => {
    const admin = await createTestUser('data_export_rooms_escape_admin', 'admin');
    const owner = await createTestUser('data_export_rooms_escape_owner');
    await pool.execute('UPDATE users SET display_name = ? WHERE id = ?', [
      '@owner',
      owner.id,
    ]);
    const room = await createRoom(owner.id, {
      name: '=SUM(1), "room"',
      isPublic: true,
    });

    const response = await exportRooms(tokenFor(admin), 'SUM');
    expect(response.status).toBe(200);

    const rows = toObjects(response.text, ROOMS_HEADER);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(`'=SUM(1), "room"`);
    expect(rows[0].ownerName).toBe(`'@owner`);

    expect(response.text).toContain(`"'=SUM(1), ""room"""`);
    expect(response.text).toContain(`'@owner`);
    // The room is still reachable by id in the same export's first column.
    expect(rows[0].id).toBe(String(room.id));
  });

  it('caps the room CSV at 5000 rows and flags truncation only when more exist', async () => {
    const admin = await createTestUser('data_export_rooms_cap_admin', 'admin');
    const owner = await createTestUser('data_export_rooms_cap_owner');
    const prefix = 'data_export_rooms_cap_';
    await seedRooms(prefix, 5001, owner.id);
    const bounds = await idBounds('rooms', 'name', prefix);

    const capped = await exportRooms(tokenFor(admin), prefix);
    expect(capped.status).toBe(200);
    expect(capped.headers['x-rooms-truncated']).toBe('true');
    const cappedRows = toObjects(capped.text, ROOMS_HEADER);
    expect(cappedRows).toHaveLength(5000);
    expect(cappedRows[0].id).toBe(String(bounds.maxId));
    expect(cappedRows.map((row) => row.id)).not.toContain(String(bounds.minId));
    const ids = cappedRows.map((row) => Number(row.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));

    await pool.execute('DELETE FROM rooms WHERE id = ?', [bounds.minId]);
    const exact = await exportRooms(tokenFor(admin), prefix);
    expect(exact.status).toBe(200);
    expect(exact.headers['x-rooms-truncated']).toBeUndefined();
    expect(toObjects(exact.text, ROOMS_HEADER)).toHaveLength(5000);
  });

  it('rejects an over-long q on both exports', async () => {
    const admin = await createTestUser('data_export_query_admin', 'admin');
    const longQuery = 'a'.repeat(65);

    for (const response of await Promise.all([
      exportUsers(tokenFor(admin), longQuery),
      exportRooms(tokenFor(admin), longQuery),
    ])) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }
  });

  it('allows ten exports per minute per admin and endpoint', async () => {
    config.rateLimitEnabled = true;
    const admin = await createTestUser('data_export_rate_admin', 'admin');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await exportUsers(tokenFor(admin));
      expect(response.status).toBe(200);
    }
    const usersLimited = await exportUsers(tokenFor(admin));
    expect(usersLimited.status).toBe(429);
    expect(usersLimited.body.error.code).toBe('RATE_LIMITED');

    // The two exports use separate buckets, so the exhausted user export
    // does not block the room export.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await exportRooms(tokenFor(admin));
      expect(response.status).toBe(200);
    }
    const roomsLimited = await exportRooms(tokenFor(admin));
    expect(roomsLimited.status).toBe(429);
    expect(roomsLimited.body.error.code).toBe('RATE_LIMITED');

    // Buckets are per admin, so a second admin is unaffected.
    const other = await createTestUser('data_export_rate_other', 'admin');
    const otherResponse = await exportUsers(tokenFor(other));
    expect(otherResponse.status).toBe(200);
  });
});
