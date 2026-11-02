import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { logger } from '../src/logger';
import {
  MAX_BUCKETS,
  REDIS_KEY_PREFIX,
  __setRedisForTests,
  checkRate,
  closeRateLimitRedis,
  rateLimitBucketCount,
  type RateLimitRedis,
} from '../src/middleware/ratelimit';

let originalEnabled: boolean;

/**
 * Minimal stand-in for the Redis client: mirrors what the Lua script does
 * (INCR, PEXPIRE on the first hit) while recording the raw call.
 */
class FakeRedis implements RateLimitRedis {
  status?: string;

  counts = new Map<string, number>();

  expirations: { key: string; windowMs: number }[] = [];

  evalCalls = 0;

  script = '';

  numKeys = 0;

  failure: Error | null = null;

  quit = vi.fn(async () => 'OK');

  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.evalCalls += 1;
    this.script = script;
    this.numKeys = numKeys;
    if (this.failure) {
      throw this.failure;
    }
    const key = String(args[0]);
    const windowMs = Number(args[1]);
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    if (next === 1) {
      this.expirations.push({ key, windowMs });
    }
    return next;
  }
}

function uniqueKey(label: string): string {
  return `${label}:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

beforeEach(() => {
  originalEnabled = config.rateLimitEnabled;
  config.rateLimitEnabled = true;
  __setRedisForTests(null);
});

afterEach(() => {
  config.rateLimitEnabled = originalEnabled;
  __setRedisForTests(null);
  vi.restoreAllMocks();
});

describe('in-memory rate limit buckets', () => {
  it('caps the bucket map and still limits fresh keys', async () => {
    const prefix = `cap:${process.pid}:${Date.now()}:`;

    for (let index = 0; index < MAX_BUCKETS + 250; index += 1) {
      await checkRate(`${prefix}${index}`, 5, 60_000);
    }

    expect(rateLimitBucketCount()).toBeLessThanOrEqual(MAX_BUCKETS);

    // The newest key survived the eviction and is still throttled.
    const freshKey = `${prefix}fresh`;
    expect(await checkRate(freshKey, 1, 60_000)).toBe(true);
    expect(await checkRate(freshKey, 1, 60_000)).toBe(false);
    expect(rateLimitBucketCount()).toBeLessThanOrEqual(MAX_BUCKETS);
  });

  it('evicts in insertion order so recently added keys keep working', async () => {
    const prefix = `order:${process.pid}:${Date.now()}:`;
    const survivor = `${prefix}survivor`;
    expect(await checkRate(survivor, 2, 60_000)).toBe(true);

    for (let index = 0; index < MAX_BUCKETS; index += 1) {
      await checkRate(`${prefix}${index}`, 5, 60_000);
    }

    expect(rateLimitBucketCount()).toBeLessThanOrEqual(MAX_BUCKETS);
    // The first key is the oldest and may have been evicted, so re-check that
    // a key inserted after the fill still enforces its limit.
    const tail = `${prefix}tail`;
    expect(await checkRate(tail, 1, 60_000)).toBe(true);
    expect(await checkRate(tail, 1, 60_000)).toBe(false);
  });

  it('does not track keys when rate limiting is disabled', async () => {
    config.rateLimitEnabled = false;
    const redis = new FakeRedis();
    __setRedisForTests(redis);
    const before = rateLimitBucketCount();
    expect(await checkRate(uniqueKey('off'), 1, 60_000)).toBe(true);
    expect(rateLimitBucketCount()).toBe(before);
    expect(redis.evalCalls).toBe(0);
  });
});

describe('redis rate limit backend', () => {
  it('counts through the prefix and enforces the limit', async () => {
    const redis = new FakeRedis();
    __setRedisForTests(redis);
    const key = uniqueKey('redis');
    const bucketsBefore = rateLimitBucketCount();

    expect(await checkRate(key, 2, 60_000)).toBe(true);
    expect(await checkRate(key, 2, 60_000)).toBe(true);
    expect(await checkRate(key, 2, 60_000)).toBe(false);

    const redisKey = `${REDIS_KEY_PREFIX}${key}`;
    expect(redis.counts.get(redisKey)).toBe(3);
    expect(redis.numKeys).toBe(1);
    // INCR + a single PEXPIRE on the first hit, so the window never slides.
    expect(redis.script).toMatch(/INCR/);
    expect(redis.script).toMatch(/PEXPIRE/);
    expect(redis.expirations).toEqual([{ key: redisKey, windowMs: 60_000 }]);
    // Redis answered, so the local buckets stayed untouched.
    expect(rateLimitBucketCount()).toBe(bucketsBefore);
  });

  it('passes the window and key as the script arguments', async () => {
    const redis = new FakeRedis();
    __setRedisForTests(redis);
    const key = uniqueKey('window');

    await checkRate(key, 1, 12_345);

    expect(redis.expirations).toEqual([
      { key: `${REDIS_KEY_PREFIX}${key}`, windowMs: 12_345 },
    ]);
  });

  it('falls back to the in-memory buckets when redis throws', async () => {
    const redis = new FakeRedis();
    redis.failure = new Error('redis down');
    __setRedisForTests(redis);
    const warn = vi.spyOn(logger, 'warn');
    const key = uniqueKey('fallback');

    // Still limited: a broken Redis must not let everything through.
    expect(await checkRate(key, 1, 60_000)).toBe(true);
    expect(await checkRate(key, 1, 60_000)).toBe(false);

    expect(redis.evalCalls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(rateLimitBucketCount()).toBeGreaterThan(0);
  });

  it('skips a client that is not connected and uses memory', async () => {
    const redis = new FakeRedis();
    redis.status = 'end';
    __setRedisForTests(redis);
    const key = uniqueKey('closed');

    expect(await checkRate(key, 1, 60_000)).toBe(true);
    expect(await checkRate(key, 1, 60_000)).toBe(false);
    expect(redis.evalCalls).toBe(0);
  });

  it('quits the client on shutdown and reverts to memory', async () => {
    const redis = new FakeRedis();
    __setRedisForTests(redis);
    const key = uniqueKey('quit');

    expect(await checkRate(key, 5, 60_000)).toBe(true);
    await closeRateLimitRedis();
    expect(redis.quit).toHaveBeenCalledTimes(1);

    // No client left: the next check is served by the in-memory buckets.
    expect(await checkRate(key, 5, 60_000)).toBe(true);
    expect(redis.evalCalls).toBe(1);
    expect(rateLimitBucketCount()).toBeGreaterThan(0);
  });
});
