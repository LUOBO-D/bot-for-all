import { afterAll, beforeAll, beforeEach } from 'vitest';
import { pool } from '../src/db';
import { runMigrations } from '../src/migrate-core';

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of ['message_reactions', 'messages', 'room_members', 'bots', 'rooms', 'users']) {
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
