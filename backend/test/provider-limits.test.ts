import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { config } from '../src/config';
import {
  SseParser,
  type SseParserOptions,
} from '../src/bot/sse';
import { completeOnce, streamChat, type StreamOptions } from '../src/bot/provider';
import { createBot } from '../src/services/bot';
import type { BotRow, MessageDTO } from '../src/types';
import {
  createFakeProviderApp,
  getFakeStats,
  resetFakeStats,
} from './fixtures/fake-openai';
import {
  connectClient,
  createTestRoom,
  createTestUser,
  delay,
  joinRoom,
  sendMessage,
  startTestServer,
  tokenFor,
  waitForEvent,
  type TestServer,
} from './helpers';

const FAKE_PORT = 4011;
const RESPONSE_LIMIT = 64 * 1024;
const EVENT_LIMIT = 16 * 1024;

interface FinalPayload {
  roomId: number;
  seq: number;
  content: string;
  status: 'done' | 'error';
  error?: string;
}

interface NewMessagePayload {
  roomId: number;
  message: MessageDTO;
}

interface GatewayFixture {
  roomId: number;
  bot: BotRow;
  client: Socket;
}

let fakeServer: http.Server;
let server: TestServer;
const clients: Socket[] = [];
const originals = {
  response: config.botMaxResponseBytes,
  event: config.botMaxSseEventBytes,
};

beforeAll(async () => {
  fakeServer = http.createServer(createFakeProviderApp() as http.RequestListener);
  const { promise, resolve } = Promise.withResolvers<void>();
  fakeServer.listen(FAKE_PORT, resolve);
  await promise;
  server = await startTestServer();
});

afterAll(async () => {
  fakeServer.closeAllConnections();
  const { promise, resolve } = Promise.withResolvers<void>();
  fakeServer.close(() => resolve());
  await promise;
  await server.close();
});

beforeEach(() => {
  resetFakeStats();
  config.botMaxResponseBytes = RESPONSE_LIMIT;
  config.botMaxSseEventBytes = EVENT_LIMIT;
});

afterEach(() => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
  config.botMaxResponseBytes = originals.response;
  config.botMaxSseEventBytes = originals.event;
});

function chatOptions(model: string): StreamOptions {
  return {
    baseUrl: `http://127.0.0.1:${FAKE_PORT}`,
    apiKey: 'test-key',
    model,
    messages: [{ role: 'user', content: 'ping' }],
    temperature: 0,
    maxTokens: 16,
  };
}

async function drain(generator: AsyncGenerator<string>): Promise<string> {
  let text = '';
  for await (const delta of generator) {
    text += delta;
  }
  return text;
}

function expectTooLarge(promise: Promise<unknown>): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    status: 502,
    code: 'BOT_RESPONSE_TOO_LARGE',
  });
}

async function setupGatewayBot(model: string): Promise<GatewayFixture> {
  const owner = await createTestUser('provider_limit_owner');
  const roomId = await createTestRoom(owner);
  const bot = await createBot({
    actor: owner,
    scope: 'room',
    roomId,
    name: 'size-limited',
    baseUrl: `http://127.0.0.1:${FAKE_PORT}`,
    apiKey: 'test-key',
    model,
    triggerMode: 'mention',
  });
  const client = await connectClient(server.url, tokenFor(owner));
  clients.push(client);
  await joinRoom(client, roomId);
  return { roomId, bot, client };
}

describe('provider response byte caps', () => {
  it('rejects an oversized non-stream JSON body', async () => {
    await expectTooLarge(completeOnce(chatOptions('fake-big-json')));
  });

  it('rejects an oversized non-stream text body', async () => {
    await expectTooLarge(completeOnce(chatOptions('fake-big-text')));
  });

  it('rejects an oversized error body', async () => {
    await expectTooLarge(completeOnce(chatOptions('fake-big-error')));
    await expectTooLarge(drain(streamChat(chatOptions('fake-big-error'))));
  });

  it('rejects one SSE event above the event cap', async () => {
    await expectTooLarge(drain(streamChat(chatOptions('fake-big-sse-event'))));
  });

  it('rejects an SSE stream whose total crosses the response cap and cancels the reader', async () => {
    await expectTooLarge(drain(streamChat(chatOptions('fake-big-sse-total'))));

    // The server observes a torn-down connection rather than writing the rest
    // of the stream; the reader cap is not merely a parse-time drop.
    let aborted = 0;
    for (let attempt = 0; attempt < 20 && aborted === 0; attempt += 1) {
      await delay(25);
      aborted = getFakeStats().aborted;
    }
    expect(aborted).toBeGreaterThanOrEqual(1);
  });

  it('finalizes a gateway message as an error without storing oversized content', async () => {
    const fixture = await setupGatewayBot('fake-big-sse-total');
    let deltas = '';
    fixture.client.on('message:delta', (payload: { delta: string }) => {
      deltas += payload.delta;
    });

    const placeholderPromise = waitForEvent<NewMessagePayload>(
      fixture.client,
      'message:new',
      (payload) => payload.message.senderType === 'bot',
    );
    await sendMessage(fixture.client, fixture.roomId, `@${fixture.bot.username} hi`);
    const placeholder = (await placeholderPromise).message;
    const final = await waitForEvent<FinalPayload>(
      fixture.client,
      'message:final',
      (payload) => payload.seq === placeholder.seq,
      8000,
    );

    expect(final.status).toBe('error');
    expect(final.error).toBe('PROVIDER');
    expect(Buffer.byteLength(final.content, 'utf8')).toBeLessThanOrEqual(RESPONSE_LIMIT);
    expect(Buffer.byteLength(deltas, 'utf8')).toBeLessThanOrEqual(RESPONSE_LIMIT);
  });
});

describe('SseParser caps', () => {
  it('throws as soon as an unterminated event buffer crosses its cap', () => {
    const parser = new SseParser({ maxBufferBytes: 1024, maxEventBytes: 1024 });
    expect(() => parser.feed(`data: ${'x'.repeat(1024)}`)).toThrow(/SSE buffer/);
  });

  it('throws for one complete event above the event cap', () => {
    const parser = new SseParser({ maxBufferBytes: 1024, maxEventBytes: 1024 });
    expect(() => parser.feed(`data: ${'x'.repeat(2048)}\n\n`)).toThrow(/SSE event/);
  });

  it('still parses many small events delivered in one chunk', () => {
    const options: SseParserOptions = { maxBufferBytes: 1024, maxEventBytes: 1024 };
    const parser = new SseParser(options);
    const events = parser.feed('data: {"a":1}\n\n'.repeat(100));
    expect(events).toHaveLength(100);
  });
});
