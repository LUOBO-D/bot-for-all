import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config';
import {
  pool,
  withTransaction,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from '../db';
import { ApiError, badRequest, forbidden, notFound, tooMany } from '../errors';
import { logger } from '../logger';
import { checkRate } from '../middleware/ratelimit';
import { getRoomOwnerId } from './room';
import type { AuthUser, BotDTO, BotRow } from '../types';
import { isDuplicateError, toIso } from '../utils';
import { bumpBotCache } from '../bot/cache';
import { decryptSecret, encryptSecret, maskKey } from '../bot/crypto';
import { assertSafeBotUrl } from '../bot/url';

const extraBodySchema = z.record(z.unknown());

function parseExtraBody(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    const result = extraBodySchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function mapBotRow(row: RowDataPacket): BotRow {
  const encrypted = String(row.api_key_encrypted);
  let apiKey: string;
  try {
    apiKey = decryptSecret(encrypted);
  } catch (error) {
    // A single corrupt ciphertext (rotated BOT_KEY_SECRET, manual edit) must not
    // break every bot listing; the row keeps working, only the key is unreadable.
    logger.warn({ err: error, botUserId: Number(row.user_id) }, 'failed to decrypt bot api key');
    apiKey = '';
  }
  return {
    userId: Number(row.user_id),
    username: String(row.username),
    name: String(row.display_name),
    baseUrl: String(row.base_url),
    apiKeyEncrypted: encrypted,
    apiKey,
    model: String(row.model),
    systemPrompt: String(row.system_prompt ?? ''),
    triggerMode: row.trigger_mode,
    scope: row.scope,
    roomId: row.room_id == null ? null : Number(row.room_id),
    temperature: Number(row.temperature),
    maxTokens: Number(row.max_tokens),
    extraBody: parseExtraBody(row.extra_body),
    enabled: Boolean(row.enabled),
    ownerUserId: Number(row.owner_user_id),
    createdAt: toIso(row.created_at),
  };
}

const BOT_SELECT = `
  SELECT b.*, u.username, u.display_name
  FROM bots b
  JOIN users u ON u.id = b.user_id
`;

export async function getBotById(botId: number): Promise<BotRow> {
  const [rows] = await pool.query<RowDataPacket[]>(`${BOT_SELECT} WHERE b.user_id = ?`, [botId]);
  const row = rows[0];
  if (!row) {
    throw notFound('BOT_NOT_FOUND', 'Bot not found');
  }
  return mapBotRow(row);
}

export async function listBots(ownerId: number): Promise<BotRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${BOT_SELECT} WHERE b.owner_user_id = ? ORDER BY b.created_at DESC`,
    [ownerId],
  );
  return rows.map(mapBotRow);
}

export async function listGlobalBots(): Promise<BotRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${BOT_SELECT} WHERE b.scope = 'global' ORDER BY b.created_at DESC`,
  );
  return rows.map(mapBotRow);
}

export async function getBotsForRoom(roomId: number): Promise<BotRow[]> {
  // A room bot is only live while its user account is active, its membership
  // row exists, and its owner still belongs to the room. The owner check is
  // deliberately scoped to room bots: a global bot may be mounted in rooms its
  // owner never joined.
  const [rows] = await pool.query<RowDataPacket[]>(
    `${BOT_SELECT}
     JOIN room_members rm ON rm.user_id = b.user_id
     WHERE rm.room_id = ? AND rm.role = 'bot' AND b.enabled = 1
       AND u.status = 'active'
       AND (
         b.scope = 'global' OR (
           b.room_id = rm.room_id AND EXISTS (
             SELECT 1
             FROM room_members owner_rm
             JOIN users owner_u ON owner_u.id = owner_rm.user_id
             WHERE owner_rm.room_id = b.room_id
               AND owner_rm.user_id = b.owner_user_id
               AND owner_u.status = 'active'
           )
         )
       )
     ORDER BY b.created_at ASC
     LIMIT ?`,
    [roomId, config.botMaxPerRoom],
  );
  return rows.map(mapBotRow);
}

export interface CreateBotInput {
  actor: AuthUser;
  scope: 'room' | 'global';
  roomId?: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  triggerMode?: 'mention' | 'all';
  temperature?: number;
  maxTokens?: number;
  extraBody?: Record<string, unknown> | null;
}

/** Per-user creation attempts allowed in any rolling minute. */
export const BOT_CREATE_RATE_MAX = 10;
export const BOT_CREATE_RATE_WINDOW_MS = 60_000;

/**
 * Shared by `POST /api/me/bots` and the admin global-bot endpoint so an admin
 * cannot dodge the limit by switching routes, and a user's two kinds of bot
 * creation draw from one bucket.
 */
export async function assertBotCreateRate(userId: number): Promise<void> {
  if (!(await checkRate(`bot:create:${userId}`, BOT_CREATE_RATE_MAX, BOT_CREATE_RATE_WINDOW_MS))) {
    throw tooMany('Too many bot creation requests');
  }
}

/**
 * Enforces both row quotas inside the creating transaction. The room row (for
 * room bots) and the owner row are locked first, room before user to match the
 * existing membership/leave transactions, so concurrent creations for the same
 * owner/room serialize and each counts the committed rows instead of all
 * passing the check and inserting. Rows are counted regardless of `enabled`:
 * disabling is a soft delete, and counting only live rows would let
 * create/disable cycles grow storage (and later re-enables bypass the cap).
 */
async function assertBotQuota(
  conn: PoolConnection,
  ownerId: number,
  scope: 'room' | 'global',
  roomId: number | null,
): Promise<void> {
  if (scope === 'room' && roomId !== null) {
    await conn.execute<RowDataPacket[]>('SELECT id FROM rooms WHERE id = ? FOR UPDATE', [roomId]);
  }
  await conn.execute<RowDataPacket[]>('SELECT id FROM users WHERE id = ? FOR UPDATE', [ownerId]);

  const [ownerRows] = await conn.execute<RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM bots WHERE owner_user_id = ?',
    [ownerId],
  );
  if (Number(ownerRows[0]?.total ?? 0) >= config.botMaxPerOwner) {
    throw badRequest(
      'BOT_LIMIT_REACHED',
      `You already own the maximum of ${config.botMaxPerOwner} bots`,
    );
  }

  if (scope === 'room' && roomId !== null) {
    const [roomRows] = await conn.execute<RowDataPacket[]>(
      "SELECT COUNT(*) AS total FROM bots WHERE scope = 'room' AND room_id = ?",
      [roomId],
    );
    if (Number(roomRows[0]?.total ?? 0) >= config.botMaxPerRoom) {
      throw badRequest(
        'BOT_LIMIT_REACHED',
        `This room already has the maximum of ${config.botMaxPerRoom} bots`,
      );
    }
  }
}

export async function createBot(input: CreateBotInput): Promise<BotRow> {
  await assertSafeBotUrl(input.baseUrl);
  if (input.scope === 'global') {
    if (input.actor.role !== 'admin') {
      throw forbidden('ADMIN_REQUIRED', 'Only admins can create global bots');
    }
  } else {
    if (!input.roomId) {
      throw badRequest('ROOM_REQUIRED', 'roomId is required for room-scoped bots');
    }
    const ownerId = await getRoomOwnerId(input.roomId);
    if (input.actor.role !== 'admin' && ownerId !== input.actor.id) {
      throw forbidden('ROOM_OWNER_REQUIRED', 'Only the room owner can create room bots');
    }
  }

  const extraBodyJson = input.extraBody ? JSON.stringify(input.extraBody) : null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const username = `bot_${randomBytes(4).toString('hex')}`;
    try {
      const botUserId = await withTransaction(async (conn) => {
        await assertBotQuota(conn, input.actor.id, input.scope, input.roomId ?? null);
        const [userResult] = await conn.execute<ResultSetHeader>(
          `INSERT INTO users (username, password_hash, display_name, type, role, status)
           VALUES (?, ?, ?, 'bot', 'user', 'active')`,
          [username, randomBytes(30).toString('hex'), input.name],
        );
        const userId = userResult.insertId;
        await conn.execute(
          `INSERT INTO bots
             (user_id, base_url, api_key_encrypted, model, system_prompt, trigger_mode,
              owner_user_id, scope, room_id, temperature, max_tokens, extra_body, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            userId,
            input.baseUrl,
            encryptSecret(input.apiKey),
            input.model,
            input.systemPrompt ?? '',
            input.triggerMode ?? 'mention',
            input.actor.id,
            input.scope,
            input.roomId ?? null,
            input.temperature ?? 0.7,
            input.maxTokens ?? 1024,
            extraBodyJson,
          ],
        );
        if (input.scope === 'room' && input.roomId) {
          await conn.execute(
            'INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)',
            [input.roomId, userId, 'bot'],
          );
        }
        return userId;
      });
      bumpBotCache();
      return getBotById(botUserId);
    } catch (error) {
      if (isDuplicateError(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new ApiError(500, 'BOT_CREATE_FAILED', 'Could not allocate bot username');
}

export interface UpdateBotInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  systemPrompt?: string;
  triggerMode?: 'mention' | 'all';
  temperature?: number;
  maxTokens?: number;
  extraBody?: Record<string, unknown> | null;
  enabled?: boolean;
}

/**
 * Management rights never come from the bot's owner row alone for room bots:
 * they belong to the room, so only the room's current owner or a global admin
 * may change them. Global bots keep the bot-owner rule.
 */
async function assertCanManageBot(bot: BotRow, actor: AuthUser): Promise<void> {
  if (bot.scope === 'room') {
    if (actor.role === 'admin') {
      return;
    }
    const ownerId = bot.roomId === null ? null : await getRoomOwnerId(bot.roomId);
    if (ownerId !== actor.id) {
      throw forbidden('ROOM_OWNER_REQUIRED', 'Only the room owner can manage this bot');
    }
    return;
  }
  if (bot.ownerUserId !== actor.id) {
    throw forbidden('BOT_OWNER_REQUIRED', 'Only the bot owner can manage it');
  }
}

export async function updateBot(
  botId: number,
  actor: AuthUser,
  patch: UpdateBotInput,
): Promise<BotRow> {
  const current = await getBotById(botId);
  await assertCanManageBot(current, actor);
  if (patch.baseUrl !== undefined) {
    await assertSafeBotUrl(patch.baseUrl);
  }

  await withTransaction(async (conn) => {
    if (patch.name !== undefined) {
      await conn.execute('UPDATE users SET display_name = ? WHERE id = ?', [patch.name, botId]);
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.baseUrl !== undefined) {
      sets.push('base_url = ?');
      params.push(patch.baseUrl);
    }
    if (
      patch.apiKey !== undefined &&
      patch.apiKey !== '' &&
      patch.apiKey !== maskKey(current.apiKey)
    ) {
      sets.push('api_key_encrypted = ?');
      params.push(encryptSecret(patch.apiKey));
    }
    if (patch.model !== undefined) {
      sets.push('model = ?');
      params.push(patch.model);
    }
    if (patch.systemPrompt !== undefined) {
      sets.push('system_prompt = ?');
      params.push(patch.systemPrompt);
    }
    if (patch.triggerMode !== undefined) {
      sets.push('trigger_mode = ?');
      params.push(patch.triggerMode);
    }
    if (patch.temperature !== undefined) {
      sets.push('temperature = ?');
      params.push(patch.temperature);
    }
    if (patch.maxTokens !== undefined) {
      sets.push('max_tokens = ?');
      params.push(patch.maxTokens);
    }
    if (patch.extraBody !== undefined) {
      sets.push('extra_body = ?');
      params.push(patch.extraBody ? JSON.stringify(patch.extraBody) : null);
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(patch.enabled ? 1 : 0);
    }
    if (sets.length > 0) {
      await conn.query(`UPDATE bots SET ${sets.join(', ')} WHERE user_id = ?`, [
        ...params,
        botId,
      ]);
    }
    if (patch.enabled === true && current.scope === 'room' && current.roomId) {
      await conn.execute(
        'INSERT IGNORE INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)',
        [current.roomId, botId, 'bot'],
      );
    }
    if (patch.enabled === false && current.scope === 'room') {
      // Mirrors disableBot: room bots lose their single membership, global bots
      // keep their mounts so re-enabling restores the previous rooms.
      await conn.execute('DELETE FROM room_members WHERE user_id = ?', [botId]);
    }
  });

  bumpBotCache();
  return getBotById(botId);
}

export async function disableBot(botId: number, actor: AuthUser): Promise<void> {
  const current = await getBotById(botId);
  await assertCanManageBot(current, actor);
  await withTransaction(async (conn) => {
    await conn.execute('UPDATE bots SET enabled = 0 WHERE user_id = ?', [botId]);
    // Room bots belong to exactly one room; global bots must keep their mounts
    // so re-enabling restores the previous rooms.
    if (current.scope === 'room') {
      await conn.execute('DELETE FROM room_members WHERE user_id = ?', [botId]);
    }
  });
  bumpBotCache();
}

export async function mountBot(roomId: number, botId: number, actor: AuthUser): Promise<void> {
  const ownerId = await getRoomOwnerId(roomId);
  if (actor.role !== 'admin' && ownerId !== actor.id) {
    throw forbidden('ROOM_OWNER_REQUIRED', 'Only the room owner can mount bots');
  }
  const bot = await getBotById(botId);
  if (bot.scope === 'room' && bot.roomId !== roomId) {
    throw badRequest('BOT_ROOM_MISMATCH', 'Bot belongs to another room');
  }
  await pool.execute(
    'INSERT IGNORE INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)',
    [roomId, botId, 'bot'],
  );
  bumpBotCache();
}

export async function unmountBot(roomId: number, botId: number, actor: AuthUser): Promise<void> {
  const ownerId = await getRoomOwnerId(roomId);
  if (actor.role !== 'admin' && ownerId !== actor.id) {
    throw forbidden('ROOM_OWNER_REQUIRED', 'Only the room owner can unmount bots');
  }
  await pool.execute('DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [
    roomId,
    botId,
  ]);
  bumpBotCache();
}

export function toBotDto(bot: BotRow): BotDTO {
  return {
    userId: bot.userId,
    username: bot.username,
    name: bot.name,
    baseUrl: bot.baseUrl,
    apiKeyMasked: maskKey(bot.apiKey),
    model: bot.model,
    systemPrompt: bot.systemPrompt,
    triggerMode: bot.triggerMode,
    scope: bot.scope,
    roomId: bot.roomId,
    temperature: bot.temperature,
    maxTokens: bot.maxTokens,
    extraBody: bot.extraBody,
    enabled: bot.enabled,
    ownerUserId: bot.ownerUserId,
    createdAt: bot.createdAt,
  };
}
