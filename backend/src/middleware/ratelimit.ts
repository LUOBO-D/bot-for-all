import { config } from '../config';
import { logger } from '../logger';
import { closeRedisClient, connectRedis, usableRedis } from '../redis';

// Hard cap on tracked keys: without it, an attacker rotating keys (per-user,
// per-IP, per-room ids) could grow this map until the process runs out of
// memory. Oldest inserted keys are evicted first.
export const MAX_BUCKETS = 20_000;

/** Namespace so the limiter never collides with other Redis users. */
export const REDIS_KEY_PREFIX = 'bfa:rl:';

// INCR is atomic, and only the first hit of a window sets the TTL, so a
// rolling window never extends under sustained traffic. Returns the new count.
const RATE_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`;

/**
 * The slice of a Redis client the limiter needs. Narrowed to this shape so
 * tests can inject a fake and so an unreachable Redis degrades to the
 * in-memory buckets instead of failing every request.
 */
export interface RateLimitRedis {
  /** ioredis connection state; absent on fakes, treated as ready. */
  status?: string;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

const buckets = new Map<string, number[]>();

let redis: RateLimitRedis | null = null;

setInterval(() => {
  const now = Date.now();
  for (const [key, times] of buckets) {
    const fresh = times.filter((time) => now - time < 60 * 60 * 1000);
    if (fresh.length === 0) {
      buckets.delete(key);
    } else if (fresh.length !== times.length) {
      buckets.set(key, fresh);
    }
  }
}, 5 * 60_000).unref();

function evictOverflow(): void {
  while (buckets.size > MAX_BUCKETS) {
    const oldest = buckets.keys().next();
    if (oldest.done) {
      return;
    }
    buckets.delete(oldest.value);
  }
}

/** Test-only introspection of the bucket map size. */
export function rateLimitBucketCount(): number {
  return buckets.size;
}

/**
 * Test-only: swaps the Redis client (or removes it with `null`). Production
 * code reaches Redis through {@link initRateLimitRedis} only.
 */
export function __setRedisForTests(client: RateLimitRedis | null): void {
  redis = client;
}

/**
 * Connects the shared Redis client. A failure is logged and leaves the limiter
 * on the in-memory buckets, so a Redis outage never keeps the API from booting.
 */
export async function initRateLimitRedis(url: string): Promise<void> {
  if (redis) {
    return;
  }
  const client = await connectRedis(url, 'rate limit');
  if (client) {
    redis = client;
  }
}

/** Closes the Redis client on shutdown; never throws. */
export async function closeRateLimitRedis(): Promise<void> {
  const client = redis;
  redis = null;
  await closeRedisClient(client, 'rate limit');
}

function checkMemory(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const times = (buckets.get(key) ?? []).filter((time) => now - time < windowMs);
  if (times.length >= max) {
    buckets.set(key, times);
    evictOverflow();
    return false;
  }
  times.push(now);
  buckets.set(key, times);
  evictOverflow();
  return true;
}

/**
 * Counts one hit in Redis and returns the new counter value, or `null` when
 * Redis could not answer, so the caller can fall back to the in-memory
 * buckets instead of letting every request through.
 */
async function checkRedis(
  client: RateLimitRedis,
  key: string,
  windowMs: number,
): Promise<number | null> {
  try {
    const count = Number(
      await client.eval(RATE_LIMIT_SCRIPT, 1, `${REDIS_KEY_PREFIX}${key}`, windowMs),
    );
    return Number.isFinite(count) ? count : null;
  } catch (error) {
    logger.warn({ err: error }, 'redis rate limit failed, using in-memory rate limiting');
    return null;
  }
}

/**
 * Counts one hit for `key` and reports whether it is allowed. Uses Redis when
 * configured (shared across instances) and the per-process buckets otherwise,
 * including whenever Redis is unreachable.
 */
export async function checkRate(key: string, max: number, windowMs: number): Promise<boolean> {
  if (!config.rateLimitEnabled) {
    return true;
  }
  const client = usableRedis(redis, 'rate limit');
  // A real client that is connecting, reconnecting or closed cannot answer,
  // so go straight to memory.
  if (client) {
    const count = await checkRedis(client, key, windowMs);
    if (count !== null) {
      return count <= max;
    }
  }
  return checkMemory(key, max, windowMs);
}
