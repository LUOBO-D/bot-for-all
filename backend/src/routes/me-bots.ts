import { Router, type Request } from 'express';
import { z } from 'zod';
import { ProviderAuthError, completeOnce } from '../bot/provider';
import { badRequest, forbidden } from '../errors';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import {
  assertBotCreateRate,
  createBot,
  disableBot,
  getBotById,
  listBots,
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

const createSchema = botFields.extend({
  roomId: z.number().int().positive().optional(),
  scope: z.enum(['global', 'room']).optional(),
});

const updateSchema = botFields.partial().extend({
  enabled: z.boolean().optional(),
});

const mountSchema = z.object({ botId: z.number().int().positive() });

const router = Router();

router.use(requireAuth);

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
  asyncHandler(async (req, res) => {
    const bots = await listBots(currentUser(req).id);
    res.json({ bots: bots.map(toBotDto) });
  }),
);

router.post(
  '/bots/:id/test',
  asyncHandler(async (req, res) => {
    const bot = await getBotById(parseId(req.params.id, 'bot'));
    const user = currentUser(req);
    if (user.role !== 'admin' && bot.ownerUserId !== user.id) {
      throw forbidden('BOT_OWNER_REQUIRED', 'Only the bot owner can test it');
    }
    try {
      const reply = await completeOnce({
        baseUrl: bot.baseUrl,
        apiKey: bot.apiKey,
        model: bot.model,
        messages: [{ role: 'user', content: '请只回复 OK' }],
        temperature: 0,
        maxTokens: 16,
        extraBody: bot.extraBody,
      });
      res.json({ ok: true, reply });
    } catch (error) {
      const code =
        error instanceof ProviderAuthError
          ? 'AUTH'
          : error instanceof Error &&
              (error.name === 'TimeoutError' || error.name === 'AbortError')
            ? 'TIMEOUT'
            : 'PROVIDER';
      res.json({
        ok: false,
        code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }),
);

router.post(
  '/bots',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    await assertBotCreateRate(user.id);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const input = parsed.data;
    const scope = input.scope ?? 'room';
    const created = await createBot({
      ...input,
      actor: user,
      scope,
      roomId: scope === 'room' ? input.roomId : undefined,
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
    await mountBot(
      parseId(req.params.id, 'room'),
      parsed.data.botId,
      currentUser(req),
    );
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

export default router;
