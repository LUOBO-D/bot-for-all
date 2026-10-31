import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { io, type Socket } from 'socket.io-client';
import { hashPassword } from '../src/auth/password';
import { signToken } from '../src/auth/jwt';
import { createBotGateway } from '../src/bot/gateway';
import { pool, type ResultSetHeader } from '../src/db';
import { createApp } from '../src/app';
import { createIo, registerSocketHandlers } from '../src/socket';
import { getAuthUserById } from '../src/services/user';
import { createRoom } from '../src/services/room';
import type { AuthUser } from '../src/types';

export async function createTestUser(
  username: string,
  role: 'admin' | 'user' = 'user',
  type: 'human' | 'bot' = 'human',
): Promise<AuthUser> {
  const passwordHash = await hashPassword('password123');
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO users (username, password_hash, display_name, type, role, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [username, passwordHash, username, type, role],
  );
  const user = await getAuthUserById(result.insertId);
  if (!user) {
    throw new Error('Failed to create test user');
  }
  return user;
}

export function tokenFor(user: AuthUser): string {
  return signToken(user);
}

export async function createTestRoom(owner: AuthUser): Promise<number> {
  const room = await createRoom(owner.id, {
    name: `room-${randomBytes(3).toString('hex')}`,
    topic: '',
    isPublic: true,
  });
  return room.id;
}

export interface TestServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const app = createApp();
  const server = http.createServer(app);
  const socketServer = createIo(server);
  const gateway = createBotGateway(socketServer);
  registerSocketHandlers(socketServer, gateway);

  const { promise: listening, resolve: onListening } = Promise.withResolvers<void>();
  server.listen(0, onListening);
  await listening;
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      await new Promise<void>((resolve) => {
        socketServer.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

export function connectClient(url: string, token: string): Promise<Socket> {
  const socket = io(url, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
  const { promise, resolve, reject } = Promise.withResolvers<Socket>();
  socket.once('connect', () => resolve(socket));
  socket.once('connect_error', reject);
  return promise;
}

export function joinRoom(socket: Socket, roomId: number): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  socket.emit('room:join', { roomId }, (response: { ok?: boolean; message?: string }) => {
    if (response?.ok) {
      resolve();
    } else {
      reject(new Error(response?.message ?? 'join failed'));
    }
  });
  return promise;
}

export function sendMessage(
  socket: Socket,
  roomId: number,
  content: string,
  clientMsgId = randomBytes(8).toString('hex'),
): Promise<{ ok: boolean; message?: { seq: number }; code?: string }> {
  const { promise, resolve } = Promise.withResolvers<{
    ok: boolean;
    message?: { seq: number };
    code?: string;
  }>();
  socket.emit('message:send', { roomId, content, clientMsgId }, (response: unknown) => {
    resolve(response as { ok: boolean; message?: { seq: number }; code?: string });
  });
  return promise;
}

export function waitForEvent<T>(
  socket: Socket,
  event: string,
  predicate: (payload: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    socket.off(event, handler);
    reject(new Error(`Timed out waiting for ${event}`));
  }, timeoutMs);
  const handler = (payload: T): void => {
    if (predicate(payload)) {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
  };
  socket.on(event, handler);
  return promise;
}

export function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
