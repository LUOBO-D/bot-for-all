import { pool, type RowDataPacket } from '../db';
import { badRequest, notFound } from '../errors';
import type {
  MessageDTO,
  MessageForwardOrigin,
  MessagePreview,
  MessageStatus,
  SenderType,
} from '../types';
import { toIso } from '../utils';
import { attachAttachments, attachPolls, attachReactions } from './message';
import { avatarUrl } from './user';

/**
 * Personal bookmarks ("收藏"). A saved message is a private pointer at one
 * message row; nothing is broadcast, so two members saving the same message
 * never see each other's bookmarks.
 */
export interface SavedMessageDTO {
  message: MessageDTO;
  roomName: string;
  savedAt: string;
}

export interface SavedMessageList {
  items: SavedMessageDTO[];
  total: number;
  limit: number;
  offset: number;
}

export const SAVED_LIMIT_DEFAULT = 50;
export const SAVED_LIMIT_MAX = 100;

/**
 * Escapes the LIKE metacharacters so a user query is matched literally.
 * MySQL's default escape character is a backslash, so `%`, `_` and a literal
 * backslash itself all get one prefixed. The escaped value is then wrapped in
 * wildcards and bound as a parameter; the SQL text stays constant.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The bookmark joined onto its message, sender and room. Columns mirror the
 * timeline projection in `services/message.ts` so a saved item is
 * indistinguishable from the same message shown in its room. The
 * `room_members` join keeps a bookmark from outliving the membership: leaving
 * or being kicked hides it here (the row survives, so rejoining restores it).
 */
const SAVED_SELECT = `
  SELECT m.id, m.seq, m.room_id, m.sender_id, m.sender_type, m.content, m.kind, m.status,
         m.reply_to_id, m.created_at, m.edited_at, m.deleted_at, m.pinned_at, m.pinned_by,
         m.forwarded_from_room_id, m.forwarded_from_room_name, m.forwarded_from_sender_name,
         m.preview_url, m.preview_title, m.preview_description, m.preview_site,
         u.display_name, u.avatar,
         r.name AS room_name, s.created_at AS saved_at
  FROM saved_messages s
  JOIN room_members rm ON rm.room_id = s.room_id AND rm.user_id = s.user_id
  JOIN messages m ON m.id = s.message_id
  JOIN rooms r ON r.id = s.room_id
  JOIN users u ON u.id = m.sender_id
`;

function mapForwardOrigin(row: RowDataPacket): MessageForwardOrigin | null {
  if (row.forwarded_from_room_name == null && row.forwarded_from_sender_name == null) {
    return null;
  }
  return {
    roomId: row.forwarded_from_room_id == null ? null : Number(row.forwarded_from_room_id),
    roomName: String(row.forwarded_from_room_name ?? ''),
    senderName: String(row.forwarded_from_sender_name ?? ''),
  };
}

function mapPreview(row: RowDataPacket): MessagePreview | null {
  if (row.preview_url == null) {
    return null;
  }
  return {
    url: String(row.preview_url),
    title: String(row.preview_title ?? ''),
    description: String(row.preview_description ?? ''),
    site: String(row.preview_site ?? ''),
  };
}

/** Same field-for-field mapping as the timeline DTO, including withdrawn rows. */
function mapSavedMessage(row: RowDataPacket): MessageDTO {
  const deleted = row.deleted_at != null;
  return {
    id: Number(row.id),
    seq: Number(row.seq),
    roomId: Number(row.room_id),
    senderId: Number(row.sender_id),
    senderType: row.sender_type as SenderType,
    senderName: String(row.display_name),
    senderAvatar: avatarUrl(Number(row.sender_id), row.avatar ? String(row.avatar) : null),
    content: deleted ? '' : String(row.content ?? ''),
    kind: (row.kind as MessageDTO['kind'] | undefined) ?? 'text',
    poll: null,
    attachments: [],
    status: row.status as MessageStatus,
    replyToId: row.reply_to_id == null ? null : Number(row.reply_to_id),
    createdAt: toIso(row.created_at),
    editedAt: row.edited_at == null ? null : toIso(row.edited_at),
    deleted,
    pinned: row.pinned_at != null,
    pinnedBy: row.pinned_by == null ? null : Number(row.pinned_by),
    forwardedFrom: mapForwardOrigin(row),
    preview: mapPreview(row),
    reactions: [],
  };
}

interface MessageRef {
  id: number;
  deleted: boolean;
}

/** Resolves a room-local seq to the message row a bookmark points at. */
async function findMessageRef(roomId: number, seq: number): Promise<MessageRef | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, deleted_at FROM messages WHERE room_id = ? AND seq = ?',
    [roomId, seq],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return { id: Number(row.id), deleted: row.deleted_at != null };
}

/**
 * Bookmarks one message for the caller. Withdrawn messages cannot be saved;
 * saving twice is a no-op so a double click never fails and never reorders the
 * list (the original saved_at is kept).
 */
export async function saveMessage(
  roomId: number,
  seq: number,
  userId: number,
): Promise<{ saved: true }> {
  const message = await findMessageRef(roomId, seq);
  if (!message) {
    throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
  }
  if (message.deleted) {
    throw badRequest('MESSAGE_DELETED', 'Message has been deleted');
  }
  await pool.execute(
    'INSERT IGNORE INTO saved_messages (user_id, message_id, room_id) VALUES (?, ?, ?)',
    [userId, message.id, roomId],
  );
  return { saved: true };
}

/**
 * Drops the caller's bookmark. Deliberately idempotent: an unknown message or
 * an already-removed bookmark both report "not saved" instead of failing.
 */
export async function removeSaved(
  roomId: number,
  seq: number,
  userId: number,
): Promise<{ saved: false }> {
  const message = await findMessageRef(roomId, seq);
  if (message) {
    await pool.execute('DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?', [
      userId,
      message.id,
    ]);
  }
  return { saved: false };
}

/**
 * One page of the caller's bookmarks, most recently saved first. A non-empty
 * `q` narrows the same membership-scoped set to rows whose content contains it
 * literally (case follows the utf8mb4_0900_ai_ci column collation). The count
 * runs with the identical predicate so pagination totals match the items.
 */
export async function listSaved(
  userId: number,
  limit: number = SAVED_LIMIT_DEFAULT,
  offset = 0,
  q = '',
): Promise<SavedMessageList> {
  const cappedLimit = Math.min(
    Math.max(Math.trunc(limit) || SAVED_LIMIT_DEFAULT, 1),
    SAVED_LIMIT_MAX,
  );
  const safeOffset = Math.max(Math.trunc(offset) || 0, 0);

  const contentFilter = q === '' ? '' : 'AND m.content LIKE ?';
  const filterParams = q === '' ? [] : [`%${escapeLike(q)}%`];

  const [countRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total
       FROM saved_messages s
       JOIN room_members rm ON rm.room_id = s.room_id AND rm.user_id = s.user_id
       JOIN messages m ON m.id = s.message_id
      WHERE s.user_id = ? ${contentFilter}`,
    [userId, ...filterParams],
  );
  const [rows] = await pool.query<RowDataPacket[]>(
    `${SAVED_SELECT}
     WHERE s.user_id = ? ${contentFilter}
     ORDER BY s.created_at DESC, s.message_id DESC
     LIMIT ? OFFSET ?`,
    [userId, ...filterParams, cappedLimit, safeOffset],
  );
  const messages = await attachAttachments(
    await attachPolls(await attachReactions(rows.map(mapSavedMessage))),
  );

  return {
    items: messages.map((message, index) => ({
      message,
      roomName: String(rows[index].room_name ?? ''),
      savedAt: toIso(rows[index].saved_at),
    })),
    total: Number(countRows[0]?.total ?? 0),
    limit: cappedLimit,
    offset: safeOffset,
  };
}
