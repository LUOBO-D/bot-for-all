import { logger } from '../logger';
import { closeRedisClient, connectRedis, usableRedis, type ClosableRedis } from '../redis';

/**
 * Presence hash per room: field = socket id, value = user id. The TTL is
 * refreshed on every join, so sockets left behind by a crashed instance
 * disappear within an hour instead of lingering forever.
 */
export const PRESENCE_KEY_PREFIX = 'bfa:presence:';
export const PRESENCE_TTL_SECONDS = 60 * 60;

/** The Redis commands presence needs; narrowed so tests can inject a fake. */
export interface PresenceRedis extends ClosableRedis {
  status?: string;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  hvals(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

const rooms = new Map<number, Map<number, Set<string>>>();

let redis: PresenceRedis | null = null;

function presenceKey(roomId: number): string {
  return `${PRESENCE_KEY_PREFIX}${roomId}`;
}

/**
 * Test-only: swaps the Redis client (or removes it with `null`). Production
 * code reaches Redis through {@link initPresenceRedis} only.
 */
export function __setPresenceRedisForTests(client: PresenceRedis | null): void {
  redis = client;
}

/** Connects the optional presence client; a failure keeps the in-process maps. */
export async function initPresenceRedis(url: string): Promise<void> {
  if (redis) {
    return;
  }
  redis = await connectRedis(url, 'presence');
}

/** Closes the presence client on shutdown; never throws. */
export async function closePresenceRedis(): Promise<void> {
  const client = redis;
  redis = null;
  await closeRedisClient(client, 'presence');
}

function memoryAddSocket(roomId: number, userId: number, socketId: string): boolean {
  let users = rooms.get(roomId);
  if (!users) {
    users = new Map();
    rooms.set(roomId, users);
  }
  let sockets = users.get(userId);
  if (!sockets) {
    sockets = new Set();
    users.set(userId, sockets);
  }
  const first = sockets.size === 0;
  sockets.add(socketId);
  return first;
}

function memoryRemoveSocket(roomId: number, userId: number, socketId: string): boolean {
  const users = rooms.get(roomId);
  if (!users) {
    return false;
  }
  const sockets = users.get(userId);
  if (!sockets) {
    return false;
  }
  sockets.delete(socketId);
  if (sockets.size > 0) {
    return false;
  }
  users.delete(userId);
  if (users.size === 0) {
    rooms.delete(roomId);
  }
  return true;
}

function memoryOnlineUserIds(roomId: number): number[] {
  const users = rooms.get(roomId);
  return users ? [...users.keys()] : [];
}

async function redisAddSocket(
  client: PresenceRedis,
  roomId: number,
  userId: number,
  socketId: string,
): Promise<boolean> {
  const key = presenceKey(roomId);
  const value = String(userId);
  // HVALS before HSET: the caller only needs "did this user have no socket
  // yet". Presence broadcasts do not depend on the answer being atomic.
  const first = !(await client.hvals(key)).includes(value);
  await client.hset(key, socketId, value);
  await client.expire(key, PRESENCE_TTL_SECONDS);
  return first;
}

async function redisRemoveSocket(
  client: PresenceRedis,
  roomId: number,
  userId: number,
  socketId: string,
): Promise<boolean> {
  const key = presenceKey(roomId);
  const removed = Number(await client.hdel(key, socketId));
  if (removed === 0) {
    // A socket that was never tracked (or expired with the TTL) cannot be the
    // user's last one.
    return false;
  }
  const remaining = await client.hvals(key);
  if (remaining.length === 0) {
    // Drop the empty hash instead of leaving a key to expire.
    await client.del(key);
    return true;
  }
  return !remaining.includes(String(userId));
}

async function redisOnlineUserIds(client: PresenceRedis, roomId: number): Promise<number[]> {
  const values = await client.hvals(presenceKey(roomId));
  const ids = new Set<number>();
  for (const value of values) {
    const id = Number(value);
    if (Number.isInteger(id)) {
      ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Marks one socket as present and reports whether it was the user's first.
 * Uses Redis when configured (shared across instances) and the in-process
 * maps otherwise, including whenever Redis is unreachable.
 */
export async function addSocket(
  roomId: number,
  userId: number,
  socketId: string,
): Promise<boolean> {
  const client = usableRedis(redis, 'presence');
  if (client) {
    try {
      return await redisAddSocket(client, roomId, userId, socketId);
    } catch (error) {
      logger.warn({ err: error, roomId }, 'redis presence add failed, using in-memory presence');
    }
  }
  return memoryAddSocket(roomId, userId, socketId);
}

/**
 * Removes one socket and reports whether it was the user's last one, which is
 * what triggers the "went offline" presence broadcast.
 */
export async function removeSocket(
  roomId: number,
  userId: number,
  socketId: string,
): Promise<boolean> {
  const client = usableRedis(redis, 'presence');
  if (client) {
    try {
      return await redisRemoveSocket(client, roomId, userId, socketId);
    } catch (error) {
      logger.warn({ err: error, roomId }, 'redis presence remove failed, using in-memory presence');
    }
  }
  return memoryRemoveSocket(roomId, userId, socketId);
}

/** Distinct online users in a room, in no particular order. */
export async function onlineUserIds(roomId: number): Promise<number[]> {
  const client = usableRedis(redis, 'presence');
  if (client) {
    try {
      return await redisOnlineUserIds(client, roomId);
    } catch (error) {
      logger.warn({ err: error, roomId }, 'redis presence read failed, using in-memory presence');
    }
  }
  return memoryOnlineUserIds(roomId);
}

/** Whether `userId` has at least one socket in the room. */
export async function isOnline(roomId: number, userId: number): Promise<boolean> {
  const client = usableRedis(redis, 'presence');
  if (client) {
    try {
      return (await client.hvals(presenceKey(roomId))).includes(String(userId));
    } catch (error) {
      logger.warn({ err: error, roomId }, 'redis presence read failed, using in-memory presence');
    }
  }
  return rooms.get(roomId)?.has(userId) ?? false;
}
