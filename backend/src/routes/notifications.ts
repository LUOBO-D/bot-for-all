import { Router } from 'express';
import { z } from 'zod';
import { badRequest, notFound, tooMany } from '../errors';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { checkRate } from '../middleware/ratelimit';
import {
  deleteNotification,
  deleteNotifications,
  deleteReadNotifications,
  exportNotifications,
  listNotifications,
  markNotificationsRead,
  notificationSummary,
} from '../services/notifications';
import type { AuthUser } from '../types';

const router = Router();

router.use(requireAuth);

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  filter: z.enum(['all', 'mention', 'join', 'invite']).default('all'),
  // Empty stays legal: it means "no search", exactly like an absent `q`.
  q: z.string().max(100).optional(),
});

// The CSV is a one-shot download, not a paging API, so it takes the same
// narrowing inputs as the list but no `limit`/`offset`.
const exportSchema = z.object({
  filter: z.enum(['all', 'mention', 'join', 'invite']).default('all'),
  q: z.string().max(100).optional(),
});

/** Downloads per user per hour; each one scans up to the export row cap. */
const NOTIFICATION_EXPORT_RATE_MAX = 5;
const NOTIFICATION_EXPORT_RATE_WINDOW_MS = 60 * 60_000;

const readSchema = z.object({
  ids: z.array(z.number().int().positive()).max(100).optional(),
});

const bulkDeleteSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        'limit must be 1-50, offset must be >= 0, filter must be all, mention, join or invite and q must be at most 100 characters',
      );
    }
    const limit = parsed.data.limit ?? 20;
    const offset = parsed.data.offset ?? 0;
    const result = await listNotifications(
      (req.user as AuthUser).id,
      limit,
      offset,
      parsed.data.filter,
      parsed.data.q ?? '',
    );
    res.json(result);
  }),
);

// The CSV download of the same list. Registered before `/:id` (and before any
// future GET `/:id`) so `export` is never read as an id.
router.get(
  '/export',
  asyncHandler(async (req, res) => {
    const parsed = exportSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        'filter must be all, mention, join or invite and q must be at most 100 characters',
      );
    }
    const userId = (req.user as AuthUser).id;
    // Each download scans up to the export cap, so one per user per twelve
    // minutes on average is enough; the bucket is per account, not global.
    if (
      !(await checkRate(
        `notifications-export:${userId}`,
        NOTIFICATION_EXPORT_RATE_MAX,
        NOTIFICATION_EXPORT_RATE_WINDOW_MS,
      ))
    ) {
      throw tooMany('Too many notification exports, try again later');
    }
    const { csv, truncated } = await exportNotifications(
      userId,
      parsed.data.filter,
      parsed.data.q ?? '',
    );

    // Every header is set before the body: truncation is known up front, and
    // `no-store` keeps one account's export out of shared caches.
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="notifications.csv"');
    res.setHeader('Cache-Control', 'no-store');
    if (truncated) {
      res.setHeader('X-Notifications-Truncated', 'true');
    }
    res.send(csv);
  }),
);

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const result = await notificationSummary((req.user as AuthUser).id);
    res.json(result);
  }),
);

router.post(
  '/read',
  asyncHandler(async (req, res) => {
    const parsed = readSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'ids must be up to 100 positive integers');
    }
    const result = await markNotificationsRead(
      (req.user as AuthUser).id,
      parsed.data.ids,
    );
    res.json(result);
  }),
);

// Batch delete lives on POST because DELETE bodies are not reliably parsed;
// it is a POST path of its own, so it never competes with `DELETE /:id`.
router.post(
  '/delete',
  asyncHandler(async (req, res) => {
    const parsed = bulkDeleteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'ids must contain 1-100 positive integers');
    }
    const result = await deleteNotifications(
      (req.user as AuthUser).id,
      parsed.data.ids,
    );
    res.json(result);
  }),
);

// Registered before `/:id`: otherwise Express would read `read` as an id.
router.delete(
  '/read',
  asyncHandler(async (req, res) => {
    const result = await deleteReadNotifications((req.user as AuthUser).id);
    res.json(result);
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw badRequest('INVALID_INPUT', 'id must be a positive integer');
    }
    const result = await deleteNotification((req.user as AuthUser).id, id);
    if (!result) {
      // Same answer for "no such row" and "someone else's row": a 403 would
      // confirm that the id exists.
      throw notFound('NOTIFICATION_NOT_FOUND', 'Notification not found');
    }
    res.json(result);
  }),
);

export default router;
