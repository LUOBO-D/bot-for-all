import { randomBytes } from 'node:crypto';
import { bumpBotCache } from '../bot/cache';
import {
  pool,
  withTransaction,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from '../db';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import type { MemberDTO, RoomSummary } from '../types';
import { isDuplicateError, toIso } from '../utils';
import { onlineUserIds } from './presence';
import { avatarUrl } from './user';

const ROOM_SELECT = `
  SELECT r.id, r.name, r.topic, r.announcement, r.slow_mode_seconds, r.retention_days,
         r.owner_id, r.is_public, r.invite_code, r.max_seq,
         r.created_at,
         rm.role, rm.last_read_seq, rm.muted, rm.favorite, rm.group_name, rm.archived,
         (SELECT COUNT(*) FROM room_members x WHERE x.room_id = r.id) AS member_count,
         (SELECT COUNT(*) FROM messages m
           WHERE m.room_id = r.id
             AND m.seq > rm.last_read_seq
             AND m.sender_id != rm.user_id
             AND m.deleted_at IS NULL) AS unread_count,
         lm.seq AS last_seq, lm.content AS last_content, lm.created_at AS last_created_at,
         lm.deleted_at AS last_deleted_at,
         lu.display_name AS last_sender_name
  FROM room_members rm
  JOIN rooms r ON r.id = rm.room_id
  LEFT JOIN messages lm ON lm.id = (
    SELECT id FROM messages WHERE room_id = r.id ORDER BY seq DESC LIMIT 1
  )
  LEFT JOIN users lu ON lu.id = lm.sender_id
`;

const PUBLIC_ROOM_SELECT = `
  SELECT r.id, r.name, r.topic, r.announcement, r.slow_mode_seconds, r.retention_days,
         r.owner_id, r.is_public, r.invite_code, r.max_seq,
         r.created_at,
         NULL AS role, 0 AS last_read_seq, 0 AS muted, 0 AS favorite, NULL AS group_name,
         0 AS archived,
         (SELECT COUNT(*) FROM room_members x WHERE x.room_id = r.id) AS member_count,
         lm.seq AS last_seq, lm.content AS last_content, lm.created_at AS last_created_at,
         lm.deleted_at AS last_deleted_at,
         lu.display_name AS last_sender_name
  FROM rooms r
  LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?
  LEFT JOIN messages lm ON lm.id = (
    SELECT id FROM messages WHERE room_id = r.id ORDER BY seq DESC LIMIT 1
  )
  LEFT JOIN users lu ON lu.id = lm.sender_id
`;

// Non-member view of any room; the caller supplies the WHERE clause.
async function getNonMemberRoomSummary(roomId: number, userId: number): Promise<RoomSummary> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${PUBLIC_ROOM_SELECT} WHERE r.id = ?`,
    [userId, roomId],
  );
  const row = rows[0];
  if (!row) {
    throw notFound('ROOM_NOT_FOUND', 'Room not found');
  }
  return mapRoom(row, userId, false);
}

function mapRoom(row: RowDataPacket, userId: number, joined: boolean): RoomSummary {
  const lastSeq = row.last_seq == null ? null : Number(row.last_seq);
  return {
    id: Number(row.id),
    name: String(row.name),
    topic: String(row.topic ?? ''),
    announcement: String(row.announcement ?? ''),
    slowModeSeconds: Number(row.slow_mode_seconds ?? 0),
    retentionDays: Number(row.retention_days ?? 0),
    createdAt: toIso(row.created_at),
    ownerId: Number(row.owner_id),
    isPublic: Boolean(row.is_public),
    inviteCode: Number(row.owner_id) === userId && row.invite_code ? String(row.invite_code) : null,
    memberCount: Number(row.member_count ?? 0),
    unreadCount: joined
      ? row.unread_count != null
        ? Math.max(Number(row.unread_count), 0)
        : Math.max(Number(row.max_seq) - Number(row.last_read_seq ?? 0), 0)
      : 0,
    lastMessage:
      lastSeq == null
        ? null
        : {
            seq: lastSeq,
            content: row.last_deleted_at ? '消息已撤回' : String(row.last_content ?? ''),
            senderName: String(row.last_sender_name ?? ''),
            createdAt: toIso(row.last_created_at),
          },
    joined,
    muted: joined ? Boolean(row.muted) : false,
    favorite: joined ? Boolean(row.favorite) : false,
    group: joined && row.group_name ? String(row.group_name) : null,
    archived: joined ? Boolean(row.archived) : false,
  };
}

/** Hard cap on the unsearched "public rooms" list, newest first. */
export const PUBLIC_ROOM_LIMIT = 100;

/** Escapes LIKE metacharacters so user input matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function listRooms(userId: number): Promise<{
  mine: RoomSummary[];
  public: RoomSummary[];
  publicTotal: number;
}> {
  const [mineRows] = await pool.query<RowDataPacket[]>(
    `${ROOM_SELECT} WHERE rm.user_id = ?
     ORDER BY rm.favorite DESC, COALESCE(lm.created_at, r.created_at) DESC, r.id DESC`,
    [userId],
  );
  const [publicRows] = await pool.query<RowDataPacket[]>(
    `${PUBLIC_ROOM_SELECT} WHERE r.is_public = 1 AND rm.user_id IS NULL
     ORDER BY r.id DESC LIMIT ${PUBLIC_ROOM_LIMIT}`,
    [userId],
  );
  const [totalRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total
     FROM rooms r
     LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?
     WHERE r.is_public = 1 AND rm.user_id IS NULL`,
    [userId],
  );
  return {
    mine: mineRows.map((row) => mapRoom(row, userId, true)),
    public: publicRows.map((row) => mapRoom(row, userId, false)),
    publicTotal: Number(totalRows[0]?.total ?? 0),
  };
}

/**
 * Server-side search over public rooms the user has not joined yet. `q` is
 * optional; when given it is matched literally (LIKE metacharacters escaped).
 * Paged newest-first so the client can keep loading.
 */
export async function searchPublicRooms(
  userId: number,
  options: { q?: string; limit?: number; offset?: number } = {},
): Promise<{ rooms: RoomSummary[]; total: number; limit: number; offset: number }> {
  const q = options.q?.trim() ?? '';
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50) || 1, 1), PUBLIC_ROOM_LIMIT);
  const offset = Math.max(Math.trunc(options.offset ?? 0) || 0, 0);

  const filters = ['r.is_public = 1', 'rm.user_id IS NULL'];
  const filterParams: unknown[] = [];
  if (q) {
    filters.push("r.name LIKE ? ESCAPE '\\\\'");
    filterParams.push(`%${escapeLike(q)}%`);
  }
  const where = `WHERE ${filters.join(' AND ')}`;

  const [rows] = await pool.query<RowDataPacket[]>(
    `${PUBLIC_ROOM_SELECT} ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    [userId, ...filterParams, limit, offset],
  );
  const [totalRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total
     FROM rooms r
     LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?
     ${where}`,
    [userId, ...filterParams],
  );
  return {
    rooms: rows.map((row) => mapRoom(row, userId, false)),
    total: Number(totalRows[0]?.total ?? 0),
    limit,
    offset,
  };
}

export async function getRoomSummary(roomId: number, userId: number): Promise<RoomSummary> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${ROOM_SELECT} WHERE rm.user_id = ? AND r.id = ?`,
    [userId, roomId],
  );
  const row = rows[0];
  if (!row) {
    throw notFound('ROOM_NOT_FOUND', 'Room not found');
  }
  return mapRoom(row, userId, true);
}

export async function createRoom(
  ownerId: number,
  input: { name: string; topic?: string; isPublic?: boolean },
): Promise<RoomSummary> {
  const isPublic = input.isPublic !== false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const inviteCode = isPublic ? null : randomBytes(4).toString('hex');
    try {
      const roomId = await withTransaction(async (conn) => {
        const [result] = await conn.execute<ResultSetHeader>(
          `INSERT INTO rooms (name, topic, owner_id, is_public, invite_code)
           VALUES (?, ?, ?, ?, ?)`,
          [input.name, input.topic ?? '', ownerId, isPublic ? 1 : 0, inviteCode],
        );
        await conn.execute(
          'INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)',
          [result.insertId, ownerId, 'owner'],
        );
        return result.insertId;
      });
      return getRoomSummary(roomId, ownerId);
    } catch (error) {
      if (!isPublic && isDuplicateError(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new ApiError(500, 'ROOM_CREATE_FAILED', 'Could not allocate invite code');
}

export async function joinRoom(
  userId: number,
  roomId: number,
  inviteCode?: string,
): Promise<RoomSummary> {
  const [roomRows] = await pool.query<RowDataPacket[]>(
    'SELECT id, is_public, invite_code FROM rooms WHERE id = ?',
    [roomId],
  );
  const room = roomRows[0];
  if (!room) {
    throw notFound('ROOM_NOT_FOUND', 'Room not found');
  }
  const [memberRows] = await pool.query<RowDataPacket[]>(
    'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  if (!memberRows[0]) {
    if (!room.is_public) {
      if (!inviteCode) {
        throw forbidden('INVITE_REQUIRED', 'Invite code required');
      }
      if (inviteCode !== room.invite_code) {
        throw forbidden('INVALID_INVITE', 'Invalid invite code');
      }
    }
    await pool.execute(
      'INSERT IGNORE INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)',
      [roomId, userId, 'member'],
    );
  }
  return getRoomSummary(roomId, userId);
}

// Private rooms only: the owner (or a global admin) can mint a fresh invite
// code, which invalidates the old one immediately. The code column is unique,
// so a collision is retried instead of failing the request.
export async function rotateInviteCode(
  roomId: number,
  actorId: number,
  actorRole: 'admin' | 'user',
): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT owner_id, is_public FROM rooms WHERE id = ?',
    [roomId],
  );
  const room = rows[0];
  if (!room) {
    throw notFound('ROOM_NOT_FOUND', 'Room not found');
  }
  if (Boolean(room.is_public)) {
    throw badRequest('PUBLIC_ROOM', 'Public rooms do not use invite codes');
  }
  if (actorRole !== 'admin' && Number(room.owner_id) !== actorId) {
    throw forbidden('ROOM_OWNER_REQUIRED', 'Only the room owner can rotate the invite code');
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const inviteCode = randomBytes(4).toString('hex');
    try {
      await pool.execute('UPDATE rooms SET invite_code = ? WHERE id = ?', [inviteCode, roomId]);
      return inviteCode;
    } catch (error) {
      if (!isDuplicateError(error)) {
        throw error;
      }
    }
  }
  throw new ApiError(500, 'ROOM_INVITE_ROTATE_FAILED', 'Could not allocate invite code');
}

// name/topic: room owner or global admin. announcement, slowModeSeconds and
// retentionDays: additionally any room member with room_members.role='admin'.
// Only patched fields are authorised.
export async function updateRoom(
  roomId: number,
  actorId: number,
  actorRole: 'admin' | 'user',
  patch: {
    name?: string;
    topic?: string;
    announcement?: string;
    slowModeSeconds?: number;
    retentionDays?: number;
  },
): Promise<RoomSummary> {
  const isGlobalAdmin = actorRole === 'admin';
  // Global admins may moderate a room they never joined.
  const isMember = isGlobalAdmin ? await isRoomMember(roomId, actorId) : true;
  if (!isGlobalAdmin) {
    await assertMember(roomId, actorId);
  }
  const ownerId = await getRoomOwnerId(roomId);
  const isOwner = ownerId === actorId;
  if ((patch.name !== undefined || patch.topic !== undefined) && !isGlobalAdmin && !isOwner) {
    throw forbidden('ROOM_OWNER_REQUIRED', 'Only the room owner can edit the room');
  }
  if (
    (patch.announcement !== undefined ||
      patch.slowModeSeconds !== undefined ||
      patch.retentionDays !== undefined) &&
    !isGlobalAdmin &&
    !isOwner
  ) {
    if ((await getMemberRole(roomId, actorId)) !== 'admin') {
      throw forbidden(
        'ROOM_MODERATOR_REQUIRED',
        'Only the room owner or a room admin can edit the announcement, slow mode or retention',
      );
    }
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.topic !== undefined) {
    sets.push('topic = ?');
    params.push(patch.topic);
  }
  if (patch.announcement !== undefined) {
    sets.push('announcement = ?');
    params.push(patch.announcement);
  }
  if (patch.slowModeSeconds !== undefined) {
    sets.push('slow_mode_seconds = ?');
    params.push(patch.slowModeSeconds);
  }
  if (patch.retentionDays !== undefined) {
    sets.push('retention_days = ?');
    params.push(patch.retentionDays);
  }
  if (sets.length > 0) {
    await pool.query(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`, [...params, roomId]);
  }
  return isMember ? getRoomSummary(roomId, actorId) : getNonMemberRoomSummary(roomId, actorId);
}

export interface RoomRetentionPreview {
  /** Policy the count was evaluated against (0 = keep forever). */
  retentionDays: number;
  /** Unpinned messages the next sweep would delete. */
  messages: number;
  /** Creation time of the oldest message in that set, if any. */
  oldestAt: string | null;
}

/**
 * Counts what the retention sweep would delete right now, without deleting
 * anything. The predicate mirrors `runRoomRetention` exactly: unpinned
 * messages older than the window, withdrawn or not.
 *
 * `days` previews a policy that is not saved yet (the settings dialog debounces
 * it while the user types); omitted, the stored `retention_days` applies.
 * Authorization matches editing the policy: global admin, room owner, or a
 * member with `room_members.role='admin'`; everyone else is refused.
 */
export async function previewRoomRetention(
  roomId: number,
  actorId: number,
  actorRole: 'admin' | 'user',
  days?: number,
): Promise<RoomRetentionPreview> {
  const isGlobalAdmin = actorRole === 'admin';
  if (!isGlobalAdmin) {
    await assertMember(roomId, actorId);
  }
  const [roomRows] = await pool.query<RowDataPacket[]>(
    'SELECT owner_id, retention_days FROM rooms WHERE id = ?',
    [roomId],
  );
  const room = roomRows[0];
  if (!room) {
    throw notFound('ROOM_NOT_FOUND', 'Room not found');
  }
  if (!isGlobalAdmin && Number(room.owner_id) !== actorId) {
    if ((await getMemberRole(roomId, actorId)) !== 'admin') {
      throw forbidden(
        'ROOM_OWNER_REQUIRED',
        'Only the room owner or a room admin can preview retention',
      );
    }
  }
  const retentionDays = days ?? Number(room.retention_days ?? 0);
  if (retentionDays <= 0) {
    return { retentionDays: 0, messages: 0, oldestAt: null };
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS messages, MIN(created_at) AS oldest_at
       FROM messages
      WHERE room_id = ?
        AND pinned_at IS NULL
        AND created_at < TIMESTAMPADD(DAY, -?, NOW(3))`,
    [roomId, retentionDays],
  );
  const messages = Number(rows[0]?.messages ?? 0);
  const oldest = rows[0]?.oldest_at;
  return {
    retentionDays,
    messages,
    oldestAt: messages > 0 && oldest != null ? toIso(oldest) : null,
  };
}

// Per-user mute state; never broadcast (each member has their own).
export async function setRoomMuted(
  roomId: number,
  userId: number,
  muted: boolean,
): Promise<boolean> {
  await pool.execute(
    'UPDATE room_members SET muted = ? WHERE room_id = ? AND user_id = ?',
    [muted ? 1 : 0, roomId, userId],
  );
  return muted;
}

// Per-user favourite state; stored on the membership row (never broadcast).
export async function setRoomFavorite(
  roomId: number,
  userId: number,
  favorite: boolean,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    'UPDATE room_members SET favorite = ? WHERE room_id = ? AND user_id = ?',
    [favorite ? 1 : 0, roomId, userId],
  );
  // affectedRows is 0 both for "not a member" and for "value already stored",
  // so confirm membership before deciding the update was rejected.
  if (result.affectedRows === 0) {
    await assertMember(roomId, userId);
  }
  return favorite;
}

// Per-user sidebar group; stored on the membership row (never broadcast).
// Blank input clears the group, so the client can send '' or null to unset.
export async function setRoomGroup(
  roomId: number,
  userId: number,
  group: string | null,
): Promise<string | null> {
  const trimmed = (group ?? '').trim();
  if (trimmed.length > 32) {
    throw badRequest('INVALID_INPUT', 'group must be at most 32 characters');
  }
  const value = trimmed === '' ? null : trimmed;
  const [result] = await pool.execute<ResultSetHeader>(
    'UPDATE room_members SET group_name = ? WHERE room_id = ? AND user_id = ?',
    [value, roomId, userId],
  );
  // affectedRows is 0 both for "not a member" and for "value already stored",
  // so confirm membership before deciding the update was rejected.
  if (result.affectedRows === 0) {
    await assertMember(roomId, userId);
  }
  return value;
}

// Per-user archive flag; stored on the membership row (never broadcast), so
// one member filing a room away never hides it from the rest.
export async function setRoomArchived(
  roomId: number,
  userId: number,
  archived: boolean,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    'UPDATE room_members SET archived = ? WHERE room_id = ? AND user_id = ?',
    [archived ? 1 : 0, roomId, userId],
  );
  // affectedRows is 0 both for "not a member" and for "value already stored",
  // so confirm membership before deciding the update was rejected.
  if (result.affectedRows === 0) {
    await assertMember(roomId, userId);
  }
  return archived;
}

/**
 * A member's room bots die with their membership: whenever the owner leaves,
 * is kicked or is banned, every room-scoped bot they own in that room is
 * disabled and loses its membership rows so it can neither read nor speak.
 * `roomId` omitted means every room (global ban). The caller bumps the bot
 * cache once its transaction has committed.
 */
export async function disableRoomBotsOwnedBy(
  ownerId: number,
  roomId?: number,
  conn?: PoolConnection,
): Promise<void> {
  const db = conn ?? pool;
  const where = roomId === undefined ? '' : ' AND room_id = ?';
  const params = roomId === undefined ? [ownerId] : [ownerId, roomId];
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT user_id FROM bots WHERE scope = 'room' AND owner_user_id = ?${where}`,
    params,
  );
  if (rows.length === 0) {
    return;
  }
  const botIds = rows.map((row) => Number(row.user_id));
  const placeholders = botIds.map(() => '?').join(',');
  await db.query(`UPDATE bots SET enabled = 0 WHERE user_id IN (${placeholders})`, botIds);
  await db.query(`DELETE FROM room_members WHERE user_id IN (${placeholders})`, botIds);
}

/**
 * Cancels a user's still-pending scheduled messages, in one room or (without
 * `roomId`) in every room. Losing a membership or being banned must also end
 * the queue: the worker would otherwise post on the user's behalf later. Rows
 * already `sent`/`sending` are left alone; the worker re-checks the sender
 * before delivering a `sending` row on retry.
 */
export async function cancelPendingScheduledMessages(
  senderId: number,
  roomId?: number,
  conn?: PoolConnection,
): Promise<number> {
  const db = conn ?? pool;
  const where = roomId === undefined ? '' : ' AND room_id = ?';
  const params = roomId === undefined ? [senderId] : [senderId, roomId];
  const [result] = await db.execute<ResultSetHeader>(
    `UPDATE scheduled_messages SET status = 'cancelled'
      WHERE sender_id = ? AND status = 'pending'${where}`,
    params,
  );
  return result.affectedRows;
}

export async function leaveRoom(userId: number, roomId: number): Promise<void> {
  await withTransaction(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT owner_id FROM rooms WHERE id = ? FOR UPDATE',
      [roomId],
    );
    const room = rows[0];
    if (!room) {
      throw notFound('ROOM_NOT_FOUND', 'Room not found');
    }
    if (Number(room.owner_id) === userId) {
      throw badRequest('OWNER_CANNOT_LEAVE', 'Room owner cannot leave');
    }
    await conn.execute(
      'DELETE FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, userId],
    );
    // A queue outlives the membership otherwise: the worker would still post
    // on behalf of someone who is no longer in the room.
    await cancelPendingScheduledMessages(userId, roomId, conn);
    await disableRoomBotsOwnedBy(userId, roomId, conn);
  });
  bumpBotCache();
}

export async function assertMember(roomId: number, userId: number): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  if (!rows[0]) {
    throw forbidden('NOT_MEMBER', 'Not a member of this room');
  }
}

export async function isRoomMember(roomId: number, userId: number): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  return Boolean(rows[0]);
}

/** Every room the user belongs to; used to fan out profile changes. */
export async function listUserRoomIds(userId: number): Promise<number[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT room_id FROM room_members WHERE user_id = ? ORDER BY room_id',
    [userId],
  );
  return rows.map((row) => Number(row.room_id));
}

export async function getRoomOwnerId(roomId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT owner_id FROM rooms WHERE id = ?',
    [roomId],
  );
  const row = rows[0];
  if (!row) {
    throw notFound('ROOM_NOT_FOUND', 'Room not found');
  }
  return Number(row.owner_id);
}

export async function getRoomName(roomId: number): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT name FROM rooms WHERE id = ?',
    [roomId],
  );
  const row = rows[0];
  if (!row) {
    throw notFound('ROOM_NOT_FOUND', 'Room not found');
  }
  return String(row.name);
}

export async function getRoomMaxSeq(roomId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT max_seq FROM rooms WHERE id = ?',
    [roomId],
  );
  const row = rows[0];
  if (!row) {
    throw notFound('ROOM_NOT_FOUND', 'Room not found');
  }
  return Number(row.max_seq);
}

/** Configured slow-mode window in seconds; 0 means the room is unrestricted. */
export async function getRoomSlowMode(roomId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT slow_mode_seconds FROM rooms WHERE id = ?',
    [roomId],
  );
  const row = rows[0];
  if (!row) {
    throw notFound('ROOM_NOT_FOUND', 'Room not found');
  }
  return Number(row.slow_mode_seconds ?? 0);
}

export async function touchRead(roomId: number, userId: number): Promise<void> {
  await pool.execute(
    `UPDATE room_members rm
     JOIN rooms r ON r.id = rm.room_id
     SET rm.last_read_seq = r.max_seq
     WHERE rm.room_id = ? AND rm.user_id = ?`,
    [roomId, userId],
  );
}

/**
 * Marks every room the user belongs to as read by moving each membership row's
 * cursor to its room's `max_seq`. Only rows that are actually behind are
 * touched, so the affected-row count is the number of rooms marked read and an
 * already-caught-up user gets 0 instead of a no-op write per room.
 */
export async function markAllRoomsRead(userId: number): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE room_members rm
     JOIN rooms r ON r.id = rm.room_id
     SET rm.last_read_seq = r.max_seq
     WHERE rm.user_id = ? AND rm.last_read_seq < r.max_seq`,
    [userId],
  );
  return Number(result.affectedRows);
}

export async function updateReadCursor(
  roomId: number,
  userId: number,
  seq: number,
): Promise<void> {
  await pool.execute(
    `UPDATE room_members
     SET last_read_seq = GREATEST(last_read_seq, ?)
     WHERE room_id = ? AND user_id = ?`,
    [seq, roomId, userId],
  );
}

const MEMBER_SELECT = `
  SELECT u.id, u.username, u.display_name, u.avatar, u.type,
         u.status_emoji, u.status_text, u.last_seen_at,
         rm.role, rm.joined_at, rm.last_read_seq
  FROM room_members rm
  JOIN users u ON u.id = rm.user_id
  LEFT JOIN bots b ON b.user_id = u.id AND u.type = 'bot'
  WHERE rm.room_id = ? AND rm.user_id = ? AND (u.type <> 'bot' OR b.enabled = 1)
`;

function mapMember(row: RowDataPacket, onlineIds: ReadonlySet<number>): MemberDTO {
  const userId = Number(row.id);
  return {
    userId,
    username: String(row.username),
    displayName: String(row.display_name),
    avatar: avatarUrl(userId, row.avatar ? String(row.avatar) : null),
    type: row.type,
    role: row.role,
    online: onlineIds.has(userId),
    lastSeenAt: row.last_seen_at ? toIso(row.last_seen_at) : null,
    statusEmoji: row.status_emoji ? String(row.status_emoji) : null,
    statusText: row.status_text ? String(row.status_text) : null,
    joinedAt: toIso(row.joined_at),
    lastReadSeq: Number(row.last_read_seq ?? 0),
  };
}

export async function getMemberRole(roomId: number, userId: number): Promise<MemberDTO['role'] | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT role FROM room_members WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  const row = rows[0];
  return row ? (String(row.role) as MemberDTO['role']) : null;
}

export async function getMember(roomId: number, userId: number): Promise<MemberDTO | null> {
  const [rows] = await pool.query<RowDataPacket[]>(MEMBER_SELECT, [roomId, userId]);
  const row = rows[0];
  if (!row) {
    return null;
  }
  const online = new Set(await onlineUserIds(roomId));
  return mapMember(row, online);
}

// Invite by username: same rights as moderation (global admin, owner, or room
// admin), and only active human accounts that are not members yet. Notification
// and socket fan-out stay in the route so this layer owns membership only.
export async function inviteMember(
  roomId: number,
  actorId: number,
  actorGlobalRole: 'admin' | 'user',
  username: string,
): Promise<MemberDTO> {
  const [roomRows] = await pool.query<RowDataPacket[]>(
    'SELECT owner_id FROM rooms WHERE id = ?',
    [roomId],
  );
  const room = roomRows[0];
  if (!room) {
    throw notFound('ROOM_NOT_FOUND', 'Room not found');
  }
  const allowed =
    actorGlobalRole === 'admin' ||
    Number(room.owner_id) === actorId ||
    (await getMemberRole(roomId, actorId)) === 'admin';
  if (!allowed) {
    throw forbidden('ROOM_OWNER_REQUIRED', 'Only a room moderator can invite members');
  }

  const [userRows] = await pool.query<RowDataPacket[]>(
    'SELECT id, type, status FROM users WHERE username = ?',
    [username],
  );
  const target = userRows[0];
  if (!target) {
    throw notFound('USER_NOT_FOUND', 'User not found');
  }
  if (String(target.type) !== 'human') {
    throw badRequest('INVALID_TARGET', 'Bots cannot be invited to a room');
  }
  if (String(target.status) !== 'active') {
    throw badRequest('INVALID_TARGET', 'Banned users cannot be invited to a room');
  }

  const targetId = Number(target.id);
  const [memberRows] = await pool.query<RowDataPacket[]>(
    'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
    [roomId, targetId],
  );
  if (memberRows[0]) {
    throw badRequest('ALREADY_MEMBER', 'User is already a member of this room');
  }
  // INSERT IGNORE keeps a concurrent double-invite from surfacing a raw
  // duplicate-key error; the second request reports the same business code.
  const [result] = await pool.execute<ResultSetHeader>(
    "INSERT IGNORE INTO room_members (room_id, user_id, role) VALUES (?, ?, 'member')",
    [roomId, targetId],
  );
  if (result.affectedRows === 0) {
    throw badRequest('ALREADY_MEMBER', 'User is already a member of this room');
  }
  const member = await getMember(roomId, targetId);
  if (!member) {
    throw notFound('MEMBER_NOT_FOUND', 'Member not found after invite');
  }
  return member;
}

/** Hard cap on a single bulk invite request. */
export const BULK_INVITE_MAX = 20;

/** Same bounds as the single-member invite body. */
const INVITE_USERNAME_MIN = 3;
const INVITE_USERNAME_MAX = 32;

/**
 * Bulk payload hygiene: trims, drops a leading `@` and blank entries, and
 * collapses case-insensitive duplicates while keeping the first spelling.
 */
function normalizeInviteUsernames(usernames: readonly string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of usernames) {
    const name = raw.trim().replace(/^@+/, '').trim();
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    names.push(name);
  }
  return names;
}

// Bulk variant of `inviteMember`: same rights (global admin, owner, or room
// admin) and the same target rules, but the whole batch is validated with one
// read and written with one insert inside a transaction, so one bad name
// leaves every membership untouched. Notifications and socket fan-out stay in
// the route so this layer owns membership only.
export async function inviteMembers(
  roomId: number,
  actorId: number,
  actorGlobalRole: 'admin' | 'user',
  usernames: readonly string[],
): Promise<{ invited: number; userIds: number[] }> {
  const names = normalizeInviteUsernames(usernames);
  if (names.length === 0) {
    throw badRequest('INVALID_INPUT', 'usernames must contain at least one username');
  }
  if (names.length > BULK_INVITE_MAX) {
    throw badRequest(
      'INVALID_INPUT',
      `usernames must contain at most ${BULK_INVITE_MAX} usernames`,
    );
  }
  const invalidLength = names.some(
    (name) => name.length < INVITE_USERNAME_MIN || name.length > INVITE_USERNAME_MAX,
  );
  if (invalidLength) {
    throw badRequest(
      'INVALID_INPUT',
      `username must be ${INVITE_USERNAME_MIN}-${INVITE_USERNAME_MAX} characters`,
    );
  }
  return withTransaction(async (conn) => {
    // Lock the room row first: the moderator check below must not be
    // invalidated by a concurrent ownership transfer while the batch runs.
    const [roomRows] = await conn.query<RowDataPacket[]>(
      'SELECT owner_id FROM rooms WHERE id = ? FOR UPDATE',
      [roomId],
    );
    const room = roomRows[0];
    if (!room) {
      throw notFound('ROOM_NOT_FOUND', 'Room not found');
    }
    const [actorRows] = await conn.query<RowDataPacket[]>(
      'SELECT role FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, actorId],
    );
    const allowed =
      actorGlobalRole === 'admin' ||
      Number(room.owner_id) === actorId ||
      (actorRows[0] ? String(actorRows[0].role) : null) === 'admin';
    if (!allowed) {
      throw forbidden('ROOM_OWNER_REQUIRED', 'Only a room moderator can invite members');
    }

    const placeholders = names.map(() => '?').join(', ');
    // One read validates the whole batch: unknown accounts, bot/banned targets
    // and existing memberships all surface before a single row is written.
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT u.id, u.username, u.type, u.status, rm.user_id AS member_id
         FROM users u
         LEFT JOIN room_members rm ON rm.room_id = ? AND rm.user_id = u.id
        WHERE u.username IN (${placeholders})`,
      [roomId, ...names],
    );
    const found = new Map<string, RowDataPacket>();
    for (const row of rows) {
      found.set(String(row.username).toLowerCase(), row);
    }
    const missing = names.filter((name) => !found.has(name.toLowerCase()));
    if (missing.length > 0) {
      throw notFound('USER_NOT_FOUND', `User not found: ${missing.join(', ')}`);
    }
    const targets = names.map((name) => {
      const row = found.get(name.toLowerCase());
      if (!row) {
        // Unreachable: `missing` above already rejected every unknown name.
        throw notFound('USER_NOT_FOUND', 'User not found');
      }
      return {
        id: Number(row.id),
        type: String(row.type),
        status: String(row.status),
        member: row.member_id !== null && row.member_id !== undefined,
      };
    });
    for (const target of targets) {
      if (target.type !== 'human') {
        throw badRequest('INVALID_TARGET', 'Bots cannot be invited to a room');
      }
      if (target.status !== 'active') {
        throw badRequest('INVALID_TARGET', 'Banned users cannot be invited to a room');
      }
    }
    for (const target of targets) {
      if (target.member) {
        throw badRequest('ALREADY_MEMBER', 'User is already a member of this room');
      }
    }

    // INSERT IGNORE keeps a concurrent double-invite from surfacing a raw
    // duplicate-key error; a partial insert rolls the whole batch back so the
    // caller still sees one all-or-nothing answer.
    const values = targets.map(() => "(?, ?, 'member')").join(', ');
    const params = targets.flatMap((target) => [roomId, target.id]);
    const [result] = await conn.execute<ResultSetHeader>(
      `INSERT IGNORE INTO room_members (room_id, user_id, role) VALUES ${values}`,
      params,
    );
    if (result.affectedRows !== targets.length) {
      throw badRequest('ALREADY_MEMBER', 'User is already a member of this room');
    }
    return { invited: targets.length, userIds: targets.map((target) => target.id) };
  });
}

// Role changes are owner/global-admin only, and never touch the owner row or
// bot rows (bot membership is managed through the bot API).
export async function setMemberRole(
  roomId: number,
  actorId: number,
  actorGlobalRole: 'admin' | 'user',
  targetId: number,
  role: 'admin' | 'member',
): Promise<MemberDTO> {
  if (role !== 'admin' && role !== 'member') {
    throw badRequest('INVALID_ROLE', "role must be 'admin' or 'member'");
  }
  const ownerId = await getRoomOwnerId(roomId);
  if (actorGlobalRole !== 'admin' && actorId !== ownerId) {
    throw forbidden('ROOM_OWNER_REQUIRED', 'Only the room owner can change member roles');
  }
  const target = await getMember(roomId, targetId);
  if (!target) {
    throw notFound('MEMBER_NOT_FOUND', 'Member not found');
  }
  if (target.role === 'owner' || target.role === 'bot' || target.type !== 'human') {
    throw forbidden('NOT_ALLOWED', 'This member cannot be assigned a role');
  }
  if (target.role !== role) {
    await pool.execute(
      'UPDATE room_members SET role = ? WHERE room_id = ? AND user_id = ?',
      [role, roomId, targetId],
    );
  }
  return { ...target, role };
}

// Bulk variant of `setMemberRole`: same rights and same restrictions, but the
// batch is validated and written as one unit, so one bad target leaves every
// row untouched. Duplicate ids collapse to a single change.
export async function setMemberRoles(
  roomId: number,
  actorId: number,
  actorGlobalRole: 'admin' | 'user',
  userIds: number[],
  role: 'admin' | 'member',
): Promise<{ updated: number }> {
  if (role !== 'admin' && role !== 'member') {
    throw badRequest('INVALID_ROLE', "role must be 'admin' or 'member'");
  }
  const targets = [...new Set(userIds)];
  if (targets.length === 0) {
    throw badRequest('INVALID_TARGET', 'userIds must contain at least one member');
  }
  return withTransaction(async (conn) => {
    // Lock the room row first: the ownership check below must not be
    // invalidated by a concurrent ownership transfer while members are updated.
    const [roomRows] = await conn.query<RowDataPacket[]>(
      'SELECT owner_id FROM rooms WHERE id = ? FOR UPDATE',
      [roomId],
    );
    const room = roomRows[0];
    if (!room) {
      throw notFound('ROOM_NOT_FOUND', 'Room not found');
    }
    if (actorGlobalRole !== 'admin' && Number(room.owner_id) !== actorId) {
      throw forbidden('ROOM_OWNER_REQUIRED', 'Only the room owner can change member roles');
    }

    const placeholders = targets.map(() => '?').join(', ');
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT rm.user_id, rm.role, u.type
         FROM room_members rm
         JOIN users u ON u.id = rm.user_id
        WHERE rm.room_id = ? AND rm.user_id IN (${placeholders})
        FOR UPDATE`,
      [roomId, ...targets],
    );
    const found = new Map(rows.map((row) => [Number(row.user_id), row]));
    if (targets.some((userId) => !found.has(userId))) {
      throw notFound('MEMBER_NOT_FOUND', 'Member not found');
    }
    for (const targetId of targets) {
      const row = found.get(targetId);
      if (
        row &&
        (String(row.role) === 'owner' || String(row.role) === 'bot' || String(row.type) !== 'human')
      ) {
        throw forbidden('NOT_ALLOWED', 'This member cannot be assigned a role');
      }
    }

    // Only rows that actually change are written, so `updated` is the number of
    // members whose role moved rather than the size of the request.
    const changed = targets.filter((userId) => String(found.get(userId)?.role) !== role);
    if (changed.length === 0) {
      return { updated: 0 };
    }
    const changedPlaceholders = changed.map(() => '?').join(', ');
    const [result] = await conn.execute<ResultSetHeader>(
      `UPDATE room_members SET role = ? WHERE room_id = ? AND user_id IN (${changedPlaceholders})`,
      [role, roomId, ...changed],
    );
    return { updated: result.affectedRows };
  });
}

// Ownership transfer: only the current owner may hand the room over, and only
// to a human member. Both membership rows move in one transaction so the room
// never ends up without exactly one owner.
export async function transferOwnership(
  roomId: number,
  actorId: number,
  targetId: number,
): Promise<{ ownerId: number; member: MemberDTO }> {
  const ownerId = await getRoomOwnerId(roomId);
  if (ownerId !== actorId) {
    throw forbidden('ROOM_OWNER_REQUIRED', 'Only the room owner can transfer ownership');
  }
  if (targetId === actorId) {
    throw badRequest('INVALID_TARGET', 'You already own this room');
  }
  const target = await getMember(roomId, targetId);
  if (!target) {
    throw notFound('MEMBER_NOT_FOUND', 'Member not found');
  }
  if (target.type !== 'human' || target.role === 'bot') {
    throw badRequest('INVALID_TARGET', 'Ownership can only be transferred to a human member');
  }
  await withTransaction(async (conn) => {
    // Guarded by owner_id so a concurrent transfer cannot hand the room to two
    // different people; the member rows are re-checked inside the same unit.
    const [roomResult] = await conn.execute<ResultSetHeader>(
      'UPDATE rooms SET owner_id = ? WHERE id = ? AND owner_id = ?',
      [targetId, roomId, actorId],
    );
    if (roomResult.affectedRows === 0) {
      throw forbidden('ROOM_OWNER_REQUIRED', 'Only the room owner can transfer ownership');
    }
    const [targetResult] = await conn.execute<ResultSetHeader>(
      "UPDATE room_members SET role = 'owner' WHERE room_id = ? AND user_id = ?",
      [roomId, targetId],
    );
    if (targetResult.affectedRows === 0) {
      throw notFound('MEMBER_NOT_FOUND', 'Member not found');
    }
    await conn.execute(
      "UPDATE room_members SET role = 'member' WHERE room_id = ? AND user_id = ?",
      [roomId, actorId],
    );
    // The room's bots are part of what changes hands: their owner follows the
    // room, while enabled state, configuration and memberships stay untouched.
    await conn.execute(
      "UPDATE bots SET owner_user_id = ? WHERE scope = 'room' AND room_id = ?",
      [targetId, roomId],
    );
  });
  bumpBotCache();
  return { ownerId: targetId, member: { ...target, role: 'owner' } };
}

// Kick matrix: global admin → anyone but the owner; owner → anyone but self;
// room admin → plain members only.
export async function removeMember(
  roomId: number,
  actorId: number,
  actorGlobalRole: 'admin' | 'user',
  targetId: number,
): Promise<void> {
  const ownerId = await getRoomOwnerId(roomId);
  const target = await getMember(roomId, targetId);
  if (!target) {
    throw notFound('MEMBER_NOT_FOUND', 'Member not found');
  }
  if (targetId === actorId) {
    throw forbidden('NOT_ALLOWED', 'Use leave instead of removing yourself');
  }
  if (target.role === 'owner') {
    throw forbidden('NOT_ALLOWED', 'The room owner cannot be removed');
  }
  const actorRoomRole = await getMemberRole(roomId, actorId);
  const allowed =
    actorGlobalRole === 'admin' ||
    actorId === ownerId ||
    (actorRoomRole === 'admin' && target.role === 'member');
  if (!allowed) {
    throw forbidden('NOT_ALLOWED', 'You cannot remove this member');
  }
  await withTransaction(async (conn) => {
    await conn.execute('DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [
      roomId,
      targetId,
    ]);
    await cancelPendingScheduledMessages(targetId, roomId, conn);
    await disableRoomBotsOwnedBy(targetId, roomId, conn);
  });
  bumpBotCache();
}

// Bulk variant of `removeMember`, for the owner and global admins only (room
// admins keep the single-target route). Duplicate ids collapse to one removal
// and the batch is validated and written as one unit, so a missing member or a
// protected target leaves every membership untouched.
export async function removeMembers(
  roomId: number,
  actorId: number,
  actorGlobalRole: 'admin' | 'user',
  userIds: number[],
): Promise<{ removed: number }> {
  const targets = [...new Set(userIds)];
  if (targets.length === 0) {
    throw badRequest('INVALID_TARGET', 'userIds must contain at least one member');
  }
  await withTransaction(async (conn) => {
    // Lock the room row first: the ownership check below must not be
    // invalidated by a concurrent ownership transfer while members are removed.
    const [roomRows] = await conn.query<RowDataPacket[]>(
      'SELECT owner_id FROM rooms WHERE id = ? FOR UPDATE',
      [roomId],
    );
    const room = roomRows[0];
    if (!room) {
      throw notFound('ROOM_NOT_FOUND', 'Room not found');
    }
    const ownerId = Number(room.owner_id);
    if (actorGlobalRole !== 'admin' && ownerId !== actorId) {
      throw forbidden('ROOM_OWNER_REQUIRED', 'Only the room owner can remove members');
    }
    if (targets.includes(actorId)) {
      throw forbidden('NOT_ALLOWED', 'Use leave instead of removing yourself');
    }
    if (targets.includes(ownerId)) {
      throw forbidden('NOT_ALLOWED', 'The room owner cannot be removed');
    }

    const placeholders = targets.map(() => '?').join(', ');
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT user_id FROM room_members
        WHERE room_id = ? AND user_id IN (${placeholders})
        FOR UPDATE`,
      [roomId, ...targets],
    );
    const found = new Set(rows.map((row) => Number(row.user_id)));
    if (targets.some((userId) => !found.has(userId))) {
      throw notFound('MEMBER_NOT_FOUND', 'Member not found');
    }
    await conn.execute(
      `DELETE FROM room_members WHERE room_id = ? AND user_id IN (${placeholders})`,
      [roomId, ...targets],
    );
    // Every removed membership ends the member's queue and room bots, exactly
    // like the single-target path; both run inside the same transaction.
    for (const targetId of targets) {
      await cancelPendingScheduledMessages(targetId, roomId, conn);
      await disableRoomBotsOwnedBy(targetId, roomId, conn);
    }
  });
  bumpBotCache();
  return { removed: targets.length };
}

export async function listMembers(roomId: number): Promise<MemberDTO[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT u.id, u.username, u.display_name, u.avatar, u.type,
            u.status_emoji, u.status_text, u.last_seen_at,
            rm.role, rm.joined_at, rm.last_read_seq
     FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     LEFT JOIN bots b ON b.user_id = u.id AND u.type = 'bot'
     WHERE rm.room_id = ? AND (u.type <> 'bot' OR b.enabled = 1)
     ORDER BY FIELD(rm.role, 'owner', 'admin', 'member', 'bot'), u.id`,
    [roomId],
  );
  const online = new Set(await onlineUserIds(roomId));
  return rows.map((row) => mapMember(row, online));
}
