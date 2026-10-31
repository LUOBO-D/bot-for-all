import {
  createPool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import { config } from './config';

export const pool = createPool({
  uri: config.databaseUrl,
  connectionLimit: 10,
  waitForConnections: true,
  timezone: 'Z',
  charset: 'utf8mb4',
  enableKeepAlive: true,
});

export async function withTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    try {
      await conn.rollback();
    } catch {
      // ignore rollback failure
    }
    throw error;
  } finally {
    conn.release();
  }
}

export async function waitForDb(retries = 30, delayMs = 1000): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === retries - 1) {
        throw error;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, delayMs);
      await promise;
    }
  }
}

export type { PoolConnection, ResultSetHeader, RowDataPacket };
