import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { Server } from 'socket.io';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../src/logger';
import { attachRedisAdapter, detachRedisAdapter } from '../src/socket/redis-adapter';

/** Port 1 refuses immediately, so the failure path costs no connect timeout. */
const UNREACHABLE_REDIS = 'redis://127.0.0.1:1';

/** Opt-in: set to a live Redis URL to also exercise the success path. */
const LIVE_REDIS = process.env.SOCKET_ADAPTER_REDIS_URL;

interface Harness {
  io: Server;
  url: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<Harness> {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: true } });
  const { promise, resolve } = Promise.withResolvers<void>();
  httpServer.listen(0, resolve);
  await promise;
  const { port } = httpServer.address() as AddressInfo;
  return {
    io,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      const ioClosed = Promise.withResolvers<void>();
      io.close(() => ioClosed.resolve());
      await ioClosed.promise;
      const httpClosed = Promise.withResolvers<void>();
      httpServer.close(() => httpClosed.resolve());
      await httpClosed.promise;
    },
  };
}

function connect(url: string): Promise<Socket> {
  const socket = connectSocket(url, { transports: ['websocket'], reconnection: false });
  const { promise, resolve, reject } = Promise.withResolvers<Socket>();
  socket.once('connect', () => resolve(socket));
  socket.once('connect_error', reject);
  return promise;
}

function nextEvent<T>(socket: Socket, event: string, timeoutMs = 3_000): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    socket.off(event, handler);
    reject(new Error(`Timed out waiting for ${event}`));
  }, timeoutMs);
  const handler = (payload: T): void => {
    clearTimeout(timer);
    resolve(payload);
  };
  socket.once(event, handler);
  return promise;
}

/** Local fan-out must keep working whether or not the adapter is installed. */
async function expectLocalBroadcast(harness: Harness): Promise<void> {
  const client = await connect(harness.url);
  try {
    const received = nextEvent<{ n: number }>(client, 'probe:echo');
    harness.io.emit('probe:echo', { n: 1 });
    await expect(received).resolves.toEqual({ n: 1 });
  } finally {
    client.close();
  }
}

afterEach(async () => {
  await detachRedisAdapter();
});

describe('socket.io redis adapter', () => {
  it('falls back to the in-process adapter when Redis is unreachable', async () => {
    const harness = await startServer();
    const warn = vi.spyOn(logger, 'warn');
    try {
      await expect(attachRedisAdapter(harness.io, UNREACHABLE_REDIS)).resolves.toBe(false);
      expect(warn).toHaveBeenCalled();
      await expectLocalBroadcast(harness);
    } finally {
      warn.mockRestore();
      await harness.close();
    }
  });

  it('keeps the fallback after a failed attach and allows a retry', async () => {
    const harness = await startServer();
    try {
      await expect(attachRedisAdapter(harness.io, UNREACHABLE_REDIS)).resolves.toBe(false);
      // No stale singleton: detach is a no-op and a later attempt re-runs.
      await expect(detachRedisAdapter()).resolves.toBeUndefined();
      await expect(attachRedisAdapter(harness.io, UNREACHABLE_REDIS)).resolves.toBe(false);
      await expectLocalBroadcast(harness);
    } finally {
      await harness.close();
    }
  });

  it('detaches cleanly when no adapter was attached', async () => {
    await expect(detachRedisAdapter()).resolves.toBeUndefined();
  });

  it('falls back when the Redis URL is malformed', async () => {
    const harness = await startServer();
    try {
      await expect(attachRedisAdapter(harness.io, 'not-a-url')).resolves.toBe(false);
      await expectLocalBroadcast(harness);
    } finally {
      await harness.close();
    }
  });

  it.skipIf(!LIVE_REDIS)('attaches to a live Redis and still broadcasts locally', async () => {
    const harness = await startServer();
    try {
      await expect(attachRedisAdapter(harness.io, LIVE_REDIS as string)).resolves.toBe(true);
      // Idempotent: a second attach reuses the existing clients.
      await expect(attachRedisAdapter(harness.io, LIVE_REDIS as string)).resolves.toBe(true);
      await expectLocalBroadcast(harness);
    } finally {
      await harness.close();
    }
  });
});
