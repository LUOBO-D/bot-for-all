import { randomUUID } from 'node:crypto';
import svgCaptcha from 'svg-captcha';
import { config } from '../config';
import { logger } from '../logger';
import { closeRedisClient, connectRedis, usableRedis, type ClosableRedis } from '../redis';

interface CaptchaEntry {
  text: string;
  expires: number;
}

export const CAPTCHA_KEY_PREFIX = 'bfa:captcha:';
export const CAPTCHA_TTL_SECONDS = 5 * 60;

const TTL_MS = CAPTCHA_TTL_SECONDS * 1000;
const MAX_ENTRIES = 5000;

/** The Redis commands captcha needs; narrowed so tests can inject a fake. */
export interface CaptchaRedis extends ClosableRedis {
  status?: string;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

const store = new Map<string, CaptchaEntry>();

let redis: CaptchaRedis | null = null;

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expires < now) {
      store.delete(id);
    }
  }
}, 60_000).unref();

/**
 * Test-only: swaps the Redis client (or removes it with `null`). Production
 * code reaches Redis through {@link initCaptchaRedis} only.
 */
export function __setCaptchaRedisForTests(client: CaptchaRedis | null): void {
  redis = client;
}

/** Connects the optional captcha client; a failure keeps the in-process store. */
export async function initCaptchaRedis(url: string): Promise<void> {
  if (redis) {
    return;
  }
  redis = await connectRedis(url, 'captcha');
}

/** Closes the captcha client on shutdown; never throws. */
export async function closeCaptchaRedis(): Promise<void> {
  const client = redis;
  redis = null;
  await closeRedisClient(client, 'captcha');
}

function memoryStore(id: string, text: string): void {
  store.set(id, { text, expires: Date.now() + TTL_MS });
  // Bounded store: Map iterates in insertion order, so the first key is the oldest.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) {
      break;
    }
    store.delete(oldest.value);
  }
}

function memoryVerify(id: string, text: string): boolean {
  const entry = store.get(id);
  if (!entry) {
    return false;
  }
  store.delete(id);
  if (entry.expires < Date.now()) {
    return false;
  }
  return entry.text === text;
}

/**
 * Creates a captcha image and remembers its answer for five minutes. Uses
 * Redis when configured (shared across instances) and the bounded in-process
 * map otherwise, including whenever Redis is unreachable.
 */
export async function createCaptcha(): Promise<{ id: string; svg: string }> {
  if (!config.captchaEnabled) {
    return { id: 'disabled', svg: '' };
  }
  const captcha = svgCaptcha.create({
    size: 4,
    noise: 2,
    color: true,
    background: '#f4f4f4',
  });
  const id = randomUUID();
  const text = captcha.text.toLowerCase();
  const client = usableRedis(redis, 'captcha');
  if (client) {
    try {
      await client.setex(`${CAPTCHA_KEY_PREFIX}${id}`, CAPTCHA_TTL_SECONDS, text);
      return { id, svg: captcha.data };
    } catch (error) {
      logger.warn({ err: error }, 'redis captcha store failed, using in-memory captcha');
    }
  }
  memoryStore(id, text);
  return { id, svg: captcha.data };
}

/**
 * Checks an answer and consumes it, so a captcha cannot be replayed. Returns
 * true when captcha verification is disabled.
 */
export async function verifyCaptcha(id?: string, text?: string): Promise<boolean> {
  if (!config.captchaEnabled) {
    return true;
  }
  if (!id || !text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  const client = usableRedis(redis, 'captcha');
  if (client) {
    const key = `${CAPTCHA_KEY_PREFIX}${id}`;
    try {
      const stored = await client.get(key);
      // Consume even a mismatched answer: one attempt per captcha.
      await client.del(key);
      return stored !== null && stored === normalized;
    } catch (error) {
      logger.warn({ err: error }, 'redis captcha verify failed, using in-memory captcha');
    }
  }
  return memoryVerify(id, normalized);
}
