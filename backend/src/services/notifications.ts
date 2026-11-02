import type { Server } from 'socket.io';
import { pool, withTransaction, type ResultSetHeader, type RowDataPacket } from '../db';
import { logger } from '../logger';
import type { NotificationDTO } from '../types';
import { toIso } from '../utils';
import { getSocketServer } from '../socket/broadcast';

/** Usernames are `[a-zA-Z0-9_]{3,32}`; a mention is an `@` immediately followed by one. */
const MENTION_PATTERN = /@([a-zA-Z0-9_]{3,32})/g;

export const NOTIFICATION_CONTENT_LIMIT = 140;
export const DELETED_MESSAGE_TEXT = '消息已撤回';

export interface MentionActor {
  id: number;
  name: string;
}

export interface MentionMessage {
  id: number;
  seq: number;
  content: string;
}

/** Socket.IO room holding every live socket of one user, used for push. */
export function userRoom(userId: number): string {
  return `user:${userId}`;
}

/** Extracts distinct usernames mentioned in `content`, in first-seen order. */
export function extractMentions(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(MENTION_PATTERN)) {
    found.add(match[1]);
  }
  return [...found];
}

/** Clips to `NOTIFICATION_CONTENT_LIMIT` characters without splitting a surrogate pair. */
export function truncateContent(content: string): string {
  const chars = Array.from(content);
  if (chars.length <= NOTIFICATION_CONTENT_LIMIT) {
    return content;
  }
  return `${chars.slice(0, NOTIFICATION_CONTENT_LIMIT - 1).join('')}…`;
}

function previewContent(content: string, deletedAt: unknown): string {
  if (deletedAt != null) {
    return DELETED_MESSAGE_TEXT;
  }
  return truncateContent(String(content ?? ''));
}

function mapNotification(row: RowDataPacket): NotificationDTO {
  const hasMessage = row.message_id != null;
  // A message notification only carries the message while the recipient still
  // belongs to the room: membership is what granted that read in the first
  // place, so leaving (or being removed) must not keep an old notification
  // showing later edits. Non-message notifications (invites, join requests)
  // keep their `detail` text, since they never expose room content.
  const visible = hasMessage && row.member_user_id != null;
  return {
    id: Number(row.id),
    type: String(row.type),
    roomId: Number(row.room_id),
    roomName: String(row.room_name ?? ''),
    messageId: visible ? Number(row.message_id) : null,
    messageSeq: visible && row.message_seq != null ? Number(row.message_seq) : null,
    actorName: String(row.actor_name ?? ''),
    content: hasMessage
      ? visible
        ? previewContent(row.message_content, row.message_deleted_at)
        : ''
      : String(row.detail ?? ''),
    createdAt: toIso(row.created_at),
    readAt: row.read_at == null ? null : toIso(row.read_at),
  };
}

/**
 * Creates one `mention` notification per mentioned human member of `roomId`
 * (never the actor) and pushes each new one to `user:<id>`.
 *
 * Fire-and-forget by contract: a notification problem must never fail the
 * message that triggered it, so every error is logged and swallowed.
 */
export async function notifyMentions(
  io: Server,
  roomId: number,
  message: MentionMessage,
  actor: MentionActor,
): Promise<void> {
  try {
    const usernames = extractMentions(message.content ?? '');
    if (usernames.length === 0) {
      return;
    }

    const [targetRows] = await pool.query<RowDataPacket[]>(
      `SELECT u.id AS user_id, r.name AS room_name
       FROM users u
       JOIN room_members rm ON rm.user_id = u.id AND rm.room_id = ?
       JOIN rooms r ON r.id = rm.room_id
       WHERE u.type = 'human' AND u.username IN (?) AND u.id <> ?`,
      [roomId, usernames, actor.id],
    );
    if (targetRows.length === 0) {
      return;
    }

    const values = targetRows.map(() => "(?, 'mention', ?, ?, ?)").join(', ');
    const params = targetRows.flatMap((row) => [
      Number(row.user_id),
      roomId,
      message.id,
      actor.id,
    ]);
    const [insertResult] = await pool.query<ResultSetHeader>(
      `INSERT IGNORE INTO notifications (user_id, type, room_id, message_id, actor_id)
       VALUES ${values}`,
      params,
    );
    if (insertResult.affectedRows === 0 || insertResult.insertId === 0) {
      // Every recipient already had a notification for this message.
      return;
    }

    // Rows created by this statement have ids >= the statement's first
    // auto-increment value; rows skipped as duplicates are below it.
    const [createdRows] = await pool.query<RowDataPacket[]>(
      `SELECT id, user_id, read_at, created_at
       FROM notifications
       WHERE message_id = ? AND type = 'mention' AND id >= ?
       ORDER BY id`,
      [message.id, insertResult.insertId],
    );
    const roomName = String(targetRows[0].room_name ?? '');
    const content = truncateContent(message.content ?? '');
    for (const row of createdRows) {
      const notification: NotificationDTO = {
        id: Number(row.id),
        type: 'mention',
        roomId,
        roomName,
        messageId: message.id,
        messageSeq: message.seq,
        actorName: actor.name,
        content,
        createdAt: toIso(row.created_at),
        readAt: row.read_at == null ? null : toIso(row.read_at),
      };
      io.to(userRoom(Number(row.user_id))).emit('notification:new', { notification });
    }
  } catch (error) {
    logger.error({ err: error, roomId, messageId: message?.id }, 'mention notify failed');
  }
}

const NOTIFICATION_SELECT = `
  SELECT n.id, n.type, n.room_id, n.message_id, n.detail, n.read_at, n.created_at,
         r.name AS room_name,
         m.seq AS message_seq, m.content AS message_content, m.deleted_at AS message_deleted_at,
         COALESCE(actor.display_name, '') AS actor_name,
         rm.user_id AS member_user_id
  FROM notifications n
  JOIN rooms r ON r.id = n.room_id
  LEFT JOIN messages m ON m.id = n.message_id
  LEFT JOIN users actor ON actor.id = n.actor_id
  LEFT JOIN room_members rm ON rm.room_id = n.room_id AND rm.user_id = n.user_id
`;

export interface CreateNotificationInput {
  userId: number;
  type: string;
  roomId: number;
  actorId: number;
  detail: string;
}

/**
 * `room_invite` rows are a standing invitation, not an event log: a repeat
 * invite for the same (recipient, room) rewrites the pending row instead of
 * stacking another one, so re-inviting cannot bury the notification list.
 * Pending duplicates left by earlier versions are collapsed here as well.
 * Returns the id of the single pending row.
 */
async function upsertRoomInvite(input: CreateNotificationInput): Promise<number> {
  return withTransaction(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM notifications
       WHERE user_id = ? AND type = 'room_invite' AND room_id = ?
         AND message_id IS NULL AND read_at IS NULL
       ORDER BY id DESC
       FOR UPDATE`,
      [input.userId, input.roomId],
    );
    const [latest, ...stale] = rows;
    if (stale.length > 0) {
      await conn.query('DELETE FROM notifications WHERE id IN (?)', [
        stale.map((row) => Number(row.id)),
      ]);
    }
    if (latest) {
      await conn.execute(
        `UPDATE notifications
         SET actor_id = ?, detail = ?, created_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [input.actorId, input.detail, Number(latest.id)],
      );
      return Number(latest.id);
    }
    const [result] = await conn.execute<ResultSetHeader>(
      `INSERT INTO notifications (user_id, type, room_id, message_id, actor_id, detail)
       VALUES (?, ?, ?, NULL, ?, ?)`,
      [input.userId, input.type, input.roomId, input.actorId, input.detail],
    );
    return result.insertId;
  });
}

/**
 * Inserts one non-message notification (no `message_id`) and pushes the full
 * DTO to `user:<id>`. Mention notifications keep using `notifyMentions`.
 * `room_invite` is idempotent per (recipient, room): see {@link upsertRoomInvite}.
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<NotificationDTO> {
  const id =
    input.type === 'room_invite'
      ? await upsertRoomInvite(input)
      : (
          await pool.execute<ResultSetHeader>(
            `INSERT INTO notifications (user_id, type, room_id, message_id, actor_id, detail)
             VALUES (?, ?, ?, NULL, ?, ?)`,
            [input.userId, input.type, input.roomId, input.actorId, input.detail],
          )
        )[0].insertId;
  const [rows] = await pool.query<RowDataPacket[]>(
    `${NOTIFICATION_SELECT} WHERE n.id = ?`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`Notification ${id} disappeared after insert`);
  }
  const notification = mapNotification(row);
  getSocketServer()?.to(userRoom(input.userId)).emit('notification:new', { notification });
  return notification;
}

export interface NotificationList {
  items: NotificationDTO[];
  total: number;
  unread: number;
}

/** Notification-center tabs; `all` keeps every type. */
export type NotificationFilter = 'all' | 'mention' | 'join' | 'invite';

/** Notification `type` values kept by each non-`all` filter. */
const FILTER_TYPES: Record<Exclude<NotificationFilter, 'all'>, string[]> = {
  mention: ['mention'],
  join: ['join_request', 'join_approved', 'join_rejected'],
  invite: ['room_invite'],
};

/**
 * Reverse of {@link FILTER_TYPES}: a stored `type` maps to the chip that counts
 * it, so the two directions can never drift apart. Types absent here (future
 * or internal ones) are ignored by the per-type summary.
 */
const TYPE_FILTER: Record<string, Exclude<NotificationFilter, 'all'>> = Object.fromEntries(
  (Object.entries(FILTER_TYPES) as [Exclude<NotificationFilter, 'all'>, string[]][]).flatMap(
    ([filter, types]) => types.map((type) => [type, filter] as const),
  ),
);

/**
 * `AND n.type IN (...)` for `filter`, or `null` when every type is listed.
 * Unknown filters (only reachable from untyped callers) behave like `all`.
 */
function filterCondition(
  filter: NotificationFilter,
): { sql: string; params: string[] } | null {
  const types = filter === 'all' ? undefined : FILTER_TYPES[filter];
  if (!types) {
    return null;
  }
  return { sql: ` AND n.type IN (${types.map(() => '?').join(', ')})`, params: types };
}

/**
 * `%`, `_` and `\` are LIKE syntax; escape them so `q` stays literal. The
 * predicates below declare `ESCAPE '\\'`, so every metacharacter takes exactly
 * one leading backslash, including a backslash the user typed themselves.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Literal substring predicate over the text a row displays: message content,
 * the detail of non-message notifications, the actor's display name and the
 * room name. Deleted messages are skipped because their preview is already
 * "消息已撤回"; matching hidden text would surface a row that cannot explain
 * the hit. Returns `null` for a blank query, which must not narrow anything.
 */
function searchCondition(q: string): { sql: string; params: string[] } | null {
  const term = q.trim();
  if (term === '') {
    return null;
  }
  const pattern = `%${escapeLike(term)}%`;
  return {
    sql: ` AND (
      COALESCE(n.detail, '') LIKE ? ESCAPE '\\\\'
      OR (m.deleted_at IS NULL AND COALESCE(m.content, '') LIKE ? ESCAPE '\\\\')
      OR COALESCE(actor.display_name, '') LIKE ? ESCAPE '\\\\'
      OR r.name LIKE ? ESCAPE '\\\\'
    )`,
    params: [pattern, pattern, pattern, pattern],
  };
}

/**
 * Lists one page of notifications, optionally narrowed to one filter tab and
 * a literal `q` match. `total` counts the filtered searched set while `unread`
 * always covers the whole account so the badge does not shrink when a tab or a
 * query is active.
 */
export async function listNotifications(
  userId: number,
  limit = 20,
  offset = 0,
  filter: NotificationFilter = 'all',
  q = '',
): Promise<NotificationList> {
  const cappedLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
  const safeOffset = Math.max(Math.trunc(offset) || 0, 0);
  const condition = filterCondition(filter);
  const search = searchCondition(q);
  const where = `n.user_id = ?${condition?.sql ?? ''}${search?.sql ?? ''}`;
  const params = [userId, ...(condition?.params ?? []), ...(search?.params ?? [])];

  const [countRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM notifications n
     JOIN rooms r ON r.id = n.room_id
     LEFT JOIN messages m ON m.id = n.message_id
     LEFT JOIN users actor ON actor.id = n.actor_id
     WHERE ${where}`,
    params,
  );
  const unread = await countUnread(userId);
  const [rows] = await pool.query<RowDataPacket[]>(
    `${NOTIFICATION_SELECT}
     WHERE ${where}
     ORDER BY n.id DESC
     LIMIT ? OFFSET ?`,
    [...params, cappedLimit, safeOffset],
  );

  return {
    items: rows.map(mapNotification),
    total: Number(countRows[0]?.total ?? 0),
    unread,
  };
}

/** Rows carried by the one-shot notification CSV; the list itself is unbounded. */
export const NOTIFICATION_EXPORT_LIMIT = 5000;

const NOTIFICATION_CSV_HEADER =
  'id,type,roomName,actorName,content,createdAt,readAt';

// RFC 4180 quoting plus spreadsheet formula neutralization: Excel/Sheets
// execute cells starting with = + - @ (or a tab/CR) even when quoted, so
// prepend an apostrophe before quoting. roomName, actorName and content are
// user data, so every cell goes through this.
function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const raw = String(value);
  const text = /^\s*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV line for an exported row, in header order. */
function notificationCsvLine(item: NotificationDTO): string {
  return [
    csvCell(item.id),
    csvCell(item.type),
    csvCell(item.roomName),
    csvCell(item.actorName),
    csvCell(item.content),
    csvCell(item.createdAt),
    csvCell(item.readAt),
  ].join(',');
}

export interface NotificationExport {
  csv: string;
  /** True when more rows matched than {@link NOTIFICATION_EXPORT_LIMIT}. */
  truncated: boolean;
}

/**
 * Builds the notification-center CSV for `userId`, narrowed by the same filter
 * chip and literal `q` as {@link listNotifications}: both share
 * `filterCondition`, `searchCondition` and {@link NOTIFICATION_SELECT}, so the
 * export can never list rows, or show a different 消息已撤回 preview, than the
 * panel would. Newest first and hard-capped: a download must not stream an
 * unbounded table, so the cap is probed with one extra row and the flag is
 * known before the body is built.
 */
export async function exportNotifications(
  userId: number,
  filter: NotificationFilter = 'all',
  q = '',
): Promise<NotificationExport> {
  const condition = filterCondition(filter);
  const search = searchCondition(q);
  const where = `n.user_id = ?${condition?.sql ?? ''}${search?.sql ?? ''}`;
  const params = [userId, ...(condition?.params ?? []), ...(search?.params ?? [])];

  const [rows] = await pool.query<RowDataPacket[]>(
    `${NOTIFICATION_SELECT}
     WHERE ${where}
     ORDER BY n.id DESC
     LIMIT ?`,
    [...params, NOTIFICATION_EXPORT_LIMIT + 1],
  );
  const truncated = rows.length > NOTIFICATION_EXPORT_LIMIT;
  const lines = [
    NOTIFICATION_CSV_HEADER,
    ...rows
      .slice(0, NOTIFICATION_EXPORT_LIMIT)
      .map((row) => notificationCsvLine(mapNotification(row))),
  ];
  return { csv: `${lines.join('\r\n')}\r\n`, truncated };
}

async function countUnread(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND read_at IS NULL',
    [userId],
  );
  return Number(rows[0]?.unread ?? 0);
}

/**
 * Marks notifications read. Omitting `ids` marks everything unread; an
 * explicit (possibly empty) list only touches those ids.
 */
export async function markNotificationsRead(
  userId: number,
  ids?: number[],
): Promise<{ updated: number; unread: number }> {
  let updated = 0;
  if (ids === undefined) {
    const [result] = await pool.query<ResultSetHeader>(
      'UPDATE notifications SET read_at = CURRENT_TIMESTAMP(3) WHERE user_id = ? AND read_at IS NULL',
      [userId],
    );
    updated = result.affectedRows;
  } else if (ids.length > 0) {
    const uniqueIds = [...new Set(ids)];
    const [result] = await pool.query<ResultSetHeader>(
      `UPDATE notifications SET read_at = CURRENT_TIMESTAMP(3)
       WHERE user_id = ? AND read_at IS NULL AND id IN (?)`,
      [userId, uniqueIds],
    );
    updated = result.affectedRows;
  }

  return { updated, unread: await countUnread(userId) };
}

export interface NotificationRemoval {
  deleted: number;
  unread: number;
}

/**
 * Deletes one notification of `userId`. Returns `null` when the row does not
 * exist or belongs to another account, so the route can answer 404 for both
 * without revealing whether the id exists.
 */
export async function deleteNotification(
  userId: number,
  id: number,
): Promise<NotificationRemoval | null> {
  const [result] = await pool.execute<ResultSetHeader>(
    'DELETE FROM notifications WHERE id = ? AND user_id = ?',
    [id, userId],
  );
  if (result.affectedRows === 0) {
    return null;
  }
  return { deleted: result.affectedRows, unread: await countUnread(userId) };
}

/**
 * Deletes every read notification of `userId`; unread rows (and other
 * accounts) stay untouched. `unread` is the account-wide total afterwards.
 */
export async function deleteReadNotifications(
  userId: number,
): Promise<NotificationRemoval> {
  const [result] = await pool.execute<ResultSetHeader>(
    'DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL',
    [userId],
  );
  return { deleted: result.affectedRows, unread: await countUnread(userId) };
}

export interface NotificationBulkRemoval {
  deleted: number;
  unread: number;
  /** Account-wide notification count after the delete (never filtered). */
  total: number;
}

async function countNotifications(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM notifications WHERE user_id = ?',
    [userId],
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Deletes several notifications of `userId` in one statement. Duplicate ids
 * collapse first, and ids that are missing or belong to another account are
 * skipped instead of failing the batch: the call is idempotent, so resending
 * the same list after a partial success deletes the rest and then reports
 * `deleted: 0`. `unread` and `total` are account-wide, after the delete.
 */
export async function deleteNotifications(
  userId: number,
  ids: number[],
): Promise<NotificationBulkRemoval> {
  const uniqueIds = [...new Set(ids)];
  let deleted = 0;
  if (uniqueIds.length > 0) {
    const [result] = await pool.query<ResultSetHeader>(
      'DELETE FROM notifications WHERE user_id = ? AND id IN (?)',
      [userId, uniqueIds],
    );
    deleted = result.affectedRows;
  }
  return {
    deleted,
    unread: await countUnread(userId),
    total: await countNotifications(userId),
  };
}

export interface NotificationRoomSummary {
  roomId: number;
  roomName: string;
  count: number;
}

/**
 * Unread totals per filter chip, keyed exactly like {@link NotificationFilter}
 * without `all`. `join` folds the three join types together; types outside
 * {@link FILTER_TYPES} contribute to `unread` but to none of these buckets.
 */
export interface NotificationTypeCounts {
  mention: number;
  join: number;
  invite: number;
}

export interface NotificationSummary {
  /** Account-wide unread total: the same number the bell badge shows. */
  unread: number;
  rooms: NotificationRoomSummary[];
  types: NotificationTypeCounts;
}

/** The panel shows the busiest rooms only; the badge still carries the rest. */
export const NOTIFICATION_SUMMARY_ROOM_LIMIT = 10;

/**
 * Groups the account's unread notifications by room and by type for the
 * panel's chips. Rooms are ranked by unread count, newest room breaking ties,
 * and capped at {@link NOTIFICATION_SUMMARY_ROOM_LIMIT}; `unread` stays
 * account-wide, so it still agrees with the badge when more than ten rooms
 * have unread rows. `types` buckets the same unread rows per filter chip, so
 * the counts cannot disagree with `unread`. Read rows never count, and
 * deleting a room cascades its notifications away, so a removed room cannot
 * linger in the summary.
 */
export async function notificationSummary(
  userId: number,
): Promise<NotificationSummary> {
  const [roomsResult, typesResult] = await Promise.all([
    pool.query<RowDataPacket[]>(
      `SELECT n.room_id, r.name AS room_name, COUNT(*) AS total
       FROM notifications n
       JOIN rooms r ON r.id = n.room_id
       WHERE n.user_id = ? AND n.read_at IS NULL
       GROUP BY n.room_id, r.name
       ORDER BY total DESC, n.room_id DESC
       LIMIT ?`,
      [userId, NOTIFICATION_SUMMARY_ROOM_LIMIT],
    ),
    pool.query<RowDataPacket[]>(
      `SELECT n.type, COUNT(*) AS total
       FROM notifications n
       WHERE n.user_id = ? AND n.read_at IS NULL
       GROUP BY n.type`,
      [userId],
    ),
  ]);
  const [rows] = roomsResult;
  const [typeRows] = typesResult;

  // Summing the grouped rows gives the same number as a separate COUNT, while
  // guaranteeing `unread` is the total of the buckets the chips show.
  const types: NotificationTypeCounts = { mention: 0, join: 0, invite: 0 };
  let unread = 0;
  for (const row of typeRows) {
    const count = Number(row.total);
    unread += count;
    const bucket = TYPE_FILTER[String(row.type)];
    if (bucket) {
      types[bucket] += count;
    }
  }

  return {
    unread,
    rooms: rows.map((row) => ({
      roomId: Number(row.room_id),
      roomName: String(row.room_name ?? ''),
      count: Number(row.total),
    })),
    types,
  };
}
