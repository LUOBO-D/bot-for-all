import { Redis, type RedisOptions } from 'ioredis';
import { logger } from './logger';

/**
 * Options shared by every optional Redis backend (rate limit, presence,
 * captcha): connect lazily, fail fast, and never queue commands while the link
 * is down so callers can fall back to their in-process state immediately.
 */
const CLIENT_OPTIONS: RedisOptions = {
  lazyConnect: true,
  connectTimeout: 2_000,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  // A dropped connection is retried for ~18s before the client gives up;
  // meanwhile every caller keeps serving from memory.
  retryStrategy: (attempt) => (attempt > 10 ? null : Math.min(attempt * 200, 2_000)),
};

/** The slice of a client needed to shut it down; narrowed for test fakes. */
export interface ClosableRedis {
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

/**
 * Opens a Redis client for one optional feature. Returns `null` after logging
 * when the server is unreachable, so startup never depends on Redis.
 */
export async function connectRedis(url: string, label: string): Promise<Redis | null> {
  const onConnectionError = (error: Error): void => {
    logger.warn({ err: error }, `redis ${label} connection error`);
  };
  const client = new Redis(url, CLIENT_OPTIONS);
  client.on('error', onConnectionError);
  try {
    await client.connect();
    logger.info(`redis ${label} backend enabled`);
    return client;
  } catch (error) {
    logger.warn({ err: error }, `redis unavailable, ${label} uses in-memory state`);
    // The client is discarded: keep a silent listener so a late 'error' does
    // not crash the process, but stop logging the outage.
    client.off('error', onConnectionError);
    client.on('error', () => {});
    client.disconnect();
    return null;
  }
}

const lastNotReadyStatus = new Map<string, string>();

/**
 * Returns the client only when it can answer right now. A connecting,
 * reconnecting or closed client falls back to memory, with one warning per
 * state change so a flapping link does not flood the log.
 */
export function usableRedis<T extends { status?: string }>(
  client: T | null,
  label: string,
): T | null {
  if (!client) {
    return null;
  }
  if (!client.status || client.status === 'ready') {
    lastNotReadyStatus.delete(label);
    return client;
  }
  if (lastNotReadyStatus.get(label) !== client.status) {
    lastNotReadyStatus.set(label, client.status);
    logger.warn({ status: client.status }, `redis ${label} not ready, using in-memory state`);
  }
  return null;
}

/** Closes a Redis client on shutdown; never throws. */
export async function closeRedisClient(
  client: ClosableRedis | null,
  label: string,
): Promise<void> {
  if (!client) {
    return;
  }
  try {
    if (client.quit) {
      await client.quit();
    } else {
      client.disconnect?.();
    }
  } catch (error) {
    logger.warn({ err: error }, `error closing redis ${label} client`);
    client.disconnect?.();
  }
}
