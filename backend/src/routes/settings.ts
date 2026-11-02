import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../errors';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import {
  NOTIFY_MODES,
  getSettings,
  updateSettings,
} from '../services/settings';
import type { AuthUser } from '../types';

const router = Router();

router.use(requireAuth);

// 24-hour wall clock, minutes precision, no seconds: that is what
// `<input type="time">` submits and what the DND comparison consumes.
const CLOCK = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');

const patchSchema = z.object({
  notifyMode: z.enum(NOTIFY_MODES).optional(),
  dndStart: CLOCK.nullable().optional(),
  dndEnd: CLOCK.nullable().optional(),
  dndAllowMentions: z.boolean().optional(),
});

router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    res.json(await getSettings((req.user as AuthUser).id));
  }),
);

router.patch(
  '/settings',
  asyncHandler(async (req, res) => {
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        'notifyMode must be all|mention, dndStart/dndEnd must be HH:MM, dndAllowMentions must be boolean',
      );
    }
    // Every field is optional, so an empty object would silently "succeed"
    // without changing anything — reject it instead of pretending.
    if (Object.keys(parsed.data).length === 0) {
      throw badRequest('INVALID_INPUT', 'at least one setting must be provided');
    }
    // The DND window is one value, not two: a request that touches it must
    // carry both ends (each may be null to turn DND off) so the stored pair
    // can never be half-set.
    if (
      (parsed.data.dndStart !== undefined) !== (parsed.data.dndEnd !== undefined)
    ) {
      throw badRequest(
        'INVALID_INPUT',
        'dndStart and dndEnd must be provided together',
      );
    }
    res.json(await updateSettings((req.user as AuthUser).id, parsed.data));
  }),
);

export default router;
