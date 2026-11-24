import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

// Mirrors SECURITY_HEADERS in backend/src/app.ts (enforced below) and
// frontend/nginx.conf (synced by the nginx test at the bottom).
const CSP =
  "default-src 'self'; script-src 'self' 'sha256-heFDH7JFx3Q+Tw3QesfP7cXT8wr8z/tkNpVLBm3NYUM='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(self), geolocation=()',
  'content-security-policy': CSP,
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

describe('Content-Security-Policy cross-checks', () => {
  it('hashes the exact theme-boot inline script from frontend/index.html', () => {
    const html = readFileSync(
      fileURLToPath(new URL('../../frontend/index.html', import.meta.url)),
      'utf8',
    );
    const inline = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(inline, 'frontend/index.html must keep the theme-boot inline script').toBeTruthy();
    const hash = createHash('sha256').update(inline?.[1] ?? '', 'utf8').digest('base64');
    // The script tag survives the Vite build byte-for-byte, so the source
    // hash is the built-page hash. Editing the boot script without updating
    // the CSP constants fails here instead of silently breaking dark mode.
    expect(CSP).toContain(`script-src 'self' 'sha256-${hash}'`);
  });

  it('is mirrored verbatim by frontend/nginx.conf', () => {
    const nginx = readFileSync(
      fileURLToPath(new URL('../../frontend/nginx.conf', import.meta.url)),
      'utf8',
    );
    expect(nginx).toContain(`add_header Content-Security-Policy "${CSP}" always;`);
  });
});
