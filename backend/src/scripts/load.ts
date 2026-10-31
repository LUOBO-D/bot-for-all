import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { io, type Socket } from 'socket.io-client';
import { config } from '../config';
import { pool, type RowDataPacket } from '../db';

const BASE_URL = 'http://127.0.0.1:3000';
const MESSAGE_COUNT = 20;

interface Receipt {
  seq: number;
  at: number;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function waitForConnect(socket: Socket): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  socket.once('connect', () => resolve());
  socket.once('connect_error', (error) => reject(error));
  return promise;
}

function joinRoom(socket: Socket, roomId: number): Promise<void> {
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

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

async function main(): Promise<void> {
  const [roomRows] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM rooms WHERE name = 'load-test' ORDER BY id LIMIT 1",
  );
  const room = roomRows[0];
  if (!room) {
    throw new Error('load-test room missing. Run `pnpm seed:load` first.');
  }
  const roomId = Number(room.id);

  const [userRows] = await pool.query<RowDataPacket[]>(
    "SELECT id, username FROM users WHERE username REGEXP '^load_[0-9]+$' ORDER BY id",
  );
  if (userRows.length === 0) {
    throw new Error('No load users found. Run `pnpm seed:load` first.');
  }

  const sockets: Socket[] = [];
  const receipts: Receipt[][] = [];

  for (const row of userRows) {
    const token = jwt.sign(
      {
        sub: String(row.id),
        username: String(row.username),
        type: 'human',
        role: 'user',
      },
      config.jwtSecret,
      { expiresIn: '1h', algorithm: 'HS256' },
    );
    const socket = io(BASE_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    const clientReceipts: Receipt[] = [];
    receipts.push(clientReceipts);
    socket.on('message:new', (payload: { message?: { seq?: number; senderType?: string } }) => {
      if (payload?.message?.senderType === 'user' && typeof payload.message.seq === 'number') {
        clientReceipts.push({ seq: payload.message.seq, at: Date.now() });
      }
    });
    sockets.push(socket);
  }

  await Promise.all(sockets.map((socket) => waitForConnect(socket)));
  await Promise.all(sockets.map((socket) => joinRoom(socket, roomId)));

  const sender = sockets[0];
  const sentAt = new Map<number, number>();

  for (let index = 0; index < MESSAGE_COUNT; index += 1) {
    const sendAt = Date.now();
    const seq = await new Promise<number>((resolve, reject) => {
      sender.emit(
        'message:send',
        { roomId, content: `load message ${index}`, clientMsgId: randomUUID() },
        (response: { ok?: boolean; message?: { seq?: number } | string }) => {
          if (response?.ok && typeof response.message === 'object' && typeof response.message.seq === 'number') {
            resolve(response.message.seq);
          } else {
            reject(new Error(typeof response?.message === 'string' ? response.message : 'send failed'));
          }
        },
      );
    });
    sentAt.set(seq, sendAt);
    await delay(50);
    if (index === 9) {
      await delay(10_000);
    }
  }

  await delay(1500);

  const latencies: number[] = [];
  let missing = 0;
  for (const clientReceipts of receipts) {
    const distinct = new Set(clientReceipts.map((receipt) => receipt.seq));
    missing += Math.max(MESSAGE_COUNT - distinct.size, 0);
    for (const receipt of clientReceipts) {
      const start = sentAt.get(receipt.seq);
      if (start != null) {
        latencies.push(receipt.at - start);
      }
    }
  }

  console.log(
    JSON.stringify({
      clients: sockets.length,
      messages: MESSAGE_COUNT,
      missing,
      p50ms: percentile(latencies, 0.5),
      p95ms: percentile(latencies, 0.95),
    }),
  );

  for (const socket of sockets) {
    socket.close();
  }
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
