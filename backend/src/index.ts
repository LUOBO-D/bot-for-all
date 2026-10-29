import http from 'node:http';
import { createApp } from './app';
import { createBotGateway } from './bot/gateway';
import { config } from './config';
import { waitForDb } from './db';
import { logger } from './logger';
import { createIo, registerSocketHandlers } from './socket';

async function main(): Promise<void> {
  await waitForDb();
  const app = createApp();
  const server = http.createServer(app);
  const io = createIo(server);
  const gateway = createBotGateway(io);
  registerSocketHandlers(io, gateway);
  await gateway.sweepStreaming();

  server.listen(config.port, () => {
    logger.info({ port: config.port }, 'server listening');
  });
}

main().catch((error) => {
  logger.error({ err: error }, 'server failed to start');
  process.exit(1);
});
