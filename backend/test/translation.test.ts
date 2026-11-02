import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { pool } from '../src/db';
import { createMessage } from '../src/services/message';
import { clearTranslationCache } from '../src/services/translation';
import type { AuthUser } from '../src/types';
import { createFakeProviderApp, getFakeStats, resetFakeStats } from './fixtures/fake-openai';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

let fakeServer: http.Server;
let fakeBaseUrl: string;

const originals = {
  baseUrl: config.translateBaseUrl,
  apiKey: config.translateApiKey,
  model: config.translateModel,
  timeoutMs: config.translateTimeoutMs,
  cacheTtlMs: config.translateCacheTtlMs,
  cacheMax: config.translateCacheMax,
  rateLimitEnabled: config.rateLimitEnabled,
};

beforeAll(async () => {
  fakeServer = http.createServer(createFakeProviderApp());
  const { promise, resolve } = Promise.withResolvers<void>();
  fakeServer.listen(0, '127.0.0.1', () => resolve());
  await promise;
  const { port } = fakeServer.address() as AddressInfo;
  fakeBaseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  fakeServer.closeAllConnections();
  const { promise, resolve } = Promise.withResolvers<void>();
  fakeServer.close(() => resolve());
  await promise;
});

beforeEach(() => {
  resetFakeStats();
  clearTranslationCache();
  config.translateBaseUrl = fakeBaseUrl;
  config.translateApiKey = 'test-translate-key';
  config.translateModel = 'fake-translate';
  config.translateTimeoutMs = 1000;
  config.translateCacheTtlMs = originals.cacheTtlMs;
  config.translateCacheMax = originals.cacheMax;
  config.rateLimitEnabled = false;
});

afterEach(() => {
  config.translateBaseUrl = originals.baseUrl;
  config.translateApiKey = originals.apiKey;
  config.translateModel = originals.model;
  config.translateTimeoutMs = originals.timeoutMs;
  config.translateCacheTtlMs = originals.cacheTtlMs;
  config.translateCacheMax = originals.cacheMax;
  config.rateLimitEnabled = originals.rateLimitEnabled;
});

interface MessageFixture {
  owner: AuthUser;
  roomId: number;
  seq: number;
  token: string;
}

async function setupMessage(content = '你好，世界'): Promise<MessageFixture> {
  const owner = await createTestUser(`tr_${randomBytes(4).toString('hex')}`);
  const roomId = await createTestRoom(owner);
  const message = await createMessage({
    roomId,
    senderId: owner.id,
    senderType: 'user',
    content,
  });
  return { owner, roomId, seq: message.seq, token: tokenFor(owner) };
}

async function translate(
  fixture: Pick<MessageFixture, 'roomId' | 'seq' | 'token'>,
  body?: unknown,
): Promise<request.Response> {
  const call = request(app)
    .post(`/api/rooms/${fixture.roomId}/messages/${fixture.seq}/translate`)
    .set('Authorization', `Bearer ${fixture.token}`);
  return body === undefined ? call : call.send(body as object);
}

describe('message translation', () => {
  it('translates a message through the OpenAI-compatible provider', async () => {
    const fixture = await setupMessage();

    const response = await translate(fixture, { targetLang: 'en' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ text: '翻译结果', targetLang: 'en' });

    const sent = getFakeStats().lastBody as {
      model: string;
      messages: { role: string; content: string }[];
    };
    expect(sent.model).toBe('fake-translate');
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages[0].content).toContain('only the translation');
    expect(sent.messages[1].role).toBe('user');
    expect(sent.messages[1].content).toContain('Target language: en');
    expect(sent.messages[1].content).toContain('你好，世界');
    expect(getFakeStats().lastAuth).toBe('Bearer test-translate-key');
  });

  it('defaults targetLang to zh-CN when the body omits it', async () => {
    const fixture = await setupMessage();

    const response = await translate(fixture);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ text: '翻译结果', targetLang: 'zh-CN' });
  });

  it('returns 503 while the provider is not fully configured', async () => {
    const fixture = await setupMessage();
    config.translateApiKey = undefined;

    const response = await translate(fixture, { targetLang: 'en' });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('TRANSLATION_DISABLED');
    expect(getFakeStats().calls).toBe(0);
  });

  it('rejects non-members before reading the message', async () => {
    const fixture = await setupMessage();
    const outsider = await createTestUser(`tr_out_${randomBytes(4).toString('hex')}`);

    const response = await request(app)
      .post(`/api/rooms/${fixture.roomId}/messages/${fixture.seq}/translate`)
      .set('Authorization', `Bearer ${tokenFor(outsider)}`)
      .send({ targetLang: 'en' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
    expect(getFakeStats().calls).toBe(0);
  });

  it('returns 404 for an unknown message seq', async () => {
    const fixture = await setupMessage();

    const response = await request(app)
      .post(`/api/rooms/${fixture.roomId}/messages/999999/translate`)
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ targetLang: 'en' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('returns 409 for a withdrawn message', async () => {
    const fixture = await setupMessage();
    await pool.execute(
      'UPDATE messages SET deleted_at = CURRENT_TIMESTAMP(3) WHERE room_id = ? AND seq = ?',
      [fixture.roomId, fixture.seq],
    );

    const response = await translate(fixture, { targetLang: 'en' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('MESSAGE_DELETED');
  });

  it('returns 400 for a message with no text', async () => {
    const fixture = await setupMessage();
    await pool.execute('UPDATE messages SET content = ? WHERE room_id = ? AND seq = ?', [
      '',
      fixture.roomId,
      fixture.seq,
    ]);

    const response = await translate(fixture, { targetLang: 'en' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MESSAGE_EMPTY');
  });

  it('returns 400 for content over the 4000-character limit', async () => {
    const fixture = await setupMessage();
    await pool.execute('UPDATE messages SET content = ? WHERE room_id = ? AND seq = ?', [
      'x'.repeat(4001),
      fixture.roomId,
      fixture.seq,
    ]);

    const response = await translate(fixture, { targetLang: 'en' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MESSAGE_TOO_LONG');
  });

  it('rejects targetLang over 20 characters', async () => {
    const fixture = await setupMessage();

    const response = await translate(fixture, { targetLang: 'x'.repeat(21) });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_INPUT');
    expect(getFakeStats().calls).toBe(0);
  });

  it('maps a provider timeout to 502 TRANSLATION_FAILED', async () => {
    const fixture = await setupMessage();
    config.translateModel = 'fake-translate-slow';
    config.translateTimeoutMs = 100;

    const response = await translate(fixture, { targetLang: 'en' });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('TRANSLATION_FAILED');
  });

  it('maps a non-2xx provider response to 502 TRANSLATION_FAILED', async () => {
    const fixture = await setupMessage();
    config.translateModel = 'fake-error';

    const response = await translate(fixture, { targetLang: 'en' });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('TRANSLATION_FAILED');
  });

  it('maps a response without choices to 502 TRANSLATION_FAILED', async () => {
    const fixture = await setupMessage();
    config.translateModel = 'fake-translate-no-choices';

    const response = await translate(fixture, { targetLang: 'en' });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('TRANSLATION_FAILED');
  });

  it('maps invalid JSON to 502 TRANSLATION_FAILED', async () => {
    const fixture = await setupMessage();
    config.translateModel = 'fake-translate-bad-json';

    const response = await translate(fixture, { targetLang: 'en' });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('TRANSLATION_FAILED');
  });

  it('maps an oversized provider response to 502 TRANSLATION_FAILED', async () => {
    const fixture = await setupMessage();
    config.translateModel = 'fake-big-json';

    const response = await translate(fixture, { targetLang: 'en' });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('TRANSLATION_FAILED');
  });

  it('limits each user to 20 translations per minute', async () => {
    const fixture = await setupMessage();
    config.rateLimitEnabled = true;

    for (let index = 0; index < 20; index += 1) {
      const response = await translate(fixture, { targetLang: 'en' });
      expect(response.status).toBe(200);
    }

    const limited = await translate(fixture, { targetLang: 'en' });

    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('translation cache', () => {
  it('serves a repeated translation from the cache without calling the provider', async () => {
    const fixture = await setupMessage();

    const first = await translate(fixture, { targetLang: 'en' });
    const second = await translate(fixture, { targetLang: 'en' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(getFakeStats().calls).toBe(1);
  });

  it('calls the provider again for a different target language', async () => {
    const fixture = await setupMessage();

    expect((await translate(fixture, { targetLang: 'en' })).status).toBe(200);
    expect((await translate(fixture, { targetLang: 'ja' })).status).toBe(200);

    expect(getFakeStats().calls).toBe(2);
  });

  it('calls the provider again after the message is edited', async () => {
    const fixture = await setupMessage();

    expect((await translate(fixture, { targetLang: 'en' })).status).toBe(200);
    await pool.execute(
      'UPDATE messages SET content = ?, edited_at = CURRENT_TIMESTAMP(3) WHERE room_id = ? AND seq = ?',
      ['改过的内容', fixture.roomId, fixture.seq],
    );
    expect((await translate(fixture, { targetLang: 'en' })).status).toBe(200);

    expect(getFakeStats().calls).toBe(2);
  });

  it('does not cache while TRANSLATE_CACHE_TTL_MS is 0', async () => {
    const fixture = await setupMessage();
    config.translateCacheTtlMs = 0;

    expect((await translate(fixture, { targetLang: 'en' })).status).toBe(200);
    expect((await translate(fixture, { targetLang: 'en' })).status).toBe(200);

    expect(getFakeStats().calls).toBe(2);
  });

  it('evicts the least recently used translation past TRANSLATE_CACHE_MAX', async () => {
    config.translateCacheMax = 2;
    const fixtures: MessageFixture[] = [];
    for (const content of ['一', '二', '三']) {
      fixtures.push(await setupMessage(content));
    }

    for (const fixture of fixtures) {
      expect((await translate(fixture, { targetLang: 'en' })).status).toBe(200);
    }
    expect(getFakeStats().calls).toBe(3);

    // The third insert evicted the first message; the other two still hit.
    expect((await translate(fixtures[1], { targetLang: 'en' })).status).toBe(200);
    expect((await translate(fixtures[2], { targetLang: 'en' })).status).toBe(200);
    expect(getFakeStats().calls).toBe(3);

    // Touching them refreshed their recency, so reloading the first message
    // evicts the second, never the third.
    expect((await translate(fixtures[0], { targetLang: 'en' })).status).toBe(200);
    expect(getFakeStats().calls).toBe(4);
    expect((await translate(fixtures[2], { targetLang: 'en' })).status).toBe(200);
    expect(getFakeStats().calls).toBe(4);
  });

  it('does not cache failed translations', async () => {
    const fixture = await setupMessage();
    config.translateModel = 'fake-error';

    const failed = await translate(fixture, { targetLang: 'en' });
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('TRANSLATION_FAILED');
    expect(getFakeStats().calls).toBe(1);

    config.translateModel = 'fake-translate';
    const retried = await translate(fixture, { targetLang: 'en' });

    expect(retried.status).toBe(200);
    expect(retried.body).toEqual({ text: '翻译结果', targetLang: 'en' });
    expect(getFakeStats().calls).toBe(2);
  });
});
