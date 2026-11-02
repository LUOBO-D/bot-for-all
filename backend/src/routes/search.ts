import { Router } from 'express';
import { z } from 'zod';
import { badRequest, tooMany } from '../errors';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { checkRate } from '../middleware/ratelimit';
import { searchAllMessages } from '../services/message';
import type { AuthUser } from '../types';

const router = Router();

router.use(requireAuth);

// `YYYY-MM-DD` or an ISO 8601 timestamp; Date.parse rejects impossible dates
// such as 2024-02-31 and free-form junk that MySQL would otherwise coerce.
const DATE_BOUND = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;

const dateBoundSchema = z
  .string()
  .trim()
  .refine((value) => DATE_BOUND.test(value) && !Number.isNaN(Date.parse(value)));

const FIELD_MESSAGES: Record<string, string> = {
  q: 'q must be 1-100 characters',
  roomId: 'roomId must be a positive integer',
  sender: 'sender must be 3-32 characters',
  before: 'before must be a valid date',
  after: 'after must be a valid date',
  limit: 'limit must be an integer between 1 and 50',
  offset: 'offset must be a non-negative integer',
};

const globalSearchSchema = z.object({
  q: z.string().trim().min(1).max(100),
  roomId: z.coerce.number().int().positive().optional(),
  sender: z.string().trim().min(3).max(32).optional(),
  before: dateBoundSchema.optional(),
  after: dateBoundSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

router.get(
  '/messages',
  asyncHandler(async (req, res) => {
    const user = req.user as AuthUser;
    // A global search fans out over every room the caller joined; cap it per
    // user so one client cannot turn the endpoint into a scanner.
    if (!(await checkRate(`global-search:${user.id}`, 30, 60_000))) {
      throw tooMany('Too many searches, try again later');
    }
    const parsed = globalSearchSchema.safeParse(req.query);
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? '');
      throw badRequest(
        'INVALID_INPUT',
        FIELD_MESSAGES[field] ?? 'Invalid search parameters',
      );
    }
    const { q, roomId, sender, before, after, limit, offset } = parsed.data;
    const result = await searchAllMessages(user.id, q, {
      roomId,
      sender,
      before,
      after,
      limit,
      offset,
    });
    res.json({
      messages: result.messages,
      total: result.total,
      limit: limit ?? 20,
      offset: offset ?? 0,
    });
  }),
);

export default router;
