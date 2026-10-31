import { config } from '../config';

const buckets = new Map<string, number[]>();

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

export function checkRate(key: string, max: number, windowMs: number): boolean {
  if (!config.rateLimitEnabled) {
    return true;
  }
  const now = Date.now();
  const times = (buckets.get(key) ?? []).filter((time) => now - time < windowMs);
  if (times.length >= max) {
    buckets.set(key, times);
    return false;
  }
  times.push(now);
  buckets.set(key, times);
  return true;
}
