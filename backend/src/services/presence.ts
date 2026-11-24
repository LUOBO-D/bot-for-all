import { logger } from '../logger';
import { closeRedisClient, connectRedis, usableRedis, type ClosableRedis } from '../redis';

/**
 * Presence hash per room: field = socket id, value = user id. The TTL is
 * refreshed on every join and, from then on, while the socket stays
 * connected, so sockets left behind by a crashed instance disappear within
 * an hour instead of lingering forever.
 */
export const PRESENCE_KEY_PREFIX = 'bfa:presence:';
export const PRESENCE_TTL_SECONDS = 60 * 60;
/** How often live sockets renew the room TTL: a third of the lifetime. */
export const PRESENCE_RENEWAL_INTERVAL_MS = Math.ceil((PRESENCE_TTL_SECONDS / 3) * 1000);

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

/**
 * Room → socket ids whose Redis hash fields must stay alive. A join already
 * refreshes the TTL, but a socket staying connected for hours would otherwise
 * expire out of the hash between joins.
 */
const renewals = new Map<number, Set<string>>();
let renewalTimer: NodeJS.Timeout | null = null;

function trackRenewal(roomId: number, socketId: string): void {
  let sockets = renewals.get(roomId);
  if (!sockets) {
    sockets = new Set();
    renewals.set(roomId, sockets);
  }
  if (!renewalTimer) {
    renewalTimer = setInterval(() => void renewPresenceTtls(), PRESENCE_RENEWAL_INTERVAL_MS);
    // Never keep the process alive just for presence renewal.
    renewalTimer.unref();
  }
  sockets.add(socketId);
}

function untrackRenewal(roomId: number, socketId: string): void {
  const sockets = renewals.get(roomId);
  if (!sockets) {
    return;
  }
  sockets.delete(socketId);
  if (sockets.size === 0) {
    renewals.delete(roomId);
  }
  if (renewals.size === 0 && renewalTimer) {
    clearInterval(renewalTimer);
    renewalTimer = null;
  }
}

/**
 * Refreshes the TTL of every room hash that still has a live socket here.
 * This is the body of the renewal interval; exported so tests can run it
 * on demand.
 */
export async function renewPresenceTtls(): Promise<void> {
  const client = usableRedis(redis, 'presence');
  if (!client) {
    return;
  }
  for (const roomId of [...renewals.keys()]) {
    try {
      await client.expire(presenceKey(roomId), PRESENCE_TTL_SECONDS);
    } catch (error) {
      // The hash survives for up to the full TTL; the next interval retries.
      logger.warn({ err: error, roomId }, 'redis presence renewal failed');
    }
  }
}

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
  renewals.clear();
  if (renewalTimer) {
    clearInterval(renewalTimer);
    renewalTimer = null;
  }
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
      const first = await redisAddSocket(client, roomId, userId, socketId);
      // Only sockets the Redis side actually tracks get the TTL renewed.
      trackRenewal(roomId, socketId);
      return first;
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
  // The socket is going away no matter which backend answers, so renewal
  // must stop even when the Redis remove itself fails.
  untrackRenewal(roomId, socketId);
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
