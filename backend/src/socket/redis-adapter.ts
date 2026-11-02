import { createAdapter } from '@socket.io/redis-adapter';
import { Redis, type RedisOptions } from 'ioredis';
import type { Server } from 'socket.io';
import { logger } from '../logger';

/**
 * Options for the adapter's dedicated pub/sub pair. Unlike the optional
 * feature clients in `redis.ts` (which fail fast and fall back to memory),
 * these keep ioredis' default offline queue and retry loop: the adapter is the
 * only path for cross-instance events, so a short outage must not silently
 * drop them.
 */
const CLIENT_OPTIONS: RedisOptions = {
  lazyConnect: true,
  connectTimeout: 2_000,
};

interface AdapterPair {
  pub: Redis;
  sub: Redis;
}

let pair: AdapterPair | null = null;

/**
 * Logs the first error of an outage, then stays quiet until the link is back,
 * so a flapping Redis does not flood the log on every retry. Every error is
 * still reported to `onError`, because ioredis' `connect()` promise only
 * rejects with a generic "Connection is closed."
 */
function watchConnection(
  client: Redis,
  role: 'pub' | 'sub',
  onError: (error: Error) => void,
): void {
  let reported = false;
  client.on('ready', () => {
    reported = false;
  });
  client.on('error', (error: Error) => {
    onError(error);
    if (reported) {
      return;
    }
    reported = true;
    logger.warn({ err: error, role }, `redis socket.io adapter ${role} connection error`);
  });
}

/**
 * Closes one adapter client: QUIT while the link is up, disconnect otherwise.
 * QUIT on a client that is still connecting/reconnecting would queue behind the
 * connection and never settle, which would hang shutdown.
 */
async function closeClient(client: Redis): Promise<void> {
  if (client.status === 'ready' || client.status === 'connect') {
    try {
      await client.quit();
      return;
    } catch (error) {
      logger.warn({ err: error }, 'error closing redis socket.io adapter client');
    }
  }
  client.disconnect();
}

/**
 * Switches `io` to the Redis adapter so every backend instance shares one
 * broadcast bus. Returns `false` — leaving the default in-process adapter in
 * place — when Redis cannot be reached, so startup never depends on it.
 *
 * Must be called before the server starts accepting connections.
 */
export async function attachRedisAdapter(io: Server, url: string): Promise<boolean> {
  if (pair) {
    return true;
  }
  let pub: Redis;
  let sub: Redis;
  try {
    pub = new Redis(url, CLIENT_OPTIONS);
    sub = new Redis(url, CLIENT_OPTIONS);
  } catch (error) {
    // A malformed URL throws from the constructor; startup must not depend on
    // the adapter either way.
    logger.warn({ err: error }, 'redis unavailable, socket.io stays single-instance');
    return false;
  }
  let lastError: Error | null = null;
  const onError = (error: Error): void => {
    lastError = error;
  };
  watchConnection(pub, 'pub', onError);
  watchConnection(sub, 'sub', onError);
  try {
    await Promise.all([pub.connect(), sub.connect()]);
  } catch (error) {
    logger.warn({ err: lastError ?? error }, 'redis unavailable, socket.io stays single-instance');
    await Promise.all([closeClient(pub), closeClient(sub)]);
    return false;
  }
  io.adapter(createAdapter(pub, sub));
  pair = { pub, sub };
  logger.info('socket.io redis adapter enabled, events reach every backend instance');
  return true;
}

/** Closes the adapter clients on shutdown; never throws. */
export async function detachRedisAdapter(): Promise<void> {
  const current = pair;
  pair = null;
  if (!current) {
    return;
  }
  await Promise.all([closeClient(current.pub), closeClient(current.sub)]);
}
