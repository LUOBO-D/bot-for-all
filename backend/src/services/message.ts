import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config';
import { pool, withTransaction, type ResultSetHeader, type RowDataPacket } from '../db';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors';
import { checkRate } from '../middleware/ratelimit';
import type {
  AttachmentDTO,
  MessageDTO,
  MessageForwardOrigin,
  MessageKind,
  MessagePreview,
  MessageReaction,
  MessageStatus,
  PollDTO,
  PollOptionDTO,
  SenderType,
} from '../types';
import { formatMiB, isDuplicateError, toIso } from '../utils';
import { resolveAttachmentPath } from './attachment-cleanup';
import { assertMember, getRoomSlowMode } from './room';
import { avatarUrl } from './user';

const MESSAGE_SELECT = `
  SELECT m.id, m.seq, m.room_id, m.sender_id, m.sender_type, m.content, m.kind, m.status,
         m.reply_to_id, m.client_msg_id, m.created_at,
         m.edited_at, m.deleted_at, m.pinned_at, m.pinned_by,
         m.forwarded_from_room_id, m.forwarded_from_room_name, m.forwarded_from_sender_name,
         m.preview_url, m.preview_title, m.preview_description, m.preview_site,
         u.display_name, u.avatar
  FROM messages m
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

function mapMessage(row: RowDataPacket): MessageDTO {
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
    kind: (row.kind as MessageKind | undefined) ?? 'text',
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

interface ReactionRow extends RowDataPacket {
  message_id: number;
  emoji: string;
  count: number;
  user_ids: string | null;
}

/**
 * Loads aggregated reactions for the given messages in a single query and
 * mutates each DTO's `reactions` array. Returns the same array for chaining.
 */
export async function attachReactions(messages: MessageDTO[]): Promise<MessageDTO[]> {
  if (messages.length === 0) {
    return messages;
  }
  const ids = messages.map((message) => message.id);
  const [rows] = await pool.query<ReactionRow[]>(
    `SELECT message_id, emoji, COUNT(*) AS count, GROUP_CONCAT(user_id) AS user_ids
     FROM message_reactions
     WHERE message_id IN (?)
     GROUP BY message_id, emoji
     ORDER BY MIN(created_at)`,
    [ids],
  );

  const byId = new Map<number, MessageReaction[]>();
  for (const row of rows) {
    const messageId = Number(row.message_id);
    const bucket = byId.get(messageId) ?? [];
    bucket.push({
      emoji: String(row.emoji),
      count: Number(row.count),
      userIds: row.user_ids
        ? String(row.user_ids)
            .split(',')
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value))
        : [],
    });
    byId.set(messageId, bucket);
  }

  for (const message of messages) {
    message.reactions = byId.get(message.id) ?? [];
  }
  return messages;
}

interface PollRow extends RowDataPacket {
  message_id: number;
  poll_id: number;
  multiple: number;
  anonymous: number;
  closes_at: Date | string | null;
  option_id: number | null;
  label: string | null;
  user_id: number | null;
}

interface PollAccumulator {
  dto: PollDTO;
  voters: Set<number>;
  options: Map<number, { dto: PollOptionDTO; voters: Set<number> }>;
}

/**
 * Loads the polls attached to the given messages in a single query and
 * mutates each DTO's `poll`. Only rows with `kind === 'poll'` are queried, so
 * a timeline of text messages costs nothing. Withdrawn messages keep their
 * `kind` but expose no poll, mirroring how their content is blanked.
 */
export async function attachPolls(messages: MessageDTO[]): Promise<MessageDTO[]> {
  const polled = messages.filter((message) => message.kind === 'poll' && !message.deleted);
  if (polled.length === 0) {
    return messages;
  }
  const [rows] = await pool.query<PollRow[]>(
    `SELECT p.message_id, p.id AS poll_id, p.multiple, p.anonymous, p.closes_at,
            o.id AS option_id, o.label, v.user_id
     FROM polls p
     LEFT JOIN poll_options o ON o.poll_id = p.id
     LEFT JOIN poll_votes v ON v.option_id = o.id
     WHERE p.message_id IN (?)
     ORDER BY p.id, o.id, v.created_at, v.user_id`,
    [polled.map((message) => message.id)],
  );

  const byMessageId = new Map<number, PollAccumulator>();
  for (const row of rows) {
    const messageId = Number(row.message_id);
    let poll = byMessageId.get(messageId);
    if (!poll) {
      const closesAt = row.closes_at == null ? null : toIso(row.closes_at);
      poll = {
        dto: {
          id: Number(row.poll_id),
          question: '',
          multiple: Number(row.multiple) === 1,
          anonymous: Number(row.anonymous) === 1,
          closesAt,
          closed: closesAt !== null && new Date(closesAt).getTime() <= Date.now(),
          totalVotes: 0,
          options: [],
        },
        voters: new Set(),
        options: new Map(),
      };
      byMessageId.set(messageId, poll);
    }
    if (row.option_id == null) {
      continue;
    }
    const optionId = Number(row.option_id);
    let option = poll.options.get(optionId);
    if (!option) {
      option = {
        dto: { id: optionId, label: String(row.label ?? ''), count: 0, userIds: [] },
        voters: new Set(),
      };
      poll.options.set(optionId, option);
      poll.dto.options.push(option.dto);
    }
    if (row.user_id != null) {
      const userId = Number(row.user_id);
      if (!option.voters.has(userId)) {
        option.voters.add(userId);
        option.dto.count = option.voters.size;
        // Anonymous polls still count every voter but never reveal who they
        // are; the voter reads their own selection from the my-votes route.
        if (!poll.dto.anonymous) {
          option.dto.userIds.push(userId);
        }
      }
      poll.voters.add(userId);
    }
  }

  for (const message of polled) {
    const poll = byMessageId.get(message.id);
    if (!poll) {
      continue;
    }
    for (const option of poll.options.values()) {
      option.dto.userIds.sort((left, right) => left - right);
    }
    poll.dto.question = message.content;
    poll.dto.totalVotes = poll.voters.size;
    message.poll = poll.dto;
  }
  return messages;
}

interface AttachmentRow extends RowDataPacket {
  id: number;
  room_id: number;
  message_id: number;
  filename: string;
  mime: string;
  size: number;
}

export const ATTACHMENT_IDS_MAX = 10;

/** Same-origin path the client fetches the file from. */
export function attachmentUrl(roomId: number, attachmentId: number): string {
  return `/api/rooms/${roomId}/attachments/${attachmentId}`;
}

/**
 * Loads the files bound to the given messages in one query and mutates each
 * DTO's `attachments` array. Withdrawn messages intentionally expose none:
 * their body is blanked for the same reason, and the download route still
 * serves the bytes to room members that already have the id.
 */
export async function attachAttachments(messages: MessageDTO[]): Promise<MessageDTO[]> {
  const visible = messages.filter((message) => !message.deleted);
  if (visible.length === 0) {
    return messages;
  }
  const [rows] = await pool.query<AttachmentRow[]>(
    `SELECT id, room_id, message_id, filename, mime, size
     FROM message_attachments
     WHERE message_id IN (?)
     ORDER BY id`,
    [visible.map((message) => message.id)],
  );

  const byMessageId = new Map<number, AttachmentDTO[]>();
  for (const row of rows) {
    const messageId = Number(row.message_id);
    const bucket = byMessageId.get(messageId) ?? [];
    const roomId = Number(row.room_id);
    const id = Number(row.id);
    bucket.push({
      id,
      filename: String(row.filename),
      mime: String(row.mime),
      size: Number(row.size),
      url: attachmentUrl(roomId, id),
    });
    byMessageId.set(messageId, bucket);
  }

  for (const message of visible) {
    message.attachments = byMessageId.get(message.id) ?? [];
  }
  return messages;
}

/** Gallery buckets. `file` is everything that is neither image, audio nor video. */
export type AttachmentFilter = 'image' | 'video' | 'file' | 'audio' | 'all';

/** One row of the room media library, tied to the message that carries it. */
export interface RoomAttachmentDTO {
  id: number;
  filename: string;
  mime: string;
  size: number;
  /** Sequence number of the carrying message; the client jumps to `?seq=`. */
  messageSeq: number;
  senderName: string;
  createdAt: string;
  url: string;
}

export interface RoomAttachmentQuery {
  type?: AttachmentFilter;
  /** Literal, case-insensitive substring of the stored file name. */
  q?: string;
  /** Exact id of the message sender; omitted means every sender. */
  senderId?: number;
  /** Inclusive lower bound as a UTC calendar day (`YYYY-MM-DD`) on the message. */
  from?: string;
  /** Inclusive upper bound as a UTC calendar day (`YYYY-MM-DD`) on the message. */
  to?: string;
  limit?: number;
  offset?: number;
}

export const ROOM_ATTACHMENT_PAGE_LIMIT = 50;

/**
 * SQL predicates per bucket. `image`/`audio`/`video` are prefix matches on the
 * stored MIME type; `file` is the complement, so every attachment lands in
 * exactly one of the four buckets. `all` adds no predicate.
 */
const ATTACHMENT_FILTER_SQL: Record<AttachmentFilter, string | null> = {
  image: "a.mime LIKE 'image/%'",
  video: "a.mime LIKE 'video/%'",
  audio: "a.mime LIKE 'audio/%'",
  file:
    "a.mime NOT LIKE 'image/%' AND a.mime NOT LIKE 'audio/%' " +
    "AND a.mime NOT LIKE 'video/%'",
  all: null,
};

/**
 * WHERE shared by the media library and its archive, so both hide exactly the
 * same rows: an unbound upload (no message yet) is private to its uploader,
 * and a withdrawn message hides its files just like it hides its body.
 * Optional filters (`type`, `q`, `senderId`, `from`/`to`) are AND-ed;
 * conditions and params grow together so each one keeps its own placeholder.
 * `q` matches the file name as a literal substring: LIKE metacharacters in the
 * user's input are escaped, so `%` and `_` only ever match themselves.
 */
function attachmentWhere(
  roomId: number,
  query: RoomAttachmentQuery,
): { where: string; params: Array<string | number> } {
  const filter = ATTACHMENT_FILTER_SQL[query.type ?? 'all'] ?? null;
  const conditions = ['a.room_id = ?', 'a.message_id IS NOT NULL', 'm.deleted_at IS NULL'];
  // `type` narrows by MIME, the rest by the carrying message.
  const params: Array<string | number> = [roomId];
  if (filter) {
    conditions.push(filter);
  }
  if (query.q) {
    conditions.push("a.filename LIKE ? ESCAPE '\\\\'");
    params.push(`%${escapeLike(query.q)}%`);
  }
  if (query.senderId !== undefined) {
    conditions.push('m.sender_id = ?');
    params.push(query.senderId);
  }
  // The window is on the message's `created_at`, a UTC DATETIME (the pool runs
  // with `timezone: 'Z'`), so the day bounds are plain string comparisons:
  // `from` starts at midnight and `to` stays inclusive by excluding the next
  // midnight.
  if (query.from) {
    conditions.push('m.created_at >= ?');
    params.push(`${query.from} 00:00:00.000`);
  }
  if (query.to) {
    conditions.push('m.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(`${query.to} 00:00:00.000`);
  }
  return { where: `WHERE ${conditions.join('\n       AND ')}`, params };
}

/**
 * Room media library. Only attachments carried by a live message are listed;
 * see {@link attachmentWhere} for the visibility rules. Rows come
 * newest-first by attachment id, which is the upload order.
 */
export async function listRoomAttachments(
  roomId: number,
  query: RoomAttachmentQuery = {},
): Promise<{ attachments: RoomAttachmentDTO[]; total: number }> {
  const limit = Math.min(
    Math.max(Math.trunc(query.limit ?? 20) || 1, 1),
    ROOM_ATTACHMENT_PAGE_LIMIT,
  );
  const offset = Math.max(Math.trunc(query.offset ?? 0) || 0, 0);
  const { where, params } = attachmentWhere(roomId, query);

  const [countRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total
     FROM message_attachments a
     JOIN messages m ON m.id = a.message_id
     ${where}`,
    params,
  );

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.id, a.filename, a.mime, a.size, a.created_at, m.seq, u.display_name
     FROM message_attachments a
     JOIN messages m ON m.id = a.message_id
     JOIN users u ON u.id = m.sender_id
     ${where}
     ORDER BY a.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const attachments = rows.map((row) => {
    const id = Number(row.id);
    return {
      id,
      filename: String(row.filename),
      mime: String(row.mime),
      size: Number(row.size),
      messageSeq: Number(row.seq),
      senderName: String(row.display_name),
      createdAt: toIso(row.created_at),
      url: attachmentUrl(roomId, id),
    };
  });
  return { attachments, total: Number(countRows[0]?.total ?? 0) };
}

/** Most files one media archive may carry. */
export const ROOM_ARCHIVE_MAX_FILES = 100;

/** Most source bytes one media archive may carry (200 MiB). */
export const ROOM_ARCHIVE_MAX_BYTES = 200 * 1024 * 1024;

/**
 * One file a media archive or room export zip may stream. `storedName` is
 * internal: it is only ever handed to `resolveAttachmentPath`, never sent to
 * a client.
 */
export interface RoomArchiveEntry {
  id: number;
  messageSeq: number;
  filename: string;
  storedName: string;
  size: number;
}

/**
 * Selects the files a media archive would contain, newest first, under the
 * exact filters and visibility rules of {@link listRoomAttachments}. One row
 * beyond the cap is read so an oversized selection is detected without a
 * second COUNT query; `overflow` is then true and no entries are returned.
 */
export async function selectRoomArchive(
  roomId: number,
  query: RoomAttachmentQuery = {},
): Promise<{ entries: RoomArchiveEntry[]; overflow: boolean }> {
  const { where, params } = attachmentWhere(roomId, query);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.id, a.filename, a.stored_name, a.size, m.seq
     FROM message_attachments a
     JOIN messages m ON m.id = a.message_id
     ${where}
     ORDER BY a.id DESC
     LIMIT ?`,
    [...params, ROOM_ARCHIVE_MAX_FILES + 1],
  );
  if (rows.length > ROOM_ARCHIVE_MAX_FILES) {
    return { entries: [], overflow: true };
  }
  return {
    entries: rows.map((row) => ({
      id: Number(row.id),
      messageSeq: Number(row.seq),
      filename: String(row.filename),
      storedName: String(row.stored_name),
      size: Number(row.size),
    })),
    overflow: false,
  };
}

/**
 * Attachments that belong in a room export zip. Only files carried by live
 * messages at or below `maxSeq` qualify: a withdrawn message keeps its rows
 * for quota accounting but contributes no file, and the seq bound keeps the
 * zip in step with the transcript `listMessagesForExport` capped at 5000
 * rows. Ordering is the transcript's own (oldest first, then attachment id),
 * so a caller streaming the zip and the markdown see the same order.
 */
export async function listExportAttachments(
  roomId: number,
  maxSeq: number,
): Promise<RoomArchiveEntry[]> {
  if (maxSeq <= 0) {
    return [];
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.id, a.filename, a.stored_name, a.size, m.seq
     FROM message_attachments a
     JOIN messages m ON m.id = a.message_id
     WHERE a.room_id = ? AND m.deleted_at IS NULL AND m.seq <= ?
     ORDER BY m.seq, a.id`,
    [roomId, maxSeq],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    messageSeq: Number(row.seq),
    filename: String(row.filename),
    storedName: String(row.stored_name),
    size: Number(row.size),
  }));
}

/**
 * Validates the socket `attachmentIds` payload: positive integers, deduped in
 * request order, at most {@link ATTACHMENT_IDS_MAX}. Absent/null means none.
 */
export function normalizeAttachmentIds(input: unknown): number[] {
  if (input === undefined || input === null) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw badRequest('ATTACHMENT_INVALID', 'attachmentIds must be an array');
  }
  const ids: number[] = [];
  for (const value of input) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw badRequest('ATTACHMENT_INVALID', 'attachmentIds must be positive integers');
    }
    if (!ids.includes(value)) {
      ids.push(value);
    }
  }
  if (ids.length > ATTACHMENT_IDS_MAX) {
    throw badRequest(
      'ATTACHMENT_INVALID',
      `A message can carry at most ${ATTACHMENT_IDS_MAX} attachments`,
    );
  }
  return ids;
}

export async function getMessageById(id: number): Promise<MessageDTO> {
  const [rows] = await pool.query<RowDataPacket[]>(`${MESSAGE_SELECT} WHERE m.id = ?`, [id]);
  const row = rows[0];
  if (!row) {
    throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
  }
  const [message] = await attachAttachments(
    await attachPolls(await attachReactions([mapMessage(row)])),
  );
  return message;
}

export async function getMessageBySeq(roomId: number, seq: number): Promise<MessageDTO | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${MESSAGE_SELECT} WHERE m.room_id = ? AND m.seq = ?`,
    [roomId, seq],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  const [message] = await attachAttachments(
    await attachPolls(await attachReactions([mapMessage(row)])),
  );
  return message;
}

async function requireMessageBySeq(roomId: number, seq: number): Promise<MessageDTO> {
  const message = await getMessageBySeq(roomId, seq);
  if (!message) {
    throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
  }
  return message;
}

async function getByClientId(
  roomId: number,
  senderId: number,
  clientMsgId: string,
): Promise<MessageDTO | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${MESSAGE_SELECT} WHERE m.room_id = ? AND m.sender_id = ? AND m.client_msg_id = ?`,
    [roomId, senderId, clientMsgId],
  );
  if (!rows[0]) {
    return null;
  }
  const [message] = await attachAttachments(
    await attachPolls(await attachReactions([mapMessage(rows[0])])),
  );
  return message;
}

export interface CreateMessagePollInput {
  multiple: boolean;
  /** Secret ballot: tallies are kept but voter ids are never exposed. */
  anonymous?: boolean;
  closesAt: Date | null;
  /** Trimmed, unique labels in display order. */
  options: string[];
}

/** A file already copied into `UPLOAD_DIR`, ready to become a new attachment row. */
export interface CopiedAttachmentInput {
  filename: string;
  storedName: string;
  mime: string;
  size: number;
}

export interface CreateMessageInput {
  roomId: number;
  senderId: number;
  senderType: SenderType;
  content: string;
  kind?: MessageKind;
  /** When present the message is stored as kind 'poll' with these options. */
  poll?: CreateMessagePollInput;
  status?: MessageStatus;
  clientMsgId?: string | null;
  replyToId?: number | null;
  forwardedFrom?: MessageForwardOrigin | null;
  /**
   * Previously uploaded, still-unbound attachments to bind to this message.
   * The whole insert (message + binding) runs in one transaction, so an id
   * that is not the caller's, not in this room, or already used aborts it.
   */
  attachmentIds?: number[];
  /**
   * Files the caller already copied to disk (message forwarding). Rows are
   * inserted in the same transaction as the message, so a rollback never
   * leaves an attachment row behind; the caller deletes the files when the
   * transaction fails. `attachmentQuotaBytes` and `attachmentMaxFiles` are
   * checked inside that transaction against the sender's total usage,
   * mirroring uploads.
   */
  copiedAttachments?: CopiedAttachmentInput[];
  /** Per-sender quota in bytes; `0`/undefined skips the check. */
  attachmentQuotaBytes?: number;
  /** Per-sender attachment row cap; `0`/undefined skips the check. */
  attachmentMaxFiles?: number;
}

export interface CreateMessageResult extends MessageDTO {
  duplicate: boolean;
}

/** Best-effort unlink of files copied for a message whose insert rolled back. */
async function removeCopiedAttachmentFiles(
  files: readonly CopiedAttachmentInput[],
): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      const absolute = resolveAttachmentPath(file.storedName);
      if (!absolute) {
        return;
      }
      await fs.promises.unlink(absolute).catch(() => {
        // Best effort: the insert error is what the caller should see.
      });
    }),
  );
}

export async function createMessage(input: CreateMessageInput): Promise<CreateMessageResult> {
  const status = input.status ?? 'done';
  const kind: MessageKind = input.poll ? 'poll' : (input.kind ?? 'text');
  const attachmentIds = normalizeAttachmentIds(input.attachmentIds);
  const copiedAttachments = input.copiedAttachments ?? [];
  let messageId: number;
  try {
    messageId = await withTransaction(async (conn) => {
      if (copiedAttachments.length > 0) {
        // Locking the sender's row serialises concurrent forwards/uploads from
        // the same user, so two requests cannot both pass the COUNT/SUM checks.
        await conn.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [input.senderId]);
        const quotaBytes = input.attachmentQuotaBytes ?? 0;
        const maxFiles = input.attachmentMaxFiles ?? 0;
        if (quotaBytes > 0 || maxFiles > 0) {
          const [usage] = await conn.execute<RowDataPacket[]>(
            `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS used
             FROM message_attachments WHERE uploader_id = ?`,
            [input.senderId],
          );
          const used = Number(usage[0]?.used ?? 0);
          const files = Number(usage[0]?.files ?? 0);
          // One copy may carry several files, so the whole batch is checked
          // before the first row is written.
          if (maxFiles > 0 && files + copiedAttachments.length > maxFiles) {
            throw new ApiError(
              413,
              'ATTACHMENT_QUOTA_EXCEEDED',
              `Attachment quota exceeded: ${files} of ${maxFiles} files used ` +
                `(this forward adds ${copiedAttachments.length})`,
            );
          }
          const incoming = copiedAttachments.reduce((total, file) => total + file.size, 0);
          if (quotaBytes > 0 && used + incoming > quotaBytes) {
            throw new ApiError(
              413,
              'ATTACHMENT_QUOTA_EXCEEDED',
              `Attachment quota exceeded: ${formatMiB(used)} MiB used of ` +
                `${formatMiB(quotaBytes)} MiB (this forward is ${formatMiB(incoming)} MiB)`,
            );
          }
        }
      }
      const [updateResult] = await conn.execute<ResultSetHeader>(
        'UPDATE rooms SET max_seq = LAST_INSERT_ID(max_seq + 1) WHERE id = ?',
        [input.roomId],
      );
      if (updateResult.affectedRows === 0) {
        throw notFound('ROOM_NOT_FOUND', 'Room not found');
      }
      const [seqRows] = await conn.query<RowDataPacket[]>('SELECT LAST_INSERT_ID() AS seq');
      const seq = Number(seqRows[0].seq);
      const [insertResult] = await conn.execute<ResultSetHeader>(
        `INSERT INTO messages
           (room_id, seq, sender_id, sender_type, kind, content, status, client_msg_id, reply_to_id,
            forwarded_from_room_id, forwarded_from_room_name, forwarded_from_sender_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.roomId,
          seq,
          input.senderId,
          input.senderType,
          kind,
          input.content,
          status,
          input.clientMsgId ?? null,
          input.replyToId ?? null,
          input.forwardedFrom?.roomId ?? null,
          input.forwardedFrom?.roomName ?? null,
          input.forwardedFrom?.senderName ?? null,
        ],
      );
      if (input.poll) {
        const [pollResult] = await conn.execute<ResultSetHeader>(
          'INSERT INTO polls (message_id, multiple, anonymous, closes_at) VALUES (?, ?, ?, ?)',
          [
            insertResult.insertId,
            input.poll.multiple ? 1 : 0,
            input.poll.anonymous ? 1 : 0,
            input.poll.closesAt,
          ],
        );
        for (const label of input.poll.options) {
          await conn.execute('INSERT INTO poll_options (poll_id, label) VALUES (?, ?)', [
            pollResult.insertId,
            label,
          ]);
        }
      }
      if (attachmentIds.length > 0) {
        // Guard every id in the same statement: room, uploader and "not yet
        // bound" all have to match, so a forged or already-consumed id simply
        // matches fewer rows and rolls the whole message back.
        const [binding] = await conn.query<ResultSetHeader>(
          `UPDATE message_attachments
           SET message_id = ?
           WHERE id IN (?) AND room_id = ? AND uploader_id = ? AND message_id IS NULL`,
          [insertResult.insertId, attachmentIds, input.roomId, input.senderId],
        );
        if (binding.affectedRows !== attachmentIds.length) {
          throw badRequest(
            'ATTACHMENT_INVALID',
            'Attachment is unknown, already used, or not yours',
          );
        }
      }
      for (const file of copiedAttachments) {
        // The file already exists on disk under `storedName`; only the row is
        // written here. A rollback removes the pointer and the catch below
        // unlinks the bytes.
        await conn.execute(
          `INSERT INTO message_attachments
             (room_id, uploader_id, message_id, filename, stored_name, mime, size)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            input.roomId,
            input.senderId,
            insertResult.insertId,
            file.filename,
            file.storedName,
            file.mime,
            file.size,
          ],
        );
      }
      return insertResult.insertId;
    });
  } catch (error) {
    // No row references the copied files after a rollback, so leaving them
    // behind would only leak disk space (quota rejection included). Hydration
    // happens after this block: once the transaction committed, the files are
    // owned by the new rows and must survive a later read error.
    await removeCopiedAttachmentFiles(copiedAttachments);
    if (input.clientMsgId && isDuplicateError(error)) {
      const existing = await getByClientId(input.roomId, input.senderId, input.clientMsgId);
      if (existing) {
        return { ...existing, duplicate: true };
      }
    }
    throw error;
  }
  return { ...(await getMessageById(messageId)), duplicate: false };
}

export interface CreatePollInput {
  roomId: number;
  senderId: number;
  question: string;
  options: string[];
  multiple?: boolean;
  /** Secret ballot; defaults to a visible poll. */
  anonymous?: boolean;
  closesAt?: Date | null;
}

export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 100;
export const POLL_OPTIONS_MIN = 2;
export const POLL_OPTIONS_MAX = 10;

/**
 * Creates a poll message: the question lives in `messages.content` and the
 * option rows are written in the same transaction as the message, so a failed
 * insert never leaves a `kind='poll'` row without its options.
 */
export async function createPoll(input: CreatePollInput): Promise<MessageDTO> {
  const question = input.question.trim();
  if (question.length === 0 || question.length > POLL_QUESTION_MAX) {
    throw badRequest('INVALID_INPUT', `question must be 1-${POLL_QUESTION_MAX} characters`);
  }
  const options = input.options.map((option) => option.trim());
  if (
    options.length < POLL_OPTIONS_MIN ||
    options.length > POLL_OPTIONS_MAX ||
    options.some((option) => option.length === 0 || option.length > POLL_OPTION_MAX)
  ) {
    throw badRequest(
      'INVALID_INPUT',
      `options must contain ${POLL_OPTIONS_MIN}-${POLL_OPTIONS_MAX} items of 1-${POLL_OPTION_MAX} characters`,
    );
  }
  const seen = new Set<string>();
  for (const option of options) {
    // Case-insensitive and trimmed: "Yes" and " yes " are the same choice.
    const key = option.toLowerCase();
    if (seen.has(key)) {
      throw badRequest('INVALID_OPTION', 'Poll options must be unique');
    }
    seen.add(key);
  }

  const created = await createMessage({
    roomId: input.roomId,
    senderId: input.senderId,
    senderType: 'user',
    content: question,
    kind: 'poll',
    poll: {
      multiple: Boolean(input.multiple),
      anonymous: Boolean(input.anonymous),
      closesAt: input.closesAt ?? null,
      options,
    },
  });
  const { duplicate: _duplicate, ...message } = created;
  return message;
}

export interface VotePollInput {
  roomId: number;
  seq: number;
  userId: number;
  optionIds: number[];
}

/**
 * Replaces the member's vote on a poll. The whole set is rewritten in one
 * transaction (empty `optionIds` clears it), so an interrupted request can
 * never leave a half-updated selection. Option ownership and the single-choice
 * rule are checked against the DTO; the close time is re-read under a row lock
 * so a poll that expires between the read and the write still rejects.
 */
export async function votePoll(input: VotePollInput): Promise<MessageDTO> {
  const message = await getMessageBySeq(input.roomId, input.seq);
  if (!message) {
    throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
  }
  if (message.deleted) {
    throw conflict('MESSAGE_DELETED', 'Message has been deleted');
  }
  const poll = message.poll;
  if (message.kind !== 'poll' || !poll) {
    throw notFound('POLL_NOT_FOUND', 'Message is not a poll');
  }
  if (poll.closed) {
    throw conflict('POLL_CLOSED', 'Poll is closed');
  }
  const optionIds = [...new Set(input.optionIds)];
  if (!poll.multiple && optionIds.length > 1) {
    throw badRequest('INVALID_OPTION', 'Single-choice poll accepts at most one option');
  }
  const allowed = new Set(poll.options.map((option) => option.id));
  if (optionIds.some((optionId) => !allowed.has(optionId))) {
    throw badRequest('INVALID_OPTION', 'Option does not belong to this poll');
  }

  await withTransaction(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT closes_at FROM polls WHERE id = ? FOR UPDATE',
      [poll.id],
    );
    if (!rows[0]) {
      throw notFound('POLL_NOT_FOUND', 'Poll not found');
    }
    const closesAt = rows[0].closes_at == null ? null : new Date(rows[0].closes_at).getTime();
    if (closesAt !== null && closesAt <= Date.now()) {
      throw conflict('POLL_CLOSED', 'Poll is closed');
    }
    await conn.execute('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', [
      poll.id,
      input.userId,
    ]);
    for (const optionId of optionIds) {
      await conn.execute(
        'INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES (?, ?, ?)',
        [poll.id, optionId, input.userId],
      );
    }
  });
  return requireMessageBySeq(input.roomId, input.seq);
}

export interface PollMyVotesInput {
  roomId: number;
  seq: number;
  userId: number;
}

/**
 * Returns the option ids the caller currently selected on a poll. Only the
 * caller's rows are read, so this is how a member recovers their own selection
 * on an anonymous poll, whose DTO hides every voter id. A message that is
 * missing, withdrawn or not a poll is reported as POLL_NOT_FOUND, matching the
 * vote/close routes.
 */
export async function getPollMyVotes(input: PollMyVotesInput): Promise<number[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT v.option_id
     FROM messages m
     JOIN polls p ON p.message_id = m.id
     LEFT JOIN poll_votes v ON v.poll_id = p.id AND v.user_id = ?
     WHERE m.room_id = ? AND m.seq = ? AND m.deleted_at IS NULL
     ORDER BY v.option_id`,
    [input.userId, input.roomId, input.seq],
  );
  if (rows.length === 0) {
    throw notFound('POLL_NOT_FOUND', 'Message is not a poll');
  }
  const optionIds: number[] = [];
  for (const row of rows) {
    // A LEFT JOIN row with no matching vote carries a null option id; the
    // message is still a poll, so an empty selection is a valid answer.
    if (row.option_id != null) {
      optionIds.push(Number(row.option_id));
    }
  }
  return optionIds;
}

export interface PollExportInput {
  roomId: number;
  seq: number;
}

/** One option's tally for the CSV export; `voters` is empty on anonymous polls. */
export interface PollExportOption {
  label: string;
  count: number;
  voters: string[];
}

export interface PollExport {
  anonymous: boolean;
  options: PollExportOption[];
}

/**
 * Loads every option of a poll together with its tallies and, unless the poll
 * is anonymous, its voters' display names in vote order. Voter names are read
 * in the same query so a poll costs one round trip, but they are dropped for
 * an anonymous poll before the result leaves the service: the secret ballot is
 * enforced here, not only in the route's column choice. A missing, withdrawn
 * or non-poll message is reported as POLL_NOT_FOUND, matching the
 * vote/close/my-votes routes.
 */
export async function getPollExport(input: PollExportInput): Promise<PollExport> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT p.anonymous, o.id AS option_id, o.label, v.user_id, u.display_name
     FROM messages m
     JOIN polls p ON p.message_id = m.id
     JOIN poll_options o ON o.poll_id = p.id
     LEFT JOIN poll_votes v ON v.option_id = o.id
     LEFT JOIN users u ON u.id = v.user_id
     WHERE m.room_id = ? AND m.seq = ? AND m.kind = 'poll' AND m.deleted_at IS NULL
     ORDER BY o.id, v.created_at, v.user_id`,
    [input.roomId, input.seq],
  );
  if (rows.length === 0) {
    throw notFound('POLL_NOT_FOUND', 'Message is not a poll');
  }
  const anonymous = Number(rows[0].anonymous) === 1;
  const options: PollExportOption[] = [];
  let currentId: number | null = null;
  for (const row of rows) {
    const optionId = Number(row.option_id);
    if (optionId !== currentId) {
      options.push({ label: String(row.label), count: 0, voters: [] });
      currentId = optionId;
    }
    // A row without a vote (the option has none) carries no user id; anonymous
    // polls still count it, they just never keep the name.
    if (row.user_id != null) {
      const option = options[options.length - 1];
      option.count += 1;
      if (!anonymous && row.display_name != null) {
        option.voters.push(String(row.display_name));
      }
    }
  }
  return { anonymous, options };
}

export interface ClosePollInput {
  roomId: number;
  seq: number;
  userId: number;
  /** Room owner/admin or a global admin: may close someone else's poll. */
  moderator: boolean;
}

/**
 * Ends a poll early by stamping `closes_at` with the current time. Only the
 * author and moderators may call it. The stamp is applied under a row lock so
 * two racing requests cannot both observe an open poll, and every later vote
 * fails with POLL_CLOSED. A withdrawn poll exposes no poll row and is reported
 * as POLL_NOT_FOUND, exactly like a text message.
 */
export async function closePoll(input: ClosePollInput): Promise<MessageDTO> {
  const message = await getMessageBySeq(input.roomId, input.seq);
  if (!message || message.deleted || message.kind !== 'poll' || !message.poll) {
    throw notFound('POLL_NOT_FOUND', 'Message is not a poll');
  }
  if (message.senderId !== input.userId && !input.moderator) {
    throw forbidden('FORBIDDEN', 'Only the poll author or a room moderator can close it');
  }
  if (message.poll.closed) {
    throw conflict('POLL_CLOSED', 'Poll is closed');
  }
  await withTransaction(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT id, closes_at FROM polls WHERE message_id = ? FOR UPDATE',
      [message.id],
    );
    const row = rows[0];
    if (!row) {
      throw notFound('POLL_NOT_FOUND', 'Message is not a poll');
    }
    const closesAt = row.closes_at == null ? null : new Date(row.closes_at).getTime();
    if (closesAt !== null && closesAt <= Date.now()) {
      throw conflict('POLL_CLOSED', 'Poll is closed');
    }
    await conn.execute('UPDATE polls SET closes_at = ? WHERE id = ?', [new Date(), Number(row.id)]);
  });
  return requireMessageBySeq(input.roomId, input.seq);
}

export interface ForwardMessageInput {
  sourceRoomId: number;
  sourceSeq: number;
  targetRoomId: number;
  userId: number;
}

/**
 * Rejects sources this feature cannot reproduce: withdrawn messages and any
 * kind without a copy rule. Text messages carrying attachments are forwarded
 * by copying each file into the target room under the forwarder's ownership
 * and quota; polls are re-created from their question and option labels.
 * Expects a hydrated DTO (`getMessageBySeq` attaches polls and attachments).
 */
function assertForwardable(source: MessageDTO): void {
  if (source.deleted) {
    throw badRequest('MESSAGE_DELETED', 'Cannot forward a deleted message');
  }
  if (source.kind === 'poll') {
    // A poll row always has its options hydrated alongside the message; a
    // `kind='poll'` without them has nothing to reproduce, so reject it
    // instead of copying an option-less poll.
    if (!source.poll) {
      throw badRequest('FORWARD_UNSUPPORTED', 'Poll is missing its options');
    }
    return;
  }
  if (source.kind !== 'text' || source.poll !== null) {
    throw badRequest('FORWARD_UNSUPPORTED', 'Only text messages and polls can be forwarded');
  }
}

/**
 * Builds the poll payload for a forwarded copy. The question stays in the
 * message content; options are copied by label in their original order, so
 * the copy gets fresh option ids. The deadline is deliberately dropped: a
 * forward opens a new ballot, and no votes are carried over.
 */
function forwardPollInput(source: MessageDTO): CreateMessagePollInput | undefined {
  if (source.kind !== 'poll' || !source.poll) {
    return undefined;
  }
  return {
    multiple: source.poll.multiple,
    anonymous: source.poll.anonymous,
    closesAt: null,
    options: source.poll.options.map((option) => option.label),
  };
}

interface SourceAttachmentRow extends RowDataPacket {
  filename: string;
  stored_name: string;
  mime: string;
  size: number;
}

/** Reads the stored names behind a source message's attachment DTOs. */
async function loadSourceAttachments(messageId: number): Promise<SourceAttachmentRow[]> {
  const [rows] = await pool.query<SourceAttachmentRow[]>(
    `SELECT filename, stored_name, mime, size
     FROM message_attachments
     WHERE message_id = ?
     ORDER BY id`,
    [messageId],
  );
  return rows;
}

/**
 * Copies every source file to a fresh random name under `UPLOAD_DIR`. Source
 * rows and bytes are never touched, so the original message keeps its files.
 * A missing/unsafe source path aborts with 404 and removes whatever this call
 * already copied, so a failed forward leaves no stray bytes behind.
 */
async function copyForwardAttachments(
  rows: SourceAttachmentRow[],
): Promise<CopiedAttachmentInput[]> {
  if (rows.length === 0) {
    return [];
  }
  await fs.promises.mkdir(config.uploadDir, { recursive: true });
  const copied: CopiedAttachmentInput[] = [];
  try {
    for (const row of rows) {
      const sourcePath = resolveAttachmentPath(String(row.stored_name));
      if (!sourcePath) {
        throw notFound('ATTACHMENT_NOT_FOUND', 'Attachment file not found');
      }
      const storedName = randomBytes(24).toString('hex');
      const targetPath = resolveAttachmentPath(storedName);
      if (!targetPath) {
        // Random hex cannot escape UPLOAD_DIR; this only narrows the type.
        throw notFound('ATTACHMENT_NOT_FOUND', 'Attachment file not found');
      }
      const copy: CopiedAttachmentInput = {
        filename: String(row.filename),
        storedName,
        mime: String(row.mime),
        size: Number(row.size),
      };
      // Track the name before the copy: if copyFile fails halfway, the
      // partial destination is still removed by the catch below.
      copied.push(copy);
      try {
        await fs.promises.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          // A 192-bit random name collided with a file we did not create; do
          // not let the cleanup below unlink it.
          copied.pop();
          throw error;
        }
        if (code === 'ENOENT') {
          throw notFound('ATTACHMENT_NOT_FOUND', 'Attachment file not found');
        }
        throw error;
      }
    }
    return copied;
  } catch (error) {
    await removeCopiedAttachmentFiles(copied);
    throw error;
  }
}

/**
 * Copies a source message into another room as a new message sent by `userId`.
 * The origin room name and sender name are snapshotted on the new row so the
 * label survives later renames or a deleted source room. Attachments are
 * copied file-by-file; the new rows belong to the target room and the
 * forwarder, and their size counts against the forwarder's quota. A poll
 * source is re-created under the forwarder with the same question, flags and
 * option labels, a cleared deadline and no votes; the source poll and its
 * votes are only read, never modified.
 */
export async function forwardMessage(input: ForwardMessageInput): Promise<MessageDTO> {
  const source = await getMessageBySeq(input.sourceRoomId, input.sourceSeq);
  if (!source) {
    throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
  }
  assertForwardable(source);
  const [roomRows] = await pool.query<RowDataPacket[]>('SELECT name FROM rooms WHERE id = ?', [
    input.sourceRoomId,
  ]);
  if (!roomRows[0]) {
    throw notFound('ROOM_NOT_FOUND', 'Room not found');
  }
  const copied =
    source.attachments.length === 0
      ? []
      : await copyForwardAttachments(await loadSourceAttachments(source.id));
  // createMessage inserts the new rows (message + poll + options) in the same
  // transaction and removes `copied` files if that transaction rolls back
  // (quota included).
  const created = await createMessage({
    roomId: input.targetRoomId,
    senderId: input.userId,
    senderType: 'user',
    content: source.content,
    poll: forwardPollInput(source),
    forwardedFrom: {
      roomId: input.sourceRoomId,
      roomName: String(roomRows[0].name),
      senderName: source.senderName,
    },
    copiedAttachments: copied,
    attachmentQuotaBytes: config.attachmentUserQuotaBytes,
    attachmentMaxFiles: config.attachmentUserMaxFiles,
  });
  // createMessage only sets `duplicate` for clientMsgId retries; strip it so the
  // DTO shape stays exactly MessageDTO.
  const { duplicate: _duplicate, ...message } = created;
  return message;
}

export interface ForwardMessagesInput {
  sourceRoomId: number;
  sourceSeqs: number[];
  targetRoomId: number;
  userId: number;
}

/**
 * Forwards a batch of messages from one room into another, oldest first and
 * once per seq. Every source is fetched and validated before the first copy
 * is written: one missing, withdrawn or unsupported message rejects the batch
 * without leaving partial results in the target room. Polls are copied on the
 * same terms as text (same question, flags and option labels; reopened with
 * no votes), so a batch may freely mix both kinds. Attachment files are
 * copied per message afterwards, so a disk/quota failure can leave the copies
 * created before it (each one is a complete, valid message). `onCreated` runs
 * right after each copy exists, so callers can broadcast it before the next.
 */
export async function forwardMessages(
  input: ForwardMessagesInput,
  onCreated?: (message: MessageDTO) => void,
): Promise<MessageDTO[]> {
  const seqs = [...new Set(input.sourceSeqs)].sort((a, b) => a - b);
  for (const seq of seqs) {
    const source = await getMessageBySeq(input.sourceRoomId, seq);
    if (!source) {
      // A batch names its seqs explicitly, so an unknown one is invalid input
      // for the whole request (unlike the single forward's 404 lookup).
      throw badRequest('MESSAGE_NOT_FOUND', 'Message not found');
    }
    assertForwardable(source);
  }
  const messages: MessageDTO[] = [];
  for (const seq of seqs) {
    const message = await forwardMessage({
      sourceRoomId: input.sourceRoomId,
      sourceSeq: seq,
      targetRoomId: input.targetRoomId,
      userId: input.userId,
    });
    messages.push(message);
    onCreated?.(message);
  }
  return messages;
}

export interface ListMessagesOptions {
  beforeSeq?: number;
  afterSeq?: number;
  limit?: number;
}

export async function listMessages(
  roomId: number,
  options: ListMessagesOptions,
): Promise<{ messages: MessageDTO[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(Number(options.limit ?? 50), 1), 200);
  // Fetch one extra row so a full page is not mistaken for a next page.
  const probe = limit + 1;

  if (options.afterSeq != null) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `${MESSAGE_SELECT}
       WHERE m.room_id = ? AND m.seq > ?
       ORDER BY m.seq ASC
       LIMIT ?`,
      [roomId, options.afterSeq, probe],
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      messages: await attachAttachments(
        await attachPolls(await attachReactions(page.map(mapMessage))),
      ),
      hasMore,
    };
  }

  if (options.beforeSeq != null) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `${MESSAGE_SELECT}
       WHERE m.room_id = ? AND m.seq < ?
       ORDER BY m.seq DESC
       LIMIT ?`,
      [roomId, options.beforeSeq, probe],
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      messages: await attachAttachments(
        await attachPolls(await attachReactions(page.reverse().map(mapMessage))),
      ),
      hasMore,
    };
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `${MESSAGE_SELECT}
     WHERE m.room_id = ?
     ORDER BY m.seq DESC
     LIMIT ?`,
    [roomId, probe],
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    messages: await attachAttachments(
      await attachPolls(await attachReactions(page.reverse().map(mapMessage))),
    ),
    hasMore,
  };
}

/**
 * Oldest-first snapshot of a room's messages for the export endpoint. Capped
 * at 5000 rows; reactions are left empty on purpose so an export costs one
 * query instead of two and never carries reaction user ids out of the app.
 * Polls are still hydrated: a JSON transcript should keep the question's
 * options and tallies even though reaction identities stay private.
 */
export async function listMessagesForExport(
  roomId: number,
  limit = 5000,
): Promise<MessageDTO[]> {
  const capped = Math.min(Math.max(Number(limit) || 0, 1), 5000);
  const [rows] = await pool.query<RowDataPacket[]>(
    `${MESSAGE_SELECT}
     WHERE m.room_id = ?
     ORDER BY m.seq ASC
     LIMIT ?`,
    [roomId, capped],
  );
  return attachAttachments(await attachPolls(rows.map(mapMessage)));
}

export async function finalizeMessage(
  id: number,
  content: string,
  status: MessageStatus,
): Promise<void> {
  await pool.execute('UPDATE messages SET content = ?, status = ? WHERE id = ?', [
    content,
    status,
    id,
  ]);
}

/**
 * Whether the streaming guard must drop this row: withdrawn, or gone entirely
 * (rows are only hard-deleted by retention sweeps, but a missing row can no
 * longer receive content either).
 */
export async function isMessageDeleted(id: number): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT deleted_at FROM messages WHERE id = ?', [
    id,
  ]);
  return rows.length === 0 || rows[0].deleted_at != null;
}

export async function messageExistsInRoom(id: number, roomId: number): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT 1 FROM messages WHERE id = ? AND room_id = ?',
    [id, roomId],
  );
  return Boolean(rows[0]);
}

/** Escapes LIKE metacharacters so user input matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Queries the ngram full-text index can answer verbatim: at least two
 * characters of letters, digits, CJK or whitespace. The index stores bigrams,
 * so a single character can never match; and any other character (`%`, `_`,
 * `\`, quotes, `+`, `-`, `@`, ...) either has a meaning of its own in BOOLEAN
 * MODE or is matched literally by LIKE, so those keep the LIKE path.
 */
const FULLTEXT_QUERY = /^[\p{L}\p{N}\s]+$/u;

/**
 * InnoDB's default stopword list, mirrored from
 * `INFORMATION_SCHEMA.INNODB_FT_DEFAULT_STOPWORD`. The ngram parser drops
 * tokens that contain a stopword, so stopword queries are not just incomplete:
 * `"with"` is reduced to the `th` bigram and matches every message containing
 * `th`, while `"in"` matches nothing at all. Both are wrong, so a query with a
 * stopword takes the literal LIKE path instead of the index.
 */
const INNODB_STOPWORDS: Record<string, true> = {
  a: true, about: true, an: true, are: true, as: true, at: true, be: true,
  by: true, com: true, de: true, en: true, for: true, from: true, how: true,
  i: true, in: true, is: true, it: true, la: true, of: true, on: true,
  or: true, that: true, the: true, this: true, to: true, und: true,
  was: true, what: true, when: true, where: true, who: true, will: true,
  with: true, www: true,
};

/** True when any whitespace-delimited word is an InnoDB stopword. */
function hasStopword(phrase: string): boolean {
  return phrase
    .toLowerCase()
    .split(/\s+/)
    .some((word) => INNODB_STOPWORDS[word] === true);
}

/** A content predicate; `fulltext` records which strategy produced it. */
interface ContentCondition {
  sql: string;
  params: [string];
  fulltext: boolean;
}

/** Literal substring predicate used when the index cannot answer reliably. */
function likeContentCondition(query: string): ContentCondition {
  // LIKE keeps the raw query, including its leading/trailing spaces, so a
  // literal search behaves exactly as it did before the index existed.
  return {
    sql: `m.content LIKE ? ESCAPE '\\\\'`,
    params: [`%${escapeLike(query)}%`],
    fulltext: false,
  };
}

/**
 * Builds the content predicate shared by room and global search. The SQL and
 * its parameter are returned together so callers cannot drift them apart.
 */
function contentCondition(query: string): ContentCondition {
  const phrase = query.trim();
  if (phrase.length >= 2 && FULLTEXT_QUERY.test(phrase) && !hasStopword(phrase)) {
    // Quoting makes BOOLEAN MODE treat the input as one phrase: "alpha beta"
    // must stay adjacent and in order instead of matching either word
    // anywhere. FULLTEXT_QUERY rejects `"`, so the phrase needs no escaping.
    return {
      sql: 'MATCH(m.content) AGAINST (? IN BOOLEAN MODE)',
      params: [`"${phrase}"`],
      fulltext: true,
    };
  }
  return likeContentCondition(query);
}

/** Optional room-search narrowing, AND-ed with the content query. */
export interface RoomSearchFilters {
  /** Exact message sender id. */
  senderId?: number;
  /** Inclusive lower bound as a UTC calendar day (`YYYY-MM-DD`). */
  from?: string;
  /** Inclusive upper bound as a UTC calendar day (`YYYY-MM-DD`). */
  to?: string;
}

/** One page of room search plus whether another page exists below it. */
export interface RoomSearchPage {
  messages: MessageDTO[];
  hasMore: boolean;
}

const ROOM_SEARCH_MAX_LIMIT = 50;

/**
 * One page of room matches, newest first, plus `hasMore`. `offset` counts
 * matches already returned (the length of the caller's current result list),
 * not raw messages: filters and deleted/streaming rows never consume it.
 */
export async function searchMessagesPage(
  roomId: number,
  query: string,
  limit = 20,
  offset = 0,
  filters: RoomSearchFilters = {},
): Promise<RoomSearchPage> {
  const pageSize = Math.min(Math.max(limit, 1), ROOM_SEARCH_MAX_LIMIT);
  const safeOffset = Math.max(offset, 0);

  // Conditions and params grow together so every filter keeps its own
  // placeholder; the caller may pass any subset of senderId/from/to. They are
  // rebuilt per attempt so the LIKE retry cannot inherit the MATCH parameter.
  const run = async (
    content: ContentCondition,
    fetchLimit: number,
    rowOffset: number,
  ): Promise<RowDataPacket[]> => {
    const conditions = [
      'm.room_id = ?',
      content.sql,
      `m.status <> 'streaming'`,
      'm.deleted_at IS NULL',
    ];
    const params: Array<string | number> = [roomId, ...content.params];

    if (filters.senderId !== undefined) {
      conditions.push('m.sender_id = ?');
      params.push(filters.senderId);
    }
    // `created_at` is a UTC DATETIME (the pool runs with `timezone: 'Z'`), so
    // the day window is plain string comparison: `from` starts at midnight and
    // `to` stays inclusive by excluding the next midnight.
    if (filters.from) {
      conditions.push('m.created_at >= ?');
      params.push(`${filters.from} 00:00:00.000`);
    }
    if (filters.to) {
      conditions.push('m.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      params.push(`${filters.to} 00:00:00.000`);
    }

    params.push(fetchLimit, rowOffset);

    const [rows] = await pool.query<RowDataPacket[]>(
      `${MESSAGE_SELECT}
       WHERE ${conditions.join('\n       AND ')}
       ORDER BY m.seq DESC
       LIMIT ? OFFSET ?`,
      params,
    );
    return rows;
  };

  // `seq` is unique within a room, so ORDER BY it is a stable page key: offset
  // N always skips exactly the N matches earlier pages returned. One extra row
  // reveals hasMore without a second COUNT over the same filters.
  const content = contentCondition(query);
  let rows = await run(content, pageSize + 1, safeOffset);
  // A non-stopword query can still miss the index: the ngram parser also
  // drops bigrams that merely contain a stopword ("wi" never gets indexed).
  // Only an empty index result pays for the literal scan; a real hit runs
  // once. Stopword queries never reach here, they start on the LIKE path.
  if (content.fulltext && rows.length === 0) {
    // An empty first page can only be a miss. A later page is ambiguous, so
    // probe page one: no index hit anywhere means the whole query must be
    // read literally, otherwise the page after a LIKE-served first page would
    // wrongly look like the end of the results.
    const missedIndex = safeOffset === 0 || (await run(content, 1, 0)).length === 0;
    if (missedIndex) {
      rows = await run(likeContentCondition(query), pageSize + 1, safeOffset);
    }
  }
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize).map(mapMessage);
  return {
    messages: await attachAttachments(await attachPolls(await attachReactions(page))),
    hasMore,
  };
}

/** Every room match in page order (seq DESC), for callers that page themselves. */
export async function searchMessages(
  roomId: number,
  query: string,
  limit = 20,
  filters: RoomSearchFilters = {},
): Promise<MessageDTO[]> {
  return (await searchMessagesPage(roomId, query, limit, 0, filters)).messages;
}

export interface GlobalMessageDTO extends MessageDTO {
  roomName: string;
}

export interface GlobalSearchResult {
  messages: GlobalMessageDTO[];
  total: number;
}

export interface GlobalSearchOptions {
  limit?: number;
  offset?: number;
  /** Restricts the search to one room; the caller must be a member of it. */
  roomId?: number;
  /** Exact username match on the message sender. */
  sender?: string;
  /** Exclusive upper bound on created_at (ISO 8601 or YYYY-MM-DD). */
  before?: string;
  /** Exclusive lower bound on created_at (ISO 8601 or YYYY-MM-DD). */
  after?: string;
}

/**
 * Searches every room the user has joined. Membership is enforced by the
 * room_members join, so private rooms the user never joined are invisible.
 * Optional roomId/sender/before/after narrow the result set further; the
 * roomId variant additionally rejects rooms the user is not a member of.
 */
export async function searchAllMessages(
  userId: number,
  query: string,
  options: GlobalSearchOptions = {},
): Promise<GlobalSearchResult> {
  const cappedLimit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const safeOffset = Math.max(options.offset ?? 0, 0);

  if (options.roomId !== undefined) {
    await assertMember(options.roomId, userId);
  }

  const membership = 'JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = ?';

  // The WHERE clause and its params are rebuilt per attempt so the LIKE retry
  // keeps the same membership and filters with a different content param.
  const buildFilters = (content: ContentCondition) => {
    const conditions = [
      content.sql,
      `m.status <> 'streaming'`,
      `m.deleted_at IS NULL`,
    ];
    const params: Array<string | number | Date> = [userId, ...content.params];

    if (options.roomId !== undefined) {
      conditions.push('m.room_id = ?');
      params.push(options.roomId);
    }
    if (options.sender !== undefined) {
      conditions.push('u.username = ?');
      params.push(options.sender);
    }
    if (options.after !== undefined) {
      conditions.push('m.created_at > ?');
      params.push(new Date(options.after));
    }
    if (options.before !== undefined) {
      conditions.push('m.created_at < ?');
      params.push(new Date(options.before));
    }

    return { filters: `WHERE ${conditions.join('\n       AND ')}`, params };
  };

  const countMessages = async (
    filters: string,
    params: Array<string | number | Date>,
  ): Promise<number> => {
    const [countRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       JOIN rooms r ON r.id = m.room_id
       ${membership}
       ${filters}`,
      params,
    );
    return Number(countRows[0]?.total ?? 0);
  };

  const content = contentCondition(query);
  let { filters, params } = buildFilters(content);
  let total = await countMessages(filters, params);

  // A silent ngram miss would otherwise report zero hits for text that is
  // literally present (see searchMessages). Retry the same membership and
  // filters with the LIKE predicate only when the index reported nothing; a
  // real hit keeps the first result and total.
  if (content.fulltext && total === 0) {
    ({ filters, params } = buildFilters(likeContentCondition(query)));
    total = await countMessages(filters, params);
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT m.id, m.seq, m.room_id, m.sender_id, m.sender_type, m.content, m.kind, m.status,
            m.reply_to_id, m.client_msg_id, m.created_at,
            m.edited_at, m.deleted_at, m.pinned_at, m.pinned_by,
            m.forwarded_from_room_id, m.forwarded_from_room_name, m.forwarded_from_sender_name,
            m.preview_url, m.preview_title, m.preview_description, m.preview_site,
            u.display_name, u.avatar, r.name AS room_name
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     JOIN rooms r ON r.id = m.room_id
     ${membership}
     ${filters}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT ? OFFSET ?`,
    [...params, cappedLimit, safeOffset],
  );

  const withReactions = await attachAttachments(
    await attachPolls(await attachReactions(rows.map(mapMessage))),
  );
  const messages = withReactions.map((message, index) => ({
    ...message,
    roomName: String(rows[index].room_name),
  }));
  return { messages, total };
}

export interface MessageEditEntry {
  oldContent: string;
  editedBy: number;
  editorName: string;
  editedAt: string;
}

export interface MessageEditHistory {
  current: string;
  edits: MessageEditEntry[];
}

/**
 * Revisions retained per message. Every edit writes the full previous content,
 * so unbounded history would let one message grow without limit; pruning runs
 * in the same transaction as the insert, leaving exactly the newest revisions.
 */
export const MESSAGE_EDIT_HISTORY_LIMIT = 50;

export async function editMessage(
  roomId: number,
  seq: number,
  userId: number,
  content: string,
): Promise<MessageDTO> {
  const message = await requireMessageBySeq(roomId, seq);
  if (message.deleted) {
    throw conflict('MESSAGE_DELETED', 'Message has been deleted');
  }
  if (message.senderId !== userId) {
    throw forbidden('NOT_SENDER', 'Only the sender can edit this message');
  }
  if (message.content === content) {
    return message;
  }
  await withTransaction(async (conn) => {
    // Re-read under a row lock so two concurrent edits cannot both archive the
    // same revision; the version replaced here is the one actually stored.
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT content FROM messages WHERE id = ? FOR UPDATE',
      [message.id],
    );
    const previous = rows[0] ? String(rows[0].content ?? '') : null;
    if (previous === null || previous === content) {
      return;
    }
    await conn.execute(
      `INSERT INTO message_edits (message_id, room_id, old_content, edited_by)
       VALUES (?, ?, ?, ?)`,
      [message.id, message.roomId, previous, userId],
    );
    // Keep only the newest revisions. The messages row is locked above, so two
    // concurrent edits of the same message cannot prune each other's rows; the
    // derived table works around MySQL's self-reference limit on DELETE.
    await conn.execute(
      `DELETE FROM message_edits
       WHERE message_id = ?
         AND id NOT IN (
           SELECT id FROM (
             SELECT id FROM message_edits
             WHERE message_id = ?
             ORDER BY edited_at DESC, id DESC
             LIMIT ?
           ) AS keep
         )`,
      [message.id, message.id, MESSAGE_EDIT_HISTORY_LIMIT],
    );
    await conn.execute(
      'UPDATE messages SET content = ?, edited_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
      [content, message.id],
    );
  });
  return requireMessageBySeq(roomId, seq);
}

/**
 * Chronological edit history of a message, oldest revision first. At most
 * {@link MESSAGE_EDIT_HISTORY_LIMIT} revisions are returned: the newest ones,
 * read newest-first and re-ordered, so legacy rows written before pruning
 * existed cannot inflate the response. A deleted message keeps its row, but its
 * content is hidden everywhere else, so the history is reported as empty rather
 * than exposing pre-deletion revisions.
 */
export async function listMessageEdits(
  roomId: number,
  seq: number,
): Promise<MessageEditHistory> {
  const message = await requireMessageBySeq(roomId, seq);
  if (message.deleted) {
    return { current: '', edits: [] };
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT recent.old_content, recent.edited_by, recent.edited_at, recent.display_name
     FROM (
       SELECT e.id, e.old_content, e.edited_by, e.edited_at, u.display_name
       FROM message_edits e
       JOIN users u ON u.id = e.edited_by
       WHERE e.message_id = ?
       ORDER BY e.edited_at DESC, e.id DESC
       LIMIT ?
     ) AS recent
     ORDER BY recent.edited_at ASC, recent.id ASC`,
    [message.id, MESSAGE_EDIT_HISTORY_LIMIT],
  );
  return {
    current: message.content,
    edits: rows.map((row) => ({
      oldContent: String(row.old_content ?? ''),
      editedBy: Number(row.edited_by),
      editorName: String(row.display_name ?? ''),
      editedAt: toIso(row.edited_at),
    })),
  };
}

export async function deleteMessage(
  roomId: number,
  seq: number,
  userId: number,
  canModerate: boolean,
): Promise<MessageDTO> {
  const message = await requireMessageBySeq(roomId, seq);
  if (message.senderId !== userId && !canModerate) {
    throw forbidden('NOT_PERMITTED', 'Only the sender or a moderator can delete this message');
  }
  if (message.deleted) {
    return message;
  }
  await pool.execute(
    'UPDATE messages SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND deleted_at IS NULL',
    [message.id],
  );
  return requireMessageBySeq(roomId, seq);
}

export async function toggleReaction(
  roomId: number,
  seq: number,
  userId: number,
  emoji: string,
): Promise<MessageDTO> {
  const message = await requireMessageBySeq(roomId, seq);
  if (message.deleted) {
    throw conflict('MESSAGE_DELETED', 'Message has been deleted');
  }
  await withTransaction(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
      [message.id, userId, emoji],
    );
    if (rows[0]) {
      await conn.execute(
        'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
        [message.id, userId, emoji],
      );
    } else {
      await conn.execute(
        'INSERT IGNORE INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)',
        [message.id, userId, emoji],
      );
    }
  });
  return requireMessageBySeq(roomId, seq);
}

export async function pinMessage(
  roomId: number,
  seq: number,
  userId: number,
): Promise<MessageDTO> {
  const message = await requireMessageBySeq(roomId, seq);
  if (message.deleted) {
    throw conflict('MESSAGE_DELETED', 'Message has been deleted');
  }
  await pool.execute(
    'UPDATE messages SET pinned_at = CURRENT_TIMESTAMP(3), pinned_by = ? WHERE id = ?',
    [userId, message.id],
  );
  return requireMessageBySeq(roomId, seq);
}

export async function unpinMessage(roomId: number, seq: number): Promise<MessageDTO> {
  const message = await requireMessageBySeq(roomId, seq);
  await pool.execute('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?', [
    message.id,
  ]);
  return requireMessageBySeq(roomId, seq);
}

export async function listPinned(roomId: number, limit = 20): Promise<MessageDTO[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${MESSAGE_SELECT}
     WHERE m.room_id = ? AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
     ORDER BY m.pinned_at DESC
     LIMIT ?`,
    [roomId, Math.min(Math.max(limit, 1), 100)],
  );
  return attachAttachments(await attachPolls(await attachReactions(rows.map(mapMessage))));
}

export async function sweepStreaming(): Promise<void> {
  await pool.execute("UPDATE messages SET status = 'error' WHERE status = 'streaming'");
}

/** Epoch millis of the member's latest message in a room, or null. */
export async function getLastUserMessageAt(
  roomId: number,
  userId: number,
): Promise<number | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT created_at FROM messages WHERE room_id = ? AND sender_id = ? ORDER BY seq DESC LIMIT 1',
    [roomId, userId],
  );
  const row = rows[0];
  return row ? new Date(row.created_at).getTime() : null;
}

/**
 * Applies the room's slow-mode window and the shared per-member message rate
 * limit, in the same order and with the same API errors as socket
 * `message:send`. HTTP poll creation goes through here so a poll costs the
 * sender exactly what a text message costs.
 */
export async function assertCanSendMessage(roomId: number, userId: number): Promise<void> {
  // Slow mode is a room setting, not a global rate-limit toggle: compare
  // against the member's latest message so it still enforces when
  // RATE_LIMIT_ENABLED=false and survives process restarts.
  const slowModeSeconds = await getRoomSlowMode(roomId);
  if (slowModeSeconds > 0) {
    const lastAt = await getLastUserMessageAt(roomId, userId);
    const elapsed = lastAt == null ? Infinity : Date.now() - lastAt;
    const windowMs = slowModeSeconds * 1000;
    if (elapsed < windowMs) {
      const wait = Math.ceil((windowMs - elapsed) / 1000);
      throw new ApiError(
        429,
        'SLOW_MODE',
        `慢速模式：每 ${slowModeSeconds} 秒只能发送一条消息（还需等待 ${wait} 秒）`,
      );
    }
  }
  if (!(await checkRate(`msg:${userId}:${roomId}`, 10, 10_000))) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many messages');
  }
}
