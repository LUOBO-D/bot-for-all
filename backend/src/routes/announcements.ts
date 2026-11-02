import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { getCurrentAnnouncement } from '../services/announcements';

const router = Router();

router.use(requireAuth);

router.get(
  '/current',
  asyncHandler(async (_req, res) => {
    res.json({ announcement: await getCurrentAnnouncement() });
  }),
);

export default router;
