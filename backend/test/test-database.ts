import { createConnection, type Connection } from 'mysql2/promise';

function parseDatabaseUrl(databaseUrl: string): { url: URL; database: string } {
  const url = new URL(databaseUrl);
  return { url, database: decodeURIComponent(url.pathname.replace(/^\//, '')) };
}

function quoteIdentifier(value: string): string {
  return `\`${value.replace(/`/g, '``')}\``;
}

/** Opens a connection to the server without selecting a database. */
async function withServerConnection<T>(
  url: URL,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  const conn = await createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    timezone: 'Z',
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

/**
 * A fresh MySQL volume has no test database, so connecting to the pool target
 * fails with ER_BAD_DB_ERROR before migrations run. Create it first.
 */
export async function ensureDatabase(databaseUrl: string): Promise<void> {
  const { url, database } = parseDatabaseUrl(databaseUrl);
  if (!database) {
    return;
  }
  await withServerConnection(url, async (conn) => {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(database)}
       CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
  });
}

export async function dropDatabase(databaseUrl: string): Promise<void> {
  const { url, database } = parseDatabaseUrl(databaseUrl);
  if (!database) {
    return;
  }
  await withServerConnection(url, async (conn) => {
    await conn.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`);
  });
}
