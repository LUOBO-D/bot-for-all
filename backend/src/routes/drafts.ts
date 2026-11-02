import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { listDraftBox } from '../services/drafts';
import type { AuthUser } from '../types';

const router = Router();

router.use(requireAuth);

// Mounted at /api/me: the caller's own draft box. Private by construction —
// the query is scoped to the authenticated user — and limited server-side to
// the newest 50 drafts, so the response has a fixed ceiling.
router.get(
  '/drafts',
  asyncHandler(async (req, res) => {
    res.json({ drafts: await listDraftBox((req.user as AuthUser).id) });
  }),
);

export default router;
