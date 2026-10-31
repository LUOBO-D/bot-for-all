import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateEnv } from '../src/config';

const validEnv = {
  DATABASE_URL: 'mysql://root:secret@127.0.0.1:3306/chat',
  JWT_SECRET: '0123456789abcdef0123456789abcdef',
  BOT_KEY_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ADMIN_PASSWORD: 'admin-password',
};

function parseExampleFile(): Record<string, string> {
  const raw = fs.readFileSync(path.resolve(process.cwd(), '../.env.example'), 'utf8');
  const entries: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    entries[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return entries;
}

describe('environment validation', () => {
  it('accepts a complete environment and applies safe defaults', () => {
    const env = validateEnv(validEnv);
    expect(env.JWT_SECRET).toBe(validEnv.JWT_SECRET);
    expect(env.ADMIN_USERNAME).toBe('admin');
    expect(env.ALLOW_PRIVATE_BOT_URLS).toBe(false);
    expect(env.TRUST_PROXY).toBe(false);
  });

  it('requires JWT_SECRET with at least 32 characters', () => {
    const missing: Record<string, string> = { ...validEnv };
    delete missing.JWT_SECRET;
    expect(() => validateEnv(missing)).toThrow(/JWT_SECRET/);
    expect(() => validateEnv({ ...validEnv, JWT_SECRET: 'a'.repeat(31) })).toThrow(
      /JWT_SECRET must be at least 32/,
    );
    expect(validateEnv({ ...validEnv, JWT_SECRET: 'a'.repeat(32) }).JWT_SECRET).toHaveLength(32);
  });

  it('requires ADMIN_PASSWORD instead of falling back to a default', () => {
    const missing: Record<string, string> = { ...validEnv };
    delete missing.ADMIN_PASSWORD;
    expect(() => validateEnv(missing)).toThrow(/ADMIN_PASSWORD/);
    expect(() => validateEnv({ ...validEnv, ADMIN_PASSWORD: '' })).toThrow(/ADMIN_PASSWORD/);
  });

  it('rejects weak BOT_KEY_SECRET values', () => {
    expect(() => validateEnv({ ...validEnv, BOT_KEY_SECRET: '0'.repeat(64) })).toThrow(
      /BOT_KEY_SECRET/,
    );
    expect(() => validateEnv({ ...validEnv, BOT_KEY_SECRET: 'a'.repeat(64) })).toThrow(
      /BOT_KEY_SECRET/,
    );
    expect(() => validateEnv({ ...validEnv, BOT_KEY_SECRET: 'z'.repeat(64) })).toThrow(
      /BOT_KEY_SECRET/,
    );
    expect(() => validateEnv({ ...validEnv, BOT_KEY_SECRET: 'a'.repeat(63) })).toThrow(
      /BOT_KEY_SECRET/,
    );
    expect(validateEnv(validEnv).BOT_KEY_SECRET).toHaveLength(64);
  });

  it('parses ALLOW_PRIVATE_BOT_URLS and TRUST_PROXY', () => {
    expect(validateEnv({ ...validEnv, ALLOW_PRIVATE_BOT_URLS: 'true' }).ALLOW_PRIVATE_BOT_URLS).toBe(
      true,
    );
    expect(validateEnv({ ...validEnv, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(validateEnv({ ...validEnv, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(validateEnv({ ...validEnv, TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
    expect(validateEnv({ ...validEnv, TRUST_PROXY: 'loopback' }).TRUST_PROXY).toBe('loopback');
  });

  it('ships an .env.example without usable secrets', () => {
    const example = parseExampleFile();
    expect(example.JWT_SECRET).toBe('');
    expect(example.BOT_KEY_SECRET).toBe('');
    expect(example.ADMIN_PASSWORD).toBe('');
    expect(() => validateEnv(example)).toThrow();
  });
});
