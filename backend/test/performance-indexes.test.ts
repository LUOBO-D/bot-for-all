import fs from 'node:fs';
import path from 'node:path';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { pool, type ResultSetHeader } from '../src/db';
import { createTestUser } from './helpers';

interface IndexSpec {
  table: string;
  index: string;
  /** Expected key parts, in `SEQ_IN_INDEX` order. */
  columns: string[];
}

const EXPECTED_INDEXES: IndexSpec[] = [
  { table: 'messages', index: 'idx_messages_room_created', columns: ['room_id', 'created_at'] },
  {
    table: 'messages',
    index: 'idx_messages_room_sender_created',
    columns: ['room_id', 'sender_id', 'created_at'],
  },
  { table: 'admin_audit_log', index: 'idx_audit_actor', columns: ['actor_id', 'id'] },
  {
    table: 'message_attachments',
    index: 'idx_message_attachments_uploader',
    columns: ['uploader_id'],
  },
  {
    table: 'message_attachments',
    index: 'idx_message_attachments_room_id',
    columns: ['room_id', 'id'],
  },
  { table: 'rooms', index: 'idx_rooms_public_id', columns: ['is_public', 'id'] },
];

/** Key parts of one index, in `SEQ_IN_INDEX` order; `[]` when it is missing. */
async function indexColumns(table: string, index: string): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
      ORDER BY SEQ_IN_INDEX`,
    [table, index],
  );
  return rows.map((row) => String(row.COLUMN_NAME));
}

async function explain(sql: string, params: Array<string | number>): Promise<RowDataPacket> {
  const [rows] = await pool.query<RowDataPacket[]>(`EXPLAIN ${sql}`, params);
  expect(rows).toHaveLength(1);
  return rows[0];
}

/**
 * The optimizer may keep a scan on a near-empty table, so the plan only has
 * to name a key that can answer the query; the new index is always the one
 * expected to win on a table with real data.
 */
function expectKeyUsed(plan: RowDataPacket, allowed: string[]): void {
  const key = plan.key == null ? null : String(plan.key);
  expect(key, `unexpected plan: ${JSON.stringify(plan)}`).not.toBeNull();
  expect(allowed).toContain(key);
}

/**
 * Enough rows that the optimizer treats each access path as a real choice;
 * a handful of rows would all be read through the primary key instead.
 */
async function seedPerformanceData(): Promise<{
  aliceId: number;
  bobId: number;
  publicRoomId: number;
  privateRoomId: number;
}> {
  const alice = await createTestUser('alice');
  const bob = await createTestUser('bob');

  // 200 rooms, 20 of them public, so `is_public = 1` is selective.
  const roomValues: Array<[string, number, number]> = [];
  for (let i = 0; i < 200; i += 1) {
    roomValues.push([`perf-room-${i}`, alice.id, i % 10 === 0 ? 1 : 0]);
  }
  const [roomResult] = await pool.query<ResultSetHeader>(
    'INSERT INTO rooms (name, owner_id, is_public) VALUES ?',
    [roomValues],
  );
  const publicRoomId = roomResult.insertId;
  const privateRoomId = publicRoomId + 1;

  // Two rooms, alternating senders, one message per day over a year.
  const messageValues: Array<[number, number, number, string, string, string]> = [];
  for (let i = 0; i < 400; i += 1) {
    const roomId = i % 2 === 0 ? publicRoomId : privateRoomId;
    const senderId = i % 3 === 0 ? alice.id : bob.id;
    const month = String((i % 12) + 1).padStart(2, '0');
    messageValues.push([
      roomId,
      i + 1,
      senderId,
      'user',
      `performance message ${i}`,
      `2024-${month}-15 12:00:00.000`,
    ]);
  }
  await pool.query(
    `INSERT INTO messages (room_id, seq, sender_id, sender_type, content, created_at)
     VALUES ?`,
    [messageValues],
  );

  const [messageRows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM messages WHERE room_id = ? ORDER BY id',
    [publicRoomId],
  );
  const attachmentValues: Array<[number, number, number | null, string, string, string, number]> =
    [];
  for (let i = 0; i < 200; i += 1) {
    // Quota rows: unbound uploads by alice, the shape the COUNT/SUM sees.
    attachmentValues.push([
      privateRoomId,
      alice.id,
      null,
      `quota-${i}.bin`,
      `quota-stored-${i}`,
      'application/octet-stream',
      1024,
    ]);
  }
  for (let i = 0; i < 2000; i += 1) {
    // Media rows: bound attachments in the public room, newest id last. Ten
    // files per message is enough that an ordered index scan beats reading
    // the room's whole attachment set and sorting it.
    const messageId = Number(messageRows[i % messageRows.length].id);
    attachmentValues.push([
      publicRoomId,
      alice.id,
      messageId,
      `media-${i}.png`,
      `media-stored-${i}`,
      'image/png',
      2048,
    ]);
  }
  // Filler owned by another uploader, so alice's quota rows stay a small
  // fraction of the table and the quota index is worth using.
  for (let i = 0; i < 2000; i += 1) {
    attachmentValues.push([
      privateRoomId,
      bob.id,
      null,
      `filler-${i}.bin`,
      `filler-stored-${i}`,
      'application/octet-stream',
      4096,
    ]);
  }
  await pool.query(
    `INSERT INTO message_attachments
       (room_id, uploader_id, message_id, filename, stored_name, mime, size)
     VALUES ?`,
    [attachmentValues],
  );

  const auditValues: Array<[number, string, string]> = [];
  for (let i = 0; i < 400; i += 1) {
    auditValues.push([i % 2 === 0 ? alice.id : bob.id, 'room.delete', 'room']);
  }
  await pool.query(
    'INSERT INTO admin_audit_log (actor_id, action, target_type) VALUES ?',
    [auditValues],
  );

  // Plans must be decided on the seeded distribution, not on the empty-table
  // statistics left behind by the previous test's truncation.
  await pool.query('ANALYZE TABLE messages, message_attachments, admin_audit_log, rooms');

  return { aliceId: alice.id, bobId: bob.id, publicRoomId, privateRoomId };
}

describe('performance indexes', () => {
  it('installs every composite index with the intended key order', async () => {
    for (const spec of EXPECTED_INDEXES) {
      expect(await indexColumns(spec.table, spec.index), `${spec.table}.${spec.index}`).toEqual(
        spec.columns,
      );
    }
  });

  it('re-runs the migration without failing', async () => {
    const candidates = [
      path.resolve(process.cwd(), '../db/migrations/0030_performance_indexes.sql'),
      path.resolve(process.cwd(), 'db/migrations/0030_performance_indexes.sql'),
    ];
    const file = candidates.find((candidate) => fs.existsSync(candidate));
    expect(file, `migration not found in ${candidates.join(', ')}`).toBeDefined();

    // MySQL DDL is not transactional, so a crash after an ALTER but before
    // the version row must not break the next run with "Duplicate key name".
    const conn = await createConnection({
      uri: config.databaseUrl,
      multipleStatements: true,
      timezone: 'Z',
    });
    try {
      const sql = fs.readFileSync(file as string, 'utf8');
      await conn.query(sql);
      await conn.query(sql);
    } finally {
      await conn.end();
    }

    for (const spec of EXPECTED_INDEXES) {
      expect(await indexColumns(spec.table, spec.index), `${spec.table}.${spec.index}`).toEqual(
        spec.columns,
      );
    }
  });

  it('lets the optimizer use the new indexes for representative queries', async () => {
    const { aliceId, bobId, publicRoomId, privateRoomId } = await seedPerformanceData();

    // Date-window search (and the retention cutoff shape): per-room range on
    // created_at, which the composite index answers without touching the room
    // scan.
    const roomCreated = await explain(
      `SELECT id FROM messages
        WHERE room_id = ? AND created_at BETWEEN ? AND ?`,
      [publicRoomId, '2024-02-01 00:00:00.000', '2024-04-01 00:00:00.000'],
    );
    expectKeyUsed(roomCreated, ['idx_messages_room_created']);

    // Sender + date search, newest first, answered in index order.
    const senderCreated = await explain(
      `SELECT id FROM messages
        WHERE room_id = ? AND sender_id = ? AND created_at >= ?
        ORDER BY created_at DESC LIMIT 50`,
      [publicRoomId, bobId, '2024-01-01 00:00:00.000'],
    );
    expectKeyUsed(senderCreated, ['idx_messages_room_sender_created']);

    // Admin audit: one operator's entries, newest first.
    const auditByActor = await explain(
      'SELECT id FROM admin_audit_log WHERE actor_id = ? ORDER BY id DESC LIMIT 20',
      [aliceId],
    );
    expectKeyUsed(auditByActor, ['idx_audit_actor']);

    // Upload quota: COUNT/SUM for one uploader.
    const quota = await explain(
      `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS used
         FROM message_attachments WHERE uploader_id = ?`,
      [aliceId],
    );
    expectKeyUsed(quota, ['idx_message_attachments_uploader']);

    // Media library pagination: room-scoped page, newest attachment first.
    // The visibility filter (`message_id IS NOT NULL`) can also be answered by
    // the older (room_id, uploader_id, message_id) index, so the ordering
    // query alone is what proves the new index.
    const mediaPage = await explain(
      `SELECT a.id FROM message_attachments a
        WHERE a.room_id = ?
        ORDER BY a.id DESC LIMIT 20`,
      [publicRoomId],
    );
    expectKeyUsed(mediaPage, ['idx_message_attachments_room_id']);

    const mediaWithVisibility = await explain(
      `SELECT a.id FROM message_attachments a
        WHERE a.room_id = ? AND a.message_id IS NOT NULL
        ORDER BY a.id DESC LIMIT 20`,
      [publicRoomId],
    );
    expectKeyUsed(mediaWithVisibility, [
      'idx_message_attachments_room_id',
      'idx_message_attachments_room_uploader',
    ]);

    // Public room discovery: public rooms, newest first.
    const publicRooms = await explain(
      'SELECT id, name FROM rooms WHERE is_public = 1 ORDER BY id DESC LIMIT 20',
      [],
    );
    expectKeyUsed(publicRooms, ['idx_rooms_public_id']);

    // The private room is the control: its date query still hits the same
    // index, so the plan does not depend on one lucky room id.
    const privateCreated = await explain(
      `SELECT id FROM messages
        WHERE room_id = ? AND created_at BETWEEN ? AND ?`,
      [privateRoomId, '2024-02-01 00:00:00.000', '2024-04-01 00:00:00.000'],
    );
    expectKeyUsed(privateCreated, ['idx_messages_room_created']);
  });
});
