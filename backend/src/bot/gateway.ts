import type { Server } from 'socket.io';
import { config } from '../config';
import { ApiError } from '../errors';
import { logger } from '../logger';
import { checkRate } from '../middleware/ratelimit';
import { attachLinkPreview } from '../services/link-preview';
import { createMessage, finalizeMessage, getMessageById, sweepStreaming } from '../services/message';
import { notifyMentions } from '../services/notifications';
import { getBotsForRoom } from '../services/bot';
import type { BotRow, MessageDTO } from '../types';
import { buildContext } from './context';
import { botCacheVersion } from './cache';
import {
  ProviderAuthError,
  ProviderError,
  streamChat,
} from './provider';
import { BotQueue, type BotJob } from './queue';
import { shouldTrigger } from './trigger';

type BotErrorCode = 'AUTH' | 'TIMEOUT' | 'PROVIDER' | 'CANCELLED' | 'UNKNOWN';

interface CacheEntry {
  at: number;
  version: number;
  bots: BotRow[];
}

const CACHE_TTL_MS = 30_000;

function classifyError(error: unknown): BotErrorCode {
  if (error instanceof ProviderAuthError) {
    return 'AUTH';
  }
  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return 'TIMEOUT';
  }
  if (error instanceof ProviderError) {
    return 'PROVIDER';
  }
  // Response-size rejections surface as ApiError 502 BOT_RESPONSE_TOO_LARGE;
  // they are provider faults for the client too.
  if (error instanceof ApiError && error.code === 'BOT_RESPONSE_TOO_LARGE') {
    return 'PROVIDER';
  }
  return 'UNKNOWN';
}

export interface BotGateway {
  onUserMessage(roomId: number, message: MessageDTO): Promise<void>;
  /** Aborts every live generation of `roomId`; returns how many were aborted. */
  cancelRoom(roomId: number): number;
  sweepStreaming(): Promise<void>;
}

export function createBotGateway(io: Server): BotGateway {
  const cache = new Map<number, CacheEntry>();
  // Live generations per room, so a stop request can abort them mid-stream.
  const activeGenerations = new Map<number, Set<AbortController>>();

  function cancelRoom(roomId: number): number {
    const controllers = activeGenerations.get(roomId);
    if (!controllers) {
      return 0;
    }
    let canceled = 0;
    for (const controller of controllers) {
      if (!controller.signal.aborted) {
        controller.abort();
        canceled += 1;
      }
    }
    return canceled;
  }

  async function loadBots(roomId: number): Promise<BotRow[]> {
    const now = Date.now();
    const cached = cache.get(roomId);
    if (
      cached &&
      cached.version === botCacheVersion() &&
      now - cached.at < CACHE_TTL_MS
    ) {
      return cached.bots;
    }
    const bots = await getBotsForRoom(roomId);
    cache.set(roomId, { at: now, version: botCacheVersion(), bots });
    return bots;
  }

  async function runJob(job: BotJob): Promise<void> {
    const { roomId, bot } = job;
    const roomKey = `room:${roomId}`;

    if (!(await checkRate(`bot:${bot.userId}`, config.botRatePerMin, 60_000))) {
      io.to(roomKey).emit('system:notice', {
        roomId,
        code: 'BOT_RATE_LIMITED',
        message: '机器人调用已达上限，稍后再试',
      });
      return;
    }

    // Registered before the placeholder row exists so a stop that lands while
    // the turn is still starting cancels it too.
    const controller = new AbortController();
    const roomControllers = activeGenerations.get(roomId) ?? new Set<AbortController>();
    roomControllers.add(controller);
    activeGenerations.set(roomId, roomControllers);
    try {
      await streamReply(job, controller);
    } finally {
      roomControllers.delete(controller);
      if (roomControllers.size === 0 && activeGenerations.get(roomId) === roomControllers) {
        activeGenerations.delete(roomId);
      }
    }
  }

  async function streamReply(job: BotJob, controller: AbortController): Promise<void> {
    const { roomId, bot } = job;
    const roomKey = `room:${roomId}`;

    const placeholder = await createMessage({
      roomId,
      senderId: bot.userId,
      senderType: 'bot',
      content: '',
      status: 'streaming',
    });
    io.to(roomKey).emit('message:new', { roomId, message: placeholder });

    let content = '';
    let pending = '';
    let pendingDeltas = 0;
    let lastFlush = Date.now();

    const flush = (): void => {
      if (!pending) {
        return;
      }
      io.to(roomKey).emit('message:delta', {
        roomId,
        seq: placeholder.seq,
        delta: pending,
      });
      pending = '';
      pendingDeltas = 0;
      lastFlush = Date.now();
    };

    try {
      const messages = await buildContext(roomId, bot, placeholder.id);
      for await (const delta of streamChat({
        baseUrl: bot.baseUrl,
        apiKey: bot.apiKey,
        model: bot.model,
        messages,
        temperature: bot.temperature,
        maxTokens: bot.maxTokens,
        extraBody: bot.extraBody,
        signal: controller.signal,
      })) {
        content += delta;
        pending += delta;
        pendingDeltas += 1;
        if (pendingDeltas >= 16 || Date.now() - lastFlush >= config.botThrottleMs) {
          flush();
        }
      }
      flush();
      // A stop that lands between the last delta and the finalize must settle
      // the row as an error, never as a completed reply.
      if (controller.signal.aborted) {
        throw new DOMException('Bot generation canceled', 'AbortError');
      }
      await finalizeMessage(placeholder.id, content, 'done');
      io.to(roomKey).emit('message:final', {
        roomId,
        seq: placeholder.seq,
        content,
        status: 'done',
      });
      // The placeholder DTO is still `streaming`; re-read the finalized row so
      // the preview sees the final content and status.
      void getMessageById(placeholder.id)
        .then((finalMessage) => attachLinkPreview(io, roomId, finalMessage))
        .catch((error) => {
          logger.error(
            { err: error, roomId, botId: bot.userId },
            'bot link preview failed',
          );
        });
      void notifyMentions(io, roomId, { ...placeholder, content }, {
        id: bot.userId,
        name: bot.name,
      }).catch((error) => {
        logger.error(
          { err: error, roomId, botId: bot.userId },
          'bot mention notification failed',
        );
      });
    } catch (error) {
      flush();
      // An abort we requested ourselves is a stop, not a provider timeout; the
      // partial content streamed so far is kept on the finalized row.
      const code: BotErrorCode = controller.signal.aborted
        ? 'CANCELLED'
        : classifyError(error);
      await finalizeMessage(placeholder.id, content, 'error');
      io.to(roomKey).emit('message:final', {
        roomId,
        seq: placeholder.seq,
        content,
        status: 'error',
        error: code,
      });
      if (code === 'CANCELLED') {
        logger.info(
          { botId: bot.userId, roomId, seq: placeholder.seq },
          'bot generation canceled',
        );
      } else {
        logger.error(
          { err: error, botId: bot.userId, roomId, code },
          'bot generation failed',
        );
      }
    }
  }

  const queue = new BotQueue(runJob);

  async function onUserMessage(roomId: number, message: MessageDTO): Promise<void> {
    if (message.senderType !== 'user') {
      return;
    }
    const bots = await loadBots(roomId);
    // `getBotsForRoom` already caps the query, but the 30s cache can hold a
    // list loaded under a larger limit; the cap belongs at the trigger point.
    for (const bot of bots.slice(0, config.botMaxPerRoom)) {
      if (!shouldTrigger(bot, message)) {
        continue;
      }
      queue.push({ roomId, bot, trigger: message }, bot.triggerMode);
    }
  }

  return {
    onUserMessage,
    cancelRoom,
    sweepStreaming,
  };
}
