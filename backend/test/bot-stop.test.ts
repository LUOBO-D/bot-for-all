import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { pool, type RowDataPacket } from '../src/db';
import { createBot } from '../src/services/bot';
import { getMessageById } from '../src/services/message';
import type { BotRow, MessageDTO } from '../src/types';
import { createFakeProviderApp, resetFakeStats } from './fixtures/fake-openai';
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

interface NewMessagePayload {
  roomId: number;
  message: MessageDTO;
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

interface NoticePayload {
  roomId: number;
  code: string;
  message: string;
}

interface Fixture {
  roomId: number;
  bot: BotRow;
  client: Socket;
}

interface Generation {
  placeholder: MessageDTO;
  deltas: string[];
  /** Resolves once the accumulated deltas start with `expected`. */
  waitForDeltas: (expected: string) => Promise<void>;
}

let server: TestServer;
let fakeServer: http.Server;
let partialServer: http.Server;
let partialBaseUrl: string;
const clients: Socket[] = [];

afterEach(() => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
});

beforeAll(async () => {
  fakeServer = http.createServer(
    createFakeProviderApp() as unknown as http.RequestListener,
  );
  const { promise: fakeListening, resolve: onFakeListening } = Promise.withResolvers<void>();
  fakeServer.listen(FAKE_PORT, onFakeListening);
  await fakeListening;

  partialServer = createPartialProviderServer();
  const { promise: partialListening, resolve: onPartialListening } =
    Promise.withResolvers<void>();
  partialServer.listen(0, onPartialListening);
  await partialListening;
  const partialPort = (partialServer.address() as AddressInfo).port;
  partialBaseUrl = `http://127.0.0.1:${partialPort}`;

  server = await startTestServer();
});

afterAll(async () => {
  for (const httpServer of [fakeServer, partialServer]) {
    httpServer.closeAllConnections();
    const { promise, resolve } = Promise.withResolvers<void>();
    httpServer.close(() => resolve());
    await promise;
  }
  await server.close();
});

beforeEach(() => {
  resetFakeStats();
});

/**
 * An OpenAI-compatible provider that streams half an answer and then keeps the
 * connection open, so a turn can only end by being canceled (or timing out).
 */
function createPartialProviderServer(): http.Server {
  return http.createServer((req, res) => {
    req.resume();
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '部分' } }] })}\n\n`);
    // A real provider paces its chunks; the gap is what makes this turn
    // cancellable mid-stream, so it cannot be replaced by fake timers.
    setTimeout(() => {
      if (res.destroyed || res.writableEnded) {
        return;
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '内容' } }] })}\n\n`);
    }, 60);
  });
}

function emitAck(socket: Socket, event: string, payload: unknown): Promise<Record<string, unknown>> {
  const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
  socket.emit(event, payload, (response: unknown) => {
    resolve(response as Record<string, unknown>);
  });
  return promise;
}

async function setupBot(
  model: string,
  baseUrl = `http://127.0.0.1:${FAKE_PORT}`,
  triggerMode: 'mention' | 'all' = 'mention',
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

/** Sends the trigger message and resolves once the bot's placeholder shows up. */
async function startGeneration(fixture: Fixture): Promise<Generation> {
  const deltas: string[] = [];
  const waiters: { expected: string; resolve: () => void }[] = [];
  fixture.client.on('message:delta', (payload: DeltaPayload) => {
    deltas.push(payload.delta);
    const accumulated = deltas.join('');
    for (const waiter of [...waiters]) {
      if (accumulated.startsWith(waiter.expected)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  });

  const placeholderPromise = waitForEvent<NewMessagePayload>(
    fixture.client,
    'message:new',
    (payload) => payload.message.senderType === 'bot',
  );
  await sendMessage(fixture.client, fixture.roomId, `@${fixture.bot.username} hi`);
  const placeholder = (await placeholderPromise).message;

  const waitForDeltas = (expected: string): Promise<void> => {
    if (deltas.join('').startsWith(expected)) {
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push({ expected, resolve });
    return promise;
  };

  return { placeholder, deltas, waitForDeltas };
}

describe('bot stop', () => {
  it('aborts a streaming reply and keeps the partial content', async () => {
    const fixture = await setupBot('fake-partial', partialBaseUrl);
    const finals: FinalPayload[] = [];
    const notices: NoticePayload[] = [];
    fixture.client.on('message:final', (payload: FinalPayload) => finals.push(payload));
    fixture.client.on('system:notice', (payload: NoticePayload) => notices.push(payload));

    const generation = await startGeneration(fixture);
    await generation.waitForDeltas('部分内容');

    const finalPromise = waitForEvent<FinalPayload>(
      fixture.client,
      'message:final',
      (payload) => payload.seq === generation.placeholder.seq,
    );
    const noticePromise = waitForEvent<NoticePayload>(
      fixture.client,
      'system:notice',
      (payload) => payload.code === 'BOT_STOPPED',
    );

    const ack = await emitAck(fixture.client, 'bot:stop', { roomId: fixture.roomId });
    expect(ack).toEqual({ ok: true, canceled: true });

    const [final, notice] = await Promise.all([finalPromise, noticePromise]);
    expect(notice).toEqual({
      roomId: fixture.roomId,
      code: 'BOT_STOPPED',
      message: '已停止机器人回复',
    });
    expect(final.status).toBe('error');
    expect(final.error).toBe('CANCELLED');
    expect(final.content).toBe('部分内容');

    const stored = await getMessageById(generation.placeholder.id);
    expect(stored.status).toBe('error');
    expect(stored.content).toBe('部分内容');

    // Negative assertion: the turn is settled, so nothing may follow. Only a
    // real window of time can show that no late delta/finalize is in flight.
    const deltaCount = generation.deltas.length;
    await delay(400);
    expect(generation.deltas).toHaveLength(deltaCount);
    expect(finals).toHaveLength(1);
    expect(notices).toHaveLength(1);
  });

  it('cancels a slow provider before it produces anything', async () => {
    const fixture = await setupBot('fake-slow');
    const finals: FinalPayload[] = [];
    fixture.client.on('message:final', (payload: FinalPayload) => finals.push(payload));

    const generation = await startGeneration(fixture);

    const finalPromise = waitForEvent<FinalPayload>(
      fixture.client,
      'message:final',
      (payload) => payload.seq === generation.placeholder.seq,
    );
    const noticePromise = waitForEvent<NoticePayload>(
      fixture.client,
      'system:notice',
      (payload) => payload.code === 'BOT_STOPPED',
    );
    const ack = await emitAck(fixture.client, 'bot:stop', { roomId: fixture.roomId });
    expect(ack).toEqual({ ok: true, canceled: true });

    const [final] = await Promise.all([finalPromise, noticePromise]);
    // A canceled turn reports CANCELLED, not the provider TIMEOUT it would hit.
    expect(final.status).toBe('error');
    expect(final.error).toBe('CANCELLED');
    expect(final.content).toBe('');

    // Wait past the provider's 3s write and the 1.5s timeout: nothing may
    // stream or finalize twice once the turn was canceled.
    await delay(1600);
    expect(generation.deltas).toHaveLength(0);
    expect(finals).toHaveLength(1);
  });

  it('treats a /stop message as a stop command and creates no message', async () => {
    const fixture = await setupBot('fake-slow');
    const created: NewMessagePayload[] = [];
    fixture.client.on('message:new', (payload: NewMessagePayload) => created.push(payload));

    const generation = await startGeneration(fixture);

    const finalPromise = waitForEvent<FinalPayload>(
      fixture.client,
      'message:final',
      (payload) => payload.seq === generation.placeholder.seq,
    );
    const noticePromise = waitForEvent<NoticePayload>(
      fixture.client,
      'system:notice',
      (payload) => payload.code === 'BOT_STOPPED',
    );

    const before = created.length;
    const ack = await emitAck(fixture.client, 'message:send', {
      roomId: fixture.roomId,
      content: '  /stop  ',
      clientMsgId: 'stop-command-1',
    });
    expect(ack).toEqual({ ok: true, stopped: true });

    const [final, notice] = await Promise.all([finalPromise, noticePromise]);
    expect(final.error).toBe('CANCELLED');
    expect(notice.code).toBe('BOT_STOPPED');

    // The command must not surface as a message: no `message:new`, no row.
    await delay(300);
    expect(created).toHaveLength(before);
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND content = ?',
      [fixture.roomId, '/stop'],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('reports nothing to stop when no generation is running', async () => {
    const fixture = await setupBot('fake-ok');
    const notices: NoticePayload[] = [];
    fixture.client.on('system:notice', (payload: NoticePayload) => notices.push(payload));

    const stopAck = await emitAck(fixture.client, 'bot:stop', { roomId: fixture.roomId });
    expect(stopAck).toEqual({ ok: true, canceled: false });

    const sendAck = await emitAck(fixture.client, 'message:send', {
      roomId: fixture.roomId,
      content: '/stop',
    });
    expect(sendAck).toEqual({ ok: true, stopped: false });

    // `/stop` matches exactly: other text is still an ordinary message.
    const textAck = await emitAck(fixture.client, 'message:send', {
      roomId: fixture.roomId,
      content: '/stops',
    });
    expect(textAck.ok).toBe(true);
    expect(textAck.stopped).toBeUndefined();
    expect((textAck.message as MessageDTO).content).toBe('/stops');

    // Nothing was canceled, so no stop notice may reach the room.
    await delay(200);
    expect(notices).toHaveLength(0);
  });

  it('rejects stop requests from non-members', async () => {
    const owner = await createTestUser('stop_owner');
    const roomId = await createTestRoom(owner);
    const outsider = await createTestUser('stop_outsider');
    const client = await connectClient(server.url, tokenFor(outsider));
    clients.push(client);

    const stopAck = await emitAck(client, 'bot:stop', { roomId });
    expect(stopAck).toEqual({
      ok: false,
      code: 'NOT_MEMBER',
      message: 'Not a member of this room',
    });

    const sendAck = await emitAck(client, 'message:send', { roomId, content: '/stop' });
    expect(sendAck).toEqual({
      ok: false,
      code: 'NOT_MEMBER',
      message: 'Not a member of this room',
    });
  });
});
