import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../src/logger';
import {
  PRESENCE_KEY_PREFIX,
  PRESENCE_RENEWAL_INTERVAL_MS,
  PRESENCE_TTL_SECONDS,
  __setPresenceRedisForTests,
  addSocket,
  closePresenceRedis,
  isOnline,
  onlineUserIds,
  removeSocket,
  renewPresenceTtls,
  type PresenceRedis,
} from '../src/services/presence';

/** In-memory stand-in for the presence hash commands. */
class FakePresenceRedis implements PresenceRedis {
  status?: string;

  hashes = new Map<string, Map<string, string>>();

  expirations: { key: string; seconds: number }[] = [];

  deleted: string[] = [];

  failure: Error | null = null;

  quit = vi.fn(async () => 'OK');

  private check(): void {
    if (this.failure) {
      throw this.failure;
    }
  }

  private readHash(key: string): Map<string, string> {
    this.check();
    return this.hashes.get(key) ?? new Map();
  }

  private ensureHash(key: string): Map<string, string> {
    this.check();
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    return hash;
  }

  async hset(key: string, field: string, value: string): Promise<unknown> {
    this.ensureHash(key).set(field, value);
    return 1;
  }

  async hdel(key: string, ...fields: string[]): Promise<unknown> {
    const hash = this.readHash(key);
    let removed = 0;
    for (const field of fields) {
      if (hash.delete(field)) {
        removed += 1;
      }
    }
    return removed;
  }

  async hvals(key: string): Promise<string[]> {
    return [...this.readHash(key).values()];
  }

  async expire(key: string, seconds: number): Promise<unknown> {
    this.check();
    this.expirations.push({ key, seconds });
    return this.hashes.has(key) ? 1 : 0;
  }

  async del(key: string): Promise<unknown> {
    this.check();
    const existed = this.hashes.delete(key);
    this.deleted.push(key);
    return existed ? 1 : 0;
  }
}

let nextRoomId = 1;

function uniqueRoomId(): number {
  return nextRoomId++;
}

afterEach(() => {
  __setPresenceRedisForTests(null);
  vi.restoreAllMocks();
});

describe('redis presence backend', () => {
  it('stores socket ids in the room hash with a refreshed TTL', async () => {
    const redis = new FakePresenceRedis();
    __setPresenceRedisForTests(redis);
    const roomId = uniqueRoomId();
    const key = `${PRESENCE_KEY_PREFIX}${roomId}`;

    expect(await addSocket(roomId, 7, 'socket-a')).toBe(true);
    expect(await addSocket(roomId, 7, 'socket-b')).toBe(false);
    expect(await addSocket(roomId, 8, 'socket-c')).toBe(true);

    expect(redis.hashes.get(key)).toEqual(
      new Map([
        ['socket-a', '7'],
        ['socket-b', '7'],
        ['socket-c', '8'],
      ]),
    );
    // Every join refreshes the hour-long TTL.
    expect(redis.expirations).toEqual([
      { key, seconds: PRESENCE_TTL_SECONDS },
      { key, seconds: PRESENCE_TTL_SECONDS },
      { key, seconds: PRESENCE_TTL_SECONDS },
    ]);
    expect(PRESENCE_TTL_SECONDS).toBe(3600);
    expect(await onlineUserIds(roomId)).toEqual([7, 8]);
    expect(await isOnline(roomId, 7)).toBe(true);
    expect(await isOnline(roomId, 9)).toBe(false);
  });

  it('reports the last socket per user and drops the empty hash', async () => {
    const redis = new FakePresenceRedis();
    __setPresenceRedisForTests(redis);
    const roomId = uniqueRoomId();
    const key = `${PRESENCE_KEY_PREFIX}${roomId}`;

    await addSocket(roomId, 7, 'socket-a');
    await addSocket(roomId, 7, 'socket-b');
    await addSocket(roomId, 8, 'socket-c');

    expect(await removeSocket(roomId, 7, 'socket-a')).toBe(false);
    expect(await onlineUserIds(roomId)).toEqual([7, 8]);

    expect(await removeSocket(roomId, 7, 'socket-b')).toBe(true);
    expect(await onlineUserIds(roomId)).toEqual([8]);

    expect(await removeSocket(roomId, 8, 'socket-c')).toBe(true);
    expect(await onlineUserIds(roomId)).toEqual([]);
    expect(redis.hashes.has(key)).toBe(false);
    expect(redis.deleted).toEqual([key]);

    // A socket that was never tracked is not a "last socket" event.
    expect(await removeSocket(roomId, 8, 'socket-c')).toBe(false);
  });

  it('falls back to the in-memory maps when redis throws', async () => {
    const redis = new FakePresenceRedis();
    redis.failure = new Error('redis down');
    __setPresenceRedisForTests(redis);
    const warn = vi.spyOn(logger, 'warn');
    const roomId = uniqueRoomId();

    expect(await addSocket(roomId, 1, 'a')).toBe(true);
    expect(await addSocket(roomId, 1, 'b')).toBe(false);
    expect(await addSocket(roomId, 2, 'c')).toBe(true);
    expect(await onlineUserIds(roomId)).toEqual([1, 2]);
    expect(await isOnline(roomId, 1)).toBe(true);

    expect(await removeSocket(roomId, 1, 'a')).toBe(false);
    expect(await removeSocket(roomId, 1, 'b')).toBe(true);
    expect(await onlineUserIds(roomId)).toEqual([2]);

    expect(warn).toHaveBeenCalled();
    expect(redis.hashes.size).toBe(0);
  });

  it('skips a client that is not connected and uses memory', async () => {
    const redis = new FakePresenceRedis();
    redis.status = 'end';
    __setPresenceRedisForTests(redis);
    const roomId = uniqueRoomId();

    expect(await addSocket(roomId, 3, 'x')).toBe(true);
    expect(await onlineUserIds(roomId)).toEqual([3]);
    expect(await isOnline(roomId, 3)).toBe(true);
    expect(redis.hashes.size).toBe(0);
    expect(redis.expirations).toEqual([]);
  });

  it('quits the client on shutdown and reverts to memory', async () => {
    const redis = new FakePresenceRedis();
    __setPresenceRedisForTests(redis);
    const roomId = uniqueRoomId();

    await addSocket(roomId, 5, 'live');
    expect(redis.hashes.size).toBe(1);

    await closePresenceRedis();
    expect(redis.quit).toHaveBeenCalledTimes(1);

    const fallbackRoom = uniqueRoomId();
    expect(await addSocket(fallbackRoom, 5, 'after-close')).toBe(true);
    expect(await onlineUserIds(fallbackRoom)).toEqual([5]);
    expect(redis.hashes.size).toBe(1);
  });
});

describe('presence ttl renewal', () => {
  // closePresenceRedis also clears the renewal registry, so every test starts
  // exact: rooms left over from earlier tests are never swept again.
  beforeEach(async () => {
    await closePresenceRedis();
  });

  it('renews each room hash while any of its sockets stays connected', async () => {
    const redis = new FakePresenceRedis();
    __setPresenceRedisForTests(redis);
    const roomId = uniqueRoomId();
    const key = `${PRESENCE_KEY_PREFIX}${roomId}`;

    await addSocket(roomId, 7, 'socket-a');
    await addSocket(roomId, 8, 'socket-b');
    redis.expirations.length = 0;

    // The interval body renews once per room, not once per socket.
    await renewPresenceTtls();
    expect(redis.expirations).toEqual([{ key, seconds: PRESENCE_TTL_SECONDS }]);

    // socket-a was user 7's only socket: the user's room presence is gone
    // (true), yet renewal must continue for user 8's socket-b.
    expect(await removeSocket(roomId, 7, 'socket-a')).toBe(true);
    redis.expirations.length = 0;
    await renewPresenceTtls();
    expect(redis.expirations).toEqual([{ key, seconds: PRESENCE_TTL_SECONDS }]);

    // The last socket leaving ends the room's renewal.
    expect(await removeSocket(roomId, 8, 'socket-b')).toBe(true);
    redis.expirations.length = 0;
    await renewPresenceTtls();
    expect(redis.expirations).toEqual([]);
  });

  it('stops renewal even when the redis remove fails', async () => {
    const redis = new FakePresenceRedis();
    __setPresenceRedisForTests(redis);
    const roomId = uniqueRoomId();

    await addSocket(roomId, 7, 'socket-a');

    // The disconnect happens during an outage: the remove falls back to
    // memory, but renewal must still stop for the vanished socket.
    redis.failure = new Error('redis down');
    await expect(removeSocket(roomId, 7, 'socket-a')).resolves.toBe(false);
    redis.failure = null;

    redis.expirations.length = 0;
    await renewPresenceTtls();
    expect(redis.expirations).toEqual([]);
  });

  it('renews nothing for sockets the memory backend alone holds', async () => {
    __setPresenceRedisForTests(null);
    const roomId = uniqueRoomId();

    expect(await addSocket(roomId, 7, 'socket-a')).toBe(true);

    // A redis client appearing later must not inherit renewal duty.
    const redis = new FakePresenceRedis();
    __setPresenceRedisForTests(redis);
    await renewPresenceTtls();
    expect(redis.expirations).toEqual([]);
    // A third of the lifetime: three missed intervals still leave the full
    // TTL as the recovery margin.
    expect(PRESENCE_RENEWAL_INTERVAL_MS).toBe((PRESENCE_TTL_SECONDS / 3) * 1000);
  });
});
