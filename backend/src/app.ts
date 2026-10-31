import cors from 'cors';
import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config';
import { pool } from './db';
import { logger } from './logger';
import { asyncHandler, errorHandler, notFoundHandler } from './middleware/error';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import meRoutes from './routes/me-bots';
import roomRoutes from './routes/rooms';

export function createApp(): express.Express {
  const app = express();

  if (config.trustProxy !== false) {
    app.set('trust proxy', config.trustProxy);
  }

  app.use(pinoHttp({ logger, redact: ['req.headers.authorization'] }));
  app.use(express.json({ limit: '64kb' }));

  if (process.env.NODE_ENV !== 'production') {
    app.use(cors({ origin: config.corsOrigin ?? true }));
  } else if (config.corsOrigin) {
    app.use(cors({ origin: config.corsOrigin }));
  }

  app.get(
    '/api/health',
    asyncHandler(async (_req, res) => {
      await pool.query('SELECT 1');
      res.json({ ok: true, db: 'up' });
    }),
  );

  app.use('/api/auth', authRoutes);
  app.use('/api/rooms', roomRoutes);
  app.use('/api/me', meRoutes);
  app.use('/api/admin', adminRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
