import http from 'node:http';
import { createApp } from './app';
import { closeCaptchaRedis, initCaptchaRedis } from './auth/captcha';
import { closeBotBus, initBotBus } from './bot/bus';
import { createBotGateway } from './bot/gateway';
import { closeSafeAgent } from './bot/safe-fetch';
import { config } from './config';
import { pool, waitForDb } from './db';
import { logger } from './logger';
import { closeRateLimitRedis, initRateLimitRedis } from './middleware/ratelimit';
import { startAttachmentCleanupScheduler } from './services/attachment-cleanup';
import { closePresenceRedis, initPresenceRedis } from './services/presence';
import { startRoomRetentionScheduler } from './services/retention';
import { processDueScheduled, recoverStuckScheduled } from './services/scheduled';
import { createIo, registerSocketHandlers } from './socket';
import { attachRedisAdapter, detachRedisAdapter } from './socket/redis-adapter';

/** How long a graceful shutdown may take before the process is forced down. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  await waitForDb();
  // Optional: without REDIS_URL (or when Redis is unreachable) rate limiting,
  // presence and captcha stay on in-process state, so startup never depends on
  // Redis. Each initializer logs and keeps its fallback on failure.
  if (config.redisUrl) {
    await Promise.all([
      initRateLimitRedis(config.redisUrl),
      initPresenceRedis(config.redisUrl),
      initCaptchaRedis(config.redisUrl),
      initBotBus(config.redisUrl),
    ]);
  }
  const app = createApp();
  const server = http.createServer(app);
  const io = createIo(server);
  // Optional: with REDIS_URL, Socket.IO fans events out to every backend
  // instance through the Redis adapter. A failure is logged and leaves the
  // default in-process adapter, so a single instance keeps working.
  if (config.redisUrl) {
    await attachRedisAdapter(io, config.redisUrl);
  }
  const gateway = createBotGateway(io);
  registerSocketHandlers(io, gateway);
  await gateway.sweepStreaming();

  // Orphaned uploads and files of withdrawn messages are reclaimed in the
  // background; the first sweep runs immediately and the timer is unref'd.
  const attachmentCleanupTimer = startAttachmentCleanupScheduler();

  // Rooms that configured a retention policy drop expired messages in the
  // background. Like the attachment sweep, the first pass runs immediately and
  // the timer is unref'd.
  const roomRetentionTimer = startRoomRetentionScheduler();

  // A row left in `sending` by a crash would otherwise never be delivered, so
  // recovery runs before the first tick claims anything.
  await recoverStuckScheduled();

  let tickRunning = false;
  const tick = async (): Promise<void> => {
    if (tickRunning) {
      // The previous pass is still delivering; overlapping would only queue up.
      return;
    }
    tickRunning = true;
    try {
      await processDueScheduled({
        io,
        onUserMessage: (roomId, message) => gateway.onUserMessage(roomId, message),
      });
    } catch (error) {
      logger.error({ err: error }, 'scheduled message tick failed');
    } finally {
      tickRunning = false;
    }
  };
  // Deliver anything already overdue right after a restart instead of waiting
  // a whole tick for it.
  void tick();
  const scheduledTimer = setInterval(() => void tick(), config.scheduledTickMs);
  // Never keep the process alive just for the queue scan.
  scheduledTimer.unref();

  server.on('error', (error) => {
    logger.error({ err: error }, 'http server error');
    process.exit(1);
  });

  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    // Close websocket connections so `server.close` can actually drain.
    io.disconnectSockets(true);
    clearInterval(scheduledTimer);
    clearInterval(attachmentCleanupTimer);
    clearInterval(roomRetentionTimer);

    server.close((closeError) => {
      let failed = false;
      if (closeError && (closeError as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        failed = true;
        logger.error({ err: closeError }, 'error closing http server');
      }
      void closeSafeAgent()
        .catch((agentError: unknown) => {
          failed = true;
          logger.error({ err: agentError }, 'error closing bot dispatcher');
        })
        // Never throws; logs a warning and moves on.
        .then(() => detachRedisAdapter())
        .then(() => closeBotBus())
        .then(() => closeRateLimitRedis())
        .then(() => closePresenceRedis())
        .then(() => closeCaptchaRedis())
        .then(() => pool.end())
        .catch((poolError: unknown) => {
          failed = true;
          logger.error({ err: poolError }, 'error closing database pool');
        })
        .finally(() => {
          clearTimeout(forceExit);
          logger.info('shutdown complete');
          process.exit(failed ? 1 : 0);
        });
    });
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  server.listen(config.port, () => {
    logger.info({ port: config.port }, 'server listening');
  });
}

main().catch((error) => {
  logger.error({ err: error }, 'server failed to start');
  process.exit(1);
});
