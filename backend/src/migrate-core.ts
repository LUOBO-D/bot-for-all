import fs from 'node:fs';
import path from 'node:path';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { config } from './config';
import { logger } from './logger';

function resolveMigrationsDir(): string {
  const candidates = [
    path.resolve(process.cwd(), '../db/migrations'),
    path.resolve(process.cwd(), 'db/migrations'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Migrations directory not found. Tried: ${candidates.join(', ')}`);
}

export async function runMigrations(databaseUrl: string = config.databaseUrl): Promise<void> {
  const dir = resolveMigrationsDir();
  const conn = await createConnection({
    uri: databaseUrl,
    multipleStatements: true,
    timezone: 'Z',
  });

  try {
    const [lockRows] = await conn.query<RowDataPacket[]>(
      "SELECT GET_LOCK('bfa_migrate', 30) AS acquired",
    );
    if (Number(lockRows[0]?.acquired) !== 1) {
      throw new Error('Could not acquire migration lock (another migration is running)');
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) NOT NULL,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (version)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    const [appliedRows] = await conn.query<RowDataPacket[]>(
      'SELECT version FROM schema_migrations',
    );
    const applied = new Set(appliedRows.map((row) => String(row.version)));

    const files = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      logger.info({ file }, 'applying migration');
      await conn.query(sql);
      await conn.execute('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
      logger.info({ file }, 'migration applied');
    }
  } finally {
    try {
      await conn.query("SELECT RELEASE_LOCK('bfa_migrate')");
    } catch {
      // connection may already be gone; the lock is released on disconnect
    }
    await conn.end();
  }
}
