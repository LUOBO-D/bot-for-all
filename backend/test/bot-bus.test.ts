import http from 'node:http';
import { Server } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  botBusEnabled,
  closeBotBus,
  initBotBus,
  onBotCancel,
  onBotCacheInvalidation,
  onBotDebounce,
  publishBotCancel,
} from '../src/bot/bus';
import { botCacheVersion, bumpBotCache } from '../src/bot/cache';
import { createBotGateway } from '../src/bot/gateway';
import { BotQueue, type BotJob } from '../src/bot/queue';
import { config } from '../src/config';
import type { BotRow, MessageDTO } from '../src/types';

/** Port 1 refuses immediately, so the failure path costs no connect timeout. */
const UNREACHABLE_REDIS = 'redis://127.0.0.1:1';
/** Opt-in: set to a live Redis URL to exercise the cross-instance paths. */
const LIVE_REDIS = process.env.BOT_BUS_REDIS_URL;

let nextMessageId = 1;

function makeBot(botUserId: number): BotRow {
  return {
    userId: botUserId,
    username: 'room-bot',
    name: 'Room Bot',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKeyEncrypted: '',
    apiKey: '',
    model: 'fake-model',
    systemPrompt: '',
    triggerMode: 'all',
    scope: 'room',
    roomId: null,
    temperature: 0,
    maxTokens: 64,
    extraBody: null,
    enabled: true,
    ownerUserId: 1,
    createdAt: new Date().toISOString(),
  };
}

/** One debounced job for `roomId`/`botUserId`; the trigger id identifies it. */
function makeJob(roomId: number, botUserId: number): BotJob {
  const id = nextMessageId++;
  return {
    roomId,
    bot: makeBot(botUserId),
    trigger: {
      id,
      seq: id,
      roomId,
      senderId: 9_000,
      senderType: 'user',
      senderName: 'tester',
      senderAvatar: null,
      content: `message ${id}`,
      kind: 'text',
      poll: null,
      attachments: [],
      reactions: [],
      status: 'done',
      replyToId: null,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deleted: false,
      pinned: false,
      pinnedBy: null,
      forwardedFrom: null,
      preview: null,
    } satisfies MessageDTO,
  };
}

interface QueueAndRuns {
  queue: BotQueue;
  runs: BotJob[];
}

/** A BotQueue wired to a spy run, the seam gateway tests never need. */
function makeQueue(): QueueAndRuns {
  const runs: BotJob[] = [];
  const queue = new BotQueue(async (job) => {
    runs.push(job);
  });
  return { queue, runs };
}

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Polls the real condition under test instead of guessing a long enough wait. */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('condition not met before timeout');
    }
    await sleep(25);
  }
}

/** Queues created by a test; reset per test, closed on teardown. */
const queues: BotQueue[] = [];

afterEach(async () => {
  for (const queue of queues.splice(0)) {
    queue.close();
  }
  await closeBotBus();
});

describe('bot bus without redis', () => {
  it('falls back to single-instance behavior when redis is unreachable', async () => {
    await expect(initBotBus(UNREACHABLE_REDIS)).resolves.toBeUndefined();
    expect(botBusEnabled()).toBe(false);

    // Publishes without the bus are no-ops, and a stop stays local.
    const io = new Server(http.createServer());
    const gateway = createBotGateway(io);
    expect(() => {
      publishBotCancel({ roomKey: 'room:1' });
      bumpBotCache();
    }).not.toThrow();
    expect(gateway.cancelRoom(1)).toBe(0);
  });

  it('debounces rapid pushes per queue and runs the latest once', async () => {
    vi.useFakeTimers();
    try {
      const { queue, runs } = makeQueue();
      queues.push(queue);
      const first = makeJob(5, 7);
      const second = makeJob(5, 7);

      queue.push(first, 'all');
      queue.push(second, 'all');
      await vi.advanceTimersByTimeAsync(config.botDebounceMs + 5);

      expect(runs.map((job) => job.trigger.id)).toEqual([second.trigger.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the documented degradation: no bus means one reply per instance', async () => {
    vi.useFakeTimers();
    try {
      const here = makeQueue();
      const there = makeQueue();
      queues.push(here.queue, there.queue);
      const local = makeJob(5, 7);
      const remote = makeJob(5, 7);

      // Two instances that cannot see each other each answer; with the bus
      // the same sequence merges into one reply (see the live tests).
      here.queue.push(local, 'all');
      there.queue.push(remote, 'all');
      await vi.advanceTimersByTimeAsync(config.botDebounceMs + 5);

      expect(here.runs.map((job) => job.trigger.id)).toEqual([local.trigger.id]);
      expect(there.runs.map((job) => job.trigger.id)).toEqual([remote.trigger.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels only the pending jobs of the stopped bot, sparing other rooms and bots', async () => {
    vi.useFakeTimers();
    try {
      const stopped = makeJob(5, 7);
      const surviving = makeJob(6, 7);
      const otherBot = makeJob(5, 8);
      const { queue, runs } = makeQueue();
      queues.push(queue);

      queue.push(stopped, 'all');
      queue.push(surviving, 'all');
      queue.push(otherBot, 'all');

      queue.cancelRoom(5, [7]);
      await vi.advanceTimersByTimeAsync(config.botDebounceMs + 5);

      expect(runs.map((job) => job.roomId).sort()).toEqual([5, 6]);
      expect(runs.map((job) => job.bot.userId).sort()).toEqual([7, 8]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('bot bus against live redis', () => {
  beforeEach(async () => {
    await initBotBus(LIVE_REDIS as string);
    expect(botBusEnabled()).toBe(true);
  });

  // Real wall-clock waits are unavoidable here: ioredis needs live sockets,
  // so fake timers cannot drive the pub/sub round trips these tests assert.

  it.skipIf(!LIVE_REDIS)('merges rapid pushes from two instances into one reply', async () => {
    const here = makeQueue();
    const there = makeQueue();
    queues.push(here.queue, there.queue);
    const first = makeJob(5, 7);
    const second = makeJob(5, 7);

    // The messages land on different instances; only the latest is answered.
    here.queue.push(first, 'all');
    there.queue.push(second, 'all');

    await waitUntil(
      () => here.runs.length + there.runs.length === 1,
      config.botDebounceMs + 3_000,
    );
    const winner = here.runs.length ? here : there;
    expect(winner.runs.map((job) => job.trigger.id)).toEqual([second.trigger.id]);

    // A negative assertion: outlive every mirror's fire deadline to prove
    // no instance replied a second time.
    await sleep(config.botDebounceMs + 300);
    expect(here.runs.length + there.runs.length).toBe(1);
  });

  it.skipIf(!LIVE_REDIS)('broadcasts a stop to every pending queue', async () => {
    const here = makeQueue();
    const there = makeQueue();
    queues.push(here.queue, there.queue);
    const roomId = 42;
    const stopped: number[] = [];

    // The same wiring every gateway installs for its own queue.
    const offHere = onBotCancel((room) => {
      here.queue.cancelRoom(room);
      stopped.push(room);
    });
    const offThere = onBotCancel((room) => there.queue.cancelRoom(room));
    // Test lens on the raw debounce feed; the same events the queues mirror.
    const echoes = vi.fn();
    const offEcho = onBotDebounce(echoes);

    here.queue.push(makeJob(roomId, 7), 'all');
    there.queue.push(makeJob(roomId, 7), 'all');
    // Await the real signal that both pushes have mirrored through Redis,
    // so the stop cannot race ahead of them.
    await waitUntil(() => echoes.mock.calls.length >= 2, 3_000);

    publishBotCancel({ roomKey: `room:${roomId}` });
    // Every instance applied the stop before any debounce deadline passed.
    await waitUntil(() => stopped.length >= 1, 3_000);

    // Outlive the debounce window: both queues must stay silent, proving the
    // pending turns were dropped cluster-wide and not just locally.
    await sleep(config.botDebounceMs + 300);
    expect(here.runs).toEqual([]);
    expect(there.runs).toEqual([]);
    expect(stopped).toEqual([roomId]);

    offHere();
    offThere();
    offEcho();
  });

  it.skipIf(!LIVE_REDIS)('passes the stop payload through, including bot filters', async () => {
    const stops: { roomId: number; botUserIds?: number[] }[] = [];
    const off = onBotCancel((roomId, botUserIds) => stops.push({ roomId, botUserIds }));

    publishBotCancel({ roomKey: 'room:11' });
    publishBotCancel({ roomKey: 'room:12', botUserIds: [3, 4] });

    // One publish connection keeps the published order.
    await waitUntil(() => stops.length === 2, 3_000);
    expect(stops).toEqual([
      { roomId: 11, botUserIds: undefined },
      { roomId: 12, botUserIds: [3, 4] },
    ]);

    off();
  });

  it.skipIf(!LIVE_REDIS)('bumps every instance bot cache on one bump', async () => {
    const before = botCacheVersion();
    const remoteSeen: number[] = [];
    // What a remote replica's cache module registers on its own import.
    const off = onBotCacheInvalidation(() => remoteSeen.push(botCacheVersion()));

    bumpBotCache();

    await waitUntil(() => remoteSeen.length === 1, 3_000);
    // The local bump plus the echoed invalidation both raised the version.
    expect(botCacheVersion()).toBeGreaterThanOrEqual(before + 2);

    off();
  });
});
