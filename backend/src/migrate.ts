import { logger } from './logger';
import { runMigrations } from './migrate-core';

runMigrations().catch((error) => {
  logger.error({ err: error }, 'migration failed');
  process.exit(1);
});
