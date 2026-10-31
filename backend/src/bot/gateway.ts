import type { Server } from 'socket.io';
import { config } from '../config';
import { logger } from '../logger';
import { checkRate } from '../middleware/ratelimit';
import { createMessage, finalizeMessage, sweepStreaming } from '../services/message';
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

type BotErrorCode = 'AUTH' | 'TIMEOUT' | 'PROVIDER' | 'UNKNOWN';

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
  return 'UNKNOWN';
}

export interface BotGateway {
  onUserMessage(roomId: number, message: MessageDTO): Promise<void>;
  sweepStreaming(): Promise<void>;
}

export function createBotGateway(io: Server): BotGateway {
  const cache = new Map<number, CacheEntry>();

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

    if (!checkRate(`bot:${bot.userId}`, config.botRatePerMin, 60_000)) {
      io.to(roomKey).emit('system:notice', {
        roomId,
        code: 'BOT_RATE_LIMITED',
        message: '机器人调用已达上限，稍后再试',
      });
      return;
    }

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
      })) {
        content += delta;
        pending += delta;
        pendingDeltas += 1;
        if (pendingDeltas >= 16 || Date.now() - lastFlush >= config.botThrottleMs) {
          flush();
        }
      }
      flush();
      await finalizeMessage(placeholder.id, content, 'done');
      io.to(roomKey).emit('message:final', {
        roomId,
        seq: placeholder.seq,
        content,
        status: 'done',
      });
    } catch (error) {
      flush();
      const code = classifyError(error);
      await finalizeMessage(placeholder.id, content, 'error');
      io.to(roomKey).emit('message:final', {
        roomId,
        seq: placeholder.seq,
        content,
        status: 'error',
        error: code,
      });
      logger.error(
        { err: error, botId: bot.userId, roomId, code },
        'bot generation failed',
      );
    }
  }

  const queue = new BotQueue(runJob);

  async function onUserMessage(roomId: number, message: MessageDTO): Promise<void> {
    if (message.senderType !== 'user') {
      return;
    }
    const bots = await loadBots(roomId);
    for (const bot of bots) {
      if (!shouldTrigger(bot, message)) {
        continue;
      }
      queue.push({ roomId, bot, trigger: message }, bot.triggerMode);
    }
  }

  return {
    onUserMessage,
    sweepStreaming,
  };
}
