import cors from 'cors';
import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config';
import { pool } from './db';
import { logger } from './logger';
import { asyncHandler, errorHandler, notFoundHandler } from './middleware/error';
import adminRoutes from './routes/admin';
import announcementRoutes from './routes/announcements';
import authRoutes from './routes/auth';
import avatarRoutes, { userAvatarRouter } from './routes/avatar';
import draftsRoutes from './routes/drafts';
import meRoutes from './routes/me-bots';
import meExportRoutes from './routes/me-export';
import notificationRoutes from './routes/notifications';
import roomRoutes from './routes/rooms';
import savedRoutes from './routes/saved';
import searchRoutes from './routes/search';
import settingsRoutes from './routes/settings';

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
};

const HSTS_HEADER = 'max-age=31536000; includeSubDomains';

/**
 * Static security headers for every response, including 404s and errors.
 * HSTS is only emitted in production: browsers pin the header per host, so
 * sending it from a local/dev host would break plain-HTTP access there.
 */
export function securityHeaders(isProduction: boolean): express.RequestHandler {
  return (_req, res, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }
    if (isProduction) {
      res.setHeader('Strict-Transport-Security', HSTS_HEADER);
    }
    next();
  };
}

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  // Registered before logging/body parsing so nothing can bypass it.
  app.use(securityHeaders(process.env.NODE_ENV === 'production'));

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
  app.use('/api/search', searchRoutes);
  app.use('/api/me', meRoutes);
  app.use('/api/me', meExportRoutes);
  app.use('/api/me', avatarRoutes);
  app.use('/api/me', settingsRoutes);
  app.use('/api/me', savedRoutes);
  app.use('/api/me', draftsRoutes);
  app.use('/api/users', userAvatarRouter);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/announcements', announcementRoutes);
  app.use('/api/admin', adminRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
