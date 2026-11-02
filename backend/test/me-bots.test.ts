import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { createBot } from '../src/services/bot';
import { createFakeProviderApp, getFakeStats, resetFakeStats } from './fixtures/fake-openai';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

let fakeServer: http.Server;
let baseUrl = '';
let originalRateLimitEnabled: boolean;

beforeAll(async () => {
  fakeServer = http.createServer(
    createFakeProviderApp() as unknown as http.RequestListener,
  );
  const { promise, resolve } = Promise.withResolvers<void>();
  fakeServer.listen(0, '127.0.0.1', resolve);
  await promise;
  baseUrl = `http://127.0.0.1:${(fakeServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  fakeServer.closeAllConnections();
  const { promise, resolve } = Promise.withResolvers<void>();
  fakeServer.close(() => resolve());
  await promise;
});

beforeEach(() => {
  originalRateLimitEnabled = config.rateLimitEnabled;
  resetFakeStats();
});

afterEach(() => {
  config.rateLimitEnabled = originalRateLimitEnabled;
});

async function setupBot(adminName: string) {
  const admin = await createTestUser(adminName, 'admin');
  const bot = await createBot({
    actor: admin,
    scope: 'global',
    name: 'probe bot',
    baseUrl,
    apiKey: 'test-key',
    model: 'fake-ok',
  });
  return { admin, bot };
}

function testBot(adminToken: string, botId: number) {
  return request(app)
    .post(`/api/me/bots/${botId}/test`)
    .set('Authorization', `Bearer ${adminToken}`);
}

describe('POST /api/me/bots/:id/test', () => {
  it('caps provider probes at 10 per user per minute', async () => {
    config.rateLimitEnabled = true;
    const { admin, bot } = await setupBot('test_rate_admin');
    const token = tokenFor(admin);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await testBot(token, bot.userId);
      expect(response.status, `attempt ${attempt + 1}`).toBe(200);
      expect(response.body).toMatchObject({ ok: true });
    }
    expect(getFakeStats().calls).toBe(10);

    const limited = await testBot(token, bot.userId);

    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    // The rejected probe never reached the provider.
    expect(getFakeStats().calls).toBe(10);

    // The limit is per user: another admin keeps its own budget.
    const other = await createTestUser('test_rate_other_admin', 'admin');
    const allowed = await testBot(tokenFor(other), bot.userId);
    expect(allowed.status).toBe(200);
    expect(getFakeStats().calls).toBe(11);
  });

  it('does not consume the budget for a malformed bot id', async () => {
    config.rateLimitEnabled = true;
    const { admin } = await setupBot('test_rate_bad_id');

    const response = await request(app)
      .post('/api/me/bots/nope/test')
      .set('Authorization', `Bearer ${tokenFor(admin)}`);

    expect(response.status).toBe(400);
    expect(getFakeStats().calls).toBe(0);
  });
});
