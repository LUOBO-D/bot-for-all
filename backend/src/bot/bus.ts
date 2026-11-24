import { Redis } from 'ioredis';
import { logger } from '../logger';
import {
  CLIENT_OPTIONS,
  REDIS_INITIAL_CONNECT_TIMEOUT_MS,
  closeRedisClient,
  connectWithTimeout,
  usableRedis,
} from '../redis';

/**
 * Cross-instance bot notifications. Without Redis (or during an outage) every
 * feature that publishes here simply stays single-instance, mirroring the
 * optional presence/rate-limit backends. Like those, the clients never queue
 * commands while the link is down, so events are dropped instead of being
 * delivered stale: a debounce that surfaces after its window closed would be
 * worse than one lost to a blip.
 */
export const BOT_CANCEL_CHANNEL = 'bfa:bot:cancel';
export const BOT_DEBOUNCE_CHANNEL = 'bfa:bot:debounce';
export const BOT_CACHE_CHANNEL = 'bfa:bot:cache';

/** Payload of {@link BOT_CANCEL_CHANNEL}; `roomKey` is the socket room id form. */
export interface BotCancelEvent {
  roomKey: string;
  botUserIds?: number[];
}

/** Payload of {@link BOT_DEBOUNCE_CHANNEL}: a `roomId:botUserId` push and who saw it last. */
export interface BotDebounceEvent {
  key: string;
  owner: string;
}

type CancelHandler = (roomId: number, botUserIds?: number[]) => void;
type DebounceHandler = (key: string, owner: string) => void;
type InvalidatedHandler = () => void;

/**
 * A dedicated pair, because a subscribed client cannot publish. Subscribers
 * connected to one Redis see the same event order (the server is
 * single-threaded), and ioredis replays SUBSCRIBE after a reconnect.
 */
let pair: { pub: Redis; sub: Redis } | null = null;
let connecting: Promise<void> | null = null;

const cancelHandlers = new Set<CancelHandler>();
const debounceHandlers = new Set<DebounceHandler>();
const invalidatedHandlers = new Set<InvalidatedHandler>();

function parseRoomId(roomKey: string): number | null {
  const match = /^room:(\d+)$/.exec(roomKey);
  if (!match) {
    logger.warn({ roomKey }, 'ignoring bot cancel event with unknown room key');
    return null;
  }
  return Number(match[1]);
}

function dispatch(channel: string, message: string): void {
  let event: unknown;
  try {
    event = JSON.parse(message);
  } catch {
    logger.warn({ channel }, 'ignoring malformed bot bus message');
    return;
  }
  if (channel === BOT_DEBOUNCE_CHANNEL) {
    const { key, owner } = (event ?? {}) as Partial<BotDebounceEvent>;
    if (typeof key === 'string' && typeof owner === 'string') {
      for (const handler of debounceHandlers) {
        handler(key, owner);
      }
    }
    return;
  }
  if (channel === BOT_CACHE_CHANNEL) {
    for (const handler of invalidatedHandlers) {
      handler();
    }
    return;
  }
  if (channel === BOT_CANCEL_CHANNEL) {
    const { roomKey, botUserIds } = (event ?? {}) as Partial<BotCancelEvent>;
    if (typeof roomKey === 'string') {
      const roomId = parseRoomId(roomKey);
      const bots = Array.isArray(botUserIds) ? botUserIds.filter(Number.isInteger) : undefined;
      if (roomId !== null) {
        for (const handler of cancelHandlers) {
          handler(roomId, bots);
        }
      }
    }
  }
}

/**
 * Connects the optional bot bus; a failure keeps every feature in this
 * process single-instance, so startup never depends on Redis.
 */
export async function initBotBus(url: string): Promise<void> {
  if (pair || connecting) {
    await connecting;
    return;
  }
  connecting = (async () => {
    const pub = new Redis(url, CLIENT_OPTIONS);
    const sub = new Redis(url, CLIENT_OPTIONS);
    try {
      await Promise.all([
        connectWithTimeout(pub, REDIS_INITIAL_CONNECT_TIMEOUT_MS),
        connectWithTimeout(sub, REDIS_INITIAL_CONNECT_TIMEOUT_MS),
      ]);
      // Attached before SUBSCRIBE is active so a message published in
      // between is never dropped for lack of a listener.
      sub.on('message', dispatch);
      await sub.subscribe(BOT_CANCEL_CHANNEL, BOT_DEBOUNCE_CHANNEL, BOT_CACHE_CHANNEL);
      pair = { pub, sub };
      logger.info('bot bus enabled, stop/debounce/cache events reach every instance');
    } catch (error) {
      logger.warn({ err: error }, 'redis unavailable, bot events stay single-instance');
      await closeRedisClient(pub, 'bot-bus-pub');
      await closeRedisClient(sub, 'bot-bus-sub');
    }
  })();
  try {
    await connecting;
  } finally {
    connecting = null;
  }
}

/** Whether publishes currently go out; gates behavior that only makes sense cluster-wide. */
export function botBusEnabled(): boolean {
  return pair !== null;
}

/**
 * Fire-and-forget publish helper. Without the bus this is a no-op; a client
 * that is not ready right now skips the event (see the module note).
 */
function publish(channel: string, message: string): void {
  const pub = usableRedis(pair?.pub ?? null, 'bot-bus');
  if (!pub) {
    return;
  }
  void pub.publish(channel, message).catch((error: unknown) => {
    logger.warn({ err: error, channel }, 'bot bus publish failed');
  });
}

/** Tells every instance to abort `roomKey`'s live and pending bot turns. */
export function publishBotCancel(event: BotCancelEvent): void {
  publish(BOT_CANCEL_CHANNEL, JSON.stringify(event));
}

/** Mirrors one debounced push of `key` so instances converge on one reply. */
export function publishBotDebounce(event: BotDebounceEvent): void {
  publish(BOT_DEBOUNCE_CHANNEL, JSON.stringify(event));
}

/** Tells every instance that the cached bot list of a room may be stale. */
export function publishBotCacheInvalidation(): void {
  publish(BOT_CACHE_CHANNEL, '{}');
}

/** Registers a cancel listener; returns its unregister function. */
export function onBotCancel(handler: CancelHandler): () => void {
  cancelHandlers.add(handler);
  return () => cancelHandlers.delete(handler);
}

/** Registers a debounce listener; returns its unregister function. */
export function onBotDebounce(handler: DebounceHandler): () => void {
  debounceHandlers.add(handler);
  return () => debounceHandlers.delete(handler);
}

/** Registers a cache-invalidation listener; returns its unregister function. */
export function onBotCacheInvalidation(handler: InvalidatedHandler): () => void {
  invalidatedHandlers.add(handler);
  return () => invalidatedHandlers.delete(handler);
}

/** Closes the bot bus on shutdown; never throws. */
export async function closeBotBus(): Promise<void> {
  const current = pair;
  pair = null;
  if (!current) {
    return;
  }
  await Promise.all([
    closeRedisClient(current.pub, 'bot-bus-pub'),
    closeRedisClient(current.sub, 'bot-bus-sub'),
  ]);
}
