import { Redis, type RedisOptions } from 'ioredis';
import { logger } from './logger';

/** Longest reconnect delay; every later attempt keeps using this delay. */
export const REDIS_RETRY_MAX_MS = 2_000;

/** Budget for the very first connect, after which a feature uses memory. */
export const REDIS_INITIAL_CONNECT_TIMEOUT_MS = 3_000;

/**
 * Reconnect delay after a failed attempt. This deliberately never returns
 * `null`: giving up would leave a feature on in-process state forever after a
 * runtime outage, while an unbounded retry lets it heal as soon as Redis is
 * reachable again.
 */
export function redisRetryDelay(attempt: number): number {
  return Math.min(attempt * 200, REDIS_RETRY_MAX_MS);
}

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
  retryStrategy: redisRetryDelay,
};

/** How often one outage may write a connection-error warning. */
const ERROR_LOG_INTERVAL_MS = 30_000;

/** Races `connect()` against the startup budget without leaking the timer. */
export async function connectWithTimeout(client: Redis, timeoutMs: number): Promise<void> {
  const { promise: timedOut, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => reject(new Error(`redis connect timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    await Promise.race([client.connect(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

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
  let lastErrorLogAt = 0;
  const onConnectionError = (error: Error): void => {
    // A permanently unreachable Redis keeps retrying forever, so log at most
    // one warning per interval instead of once per attempt.
    const now = Date.now();
    if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) {
      return;
    }
    lastErrorLogAt = now;
    logger.warn({ err: error }, `redis ${label} connection error`);
  };
  const client = new Redis(url, CLIENT_OPTIONS);
  client.on('error', onConnectionError);
  // A recovered link gets a fresh logging budget for the next outage.
  client.on('ready', () => {
    lastErrorLogAt = 0;
  });
  try {
    // Startup stays bounded even though the client itself retries forever:
    // only a runtime drop after a successful connect benefits from that.
    await connectWithTimeout(client, REDIS_INITIAL_CONNECT_TIMEOUT_MS);
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
