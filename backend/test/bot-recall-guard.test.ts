import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { createBot } from '../src/services/bot';
import { deleteMessage, getMessageById } from '../src/services/message';
import type { BotRow, MessageDTO } from '../src/types';
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

/**
 * Withdrawal guard (HealthScan #1/#2): a bot message recalled mid-stream must
 * not receive any further content — no delta broadcast, and a final that
 * carries no partial text. The provider streams slowly on purpose so the
 * recall lands mid-generation; the recalled final settles through the
 * existing error shape (status `error`, code `CANCELLED`, empty content).
 *
 * The deletion is driven through the message service directly — exactly the
 * DB state a moderator's HTTP delete produces — so the test measures the
 * streaming side of the race, not the route broadcast.
 */

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

interface PacedProvider {
  url: string;
  close: () => Promise<void>;
}

function sse(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/**
 * Streams ten paced deltas (~100ms apart) so a withdrawal has a real window
 * to land in; a full unguarded run finishes in about a second, well under
 * the test env's BOT_TIMEOUT_MS of 1500.
 */
async function startPacedProvider(): Promise<PacedProvider> {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.write(sse('第一段'));
    void (async () => {
      for (let index = 1; index <= 9; index += 1) {
        await delay(100);
        if (res.destroyed || res.writableEnded) {
          return;
        }
        res.write(sse(`后续段${index}`));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    })();
  });
  const { promise: listening, resolve: onListening } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', onListening);
  await listening;
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
    },
  };
}

let server: TestServer;
let provider: PacedProvider;
const clients: Socket[] = [];

beforeAll(async () => {
  provider = await startPacedProvider();
  server = await startTestServer();
});

afterAll(async () => {
  for (const client of clients) {
    client.close();
  }
  await provider.close();
  await server.close();
});

describe('bot recall guard', () => {
  it('stops all content broadcasts once the streaming message is withdrawn', async () => {
    const owner = await createTestUser('bot_recall_owner');
    const roomId = await createTestRoom(owner);
    const bot: BotRow = await createBot({
      actor: owner,
      scope: 'room',
      roomId,
      name: 'recallbot',
      baseUrl: provider.url,
      apiKey: 'test-key',
      model: 'fake-paced',
      triggerMode: 'mention',
    });
    const client = await connectClient(server.url, tokenFor(owner));
    clients.push(client);
    await joinRoom(client, roomId);

    const deltas: string[] = [];
    client.on('message:delta', (payload: DeltaPayload) => {
      deltas.push(payload.delta);
    });

    const placeholderPromise = waitForEvent<NewMessagePayload>(
      client,
      'message:new',
      (payload) => payload.message.senderType === 'bot',
    );
    await sendMessage(client, roomId, `@${bot.username} 聊点什么`);
    const placeholder = (await placeholderPromise).message;

    // Land the withdrawal between two paced deltas: the first batch is
    // already visible, the stream is still running, and more text is about
    // to arrive — none of it may be broadcast.
    await waitForEvent<DeltaPayload>(
      client,
      'message:delta',
      (payload) => payload.seq === placeholder.seq,
    );
    await deleteMessage(roomId, placeholder.seq, owner.id, true);

    const final = await waitForEvent<FinalPayload>(
      client,
      'message:final',
      (payload) => payload.seq === placeholder.seq,
    );
    expect(final.status).toBe('error');
    expect(final.error).toBe('CANCELLED');
    // 撤回不泄露原文: neither the pending tail nor the partial text that
    // streamed before the withdrawal reaches the final.
    expect(final.content).toBe('');

    // Socket events on one connection keep their order, so any delta the
    // guard failed to suppress would have arrived before this final; give
    // the stream a real window and prove nothing follows.
    const deltaCount = deltas.length;
    await delay(300);
    expect(deltas).toHaveLength(deltaCount);

    // The row itself: withdrawn, settled as an error, with the streamed
    // partial never written back into it.
    const stored = await getMessageById(placeholder.id);
    expect(stored.deleted).toBe(true);
    expect(stored.status).toBe('error');
    expect(stored.content).toBe('');
  });
});
