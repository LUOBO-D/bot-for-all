import { afterAll, beforeAll, beforeEach } from 'vitest';
import { config } from '../src/config';
import { pool } from '../src/db';
import { runMigrations } from '../src/migrate-core';
import { ensureDatabase } from './test-database';

beforeAll(async () => {
  // A fresh MySQL volume has no `chat_test` database yet.
  await ensureDatabase(config.databaseUrl);
  await runMigrations();
});

beforeEach(async () => {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of [
      'announcements',
      'notifications',
      'admin_audit_log',
      'message_edits',
      'message_reactions',
      'message_attachments',
      'poll_votes',
      'poll_options',
      'polls',
      'message_reports',
      'saved_messages',
      'scheduled_messages',
      'messages',
      'room_join_requests',
      'room_members',
      'bots',
      'rooms',
      'user_settings',
      'users',
    ]) {
      await conn.query(`TRUNCATE TABLE ${table}`);
    }
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    conn.release();
  }
});

afterAll(async () => {
  await pool.end();
});
