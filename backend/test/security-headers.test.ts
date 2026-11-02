import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(self), geolocation=()',
} as const;

const HSTS = 'max-age=31536000; includeSubDomains';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

function expectBaseHeaders(headers: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(headers[name], name).toBe(value);
  }
  expect(headers['x-powered-by']).toBeUndefined();
}

describe('security headers', () => {
  it('sets the base headers on a successful API response', async () => {
    process.env.NODE_ENV = 'test';
    const res = await request(createApp()).get('/api/health');

    expect(res.status).toBe(200);
    expectBaseHeaders(res.headers);
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('sets the base headers on a 404 response', async () => {
    process.env.NODE_ENV = 'test';
    const res = await request(createApp()).get('/api/definitely-not-a-route');

    expect(res.status).toBe(404);
    expectBaseHeaders(res.headers);
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('adds HSTS in production, for both success and 404 responses', async () => {
    process.env.NODE_ENV = 'production';

    const ok = await request(createApp()).get('/api/health');
    expect(ok.status).toBe(200);
    expectBaseHeaders(ok.headers);
    expect(ok.headers['strict-transport-security']).toBe(HSTS);

    const missing = await request(createApp()).get('/api/definitely-not-a-route');
    expect(missing.status).toBe(404);
    expectBaseHeaders(missing.headers);
    expect(missing.headers['strict-transport-security']).toBe(HSTS);
  });
});
