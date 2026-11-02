import fs from 'node:fs';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import {
  pool,
  withTransaction,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from '../db';
import { ApiError, badRequest, notFound, tooMany } from '../errors';
import { logger } from '../logger';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { checkRate } from '../middleware/ratelimit';
import { bumpBotCache } from '../bot/cache';
import {
  buildAuditScope,
  escapeLikePattern,
  isAuditDate,
  listAudit,
  recordAudit,
} from '../services/audit';
import { resolveAttachmentPath } from '../services/attachment-cleanup';
import {
  ANNOUNCEMENT_BODY_MAX,
  createAnnouncement,
  deactivateAnnouncement,
  listAnnouncements,
  updateAnnouncement,
} from '../services/announcements';
import {
  assertBotCreateRate,
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
import {
  listReports,
  listReportsForExport,
  REPORT_LIST_LIMIT,
  resolveReport,
  type ReportDTO,
} from '../services/reports';
import { cancelPendingScheduledMessages, disableRoomBotsOwnedBy } from '../services/room';
import {
  avatarUrl,
  listUsers,
  listUsersForExport,
  type AdminUser,
} from '../services/user';
import { disconnectUserSockets, roomKey } from '../socket';
import { getSocketServer } from '../socket/broadcast';
import type { AuthUser } from '../types';
import { toIso } from '../utils';

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
// Up to 100 picks per page make a full admin page one request; duplicates are
// collapsed before validation so a repeated id is not an error.
const bulkStatusSchema = z.object({
  userIds: z.array(z.number().int().positive()).min(1).max(100),
  status: z.enum(['active', 'banned']),
});
const roleSchema = z.object({ role: z.enum(['admin', 'user']) });
const listUsersSchema = z.object({
  q: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
// `from`/`to` are calendar days; the service turns `to` into an exclusive
// next-day bound so both ends are inclusive for the caller.
const auditDateField = z
  .string()
  .refine(isAuditDate, 'expected a valid YYYY-MM-DD date');

const auditFilterFields = {
  action: z.string().min(1).max(64).optional(),
  actor: z.string().trim().max(64).optional(),
  from: auditDateField.optional(),
  to: auditDateField.optional(),
};

function auditRangeOrdered(data: { from?: string; to?: string }): boolean {
  return !data.from || !data.to || data.from <= data.to;
}

const listAuditSchema = z
  .object({
    ...auditFilterFields,
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .refine(auditRangeOrdered, { message: 'from must not be after to' });
const exportAuditSchema = z
  .object(auditFilterFields)
  .refine(auditRangeOrdered, { message: 'from must not be after to' });

const listRoomsSchema = z.object({
  q: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
// Both exports are one-shot downloads: the only filter is the same `q` the
// matching admin table uses, and paging is deliberately not accepted.
const exportDataSchema = z.object({
  q: z.string().max(64).optional(),
});
const announcementSchema = z.object({
  body: z.string().trim().min(1).max(ANNOUNCEMENT_BODY_MAX),
});
// A rooms page holds 50 rows, so one full-page selection is a single batch.
const bulkDeleteRoomsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});
const listReportsSchema = z.object({
  status: z.enum(['open', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
// Same filter as the queue; `open` is the UI default, so an omitted status
// exports the queue rather than silently including handled history.
const exportReportsSchema = z.object({
  status: z.enum(['open', 'all']).default('open'),
});
const resolveReportSchema = z.object({
  status: z.enum(['resolved', 'dismissed']),
});
// One admin page holds 200 report rows, so a full-page selection is one batch.
const bulkReportSchema = resolveReportSchema.extend({
  ids: z.array(z.number().int().positive()).min(1).max(200),
});
const statsSchema = z.object({
  days: z.coerce.number().int().min(7).max(30).default(14),
});

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

/** Named lock shared by process instances; exported for the concurrency test. */
export const ADMIN_GUARD_LOCK = 'bfa:admin_guard';
/** How long a request waits for a concurrent admin change before giving up. */
const ADMIN_GUARD_TIMEOUT_SECONDS = 5;

/**
 * Runs a role/status mutation under a MySQL named lock. Row locks alone cannot
 * protect the "last active admin" invariant: two transactions can each read a
 * different victim before either writes, and both would then pass the count
 * check. GET_LOCK serializes every instance that talks to this database.
 *
 * The lock belongs to the connection, not the transaction, so it is released
 * explicitly; if that release cannot be confirmed the connection is destroyed
 * instead of going back to the pool, where it would block every later admin
 * change until the process exits.
 */
async function withAdminGuard<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  let lockAcquired = false;
  try {
    const [lockRows] = await conn.query<RowDataPacket[]>(
      'SELECT GET_LOCK(?, ?) AS acquired',
      [ADMIN_GUARD_LOCK, ADMIN_GUARD_TIMEOUT_SECONDS],
    );
    lockAcquired = Number(lockRows[0]?.acquired) === 1;
    if (!lockAcquired) {
      throw new ApiError(
        503,
        'ADMIN_BUSY',
        'Another admin change is in progress, please retry',
      );
    }

    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (error) {
      try {
        await conn.rollback();
      } catch {
        // ignore rollback failure
      }
      throw error;
    }
  } finally {
    let reusable = true;
    if (lockAcquired) {
      let released = false;
      try {
        const [releaseRows] = await conn.query<RowDataPacket[]>(
          'SELECT RELEASE_LOCK(?) AS released',
          [ADMIN_GUARD_LOCK],
        );
        released = Number(releaseRows[0]?.released) === 1;
      } catch {
        released = false;
      }
      if (!released) {
        reusable = false;
        conn.destroy();
      }
    }
    if (reusable) {
      conn.release();
    }
  }
}

/**
 * Best-effort removal of attachment files whose rows were deleted along with
 * their room. Called only after the delete committed, so a rollback can never
 * strand a live row without its file. An unsafe stored name is refused and a
 * missing file is not an error; other failures are logged and otherwise
 * ignored because the row is already gone and cannot point at the file again.
 */
async function removeAttachmentFiles(storedNames: string[]): Promise<void> {
  for (const storedName of storedNames) {
    const absolute = resolveAttachmentPath(storedName);
    if (!absolute) {
      logger.warn({ storedName }, 'refusing unsafe attachment path during room delete');
      continue;
    }
    try {
      await fs.promises.unlink(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      logger.warn(
        { err: error, storedName },
        'failed to remove attachment file during room delete',
      );
    }
  }
}

export interface AdminTrendPoint {
  date: string;
  users: number;
  messages: number;
  rooms: number;
  bots: number;
}

/** New rows per series in the window immediately before the trend window. */
export interface AdminPreviousCounts {
  users: number;
  messages: number;
  rooms: number;
  bots: number;
}

export interface AdminStats {
  users: { total: number; active: number; banned: number; admins: number };
  rooms: { total: number; public: number; private: number };
  messages: { total: number; deleted: number };
  bots: { total: number; enabled: number };
  reports: { open: number; resolved: number; dismissed: number; total: number };
  trend: AdminTrendPoint[];
  previous: AdminPreviousCounts;
}

// Series carried by the trend panel, in the order the SQL below emits them.
const TREND_SERIES = ['users', 'messages', 'rooms', 'bots'] as const;
type TrendSeries = (typeof TREND_SERIES)[number];

// Continuous `YYYY-MM-DD` list ending on `today` (the database's CURDATE, so the
// buckets line up with the `created_at` day boundaries used by the query).
function trendDates(today: string, days: number): string[] {
  const base = Date.parse(`${today}T00:00:00Z`);
  const dates: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    dates.push(new Date(base - offset * 86_400_000).toISOString().slice(0, 10));
  }
  return dates;
}

// Daily creation counts behind the trend panel. `/stats` and the CSV export
// both read this, so the chart and the download can never disagree.
async function loadTrendRows(days: number): Promise<RowDataPacket[]> {
  const windowDays = days - 1;
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT 'users' AS series, DATE_FORMAT(created_at, '%Y-%m-%d') AS bucket_day, COUNT(*) AS total
       FROM users WHERE created_at >= CURDATE() - INTERVAL ? DAY GROUP BY bucket_day
     UNION ALL
     SELECT 'messages', DATE_FORMAT(created_at, '%Y-%m-%d'), COUNT(*)
       FROM messages WHERE created_at >= CURDATE() - INTERVAL ? DAY GROUP BY 2
     UNION ALL
     SELECT 'rooms', DATE_FORMAT(created_at, '%Y-%m-%d'), COUNT(*)
       FROM rooms WHERE created_at >= CURDATE() - INTERVAL ? DAY GROUP BY 2
     UNION ALL
     SELECT 'bots', DATE_FORMAT(created_at, '%Y-%m-%d'), COUNT(*)
       FROM bots WHERE created_at >= CURDATE() - INTERVAL ? DAY GROUP BY 2`,
    [windowDays, windowDays, windowDays, windowDays],
  );
  return rows;
}

/**
 * New rows in the window immediately before the trend window: same tables and
 * same `created_at` definition as `loadTrendRows`, over
 * `[CURDATE()-(2*days-1), CURDATE()-(days-1))`. The upper bound is exclusive so
 * the oldest trend bucket is counted by the current window only.
 */
async function loadPreviousCounts(days: number): Promise<AdminPreviousCounts> {
  const fromDays = 2 * days - 1;
  const toDays = days - 1;
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       (SELECT COUNT(*) FROM users
         WHERE created_at >= CURDATE() - INTERVAL ? DAY
           AND created_at < CURDATE() - INTERVAL ? DAY) AS users_previous,
       (SELECT COUNT(*) FROM messages
         WHERE created_at >= CURDATE() - INTERVAL ? DAY
           AND created_at < CURDATE() - INTERVAL ? DAY) AS messages_previous,
       (SELECT COUNT(*) FROM rooms
         WHERE created_at >= CURDATE() - INTERVAL ? DAY
           AND created_at < CURDATE() - INTERVAL ? DAY) AS rooms_previous,
       (SELECT COUNT(*) FROM bots
         WHERE created_at >= CURDATE() - INTERVAL ? DAY
           AND created_at < CURDATE() - INTERVAL ? DAY) AS bots_previous`,
    [fromDays, toDays, fromDays, toDays, fromDays, toDays, fromDays, toDays],
  );
  const row = rows[0] ?? {};
  return {
    users: Number(row.users_previous ?? 0),
    messages: Number(row.messages_previous ?? 0),
    rooms: Number(row.rooms_previous ?? 0),
    bots: Number(row.bots_previous ?? 0),
  };
}

/**
 * Zero-fills the window ending on `today`: one ascending entry per day, quiet
 * days included. Rows outside the window are ignored rather than folded into
 * the first bucket.
 */
function buildTrend(
  today: string,
  days: number,
  rows: RowDataPacket[],
): AdminTrendPoint[] {
  const buckets = new Map<string, Map<TrendSeries, number>>();
  for (const bucket of rows) {
    const day = String(bucket.bucket_day ?? '');
    const series = String(bucket.series ?? '') as TrendSeries;
    if (!TREND_SERIES.includes(series)) {
      continue;
    }
    const counts = buckets.get(day) ?? new Map<TrendSeries, number>();
    counts.set(series, Number(bucket.total ?? 0));
    buckets.set(day, counts);
  }
  return trendDates(today, days).map((date) => {
    const counts = buckets.get(date);
    return {
      date,
      users: counts?.get('users') ?? 0,
      messages: counts?.get('messages') ?? 0,
      rooms: counts?.get('rooms') ?? 0,
      bots: counts?.get('bots') ?? 0,
    };
  });
}

const STATS_CSV_HEADER = 'date,users,messages,rooms,bots';

/** One CSV line for a trend point. Dates and counts are always safe cells. */
function statsCsvLine(point: AdminTrendPoint): string {
  return [
    csvCell(point.date),
    csvCell(point.users),
    csvCell(point.messages),
    csvCell(point.rooms),
    csvCell(point.bots),
  ].join(',');
}

export interface AdminUserRoom {
  id: number;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'bot';
  joinedAt: string;
  memberCount: number;
}

export interface AdminRoom {
  id: number;
  name: string;
  ownerId: number;
  ownerName: string;
  isPublic: boolean;
  memberCount: number;
  messageCount: number;
  createdAt: string;
}

export interface AdminRoomDetail extends AdminRoom {
  topic: string;
  announcement: string;
  retentionDays: number;
  slowModeSeconds: number;
}

/** Rows carried by the one-shot audit export; the log itself is unbounded. */
const AUDIT_EXPORT_LIMIT = 5000;
/** Rows fetched per keyset page by the full (streaming) export. */
const AUDIT_EXPORT_ALL_BATCH = 1000;
const AUDIT_CSV_HEADER =
  'id,createdAt,actorName,action,targetType,targetId,detail';

// RFC 4180 quoting plus spreadsheet formula neutralization: Excel/Sheets
// execute cells starting with = + - @ (or a tab/CR) even when quoted, so
// prepend an apostrophe before quoting. actorName and detail are user data.
function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const raw = String(value);
  const text = /^\s*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// `detail` is stored as JSON text (TEXT column); normalize it to one compact
// JSON string so embedded commas/quotes/newlines never leak into the row shape.
function auditDetailCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  if (typeof text !== 'string') {
    return JSON.stringify(text) ?? '';
  }
  try {
    const detail = JSON.parse(text);
    return detail === null ? '' : JSON.stringify(detail) ?? text;
  } catch {
    // Hand-edited or legacy rows may hold non-JSON text; keep it verbatim.
    return text;
  }
}

/** One CSV line for an audit row selected by either export route. */
function auditCsvLine(row: RowDataPacket): string {
  return [
    csvCell(row.id),
    csvCell(toIso(row.created_at)),
    csvCell(row.actor_name == null ? '' : String(row.actor_name)),
    csvCell(row.action),
    csvCell(row.target_type),
    csvCell(row.target_id == null ? '' : row.target_id),
    csvCell(auditDetailCell(row.detail)),
  ].join(',');
}

const REPORTS_CSV_HEADER =
  'id,createdAt,roomName,senderName,messageContent,reporterName,reason,status,resolvedBy,resolvedAt';

/**
 * One CSV line for a report. Room, people, message and reason are user data,
 * so every cell goes through `csvCell`; `resolvedBy` is the resolver's user id
 * (blank until handled), matching the API's ReportDTO field.
 */
function reportCsvLine(report: ReportDTO): string {
  return [
    csvCell(report.id),
    csvCell(report.createdAt),
    csvCell(report.roomName),
    csvCell(report.senderName),
    csvCell(report.messageContent),
    csvCell(report.reporterName),
    csvCell(report.reason),
    csvCell(report.status),
    csvCell(report.resolvedBy),
    csvCell(report.resolvedAt),
  ].join(',');
}

const USERS_CSV_HEADER =
  'id,username,displayName,type,role,status,statusEmoji,statusText,createdAt';
const ROOMS_CSV_HEADER =
  'id,name,ownerId,ownerName,isPublic,memberCount,messageCount,retentionDays,createdAt';
/** Rows carried by either one-shot admin user/room export. */
const ADMIN_DATA_EXPORT_LIMIT = 5000;

/** One CSV line for an admin user row; names and statuses are user data. */
function userCsvLine(user: AdminUser): string {
  return [
    csvCell(user.id),
    csvCell(user.username),
    csvCell(user.displayName),
    csvCell(user.type),
    csvCell(user.role),
    csvCell(user.status),
    csvCell(user.statusEmoji),
    csvCell(user.statusText),
    csvCell(user.createdAt),
  ].join(',');
}

/**
 * One CSV line for an admin room row. Room and owner names are user data;
 * `isPublic` keeps the JSON DTO's boolean form instead of the raw 0/1 column.
 */
function roomCsvLine(row: RowDataPacket): string {
  return [
    csvCell(row.id),
    csvCell(row.name),
    csvCell(row.owner_id),
    csvCell(row.owner_name == null ? '' : String(row.owner_name)),
    csvCell(Number(row.is_public) === 1),
    csvCell(row.member_count ?? 0),
    csvCell(row.message_count ?? 0),
    csvCell(row.retention_days ?? 0),
    csvCell(toIso(row.created_at)),
  ].join(',');
}

/**
 * Writes one CSV chunk and resolves `false` when the client went away. Waiting
 * for `drain` keeps a slow download from buffering the whole export in memory.
 */
function writeCsvChunk(res: Response, chunk: string): Promise<boolean> {
  if (res.destroyed || res.writableEnded) {
    return Promise.resolve(false);
  }
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const settle = (ok: boolean): void => {
    res.off('drain', onDrain);
    res.off('close', onClose);
    resolve(ok);
  };
  const onDrain = (): void => settle(true);
  const onClose = (): void => settle(false);
  res.once('drain', onDrain);
  res.once('close', onClose);
  try {
    if (res.write(chunk)) {
      settle(true);
    }
  } catch {
    settle(false);
  }
  return promise;
}

// Columns shared with the admin list so a single-user response is byte-for-byte
// the same shape as one row of `GET /users`.
const ADMIN_USER_COLUMNS =
  'id, username, display_name, avatar, type, role, status, status_emoji, status_text, created_at';

async function loadAdminUser(userId: number): Promise<AdminUser | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${ADMIN_USER_COLUMNS} FROM users WHERE id = ?`,
    [userId],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    avatar: avatarUrl(Number(row.id), row.avatar ? String(row.avatar) : null),
    type: row.type,
    role: row.role,
    status: row.status,
    statusEmoji: row.status_emoji ? String(row.status_emoji) : null,
    statusText: row.status_text ? String(row.status_text) : null,
    createdAt: toIso(row.created_at),
  };
}

function mapAdminRoom(row: RowDataPacket): AdminRoom {
  return {
    id: Number(row.id),
    name: String(row.name),
    ownerId: Number(row.owner_id),
    ownerName: String(row.owner_name ?? ''),
    isPublic: Number(row.is_public) === 1,
    memberCount: Number(row.member_count ?? 0),
    messageCount: Number(row.message_count ?? 0),
    createdAt: toIso(row.created_at),
  };
}

function mapAdminRoomDetail(row: RowDataPacket): AdminRoomDetail {
  return {
    ...mapAdminRoom(row),
    topic: String(row.topic ?? ''),
    announcement: String(row.announcement ?? ''),
    retentionDays: Number(row.retention_days ?? 0),
    slowModeSeconds: Number(row.slow_mode_seconds ?? 0),
  };
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
    await assertBotCreateRate(currentUser(req).id);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const created = await createBot({
      ...parsed.data,
      actor: currentUser(req),
      scope: 'global',
    } satisfies CreateBotInput);
    await recordAudit({
      actorId: currentUser(req).id,
      action: 'bot.create',
      targetType: 'bot',
      targetId: created.userId,
      detail: { name: created.name, scope: created.scope },
    });
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
    await recordAudit({
      actorId: currentUser(req).id,
      action: 'bot.update',
      targetType: 'bot',
      targetId: updated.userId,
      detail: { fields: Object.keys(parsed.data) },
    });
    res.json({ bot: toBotDto(updated) });
  }),
);

router.delete(
  '/bots/:id',
  asyncHandler(async (req, res) => {
    const botId = parseId(req.params.id, 'bot');
    await disableBot(botId, currentUser(req));
    await recordAudit({
      actorId: currentUser(req).id,
      action: 'bot.delete',
      targetType: 'bot',
      targetId: botId,
    });
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
    const roomId = parseId(req.params.id, 'room');
    await mountBot(roomId, parsed.data.botId, currentUser(req));
    await recordAudit({
      actorId: currentUser(req).id,
      action: 'bot.mount',
      targetType: 'room',
      targetId: roomId,
      detail: { botId: parsed.data.botId },
    });
    res.json({ ok: true });
  }),
);

router.delete(
  '/rooms/:id/bots/:botId',
  asyncHandler(async (req, res) => {
    const roomId = parseId(req.params.id, 'room');
    const botId = parseId(req.params.botId, 'bot');
    await unmountBot(roomId, botId, currentUser(req));
    await recordAudit({
      actorId: currentUser(req).id,
      action: 'bot.unmount',
      targetType: 'room',
      targetId: roomId,
      detail: { botId },
    });
    res.json({ ok: true });
  }),
);

// Shared by the admin room table and its CSV export: both search the room
// name, so the download always contains what the table's filter matches.
function roomSearchScope(q: string | undefined): { where: string; params: unknown[] } {
  const trimmed = q?.trim();
  if (!trimmed) {
    return { where: '', params: [] };
  }
  return {
    where: " WHERE r.name LIKE ? ESCAPE '\\\\'",
    params: [`%${escapeLikePattern(trimmed)}%`],
  };
}

router.get(
  '/rooms',
  asyncHandler(async (req, res) => {
    const parsed = listRoomsSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        parsed.error.issues[0]?.message ?? 'Invalid query',
      );
    }
    const limit = parsed.data.limit ?? 50;
    const offset = parsed.data.offset ?? 0;
    const { where, params } = roomSearchScope(parsed.data.q);

    const [countRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM rooms r${where}`,
      params,
    );
    const total = Number(countRows[0]?.total ?? 0);

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT r.id, r.name, r.owner_id, r.is_public, r.created_at,
              COALESCE(NULLIF(u.display_name, ''), u.username) AS owner_name,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS member_count,
              (SELECT COUNT(*) FROM messages msg WHERE msg.room_id = r.id) AS message_count
         FROM rooms r
         JOIN users u ON u.id = r.owner_id${where}
        ORDER BY r.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    res.json({ rooms: rows.map(mapAdminRoom), total, limit, offset });
  }),
);

// Whole filtered room set as one CSV download: same `q` semantics as the
// table above, newest first, capped at 5000 rows. The extra row fetched past
// the cap answers truncation before the first byte is written.
router.get(
  '/rooms/export',
  asyncHandler(async (req, res) => {
    const parsed = exportDataSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'q must be at most 64 characters');
    }
    const adminId = currentUser(req).id;
    // Ten downloads a minute covers normal use without exposing the
    // count-per-room subqueries to a hammering client.
    if (!(await checkRate(`rooms-export:${adminId}`, 10, 60_000))) {
      throw tooMany('Too many room exports, try again later');
    }

    const { where, params } = roomSearchScope(parsed.data.q);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT r.id, r.name, r.owner_id, r.is_public, r.retention_days, r.created_at,
              COALESCE(NULLIF(u.display_name, ''), u.username) AS owner_name,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS member_count,
              (SELECT COUNT(*) FROM messages msg WHERE msg.room_id = r.id) AS message_count
         FROM rooms r
         JOIN users u ON u.id = r.owner_id${where}
        ORDER BY r.id DESC
        LIMIT ${ADMIN_DATA_EXPORT_LIMIT + 1}`,
      params,
    );
    const truncated = rows.length > ADMIN_DATA_EXPORT_LIMIT;
    const lines = [
      ROOMS_CSV_HEADER,
      ...rows.slice(0, ADMIN_DATA_EXPORT_LIMIT).map(roomCsvLine),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="rooms.csv"');
    res.setHeader('Cache-Control', 'no-store');
    if (truncated) {
      res.setHeader('X-Rooms-Truncated', 'true');
    }
    res.send(`${lines.join('\r\n')}\r\n`);
  }),
);

router.get(
  '/rooms/:id',
  asyncHandler(async (req, res) => {
    const roomId = parseId(req.params.id, 'room');
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT r.id, r.name, r.topic, r.announcement, r.owner_id, r.is_public,
              r.retention_days, r.slow_mode_seconds, r.created_at,
              COALESCE(NULLIF(u.display_name, ''), u.username) AS owner_name,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS member_count,
              (SELECT COUNT(*) FROM messages msg WHERE msg.room_id = r.id) AS message_count
         FROM rooms r
         JOIN users u ON u.id = r.owner_id
        WHERE r.id = ?`,
      [roomId],
    );
    const room = rows[0];
    if (!room) {
      throw notFound('ROOM_NOT_FOUND', 'Room not found');
    }
    res.json({ room: mapAdminRoomDetail(room) });
  }),
);

router.delete(
  '/rooms/:id',
  asyncHandler(async (req, res) => {
    const roomId = parseId(req.params.id, 'room');
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, name, owner_id FROM rooms WHERE id = ?',
      [roomId],
    );
    const room = rows[0];
    if (!room) {
      throw notFound('ROOM_NOT_FOUND', 'Room not found');
    }
    // Attachments cascade with the room (directly and through messages), so
    // their file names must be read before the rows disappear.
    const [attachmentRows] = await pool.query<RowDataPacket[]>(
      'SELECT stored_name FROM message_attachments WHERE room_id = ?',
      [roomId],
    );
    const io = getSocketServer();
    if (io) {
      io.to(roomKey(roomId)).emit('room:revoked', { roomId });
      io.socketsLeave(roomKey(roomId));
    }
    // members / messages / bots / reactions / attachments cascade through
    // their foreign keys.
    await pool.execute<ResultSetHeader>('DELETE FROM rooms WHERE id = ?', [roomId]);
    await removeAttachmentFiles(attachmentRows.map((row) => String(row.stored_name)));
    await recordAudit({
      actorId: currentUser(req).id,
      action: 'room.delete',
      targetType: 'room',
      targetId: roomId,
      detail: { name: room.name, ownerId: Number(room.owner_id) },
    });
    res.json({ ok: true });
  }),
);

// Bulk room deletion: lock and verify every id first, then delete the whole
// batch in one transaction. A single missing id aborts the batch with no
// deletions, keeping the UI's "N selected" action all-or-nothing. Broadcasts,
// audit rows and attachment-file removal run only after the commit. The POST
// method keeps this path distinct from `DELETE /rooms/:id`.
router.post(
  '/rooms/bulk-delete',
  asyncHandler(async (req, res) => {
    const parsed = bulkDeleteRoomsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'ids must contain 1-100 room ids');
    }
    const roomIds = [...new Set(parsed.data.ids)];
    const actorId = currentUser(req).id;
    const placeholders = roomIds.map(() => '?').join(',');

    const deleted = await withTransaction(async (conn) => {
      const [roomRows] = await conn.query<RowDataPacket[]>(
        `SELECT id, name, owner_id FROM rooms WHERE id IN (${placeholders}) FOR UPDATE`,
        roomIds,
      );
      if (roomRows.length !== roomIds.length) {
        throw notFound('ROOM_NOT_FOUND', 'One or more rooms do not exist');
      }
      const [attachmentRows] = await conn.query<RowDataPacket[]>(
        `SELECT stored_name FROM message_attachments WHERE room_id IN (${placeholders})`,
        roomIds,
      );
      await conn.query(`DELETE FROM rooms WHERE id IN (${placeholders})`, roomIds);
      return {
        rooms: roomRows.map((row) => ({
          id: Number(row.id),
          name: String(row.name),
          ownerId: Number(row.owner_id),
        })),
        storedNames: attachmentRows.map((row) => String(row.stored_name)),
      };
    });

    const io = getSocketServer();
    if (io) {
      for (const room of deleted.rooms) {
        io.to(roomKey(room.id)).emit('room:revoked', { roomId: room.id });
        io.socketsLeave(roomKey(room.id));
      }
    }
    await removeAttachmentFiles(deleted.storedNames);
    // After the commit: an audit entry must never describe a rolled-back write.
    for (const room of deleted.rooms) {
      await recordAudit({
        actorId,
        action: 'room.delete',
        targetType: 'room',
        targetId: room.id,
        detail: { name: room.name, ownerId: room.ownerId, bulk: true },
      });
    }

    res.json({ deleted: deleted.rooms.length });
  }),
);

router.get(
  '/announcements',
  asyncHandler(async (_req, res) => {
    res.json({ announcements: await listAnnouncements() });
  }),
);

router.post(
  '/announcements',
  asyncHandler(async (req, res) => {
    const parsed = announcementSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        `body must be 1-${ANNOUNCEMENT_BODY_MAX} characters`,
      );
    }
    const announcement = await createAnnouncement(currentUser(req).id, parsed.data.body);
    await recordAudit({
      actorId: currentUser(req).id,
      action: 'announcement.create',
      targetType: 'announcement',
      targetId: announcement.id,
      detail: { body: announcement.body },
    });
    res.status(201).json({ announcement });
  }),
);

router.patch(
  '/announcements/:id',
  asyncHandler(async (req, res) => {
    const announcementId = parseId(req.params.id, 'announcement');
    const parsed = announcementSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        `body must be 1-${ANNOUNCEMENT_BODY_MAX} characters`,
      );
    }
    const announcement = await updateAnnouncement(announcementId, parsed.data.body);
    if (!announcement) {
      throw notFound('ANNOUNCEMENT_NOT_FOUND', 'Announcement not found');
    }
    await recordAudit({
      actorId: currentUser(req).id,
      action: 'announcement.update',
      targetType: 'announcement',
      targetId: announcementId,
      detail: { body: announcement.body },
    });
    res.json({ announcement });
  }),
);

router.delete(
  '/announcements/:id',
  asyncHandler(async (req, res) => {
    const announcementId = parseId(req.params.id, 'announcement');
    const found = await deactivateAnnouncement(announcementId);
    if (!found) {
      throw notFound('ANNOUNCEMENT_NOT_FOUND', 'Announcement not found');
    }
    await recordAudit({
      actorId: currentUser(req).id,
      action: 'announcement.delete',
      targetType: 'announcement',
      targetId: announcementId,
    });
    res.json({ ok: true });
  }),
);

// Message-report queue. `status` defaults to the open queue; `all` also shows
// handled rows. Rows are joined with message/room/reporter/sender so the admin
// list needs no follow-up requests.
router.get(
  '/reports',
  asyncHandler(async (req, res) => {
    const parsed = listReportsSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        parsed.error.issues[0]?.message ?? 'Invalid query',
      );
    }
    const limit = parsed.data.limit ?? REPORT_LIST_LIMIT;
    const offset = parsed.data.offset ?? 0;
    const result = await listReports({
      status: parsed.data.status ?? 'open',
      limit,
      offset,
    });
    res.json({ ...result, limit, offset });
  }),
);

// Whole filtered report set as one CSV download. `open` (the queue default)
// exports exactly what the table shows; `all` includes handled history. The
// query fetches one row past the 5000-row cap so truncation can be reported
// before the first byte, and the export is rate-limited like the stats one.
router.get(
  '/reports/export',
  asyncHandler(async (req, res) => {
    const parsed = exportReportsSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', "status must be 'open' or 'all'");
    }
    const status = parsed.data.status;
    const adminId = currentUser(req).id;
    if (!(await checkRate(`reports-export:${adminId}`, 10, 60_000))) {
      throw tooMany('Too many report exports, try again later');
    }

    const { reports, truncated } = await listReportsForExport(status);
    const lines = [REPORTS_CSV_HEADER, ...reports.map(reportCsvLine)];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="reports-${status}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    if (truncated) {
      res.setHeader('X-Report-Truncated', 'true');
    }
    // RFC 4180 records end in CRLF; the trailing one terminates the last row.
    res.send(`${lines.join('\r\n')}\r\n`);
  }),
);

// Bulk report handling: lock and verify every id first, then write the whole
// batch inside one transaction. A single missing id aborts the batch with no
// updates, keeping the UI's "N selected" action all-or-nothing. Already
// handled rows are re-classified in place, like PATCH /reports/:id.
// Registered before `/reports/:id`, which would otherwise parse `bulk` as an id.
router.patch(
  '/reports/bulk',
  asyncHandler(async (req, res) => {
    const parsed = bulkReportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        'ids must contain 1-200 ids and status must be resolved or dismissed',
      );
    }
    const reportIds = [...new Set(parsed.data.ids)];
    const status = parsed.data.status;
    const actorId = currentUser(req).id;
    const placeholders = reportIds.map(() => '?').join(',');

    await withTransaction(async (conn) => {
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT id FROM message_reports WHERE id IN (${placeholders}) FOR UPDATE`,
        reportIds,
      );
      if (rows.length !== reportIds.length) {
        throw notFound('REPORT_NOT_FOUND', 'One or more reports do not exist');
      }
      await conn.query(
        `UPDATE message_reports
            SET status = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP(3)
          WHERE id IN (${placeholders})`,
        [status, actorId, ...reportIds],
      );
    });

    // After the commit: an audit entry must never describe a rolled-back write.
    for (const reportId of reportIds) {
      await recordAudit({
        actorId,
        action: 'report.resolve',
        targetType: 'report',
        targetId: reportId,
        detail: { status, bulk: true },
      });
    }

    res.json({ updated: reportIds.length });
  }),
);

// Handles a report: `resolved` (action taken) or `dismissed` (no action).
// Re-handling an already handled row overwrites the resolver and timestamp;
// the audit log keeps every change.
router.patch(
  '/reports/:id',
  asyncHandler(async (req, res) => {
    const reportId = parseId(req.params.id, 'report');
    const parsed = resolveReportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', "status must be 'resolved' or 'dismissed'");
    }
    const report = await resolveReport(reportId, parsed.data.status, currentUser(req).id);
    if (!report) {
      throw notFound('REPORT_NOT_FOUND', 'Report not found');
    }
    await recordAudit({
      actorId: currentUser(req).id,
      action: 'report.resolve',
      targetType: 'report',
      targetId: reportId,
      detail: { status: parsed.data.status },
    });
    res.json({ report });
  }),
);

router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const parsed = listUsersSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        parsed.error.issues[0]?.message ?? 'Invalid query',
      );
    }
    const limit = parsed.data.limit ?? 50;
    const offset = parsed.data.offset ?? 0;
    const result = await listUsers({ q: parsed.data.q, limit, offset });
    res.json({ ...result, limit, offset });
  }),
);

// Whole filtered user set as one CSV download. `listUsersForExport` reuses the
// table's search scope, and truncation is known before the body is written.
// Registered before `/users/:id`, which would otherwise parse `export` as an id.
router.get(
  '/users/export',
  asyncHandler(async (req, res) => {
    const parsed = exportDataSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'q must be at most 64 characters');
    }
    const adminId = currentUser(req).id;
    if (!(await checkRate(`users-export:${adminId}`, 10, 60_000))) {
      throw tooMany('Too many user exports, try again later');
    }

    const { users, truncated } = await listUsersForExport(parsed.data.q);
    const lines = [USERS_CSV_HEADER, ...users.map(userCsvLine)];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
    res.setHeader('Cache-Control', 'no-store');
    if (truncated) {
      res.setHeader('X-Users-Truncated', 'true');
    }
    res.send(`${lines.join('\r\n')}\r\n`);
  }),
);

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const parsed = statsSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        parsed.error.issues[0]?.message ?? 'days must be an integer between 7 and 30',
      );
    }
    const days = parsed.data.days;

    // Three round trips in parallel: totals, the per-day buckets the trend
    // panel renders, and the equally long window before it for the comparison.
    // `CURDATE()` comes back with the totals so the zero-filled date axis uses
    // the same clock as the SQL day boundaries.
    const [[summaryRows], trendRows, previous] = await Promise.all([
      pool.query<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM users) AS users_total,
           (SELECT COUNT(*) FROM users WHERE status = 'active') AS users_active,
           (SELECT COUNT(*) FROM users WHERE status = 'banned') AS users_banned,
           (SELECT COUNT(*) FROM users WHERE role = 'admin') AS users_admins,
           (SELECT COUNT(*) FROM rooms) AS rooms_total,
           (SELECT COUNT(*) FROM rooms WHERE is_public = 1) AS rooms_public,
           (SELECT COUNT(*) FROM rooms WHERE is_public = 0) AS rooms_private,
           (SELECT COUNT(*) FROM messages) AS messages_total,
           (SELECT COUNT(*) FROM messages WHERE deleted_at IS NOT NULL) AS messages_deleted,
           (SELECT COUNT(*) FROM bots) AS bots_total,
           (SELECT COUNT(*) FROM bots WHERE enabled = 1) AS bots_enabled,
           (SELECT COUNT(*) FROM message_reports) AS reports_total,
           (SELECT COUNT(*) FROM message_reports WHERE status = 'open') AS reports_open,
           (SELECT COUNT(*) FROM message_reports WHERE status = 'resolved') AS reports_resolved,
           (SELECT COUNT(*) FROM message_reports WHERE status = 'dismissed') AS reports_dismissed,
           DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today`,
      ),
      loadTrendRows(days),
      loadPreviousCounts(days),
    ]);

    const row = summaryRows[0] ?? {};

    const stats: AdminStats = {
      users: {
        total: Number(row.users_total ?? 0),
        active: Number(row.users_active ?? 0),
        banned: Number(row.users_banned ?? 0),
        admins: Number(row.users_admins ?? 0),
      },
      rooms: {
        total: Number(row.rooms_total ?? 0),
        public: Number(row.rooms_public ?? 0),
        private: Number(row.rooms_private ?? 0),
      },
      messages: {
        total: Number(row.messages_total ?? 0),
        deleted: Number(row.messages_deleted ?? 0),
      },
      bots: {
        total: Number(row.bots_total ?? 0),
        enabled: Number(row.bots_enabled ?? 0),
      },
      reports: {
        open: Number(row.reports_open ?? 0),
        resolved: Number(row.reports_resolved ?? 0),
        dismissed: Number(row.reports_dismissed ?? 0),
        total: Number(row.reports_total ?? 0),
      },
      // Ascending, one entry per day in the window; quiet days stay at zero.
      trend: buildTrend(String(row.today ?? ''), days, trendRows),
      // Same series over the equally long window just before it, for the
      // trend panel's period-over-period comparison.
      previous,
    };
    res.json(stats);
  }),
);

// Daily-creation CSV behind the overview trend panel. Same `days` window,
// same SQL and same zero-filling as `/stats`, so the download matches the
// chart; only the encoding differs.
router.get(
  '/stats/export',
  asyncHandler(async (req, res) => {
    const parsed = statsSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        parsed.error.issues[0]?.message ?? 'days must be an integer between 7 and 30',
      );
    }
    const days = parsed.data.days;
    const adminId = currentUser(req).id;
    // One click per refresh is the normal pace; ten a minute leaves room for
    // retries without letting an admin hammer the aggregate queries.
    if (!(await checkRate(`stats-export:${adminId}`, 10, 60_000))) {
      throw tooMany('Too many stats exports, try again later');
    }

    // `CURDATE()` is read beside the buckets so the date axis uses the same
    // database clock as the day boundaries.
    const [[todayRows], trendRows] = await Promise.all([
      pool.query<RowDataPacket[]>(
        "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today",
      ),
      loadTrendRows(days),
    ]);
    const trend = buildTrend(String(todayRows[0]?.today ?? ''), days, trendRows);

    const lines = [STATS_CSV_HEADER, ...trend.map(statsCsvLine)];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="admin-trend-${days}d.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.send(`${lines.join('\n')}\n`);
  }),
);

router.get(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const userId = parseId(req.params.id, 'user');
    const user = await loadAdminUser(userId);
    if (!user) {
      throw notFound('USER_NOT_FOUND', 'User not found');
    }

    const [statRows] = await pool.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM room_members WHERE user_id = ?) AS rooms,
         (SELECT COUNT(*) FROM messages WHERE sender_id = ?) AS messages,
         (SELECT COUNT(*) FROM bots WHERE owner_user_id = ?) AS bots`,
      [userId, userId, userId],
    );
    const statRow = statRows[0] ?? {};

    const [roomRows] = await pool.query<RowDataPacket[]>(
      `SELECT rm.room_id, r.name, rm.role, rm.joined_at,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS member_count
         FROM room_members rm
         JOIN rooms r ON r.id = rm.room_id
        WHERE rm.user_id = ?
        ORDER BY rm.joined_at DESC, rm.room_id DESC
        LIMIT 50`,
      [userId],
    );
    const rooms: AdminUserRoom[] = roomRows.map((room) => ({
      id: Number(room.room_id),
      name: String(room.name),
      role: room.role as AdminUserRoom['role'],
      joinedAt: toIso(room.joined_at),
      memberCount: Number(room.member_count ?? 0),
    }));

    res.json({
      user,
      stats: {
        rooms: Number(statRow.rooms ?? 0),
        messages: Number(statRow.messages ?? 0),
        bots: Number(statRow.bots ?? 0),
      },
      rooms,
    });
  }),
);

// Bulk status change: validate every target first, reject the whole batch on
// the first violation, then apply every update in one transaction. This keeps
// the UI's "selected N users" promise all-or-nothing instead of leaving a
// half-banned page behind.
router.patch(
  '/users/bulk-status',
  asyncHandler(async (req, res) => {
    const parsed = bulkStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        'userIds must contain 1-100 ids and status must be active or banned',
      );
    }
    const userIds = [...new Set(parsed.data.userIds)];
    const nextStatus = parsed.data.status;
    const actorId = currentUser(req).id;
    const placeholders = userIds.map(() => '?').join(',');
    const changed: { id: number; from: string }[] = [];

    await withTransaction(async (conn) => {
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT id, type, role, status
           FROM users
          WHERE id IN (${placeholders})
          FOR UPDATE`,
        userIds,
      );
      if (rows.length !== userIds.length) {
        throw notFound('USER_NOT_FOUND', 'One or more users do not exist');
      }
      if (rows.some((row) => row.type === 'bot')) {
        throw badRequest(
          'BOT_STATUS_UNSUPPORTED',
          'Bot accounts cannot be banned through this endpoint',
        );
      }
      // Counted before the self check, like PATCH /users/:id/status, so a sole
      // admin selecting themselves still learns that the batch empties the
      // admin pool instead of a generic self-ban error. Banning all active
      // admins is the only selection that can drop the platform to zero.
      if (nextStatus === 'banned') {
        const [adminRows] = await conn.query<RowDataPacket[]>(
          "SELECT id FROM users WHERE role = 'admin' AND status = 'active' FOR UPDATE",
        );
        const selected = new Set(userIds);
        const remaining = adminRows.filter((row) => !selected.has(Number(row.id)));
        if (remaining.length === 0) {
          throw badRequest('LAST_ADMIN', 'Cannot ban the last active admin');
        }
      }
      if (userIds.includes(actorId)) {
        throw badRequest('CANNOT_BAN_SELF', 'Cannot change your own status');
      }

      const updates = rows.filter((row) => row.status !== nextStatus);
      if (updates.length > 0) {
        const changedIds = updates.map((row) => Number(row.id));
        // Banning revokes sessions: every row here really transitions into
        // `banned`, so each bumps its token version in the same statement that
        // changes the status. Unbanning keeps the already-bumped version.
        await conn.query(
          `UPDATE users
              SET token_version = token_version + ?,
                  status = ?
            WHERE id IN (${changedIds.map(() => '?').join(',')})`,
          [nextStatus === 'banned' ? 1 : 0, nextStatus, ...changedIds],
        );
        changed.push(
          ...updates.map((row) => ({ id: Number(row.id), from: String(row.status) })),
        );
      }

      if (nextStatus === 'banned') {
        // Banning withdraws the owner from every room they had a bot in, so
        // those room bots must stop reading and speaking immediately. Already
        // banned rows are cleaned too, making the batch idempotent.
        for (const id of userIds) {
          await disableRoomBotsOwnedBy(id, undefined, conn);
          // A ban wins over every queued message, in every room.
          await cancelPendingScheduledMessages(id, undefined, conn);
        }
      }
    });

    if (nextStatus === 'banned') {
      bumpBotCache();
    }

    // The ban is committed; kill the sessions it just revoked before any
    // best-effort follow-up work can fail. Only rows that actually changed are
    // in `changed`, which is exactly whose version moved.
    if (nextStatus === 'banned') {
      for (const entry of changed) {
        await disconnectUserSockets(entry.id, 'banned');
      }
    }

    // Written after the commit so an audit entry can never describe a rollback.
    for (const entry of changed) {
      await recordAudit({
        actorId,
        action: 'user.status',
        targetType: 'user',
        targetId: entry.id,
        detail: { from: entry.from, to: nextStatus, bulk: true },
      });
    }

    res.json({
      updated: changed.length,
      unchanged: userIds.length - changed.length,
    });
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
    const nextStatus = parsed.data.status;
    const actorId = currentUser(req).id;

    // The read, the last-admin check and the write share one serialized
    // transaction, so a concurrent ban/demotion cannot invalidate the count
    // between the check and the update.
    const target = await withAdminGuard(async (conn) => {
      const [targetRows] = await conn.query<RowDataPacket[]>(
        'SELECT type, role, status FROM users WHERE id = ? FOR UPDATE',
        [userId],
      );
      const row = targetRows[0];
      if (!row) {
        throw notFound('USER_NOT_FOUND', 'User not found');
      }
      if (row.type === 'bot') {
        throw badRequest(
          'BOT_STATUS_UNSUPPORTED',
          'Bot accounts cannot be banned through this endpoint',
        );
      }
      if (nextStatus === 'banned' && row.role === 'admin' && row.status === 'active') {
        // `FOR UPDATE` locks every active admin row, so a concurrent mutation
        // waits and then counts the committed state instead of its own copy.
        const [adminRows] = await conn.query<RowDataPacket[]>(
          "SELECT id FROM users WHERE role = 'admin' AND status = 'active' FOR UPDATE",
        );
        if (adminRows.length <= 1) {
          throw badRequest('LAST_ADMIN', 'Cannot ban the last active admin');
        }
      }
      if (userId === actorId) {
        throw badRequest('CANNOT_BAN_SELF', 'Cannot change your own status');
      }
      await conn.execute<ResultSetHeader>(
        `UPDATE users
            SET token_version = token_version + IF(status <> 'banned' AND ? = 'banned', 1, 0),
                status = ?
          WHERE id = ?`,
        [nextStatus, nextStatus, userId],
      );
      if (nextStatus === 'banned') {
        // A banned owner loses every room bot they own, not just the ones in
        // rooms they happen to be present in right now.
        await disableRoomBotsOwnedBy(userId, undefined, conn);
        // Every queued message is withdrawn with the account.
        await cancelPendingScheduledMessages(userId, undefined, conn);
      }
      return row;
    });

    if (nextStatus === 'banned') {
      bumpBotCache();
    }
    // The status change is committed; a session that was open before the ban
    // must lose its socket even though its handshake already succeeded. Done
    // before the audit write so a failed audit cannot keep it alive.
    if (nextStatus === 'banned') {
      await disconnectUserSockets(userId, 'banned');
    }
    await recordAudit({
      actorId,
      action: 'user.status',
      targetType: 'user',
      targetId: userId,
      detail: { from: String(target.status), to: nextStatus },
    });
    res.json({ ok: true });
  }),
);

router.patch(
  '/users/:id/role',
  asyncHandler(async (req, res) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'role must be admin or user');
    }
    const userId = parseId(req.params.id, 'user');
    const nextRole: 'admin' | 'user' = parsed.data.role;
    const actorId = currentUser(req).id;

    const target = await withAdminGuard(async (conn) => {
      const [targetRows] = await conn.query<RowDataPacket[]>(
        'SELECT type, role, status FROM users WHERE id = ? FOR UPDATE',
        [userId],
      );
      const row = targetRows[0];
      if (!row) {
        throw notFound('USER_NOT_FOUND', 'User not found');
      }
      if (row.type === 'bot') {
        throw badRequest('INVALID_TARGET', 'Bot accounts cannot hold a user role');
      }
      // Only demoting an active admin can empty the admin pool; banning an
      // admin is guarded the same way in PATCH /users/:id/status, and the guard
      // runs before the self check there too, so the sole admin sees the real
      // reason. Locking every active admin row makes a concurrent demotion wait
      // and then count the committed state.
      if (nextRole === 'user' && row.role === 'admin' && row.status === 'active') {
        const [adminRows] = await conn.query<RowDataPacket[]>(
          "SELECT id FROM users WHERE role = 'admin' AND status = 'active' FOR UPDATE",
        );
        if (adminRows.length <= 1) {
          throw badRequest('LAST_ADMIN', 'Cannot demote the last active admin');
        }
      }
      if (userId === actorId) {
        throw badRequest('CANNOT_CHANGE_SELF_ROLE', 'Cannot change your own role');
      }
      await conn.execute<ResultSetHeader>('UPDATE users SET role = ? WHERE id = ?', [
        nextRole,
        userId,
      ]);
      return row;
    });
    await recordAudit({
      actorId,
      action: 'user.role',
      targetType: 'user',
      targetId: userId,
      detail: { from: String(target.role), to: nextRole },
    });
    const user = await loadAdminUser(userId);
    if (!user) {
      throw notFound('USER_NOT_FOUND', 'User not found');
    }
    res.json({ user });
  }),
);

router.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const parsed = listAuditSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        parsed.error.issues[0]?.message ?? 'Invalid query',
      );
    }
    const limit = parsed.data.limit ?? 50;
    const offset = parsed.data.offset ?? 0;
    const result = await listAudit({
      action: parsed.data.action,
      actor: parsed.data.actor,
      from: parsed.data.from,
      to: parsed.data.to,
      limit,
      offset,
    });
    res.json({ ...result, limit, offset });
  }),
);

router.get(
  '/audit/export',
  asyncHandler(async (req, res) => {
    const parsed = exportAuditSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        parsed.error.issues[0]?.message ?? 'Invalid audit filter',
      );
    }
    const { where, params } = buildAuditScope(parsed.data);

    // Newest first, hard-capped: the CSV is a one-shot download, not a paging
    // API, so the cap keeps one click from streaming an unbounded table.
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT a.id, u.display_name AS actor_name, a.action, a.target_type,
              a.target_id, a.detail, a.created_at
         FROM admin_audit_log a
         LEFT JOIN users u ON u.id = a.actor_id
         ${where}
         ORDER BY a.id DESC
         LIMIT ${AUDIT_EXPORT_LIMIT}`,
      params,
    );

    const lines = [
      AUDIT_CSV_HEADER,
      ...rows.map(auditCsvLine),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-export.csv"');
    if (rows.length === AUDIT_EXPORT_LIMIT) {
      res.setHeader('X-Audit-Truncated', 'true');
    }
    res.send(`${lines.join('\n')}\n`);
  }),
);

router.get(
  '/audit/export-all',
  asyncHandler(async (req, res) => {
    const parsed = exportAuditSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        parsed.error.issues[0]?.message ?? 'Invalid audit filter',
      );
    }
    const adminId = currentUser(req).id;
    // A full export can walk the entire log, so one download per admin per
    // five minutes is enough.
    if (!(await checkRate(`audit-export-all:${adminId}`, 1, 5 * 60_000))) {
      throw tooMany('Too many audit exports, try again later');
    }

    const maxRows = config.auditExportAllMax;
    const { where, params, joinsActor } = buildAuditScope(parsed.data);

    // Truncation is a response header, so it must be known before the first
    // byte. Counting stops at maxRows + 1, which bounds the probe even when
    // the filter matches the whole log. The actor join is only needed when the
    // filter reads `users`.
    const countJoin = joinsActor ? ' LEFT JOIN users u ON u.id = a.actor_id' : '';
    const [countRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM (
         SELECT a.id
           FROM admin_audit_log a${countJoin}
           ${where}
          LIMIT ${maxRows + 1}
       ) AS capped`,
      params,
    );
    const truncated = Number(countRows[0]?.total ?? 0) > maxRows;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="audit-export-all.csv"',
    );
    res.setHeader('Cache-Control', 'no-store');
    if (truncated) {
      res.setHeader('X-Audit-Truncated', 'true');
    }

    let disconnected = false;
    res.on('close', () => {
      disconnected = true;
    });
    // A client that disappears mid-chunk can surface EPIPE on the response;
    // without a listener that error would be unhandled.
    res.on('error', () => {
      disconnected = true;
    });

    // Keyset paging on `id DESC`: every batch is independent of the ones
    // before it, so a row inserted during the download never shifts the
    // cursor and no offset scan grows with the export.
    let cursor: number | null = null;
    let written = 0;
    try {
      let open = await writeCsvChunk(res, `${AUDIT_CSV_HEADER}\n`);
      while (open && written < maxRows) {
        const limit = Math.min(AUDIT_EXPORT_ALL_BATCH, maxRows - written);
        const batchWhere: string =
          cursor === null
            ? where
            : where
              ? `${where} AND a.id < ?`
              : ' WHERE a.id < ?';
        const batchParams: unknown[] = cursor === null ? params : [...params, cursor];
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT a.id, u.display_name AS actor_name, a.action, a.target_type,
                  a.target_id, a.detail, a.created_at
             FROM admin_audit_log a
             LEFT JOIN users u ON u.id = a.actor_id
             ${batchWhere}
             ORDER BY a.id DESC
             LIMIT ${limit}`,
          batchParams,
        );
        if (rows.length === 0) {
          break;
        }
        open = await writeCsvChunk(res, `${rows.map(auditCsvLine).join('\n')}\n`);
        written += rows.length;
        cursor = Number(rows[rows.length - 1].id);
        if (rows.length < limit) {
          break;
        }
      }
    } catch (error) {
      // Headers are already on the wire, so a JSON error cannot follow. Log it
      // and drop the connection; the client sees an incomplete download.
      logger.warn({ err: error, adminId }, 'audit export-all aborted mid-stream');
      res.destroy();
      return;
    }

    if (!disconnected && !res.destroyed && !res.writableEnded) {
      res.end();
    }
  }),
);

export default router;
