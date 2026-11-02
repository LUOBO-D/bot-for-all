import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  REDIS_INITIAL_CONNECT_TIMEOUT_MS,
  REDIS_RETRY_MAX_MS,
  closeRedisClient,
  connectRedis,
  connectWithTimeout,
  redisRetryDelay,
  usableRedis,
} from '../src/redis';

interface FakeRedisServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * Minimal TCP stand-in for Redis. ioredis marks a connection ready after the
 * socket connects, so answering PING/QUIT (and acknowledging anything else) is
 * enough to observe the client's own reconnect loop.
 */
async function startFakeRedis(port = 0): Promise<FakeRedisServer> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      const data = chunk.toString('utf8');
      if (/QUIT/i.test(data)) {
        socket.end('+OK\r\n');
        return;
      }
      // ioredis may pack several RESP commands (CLIENT SETINFO + INFO) into one
      // TCP chunk; each one needs its own reply or the ready check stalls.
      const commands = data.match(/\*/g)?.length ?? 1;
      socket.write('+OK\r\n'.repeat(commands));
    });
  });

  const { promise: listening, resolve: onListening } = Promise.withResolvers<void>();
  server.listen(port, '127.0.0.1', onListening);
  await listening;
  const address = server.address() as net.AddressInfo;

  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
    },
  };
}

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  const { promise: listening, resolve: onListening } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', onListening);
  await listening;
  const port = (server.address() as net.AddressInfo).port;
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  await promise;
  return port;
}

function nextEvent(client: { once(event: string, handler: () => void): unknown }, event: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  client.once(event, resolve);
  return promise;
}

describe('redis retry policy', () => {
  it('backs off with a cap and never gives up', () => {
    expect(redisRetryDelay(1)).toBe(200);
    for (const attempt of [1, 2, 10, 100, 10_000]) {
      const delay = redisRetryDelay(attempt);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(REDIS_RETRY_MAX_MS);
    }
    expect(redisRetryDelay(10_000)).toBe(REDIS_RETRY_MAX_MS);
  });

  it('falls back to memory when the initial connect is refused', async () => {
    const port = await unusedPort();
    const startedAt = Date.now();

    const client = await connectRedis(`redis://127.0.0.1:${port}`, 'refused test');

    expect(client).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(REDIS_INITIAL_CONNECT_TIMEOUT_MS + 2_000);
  }, 10_000);

  it('cuts a connect attempt that never settles at the startup budget', async () => {
    vi.useFakeTimers();
    try {
      const { promise: neverSettles } = Promise.withResolvers<void>();
      const pendingClient = {
        connect: () => neverSettles,
      } as unknown as Parameters<typeof connectWithTimeout>[0];

      const attempt = connectWithTimeout(pendingClient, REDIS_INITIAL_CONNECT_TIMEOUT_MS);
      const rejected = expect(attempt).rejects.toThrow(/timed out/);

      await vi.advanceTimersByTimeAsync(REDIS_INITIAL_CONNECT_TIMEOUT_MS);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects after a runtime disconnect instead of staying on memory', async () => {
    const fake = await startFakeRedis();
    const client = await connectRedis(`redis://127.0.0.1:${fake.port}`, 'reconnect test');
    expect(client).not.toBeNull();
    expect(client?.status).toBe('ready');
    expect(usableRedis(client, 'reconnect test')).toBe(client);
    const redisClient = client!;

    const closed = nextEvent(redisClient, 'close');
    await fake.close();
    await closed;

    // A client that had given up permanently would never emit `ready` again.
    const ready = nextEvent(redisClient, 'ready');
    const restarted = await startFakeRedis(fake.port);
    try {
      await ready;
      expect(usableRedis(client, 'reconnect test')).toBe(client);
    } finally {
      await closeRedisClient(client, 'reconnect test');
      await restarted.close();
    }
  }, 15_000);
});
