import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fixed answer so the fallback path can be verified without reading the image.
vi.mock('svg-captcha', () => ({
  default: {
    create: () => ({ text: 'AbCd', data: '<svg>captcha</svg>' }),
  },
}));

import { config } from '../src/config';
import { logger } from '../src/logger';
import {
  CAPTCHA_KEY_PREFIX,
  CAPTCHA_TTL_SECONDS,
  __setCaptchaRedisForTests,
  closeCaptchaRedis,
  createCaptcha,
  verifyCaptcha,
  type CaptchaRedis,
} from '../src/auth/captcha';

/** In-memory stand-in for the captcha string commands. */
class FakeCaptchaRedis implements CaptchaRedis {
  status?: string;

  values = new Map<string, string>();

  ttls: { key: string; seconds: number }[] = [];

  deleted: string[] = [];

  failure: Error | null = null;

  quit = vi.fn(async () => 'OK');

  private check(): void {
    if (this.failure) {
      throw this.failure;
    }
  }

  async setex(key: string, seconds: number, value: string): Promise<unknown> {
    this.check();
    this.values.set(key, value);
    this.ttls.push({ key, seconds });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.check();
    return this.values.get(key) ?? null;
  }

  async del(key: string): Promise<unknown> {
    this.check();
    const existed = this.values.delete(key);
    this.deleted.push(key);
    return existed ? 1 : 0;
  }
}

let originalCaptchaEnabled: boolean;

beforeEach(() => {
  originalCaptchaEnabled = config.captchaEnabled;
  config.captchaEnabled = true;
  __setCaptchaRedisForTests(null);
});

afterEach(() => {
  config.captchaEnabled = originalCaptchaEnabled;
  __setCaptchaRedisForTests(null);
  vi.restoreAllMocks();
});

describe('redis captcha backend', () => {
  it('stores the answer with the five-minute TTL and consumes it once', async () => {
    const redis = new FakeCaptchaRedis();
    __setCaptchaRedisForTests(redis);

    const created = await createCaptcha();
    const key = `${CAPTCHA_KEY_PREFIX}${created.id}`;

    expect(created.id).not.toBe('disabled');
    expect(created.svg).toBe('<svg>captcha</svg>');
    expect(redis.values.get(key)).toBe('abcd');
    expect(redis.ttls).toEqual([{ key, seconds: CAPTCHA_TTL_SECONDS }]);
    expect(CAPTCHA_TTL_SECONDS).toBe(300);

    expect(await verifyCaptcha(created.id, ' ABcd ')).toBe(true);
    expect(redis.deleted).toEqual([key]);

    // The answer is single-use: a replay finds nothing.
    expect(await verifyCaptcha(created.id, 'abcd')).toBe(false);
    expect(redis.deleted).toEqual([key, key]);
  });

  it('rejects a wrong answer and still consumes it', async () => {
    const redis = new FakeCaptchaRedis();
    __setCaptchaRedisForTests(redis);

    const { id } = await createCaptcha();
    const key = `${CAPTCHA_KEY_PREFIX}${id}`;

    expect(await verifyCaptcha(id, 'zzzz')).toBe(false);
    expect(redis.values.has(key)).toBe(false);
    expect(await verifyCaptcha(id, 'abcd')).toBe(false);
  });

  it('rejects a missing id or answer', async () => {
    const redis = new FakeCaptchaRedis();
    __setCaptchaRedisForTests(redis);

    expect(await verifyCaptcha(undefined, 'abcd')).toBe(false);
    expect(await verifyCaptcha('some-id', undefined)).toBe(false);
    expect(redis.values.size).toBe(0);
  });

  it('falls back to the in-memory store when redis throws', async () => {
    const redis = new FakeCaptchaRedis();
    redis.failure = new Error('redis down');
    __setCaptchaRedisForTests(redis);
    const warn = vi.spyOn(logger, 'warn');

    const { id } = await createCaptcha();
    expect(redis.values.size).toBe(0);

    expect(await verifyCaptcha(id, 'abcd')).toBe(true);
    expect(await verifyCaptcha(id, 'abcd')).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('skips a client that is not connected and uses memory', async () => {
    const redis = new FakeCaptchaRedis();
    redis.status = 'end';
    __setCaptchaRedisForTests(redis);

    const { id } = await createCaptcha();
    expect(redis.values.size).toBe(0);
    expect(redis.ttls).toEqual([]);
    expect(await verifyCaptcha(id, 'abcd')).toBe(true);
  });

  it('does not create or verify captchas when disabled', async () => {
    config.captchaEnabled = false;
    const redis = new FakeCaptchaRedis();
    __setCaptchaRedisForTests(redis);

    expect(await createCaptcha()).toEqual({ id: 'disabled', svg: '' });
    expect(await verifyCaptcha(undefined, undefined)).toBe(true);
    expect(redis.values.size).toBe(0);
  });

  it('quits the client on shutdown and reverts to memory', async () => {
    const redis = new FakeCaptchaRedis();
    __setCaptchaRedisForTests(redis);

    const first = await createCaptcha();
    expect(redis.values.size).toBe(1);

    await closeCaptchaRedis();
    expect(redis.quit).toHaveBeenCalledTimes(1);

    const fallback = await createCaptcha();
    expect(redis.values.size).toBe(1);
    // The first answer lived only in Redis, so it is gone with the client.
    expect(await verifyCaptcha(first.id, 'abcd')).toBe(false);
    expect(await verifyCaptcha(fallback.id, 'abcd')).toBe(true);
  });
});
