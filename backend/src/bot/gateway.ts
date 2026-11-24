import type { Server } from 'socket.io';
import { config } from '../config';
import { ApiError } from '../errors';
import { logger } from '../logger';
import { checkRate } from '../middleware/ratelimit';
import { attachLinkPreview } from '../services/link-preview';
import {
  createMessage,
  finalizeMessage,
  getMessageById,
  isMessageDeleted,
  sweepStreaming,
} from '../services/message';
import { notifyMentions } from '../services/notifications';
import { getBotsForRoom } from '../services/bot';
import type { BotRow, MessageDTO } from '../types';
import { buildContext } from './context';
import { botBusEnabled, onBotCancel, publishBotCancel } from './bus';
import { botCacheVersion } from './cache';
import {
  ProviderAuthError,
  ProviderError,
  streamChat,
  type ToolCallPayload,
} from './provider';
import {
  BOT_TOOL_SPECS,
  executeBotTool,
  parseToolArgs,
  type ToolExecution,
  type ToolSource,
} from './tools';
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

/** Tool rounds after which `tools` is withheld so the turn must converge. */
const BOT_TOOL_ROUNDS_MAX = 2;

/**
 * Raised by the recall guard. A withdrawn placeholder must stop receiving
 * content — neither further deltas nor a final carrying the partial text —
 * so it settles through the same error path as a stop.
 */
class MessageRecalledError extends Error {
  constructor() {
    super('Bot message was withdrawn mid-stream');
    this.name = 'MessageRecalledError';
  }
}

function clipText(value: string, max: number): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max)}…`;
}

/**
 * The progress line broadcast in the placeholder while a tool runs, so a
 * multi-second round shows in the room instead of a silent pause.
 */
function describeToolCall(call: ToolCallPayload): string {
  const args = parseToolArgs(call.function.arguments);
  const raw =
    typeof args?.query === 'string'
      ? args.query
      : typeof args?.url === 'string'
        ? args.url
        : call.function.arguments;
  if (call.function.name === 'web_search') {
    return `\n\n（联网搜索：${clipText(raw ?? '', 80)}）\n\n`;
  }
  if (call.function.name === 'web_fetch') {
    return `\n\n（读取网页：${clipText(raw ?? '', 120)}）\n\n`;
  }
  return `\n\n（调用工具：${clipText(call.function.name, 40)}）\n\n`;
}

export interface BotGateway {
  onUserMessage(roomId: number, message: MessageDTO): Promise<void>;
  /** Aborts every live generation of `roomId`; returns how many were aborted. */
  cancelRoom(roomId: number): number;
  sweepStreaming(): Promise<void>;
}

export function createBotGateway(io: Server): BotGateway {
  const cache = new Map<number, CacheEntry>();
  // Live generations per room and bot, so a stop can abort them mid-stream
  // by room or by bot.
  const activeGenerations = new Map<number, Map<number, Set<AbortController>>>();

  /**
   * Aborts the room's matching local controllers and returns how many. Live
   * generations are tracked per bot as well, so a cancel can target a subset.
   */
  function applyCancel(roomId: number, botUserIds?: number[]): number {
    const bots = activeGenerations.get(roomId);
    if (!bots) {
      return 0;
    }
    let canceled = 0;
    for (const [botUserId, controllers] of bots) {
      if (botUserIds && !botUserIds.includes(botUserId)) {
        continue;
      }
      for (const controller of controllers) {
        if (!controller.signal.aborted) {
          controller.abort();
          canceled += 1;
        }
      }
    }
    return canceled;
  }

  function cancelRoom(roomId: number): number {
    const canceled = applyCancel(roomId);
    if (botBusEnabled()) {
      // Cluster-wide only with the bus; without Redis a stop keeps today's
      // local semantics, including debounced jobs outliving it.
      queue.cancelRoom(roomId);
      publishBotCancel({ roomKey: `room:${roomId}` });
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
    const roomBots = activeGenerations.get(roomId) ?? new Map<number, Set<AbortController>>();
    const botControllers = roomBots.get(bot.userId) ?? new Set<AbortController>();
    botControllers.add(controller);
    roomBots.set(bot.userId, botControllers);
    activeGenerations.set(roomId, roomBots);
    try {
      await streamReply(job, controller);
    } finally {
      botControllers.delete(controller);
      if (botControllers.size === 0 && roomBots.get(bot.userId) === botControllers) {
        roomBots.delete(bot.userId);
      }
      if (roomBots.size === 0 && activeGenerations.get(roomId) === roomBots) {
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

    // With web tools the turn spans up to three provider rounds plus the
    // tool requests between them; one wall-clock budget covers the whole
    // thing so a slow tool can never hold the stream open past the deadline.
    const signal = config.webSearchEnabled
      ? AbortSignal.any([controller.signal, AbortSignal.timeout(config.botToolTotalTimeoutMs)])
      : controller.signal;

    let content = '';
    let pending = '';
    let pendingDeltas = 0;
    let lastFlush = Date.now();
    // Everything the executed tools actually retrieved; appended verbatim as
    // a source list, so linking never relies on the model's goodwill alone.
    const sources: ToolSource[] = [];

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

    // Recall guard: rereads the row before every flush and before the
    // finalize, so a withdrawn placeholder stops receiving content instead
    // of leaking more text behind its recall cover.
    const ensureNotRecalled = async (): Promise<void> => {
      if (await isMessageDeleted(placeholder.id)) {
        throw new MessageRecalledError();
      }
    };

    try {
      const messages = await buildContext(roomId, bot, placeholder.id);
      for (let toolRounds = 0; ; toolRounds += 1) {
        const attachTools = config.webSearchEnabled && toolRounds < BOT_TOOL_ROUNDS_MAX;
        let roundCalls: ToolCallPayload[] = [];
        let fetchesThisRound = 0;
        let roundContent = '';
        for await (const event of streamChat({
          baseUrl: bot.baseUrl,
          apiKey: bot.apiKey,
          model: bot.model,
          messages,
          temperature: bot.temperature,
          maxTokens: bot.maxTokens,
          extraBody: bot.extraBody,
          tools: attachTools ? BOT_TOOL_SPECS : null,
          signal,
        })) {
          if (event.type === 'tool_calls') {
            roundCalls = event.calls;
            continue;
          }
          content += event.text;
          roundContent += event.text;
          pending += event.text;
          pendingDeltas += 1;
          if (pendingDeltas >= 16 || Date.now() - lastFlush >= config.botThrottleMs) {
            await ensureNotRecalled();
            flush();
          }
        }
        await ensureNotRecalled();
        flush();
        // A stop that lands between the last delta and the finalize must
        // settle the row as an error, never as a completed reply.
        if (controller.signal.aborted) {
          throw new DOMException('Bot generation canceled', 'AbortError');
        }
        // No calls this round, or the cap was reached and `tools` was
        // withheld: the stream is the answer, converge.
        if (roundCalls.length === 0 || !attachTools) {
          break;
        }

        messages.push({ role: 'assistant', content: roundContent, tool_calls: roundCalls });
        for (const call of roundCalls) {
          const label = describeToolCall(call);
          content += label;
          pending += label;
          await ensureNotRecalled();
          flush();
          // Serial execution, and at most one page read per round, keeps
          // the loop's wall-clock bounded.
          const execution: ToolExecution =
            call.function.name === 'web_fetch' && (fetchesThisRound += 1) > 1
              ? {
                  content: '（本轮网页抓取次数已用完；请基于已有信息回答。）',
                  sources: [],
                }
              : await executeBotTool(
                  bot.userId,
                  {
                    id: call.id,
                    name: call.function.name,
                    arguments: call.function.arguments,
                  },
                  signal,
                );
          messages.push({
            role: 'tool',
            content: execution.content,
            tool_call_id: call.id,
            name: call.function.name,
          });
          for (const source of execution.sources) {
            if (!sources.some((existing) => existing.url === source.url)) {
              sources.push(source);
            }
          }
        }
      }

      if (sources.length > 0) {
        const list = sources.map((source) => `- [${source.title}](${source.url})`).join('\n');
        content += `\n\n来源：\n${list}`;
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
      const recalled = error instanceof MessageRecalledError;
      // A withdrawn row must not receive the pending tail either; and neither
      // the finalize nor the final broadcast carries the partial text it
      // streamed before the withdrawal.
      const withdrawn = recalled || (await isMessageDeleted(placeholder.id));
      if (!withdrawn) {
        // An abort we requested ourselves is a stop, not a provider timeout;
        // the partial content streamed so far is kept on the finalized row.
        flush();
      }
      const code: BotErrorCode =
        recalled || controller.signal.aborted ? 'CANCELLED' : classifyError(error);
      const finalContent = withdrawn ? '' : content;
      await finalizeMessage(placeholder.id, finalContent, 'error');
      io.to(roomKey).emit('message:final', {
        roomId,
        seq: placeholder.seq,
        content: finalContent,
        status: 'error',
        error: code,
      });
      if (recalled) {
        logger.info(
          { botId: bot.userId, roomId, seq: placeholder.seq },
          'bot message withdrawn mid-stream',
        );
      } else if (code === 'CANCELLED') {
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
  // A stop published by any instance (including this one's own reflection)
  // lands here too; both halves are idempotent.
  onBotCancel((roomId, botUserIds) => {
    queue.cancelRoom(roomId, botUserIds);
    applyCancel(roomId, botUserIds);
  });

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
