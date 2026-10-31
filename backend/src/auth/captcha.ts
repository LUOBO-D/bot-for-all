import { randomUUID } from 'node:crypto';
import svgCaptcha from 'svg-captcha';
import { config } from '../config';

interface CaptchaEntry {
  text: string;
  expires: number;
}

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 5000;
const store = new Map<string, CaptchaEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expires < now) {
      store.delete(id);
    }
  }
}, 60_000).unref();

export function createCaptcha(): { id: string; svg: string } {
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
  store.set(id, {
    text: captcha.text.toLowerCase(),
    expires: Date.now() + TTL_MS,
  });
  // Bounded store: Map iterates in insertion order, so the first key is the oldest.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) {
      break;
    }
    store.delete(oldest.value);
  }
  return { id, svg: captcha.data };
}

export function verifyCaptcha(id?: string, text?: string): boolean {
  if (!config.captchaEnabled) {
    return true;
  }
  if (!id || !text) {
    return false;
  }
  const entry = store.get(id);
  if (!entry) {
    return false;
  }
  store.delete(id);
  if (entry.expires < Date.now()) {
    return false;
  }
  return entry.text === text.trim().toLowerCase();
}
