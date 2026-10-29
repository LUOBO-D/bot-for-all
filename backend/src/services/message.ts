import { pool, withTransaction, type ResultSetHeader, type RowDataPacket } from '../db';
import { conflict, forbidden, notFound } from '../errors';
import type { MessageDTO, MessageReaction, MessageStatus, SenderType } from '../types';
import { isDuplicateError, toIso } from '../utils';

const MESSAGE_SELECT = `
  SELECT m.id, m.seq, m.room_id, m.sender_id, m.sender_type, m.content, m.status,
         m.reply_to_id, m.client_msg_id, m.created_at,
         m.edited_at, m.deleted_at, m.pinned_at, m.pinned_by,
         u.display_name, u.avatar
  FROM messages m
  JOIN users u ON u.id = m.sender_id
`;

function mapMessage(row: RowDataPacket): MessageDTO {
  const deleted = row.deleted_at != null;
  return {
    id: Number(row.id),
    seq: Number(row.seq),
    roomId: Number(row.room_id),
    senderId: Number(row.sender_id),
    senderType: row.sender_type as SenderType,
    senderName: String(row.display_name),
    senderAvatar: row.avatar ? String(row.avatar) : null,
    content: deleted ? '' : String(row.content ?? ''),
    status: row.status as MessageStatus,
    replyToId: row.reply_to_id == null ? null : Number(row.reply_to_id),
    createdAt: toIso(row.created_at),
    editedAt: row.edited_at == null ? null : toIso(row.edited_at),
    deleted,
    pinned: row.pinned_at != null,
    pinnedBy: row.pinned_by == null ? null : Number(row.pinned_by),
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

export async function getMessageById(id: number): Promise<MessageDTO> {
  const [rows] = await pool.query<RowDataPacket[]>(`${MESSAGE_SELECT} WHERE m.id = ?`, [id]);
  const row = rows[0];
  if (!row) {
    throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
  }
  const [message] = await attachReactions([mapMessage(row)]);
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
  const [message] = await attachReactions([mapMessage(row)]);
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
  const [message] = await attachReactions([mapMessage(rows[0])]);
  return message;
}

export interface CreateMessageInput {
  roomId: number;
  senderId: number;
  senderType: SenderType;
  content: string;
  status?: MessageStatus;
  clientMsgId?: string | null;
  replyToId?: number | null;
}

export interface CreateMessageResult extends MessageDTO {
  duplicate: boolean;
}

export async function createMessage(input: CreateMessageInput): Promise<CreateMessageResult> {
  const status = input.status ?? 'done';
  try {
    const messageId = await withTransaction(async (conn) => {
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
           (room_id, seq, sender_id, sender_type, content, status, client_msg_id, reply_to_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.roomId,
          seq,
          input.senderId,
          input.senderType,
          input.content,
          status,
          input.clientMsgId ?? null,
          input.replyToId ?? null,
        ],
      );
      return insertResult.insertId;
    });
    return { ...(await getMessageById(messageId)), duplicate: false };
  } catch (error) {
    if (input.clientMsgId && isDuplicateError(error)) {
      const existing = await getByClientId(input.roomId, input.senderId, input.clientMsgId);
      if (existing) {
        return { ...existing, duplicate: true };
      }
    }
    throw error;
  }
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

  if (options.afterSeq != null) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `${MESSAGE_SELECT}
       WHERE m.room_id = ? AND m.seq > ?
       ORDER BY m.seq ASC
       LIMIT ?`,
      [roomId, options.afterSeq, limit],
    );
    return {
      messages: await attachReactions(rows.map(mapMessage)),
      hasMore: rows.length === limit,
    };
  }

  if (options.beforeSeq != null) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `${MESSAGE_SELECT}
       WHERE m.room_id = ? AND m.seq < ?
       ORDER BY m.seq DESC
       LIMIT ?`,
      [roomId, options.beforeSeq, limit],
    );
    return {
      messages: await attachReactions(rows.reverse().map(mapMessage)),
      hasMore: rows.length === limit,
    };
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `${MESSAGE_SELECT}
     WHERE m.room_id = ?
     ORDER BY m.seq DESC
     LIMIT ?`,
    [roomId, limit],
  );
  return {
    messages: await attachReactions(rows.reverse().map(mapMessage)),
    hasMore: rows.length === limit,
  };
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

export async function messageExistsInRoom(id: number, roomId: number): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT 1 FROM messages WHERE id = ? AND room_id = ?',
    [id, roomId],
  );
  return Boolean(rows[0]);
}

export async function searchMessages(
  roomId: number,
  query: string,
  limit = 20,
): Promise<MessageDTO[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${MESSAGE_SELECT}
     WHERE m.room_id = ?
       AND LOCATE(?, m.content) > 0
       AND m.status <> 'streaming'
       AND m.deleted_at IS NULL
     ORDER BY m.seq DESC
     LIMIT ?`,
    [roomId, query, Math.min(Math.max(limit, 1), 50)],
  );
  return attachReactions(rows.map(mapMessage));
}

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
  await pool.execute(
    'UPDATE messages SET content = ?, edited_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
    [content, message.id],
  );
  return requireMessageBySeq(roomId, seq);
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
  return attachReactions(rows.map(mapMessage));
}

export async function sweepStreaming(): Promise<void> {
  await pool.execute("UPDATE messages SET status = 'error' WHERE status = 'streaming'");
}
