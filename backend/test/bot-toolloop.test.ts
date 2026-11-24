import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { config } from '../src/config';
import { createBot } from '../src/services/bot';
import { getMessageById } from '../src/services/message';
import type { BotRow, MessageDTO } from '../src/types';
import {
  connectClient,
  createTestRoom,
  createTestUser,
  joinRoom,
  sendMessage,
  startTestServer,
  tokenFor,
  waitForEvent,
  type TestServer,
} from './helpers';

/**
 * Gateway tool-loop tests. A scripted OpenAI-compatible provider streams a
 * web_fetch tool call on tool rounds and plain content otherwise; a local
 * fixture server stands in for the fetched page. Everything runs through the
 * real socket gateway and DB, so the loop's convergence, budget and
 * rate-limit contracts are observed end to end.
 */

interface ProviderBehavior {
  /** Content streamed while the request still carries `tools`. */
  toolRoundContent: string;
  /** Content streamed once `tools` is absent (converged round). */
  finalContent: string;
  /** URL the scripted web_fetch call asks for. */
  fetchUrl: string;
  /** Emit the call on every tool round instead of only the first. */
  alwaysCallTools: boolean;
}

interface ProviderHandle {
  url: string;
  bodies: unknown[];
  close: () => Promise<void>;
}

interface TargetServer {
  pageUrl: string;
  stallUrl: string;
  hits: { page: number; stall: number };
  close: () => Promise<void>;
}

interface Fixture {
  roomId: number;
  bot: BotRow;
  client: Socket;
  provider: ProviderHandle;
}

interface NewMessagePayload {
  roomId: number;
  message: MessageDTO;
}

interface FinalPayload {
  roomId: number;
  seq: number;
  content: string;
  status: 'done' | 'error';
  error?: string;
}

function readMessages(body: unknown): Array<{ role: unknown; content: unknown }> {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('messages' in body) ||
    !Array.isArray(body.messages)
  ) {
    return [];
  }
  return body.messages.map((message: unknown) => {
    if (typeof message !== 'object' || message === null) {
      return { role: undefined, content: undefined };
    }
    return {
      role: 'role' in message ? message.role : undefined,
      content: 'content' in message ? message.content : undefined,
    };
  });
}

function hasKey(body: unknown, key: string): boolean {
  return typeof body === 'object' && body !== null && key in body;
}

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function shutdown(server: http.Server): Promise<void> {
  server.closeAllConnections();
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  await promise;
}

async function startProviderServer(behavior: ProviderBehavior): Promise<ProviderHandle> {
  const bodies: unknown[] = [];
  const server = http.createServer((req, response) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = {};
        }
      }
      bodies.push(body);
      const messages = readMessages(body);
      const sawToolRole = messages.some((message) => message.role === 'tool');
      const callTools = hasKey(body, 'tools') && (behavior.alwaysCallTools || !sawToolRole);
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      if (callTools) {
        response.write(sse({ choices: [{ delta: { content: behavior.toolRoundContent } }] }));
        response.write(
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'web_fetch',
                        arguments: JSON.stringify({ url: behavior.fetchUrl }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      } else {
        response.write(sse({ choices: [{ delta: { content: behavior.finalContent } }] }));
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  const { promise: listening, resolve: onListening } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', onListening);
  await listening;
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => shutdown(server),
  };
}

/** Stands in for the fetched web page: /page serves text, /stall never answers. */
async function startTargetServer(): Promise<TargetServer> {
  const hits = { page: 0, stall: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === '/page') {
      hits.page += 1;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>页面标题</title></head><body><p>页面正文内容</p></body></html>');
      return;
    }
    hits.stall += 1;
    // Never answers: the request hangs until the caller's budget aborts it.
    req.resume();
  });
  const { promise: listening, resolve: onListening } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', onListening);
  await listening;
  const port = (server.address() as AddressInfo).port;
  return {
    pageUrl: `http://127.0.0.1:${port}/page`,
    stallUrl: `http://127.0.0.1:${port}/stall`,
    hits,
    close: () => shutdown(server),
  };
}

const closers: Array<() => Promise<void>> = [];
const restoreOverrides: Array<() => void> = [];
const clients: Socket[] = [];

/** Test-only config mutation, undone per-test in `afterEach`. */
function overrideConfig(values: Partial<typeof config>): void {
  const saved = Object.keys(values).map((key) => ({
    key,
    value: (config as unknown as Record<string, unknown>)[key],
  }));
  for (const [key, value] of Object.entries(values)) {
    (config as unknown as Record<string, unknown>)[key] = value;
  }
  restoreOverrides.push(() => {
    for (const entry of [...saved].reverse()) {
      (config as unknown as Record<string, unknown>)[entry.key] = entry.value;
    }
  });
}

let server: TestServer;
let target: TargetServer;

beforeAll(async () => {
  server = await startTestServer();
  target = await startTargetServer();
});

afterEach(() => {
  for (const restore of restoreOverrides.splice(0)) {
    restore();
  }
  for (const client of clients.splice(0)) {
    client.close();
  }
});

afterAll(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
  await target.close();
  await server.close();
});

async function setupBot(behavior: ProviderBehavior): Promise<Fixture> {
  const provider = await startProviderServer(behavior);
  closers.push(provider.close);
  const owner = await createTestUser('bot_tools_owner');
  const roomId = await createTestRoom(owner);
  const bot = await createBot({
    actor: owner,
    scope: 'room',
    roomId,
    name: 'toolbot',
    baseUrl: provider.url,
    apiKey: 'test-key',
    model: 'fake-tools',
    triggerMode: 'mention',
  });
  const client = await connectClient(server.url, tokenFor(owner));
  clients.push(client);
  await joinRoom(client, roomId);
  return { roomId, bot, client, provider };
}

/** Sends the triggering message; resolves when the bot placeholder exists. */
async function startGeneration(fixture: Fixture): Promise<NewMessagePayload> {
  const placeholderPromise = waitForEvent<NewMessagePayload>(
    fixture.client,
    'message:new',
    (payload) => payload.message.senderType === 'bot',
  );
  await sendMessage(fixture.client, fixture.roomId, `@${fixture.bot.username} 查一下`);
  return placeholderPromise;
}

function awaitFinal(fixture: Fixture, seq: number): Promise<FinalPayload> {
  return waitForEvent<FinalPayload>(
    fixture.client,
    'message:final',
    (payload) => payload.seq === seq,
    15000,
  );
}

describe('gateway tool loop', () => {
  it('runs one web_fetch round, then converges with a deterministic source list', async () => {
    overrideConfig({ webSearchEnabled: true });
    const pageHitsBefore = target.hits.page;
    const fixture = await setupBot({
      toolRoundContent: '正在查资料',
      finalContent: '这是最终答案',
      fetchUrl: target.pageUrl,
      alwaysCallTools: false,
    });
    const placeholder = (await startGeneration(fixture)).message;

    const final = await awaitFinal(fixture, placeholder.seq);
    const content = final.content;
    expect(final.status).toBe('done');
    expect(content).toContain('正在查资料');
    expect(content).toContain(`（读取网页：${target.pageUrl}）`);
    expect(content).toContain('这是最终答案');
    expect(content).toContain('来源：');
    expect(content).toContain(`[页面标题](${target.pageUrl})`);
    // Exactly one deterministic source footer.
    expect(content.indexOf('来源：', content.indexOf('来源：') + 1)).toBe(-1);

    const stored = await getMessageById(placeholder.id);
    expect(stored.status).toBe('done');
    expect(stored.content).toBe(content);

    expect(fixture.provider.bodies).toHaveLength(2);
    expect(hasKey(fixture.provider.bodies[0], 'tools')).toBe(true);
    const second = readMessages(fixture.provider.bodies[1]);
    expect(
      second.some(
        (message) =>
          message.role === 'assistant' &&
          typeof message.content === 'string' &&
          message.content.includes('正在查资料'),
      ),
    ).toBe(true);
    const toolMessage = second.find((message) => message.role === 'tool');
    expect(
      typeof toolMessage?.content === 'string' && toolMessage.content.includes('页面正文内容'),
    ).toBe(true);
    expect(target.hits.page).toBe(pageHitsBefore + 1);
  });

  it('withholds tools after two tool rounds and converges without more calls', async () => {
    overrideConfig({ webSearchEnabled: true });
    const pageHitsBefore = target.hits.page;
    const fixture = await setupBot({
      toolRoundContent: '再查一次',
      finalContent: '收敛回答',
      fetchUrl: target.pageUrl,
      alwaysCallTools: true,
    });
    const placeholder = (await startGeneration(fixture)).message;

    const final = await awaitFinal(fixture, placeholder.seq);
    const content = final.content;
    expect(final.status).toBe('done');
    expect(content).toContain('收敛回答');
    // Two rounds hit the SAME page, so the deduped footer lists it once.
    expect(content.indexOf('来源：', content.indexOf('来源：') + 1)).toBe(-1);
    expect(target.hits.page).toBe(pageHitsBefore + 2);

    expect(fixture.provider.bodies).toHaveLength(3);
    expect(hasKey(fixture.provider.bodies[2], 'tools')).toBe(false);
    const toolRoles = readMessages(fixture.provider.bodies[2]).filter(
      (message) => message.role === 'tool',
    );
    expect(toolRoles).toHaveLength(2);
  });

  it('settles the turn as TIMEOUT when a hanging tool exhausts the whole-turn budget', async () => {
    overrideConfig({
      webSearchEnabled: true,
      botToolTotalTimeoutMs: 3000,
      webToolsTimeoutMs: 9000,
    });
    const stallHitsBefore = target.hits.stall;
    const fixture = await setupBot({
      toolRoundContent: '开始抓取',
      finalContent: '不应出现',
      fetchUrl: target.stallUrl,
      alwaysCallTools: false,
    });
    const placeholder = (await startGeneration(fixture)).message;

    const final = await awaitFinal(fixture, placeholder.seq);
    expect(final.status).toBe('error');
    expect(final.error).toBe('TIMEOUT');
    expect(final.content).not.toContain('不应出现');

    const stored = await getMessageById(placeholder.id);
    expect(stored.status).toBe('error');
    expect(target.hits.stall).toBe(stallHitsBefore + 1);
  });

  it('injects the rate-limit text as the tool message and still finishes the turn', async () => {
    overrideConfig({
      webSearchEnabled: true,
      rateLimitEnabled: true,
      botToolRatePerMin: 0,
    });
    const pageHitsBefore = target.hits.page;
    const fixture = await setupBot({
      toolRoundContent: '试着抓取',
      finalContent: '基于已知信息回答',
      fetchUrl: target.pageUrl,
      alwaysCallTools: false,
    });
    const placeholder = (await startGeneration(fixture)).message;

    const final = await awaitFinal(fixture, placeholder.seq);
    expect(final.status).toBe('done');
    expect(final.content).toContain('基于已知信息回答');
    // The tool never executed, so no source footer is appended.
    expect(final.content).not.toContain('来源：');

    const second = readMessages(fixture.provider.bodies[1]);
    const toolMessage = second.find((message) => message.role === 'tool');
    expect(
      typeof toolMessage?.content === 'string' && toolMessage.content.includes('每分钟上限'),
    ).toBe(true);
    expect(target.hits.page).toBe(pageHitsBefore);
  });
});
