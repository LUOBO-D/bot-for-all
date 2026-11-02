import mysql, { type RowDataPacket } from 'mysql2/promise';

/**
 * Wipes the e2e database before Playwright starts its servers. Without this the
 * suite accumulates rooms/messages across runs until per-test timings and
 * count-based assertions become flaky.
 *
 * Safe by construction: it only touches the database named by DATABASE_URL and
 * refuses anything that is not clearly an e2e database.
 */
async function main(): Promise<void> {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('DATABASE_URL is required');
  }
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, '');
  if (!/e2e/i.test(database)) {
    throw new Error(`Refusing to reset non-e2e database: ${database}`);
  }

  const server = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  });
  await server.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  );
  await server.end();

  const conn = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  });
  const [rows] = await conn.query<RowDataPacket[]>('SHOW TABLES');
  const tables = rows.map((row) => String(Object.values(row)[0]));
  if (tables.length === 0) {
    await conn.end();
    console.log(`${database} ready (empty)`);
    return;
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of tables) {
    await conn.query(`TRUNCATE TABLE \`${table.replace(/`/g, '``')}\``);
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  await conn.end();
  console.log(`${database} reset (${tables.length} tables)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
