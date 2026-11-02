import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { runMigrations } from '../src/migrate-core';
import { dropDatabase, ensureDatabase } from './test-database';

function tempDatabaseUrl(name: string): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function columns(databaseUrl: string, table: string): Promise<string[]> {
  const conn = await createConnection({ uri: databaseUrl, timezone: 'Z' });
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    return rows.map((row) => String(row.COLUMN_NAME)).sort();
  } finally {
    await conn.end();
  }
}

describe('migrations', () => {
  it('bootstraps an empty database and re-runs safely', async () => {
    const databaseUrl = tempDatabaseUrl(`chat_test_migrate_${process.pid}`);
    await ensureDatabase(databaseUrl);
    try {
      await runMigrations(databaseUrl);
      expect(await columns(databaseUrl, 'messages')).toEqual(
        expect.arrayContaining(['edited_at', 'deleted_at', 'pinned_at', 'pinned_by']),
      );

      // Simulate a crash between the DDL and recording the version: rerunning
      // must not fail with "Duplicate column name".
      const conn = await createConnection({ uri: databaseUrl, multipleStatements: true });
      try {
        await conn.execute("DELETE FROM schema_migrations WHERE version = '0002_message_actions.sql'");
      } finally {
        await conn.end();
      }
      await runMigrations(databaseUrl);
      expect(await columns(databaseUrl, 'messages')).toEqual(
        expect.arrayContaining(['edited_at', 'deleted_at', 'pinned_at', 'pinned_by']),
      );

      // A second full run on an already-migrated database is a no-op.
      await runMigrations(databaseUrl);
    } finally {
      await dropDatabase(databaseUrl);
    }
  });
});
