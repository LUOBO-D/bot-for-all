import request from 'supertest';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { pool } from '../src/db';
import { runMigrations } from '../src/migrate-core';
import { createMessage, deleteMessage, editMessage, listMessageEdits } from '../src/services/message';
import type { AuthUser } from '../src/types';
import { createTestRoom, createTestUser, tokenFor } from './helpers';
import { dropDatabase, ensureDatabase } from './test-database';

const app = createApp();

// test/setup.ts truncates the tables it knows about; message_edits is newer, so
// this file clears its own rows before each test to stay independent of run
// order (message ids restart at 1 after every TRUNCATE).
beforeEach(async () => {
  await pool.execute('DELETE FROM message_edits');
});

afterAll(async () => {
  await pool.execute('DELETE FROM message_edits');
});

async function joinRoomAs(user: AuthUser, roomId: number): Promise<void> {
  const response = await request(app)
    .post(`/api/rooms/${roomId}/join`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .send({});
  expect(response.status).toBe(200);
}

function getEdits(roomId: number, seq: number, user: AuthUser) {
  return request(app)
    .get(`/api/rooms/${roomId}/messages/${seq}/edits`)
    .set('Authorization', `Bearer ${tokenFor(user)}`);
}

function patchMessage(roomId: number, seq: number, user: AuthUser, content: string) {
  return request(app)
    .patch(`/api/rooms/${roomId}/messages/${seq}`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .send({ content });
}

async function editRows(messageId: number): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT old_content, edited_by, room_id FROM message_edits WHERE message_id = ? ORDER BY id',
    [messageId],
  );
  return rows;
}

describe('message edit history', () => {
  it('records every replaced revision in order and reports the live content', async () => {
    const alice = await createTestUser('edits_owner');
    const roomId = await createTestRoom(alice);
    const message = await createMessage({
      roomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'v1',
    });

    const second = await patchMessage(roomId, message.seq, alice, 'v2');
    expect(second.status).toBe(200);
    const third = await patchMessage(roomId, message.seq, alice, 'v3');
    expect(third.status).toBe(200);
    expect(third.body.message.content).toBe('v3');

    const response = await getEdits(roomId, message.seq, alice);
    expect(response.status).toBe(200);
    expect(response.body.current).toBe('v3');
    expect(response.body.edits.map((entry: { oldContent: string }) => entry.oldContent)).toEqual([
      'v1',
      'v2',
    ]);
    for (const entry of response.body.edits) {
      expect(entry.editedBy).toBe(alice.id);
      expect(entry.editorName).toBe('edits_owner');
      expect(typeof entry.editedAt).toBe('string');
      expect(entry.editedAt.length).toBeGreaterThan(0);
    }
    expect(
      Date.parse(response.body.edits[0].editedAt) <= Date.parse(response.body.edits[1].editedAt),
    ).toBe(true);

    const rows = await editRows(message.id);
    expect(rows.map((row) => String(row.old_content))).toEqual(['v1', 'v2']);
    expect(rows.every((row) => Number(row.edited_by) === alice.id)).toBe(true);
    expect(rows.every((row) => Number(row.room_id) === roomId)).toBe(true);
  });

  it('skips the history entry when the content is unchanged', async () => {
    const alice = await createTestUser('edits_noop');
    const roomId = await createTestRoom(alice);
    const message = await createMessage({
      roomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'stable',
    });

    const noop = await editMessage(roomId, message.seq, alice.id, 'stable');
    expect(noop.content).toBe('stable');
    expect(noop.editedAt).toBeNull();
    expect(await editRows(message.id)).toHaveLength(0);

    // The route trims input, so surrounding whitespace also collapses to a no-op.
    const viaRoute = await patchMessage(roomId, message.seq, alice, '  stable  ');
    expect(viaRoute.status).toBe(200);
    expect(viaRoute.body.message.editedAt).toBeNull();
    expect(await editRows(message.id)).toHaveLength(0);

    const history = await listMessageEdits(roomId, message.seq);
    expect(history).toEqual({ current: 'stable', edits: [] });
  });

  it('rejects non-members with 403', async () => {
    const alice = await createTestUser('edits_member');
    const outsider = await createTestUser('edits_outsider');
    const roomId = await createTestRoom(alice);
    const message = await createMessage({
      roomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'private',
    });

    const response = await getEdits(roomId, message.seq, outsider);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
  });

  it('returns 404 for a message that does not exist', async () => {
    const alice = await createTestUser('edits_missing');
    const roomId = await createTestRoom(alice);

    const response = await getEdits(roomId, 4242, alice);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('keeps the sender-only edit rule and does not record rejected edits', async () => {
    const alice = await createTestUser('edits_author');
    const bob = await createTestUser('edits_hijacker');
    const roomId = await createTestRoom(alice);
    await joinRoomAs(bob, roomId);
    const message = await createMessage({
      roomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'mine',
    });

    const hijack = await patchMessage(roomId, message.seq, bob, 'hijacked');
    expect(hijack.status).toBe(403);
    expect(hijack.body.error.code).toBe('NOT_SENDER');
    expect(await editRows(message.id)).toHaveLength(0);

    // Members can read the history even when they cannot write to it.
    const history = await getEdits(roomId, message.seq, bob);
    expect(history.status).toBe(200);
    expect(history.body).toEqual({ current: 'mine', edits: [] });
  });

  it('hides the history once the message is deleted', async () => {
    const alice = await createTestUser('edits_deleted');
    const roomId = await createTestRoom(alice);
    const message = await createMessage({
      roomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'first',
    });
    await editMessage(roomId, message.seq, alice.id, 'second');
    await deleteMessage(roomId, message.seq, alice.id, false);

    // Deleted messages keep their row but every read hides the content, so the
    // endpoint mirrors that: 200 with an empty history instead of 404.
    const response = await getEdits(roomId, message.seq, alice);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ current: '', edits: [] });
    expect(await editRows(message.id)).toHaveLength(1);
  });

  it('cascades history rows away with the message', async () => {
    const alice = await createTestUser('edits_cascade');
    const roomId = await createTestRoom(alice);
    const message = await createMessage({
      roomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'before',
    });
    await editMessage(roomId, message.seq, alice.id, 'after');
    expect(await editRows(message.id)).toHaveLength(1);

    await pool.execute('DELETE FROM messages WHERE id = ?', [message.id]);
    expect(await editRows(message.id)).toHaveLength(0);
  });
});

describe('0014_message_edits migration', () => {
  it('creates the history table and re-runs safely', async () => {
    const databaseUrl = new URL(config.databaseUrl);
    databaseUrl.pathname = `/chat_test_edits_${process.pid}`;
    const url = databaseUrl.toString();
    await ensureDatabase(url);
    try {
      await runMigrations(url);
      const conn = await createConnection({ uri: url, timezone: 'Z' });
      try {
        const [columns] = await conn.query<RowDataPacket[]>(
          `SELECT COLUMN_NAME FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message_edits'`,
        );
        expect(columns.map((row) => String(row.COLUMN_NAME)).sort()).toEqual([
          'edited_at',
          'edited_by',
          'id',
          'message_id',
          'old_content',
          'room_id',
        ]);
        const [indexes] = await conn.query<RowDataPacket[]>(
          `SELECT INDEX_NAME FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message_edits'
           GROUP BY INDEX_NAME`,
        );
        expect(indexes.map((row) => String(row.INDEX_NAME))).toContain(
          'idx_message_edits_message',
        );

        // Simulate a crash between the DDL and recording the version.
        await conn.execute(
          "DELETE FROM schema_migrations WHERE version = '0014_message_edits.sql'",
        );
      } finally {
        await conn.end();
      }
      // Rerunning the migration after the version row vanished must not fail
      // with "Table already exists".
      await runMigrations(url);
    } finally {
      await dropDatabase(url);
    }
  });
});
