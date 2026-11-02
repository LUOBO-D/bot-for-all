import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../errors';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { SAVED_LIMIT_DEFAULT, SAVED_LIMIT_MAX, listSaved } from '../services/saved';
import type { AuthUser } from '../types';

const router = Router();

router.use(requireAuth);

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(SAVED_LIMIT_MAX).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  // An absent or empty q means "no content filter"; a present value is capped.
  q: z.string().max(100).optional(),
});

// Mounted at /api/me: the caller's own bookmarks, newest first.
router.get(
  '/saved',
  asyncHandler(async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        `limit must be 1-${SAVED_LIMIT_MAX}, offset must be >= 0 and q must be at most 100 characters`,
      );
    }
    res.json(
      await listSaved(
        (req.user as AuthUser).id,
        parsed.data.limit ?? SAVED_LIMIT_DEFAULT,
        parsed.data.offset ?? 0,
        parsed.data.q ?? '',
      ),
    );
  }),
);

export default router;
