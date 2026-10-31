import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool, type ResultSetHeader } from '../db';
import { badRequest, notFound } from '../errors';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import {
  createBot,
  disableBot,
  listGlobalBots,
  mountBot,
  toBotDto,
  unmountBot,
  updateBot,
  type CreateBotInput,
  type UpdateBotInput,
} from '../services/bot';
import type { AuthUser } from '../types';

const botFields = z.object({
  name: z.string().min(1).max(64),
  baseUrl: z.string().url().max(512),
  apiKey: z.string().min(1).max(512),
  model: z.string().min(1).max(128),
  systemPrompt: z.string().max(8000).optional(),
  triggerMode: z.enum(['mention', 'all']).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(8192).optional(),
  extraBody: z.record(z.unknown()).nullable().optional(),
});

const createSchema = botFields;
const updateSchema = botFields.partial().extend({
  enabled: z.boolean().optional(),
});
const mountSchema = z.object({ botId: z.number().int().positive() });
const statusSchema = z.object({ status: z.enum(['active', 'banned']) });

const router = Router();

router.use(requireAuth, requireAdmin);

function currentUser(req: Request): AuthUser {
  return req.user as AuthUser;
}

function parseId(value: string, label: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest('INVALID_ID', `Invalid ${label} id`);
  }
  return id;
}

router.get(
  '/bots',
  asyncHandler(async (_req, res) => {
    const bots = await listGlobalBots();
    res.json({ bots: bots.map(toBotDto) });
  }),
);

router.post(
  '/bots',
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const created = await createBot({
      ...parsed.data,
      actor: currentUser(req),
      scope: 'global',
    } satisfies CreateBotInput);
    res.status(201).json({ bot: toBotDto(created) });
  }),
);

router.patch(
  '/bots/:id',
  asyncHandler(async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const updated = await updateBot(
      parseId(req.params.id, 'bot'),
      currentUser(req),
      parsed.data satisfies UpdateBotInput,
    );
    res.json({ bot: toBotDto(updated) });
  }),
);

router.delete(
  '/bots/:id',
  asyncHandler(async (req, res) => {
    await disableBot(parseId(req.params.id, 'bot'), currentUser(req));
    res.json({ ok: true, disabled: true });
  }),
);

router.post(
  '/rooms/:id/bots',
  asyncHandler(async (req, res) => {
    const parsed = mountSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'botId is required');
    }
    await mountBot(parseId(req.params.id, 'room'), parsed.data.botId, currentUser(req));
    res.json({ ok: true });
  }),
);

router.delete(
  '/rooms/:id/bots/:botId',
  asyncHandler(async (req, res) => {
    await unmountBot(
      parseId(req.params.id, 'room'),
      parseId(req.params.botId, 'bot'),
      currentUser(req),
    );
    res.json({ ok: true });
  }),
);

router.patch(
  '/users/:id/status',
  asyncHandler(async (req, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'status must be active or banned');
    }
    const userId = parseId(req.params.id, 'user');
    if (userId === currentUser(req).id) {
      throw badRequest('CANNOT_BAN_SELF', 'Cannot change your own status');
    }
    const [result] = await pool.execute<ResultSetHeader>(
      'UPDATE users SET status = ? WHERE id = ?',
      [parsed.data.status, userId],
    );
    if (result.affectedRows === 0) {
      throw notFound('USER_NOT_FOUND', 'User not found');
    }
    res.json({ ok: true });
  }),
);

export default router;
