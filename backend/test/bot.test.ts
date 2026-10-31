import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { createBot } from '../src/services/bot';
import { completeOnce } from '../src/bot/provider';
import type { BotRow, Message } from '../src/types';
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

const FAKE_PORT = 4010;

interface NewMessagePayload {
  roomId: number;
  message: Message;
}

interface DeltaPayload {
  roomId: number;
  seq: number;
  delta: string;
}

interface FinalPayload {
  roomId: number;
  seq: number;
  content: string;
  status: 'done' | 'error';
  error?: string;
}

interface Fixture {
  roomId: number;
  bot: BotRow;
  client: Socket;
}

let server: TestServer;
let fakeServer: http.Server;
const clients: Socket[] = [];

afterEach(() => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
});

beforeAll(async () => {
  fakeServer = http.createServer(createFakeProviderApp());
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
});

async function setupBot(
  model: string,
  triggerMode: 'mention' | 'all' = 'mention',
  baseUrl = `http://127.0.0.1:${FAKE_PORT}`,
): Promise<Fixture> {
  const owner = await createTestUser('bot_owner');
  const roomId = await createTestRoom(owner);
  const bot = await createBot({
    actor: owner,
    scope: 'room',
    roomId,
    name: 'tester',
    baseUrl,
    apiKey: 'test-key',
    model,
    triggerMode,
  });
  const client = await connectClient(server.url, tokenFor(owner));
  clients.push(client);
  await joinRoom(client, roomId);
  return { roomId, bot, client };
}

async function runBotTurn(
  fixture: Fixture,
  content: string,
): Promise<{ placeholder: Message; final: FinalPayload; deltas: string }> {
  let deltas = '';
  const placeholderPromise = waitForEvent<NewMessagePayload>(
    fixture.client,
    'message:new',
    (payload) => payload.message.senderType === 'bot',
  );
  fixture.client.on('message:delta', (payload: DeltaPayload) => {
    deltas += payload.delta;
  });

  await sendMessage(fixture.client, fixture.roomId, content);
  const placeholder = (await placeholderPromise).message;
  const final = await waitForEvent<FinalPayload>(
    fixture.client,
    'message:final',
    (payload) => payload.seq === placeholder.seq,
    8000,
  );
  return { placeholder, final, deltas };
}

describe('bot gateway', () => {
  it('streams a reply and finalizes it', async () => {
    const fixture = await setupBot('fake-ok');
    const { placeholder, final, deltas } = await runBotTurn(
      fixture,
      `@${fixture.bot.username} hi`,
    );

    expect(placeholder.status).toBe('streaming');
    expect(final.status).toBe('done');
    expect(final.content).toBe('你好，世界');
    expect(deltas).toBe('你好，世界');

    fixture.client.close();
  });

  it('ignores reasoning deltas', async () => {
    const fixture = await setupBot('fake-reasoning');
    const { final } = await runBotTurn(fixture, `@${fixture.bot.username} hi`);

    expect(final.status).toBe('done');
    expect(final.content).toBe('真实回答');
    expect(final.content).not.toContain('Thinking');

    fixture.client.close();
  });

  it('times out a slow provider', async () => {
    const fixture = await setupBot('fake-slow');
    const { final } = await runBotTurn(fixture, `@${fixture.bot.username} hi`);

    expect(final.status).toBe('error');
    expect(final.error).toBe('TIMEOUT');

    fixture.client.close();
  });

  it('falls back to non-stream when the provider rejects stream', async () => {
    const fixture = await setupBot('fake-nostream');
    const { final } = await runBotTurn(fixture, `@${fixture.bot.username} hi`);

    expect(final.status).toBe('done');
    expect(final.content).toBe('非流式回复');
    expect(getFakeStats().calls).toBe(2);

    fixture.client.close();
  });

  it('reports provider auth failures', async () => {
    const fixture = await setupBot('fake-401');
    const { final } = await runBotTurn(fixture, `@${fixture.bot.username} hi`);

    expect(final.status).toBe('error');
    expect(final.error).toBe('AUTH');

    fixture.client.close();
  });

  it('reports provider connection failures', async () => {
    const fixture = await setupBot('fake-ok', 'mention', 'http://127.0.0.1:1');
    const { final } = await runBotTurn(fixture, `@${fixture.bot.username} hi`);

    expect(final.status).toBe('error');
    expect(final.error).toBe('PROVIDER');

    fixture.client.close();
  });

  it('supports a one-shot provider test', async () => {
    const fixture = await setupBot('fake-ok');
    const reply = await completeOnce({
      baseUrl: fixture.bot.baseUrl,
      apiKey: 'test-key',
      model: 'fake-ok',
      messages: [{ role: 'user', content: 'ping' }],
      temperature: 0,
      maxTokens: 16,
    });
    expect(reply).toBe('整段回复');

    fixture.client.close();
  });

  it('does not trigger mention bots without an @mention', async () => {
    const fixture = await setupBot('fake-ok', 'mention');
    let botMessages = 0;
    fixture.client.on('message:new', (payload: NewMessagePayload) => {
      if (payload.message.senderType === 'bot') {
        botMessages += 1;
      }
    });

    await sendMessage(fixture.client, fixture.roomId, 'no mention here');
    await delay(400);
    expect(botMessages).toBe(0);

    const { final } = await runBotTurn(fixture, `@${fixture.bot.username} hi`);
    expect(final.status).toBe('done');

    fixture.client.close();
  });

  it('debounces all-message bots into one call', async () => {
    const fixture = await setupBot('fake-ok', 'all');
    await sendMessage(fixture.client, fixture.roomId, 'first');
    await delay(100);
    await sendMessage(fixture.client, fixture.roomId, 'second');
    await delay(900);

    expect(getFakeStats().calls).toBe(1);

    fixture.client.close();
  });
});
