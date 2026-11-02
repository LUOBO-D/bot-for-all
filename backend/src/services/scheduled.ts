import type { Server } from 'socket.io';
import { pool, withTransaction, type ResultSetHeader, type RowDataPacket } from '../db';
import { ApiError, badRequest, notFound } from '../errors';
import { logger } from '../logger';
import { roomKey } from '../socket';
import type { MessageDTO } from '../types';
import { toIso } from '../utils';
import { assertCanSendMessage, createMessage } from './message';
import { notifyMentions } from './notifications';
import { getRoomSlowMode } from './room';

/** Column width of `scheduled_messages.content`; the route validates against it too. */
export const SCHEDULED_CONTENT_MAX = 4000;

/** Pending rows one user may queue in a single room. */
export const SCHEDULED_MAX_PENDING = 20;

/** A schedule must land strictly after this lead time, so "now" is rejected. */
export const SCHEDULED_MIN_LEAD_MS = 1_000;

/** Upper bound of the scheduling window: 30 days. */
export const SCHEDULED_MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows the worker claims per tick; keeps one slow tick from starving the loop. */
const SCHEDULED_BATCH = 50;

/**
 * Shortest push applied when the send gate defers a due row. Slow mode can ask
 * for a longer pause; never shorter, so a deferred row cannot spin the tick.
 */
const SCHEDULED_DEFER_MIN_MS = 5_000;

export type ScheduledStatus = 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed';

/** What a client sees: no sender/status, because it is always their own pending row. */
export interface ScheduledMessageDTO {
  id: number;
  content: string;
  sendAt: string;
  createdAt: string;
}

const SCHEDULED_SELECT = `
  SELECT id, content, send_at, created_at
  FROM scheduled_messages
`;

function mapScheduled(row: RowDataPacket): ScheduledMessageDTO {
  return {
    id: Number(row.id),
    content: String(row.content ?? ''),
    sendAt: toIso(row.send_at),
    createdAt: toIso(row.created_at),
  };
}

/**
 * Parses and range-checks `sendAt`. Kept here (not only in the route) so the
 * rules cannot drift between the HTTP layer and any future caller.
 */
export function parseSendAt(raw: string, now: number = Date.now()): Date {
  const sendAt = new Date(raw);
  if (Number.isNaN(sendAt.getTime())) {
    throw badRequest('INVALID_SEND_AT', 'sendAt must be an ISO 8601 timestamp');
  }
  const delta = sendAt.getTime() - now;
  if (delta < SCHEDULED_MIN_LEAD_MS) {
    throw badRequest('INVALID_SEND_AT', 'sendAt must be at least 1 second in the future');
  }
  if (delta > SCHEDULED_MAX_HORIZON_MS) {
    throw badRequest('INVALID_SEND_AT', 'sendAt must be at most 30 days in the future');
  }
  return sendAt;
}

export interface ScheduleMessageInput {
  roomId: number;
  senderId: number;
  content: string;
  sendAt: Date;
}

/**
 * Queues one message. The pending cap is enforced inside the same transaction
 * that inserts, with the caller's pending rows locked, so a burst of parallel
 * requests cannot slip past the limit.
 */
export async function scheduleMessage(
  input: ScheduleMessageInput,
): Promise<ScheduledMessageDTO> {
  const id = await withTransaction(async (conn) => {
    const [pending] = await conn.execute<RowDataPacket[]>(
      `SELECT id FROM scheduled_messages
        WHERE room_id = ? AND sender_id = ? AND status = 'pending'
        FOR UPDATE`,
      [input.roomId, input.senderId],
    );
    if (pending.length >= SCHEDULED_MAX_PENDING) {
      throw badRequest(
        'TOO_MANY_SCHEDULED',
        `At most ${SCHEDULED_MAX_PENDING} pending scheduled messages per room`,
      );
    }
    const [result] = await conn.execute<ResultSetHeader>(
      `INSERT INTO scheduled_messages (room_id, sender_id, content, send_at)
       VALUES (?, ?, ?, ?)`,
      [input.roomId, input.senderId, input.content, input.sendAt],
    );
    return result.insertId;
  });

  const [rows] = await pool.query<RowDataPacket[]>(`${SCHEDULED_SELECT} WHERE id = ?`, [id]);
  if (!rows[0]) {
    throw notFound('SCHEDULED_NOT_FOUND', 'Scheduled message not found');
  }
  return mapScheduled(rows[0]);
}

/** The caller's still-pending rows in one room, earliest first. */
export async function listScheduled(
  roomId: number,
  senderId: number,
): Promise<ScheduledMessageDTO[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${SCHEDULED_SELECT}
      WHERE room_id = ? AND sender_id = ? AND status = 'pending'
      ORDER BY send_at ASC, id ASC`,
    [roomId, senderId],
  );
  return rows.map(mapScheduled);
}

/**
 * Cancels one of the caller's own pending rows. Someone else's row is a 404
 * (its existence is not disclosed); a row already sent/failed/cancelled is a
 * 400 because the caller did find it.
 */
export async function cancelScheduled(
  roomId: number,
  senderId: number,
  id: number,
): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT status FROM scheduled_messages WHERE id = ? AND room_id = ? AND sender_id = ?',
    [id, roomId, senderId],
  );
  if (!rows[0]) {
    throw notFound('SCHEDULED_NOT_FOUND', 'Scheduled message not found');
  }
  if (String(rows[0].status) !== 'pending') {
    throw badRequest('NOT_PENDING', 'Scheduled message is no longer pending');
  }
  // Conditional so a worker that claimed the row in between still wins.
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ? AND status = 'pending'`,
    [id],
  );
  if (result.affectedRows === 0) {
    throw badRequest('NOT_PENDING', 'Scheduled message is no longer pending');
  }
}

export interface UpdateScheduledInput {
  roomId: number;
  senderId: number;
  id: number;
  /** Already trimmed by the route; omitted when the caller only moves the time. */
  content?: string;
  /** Omitted when the caller only edits the text. */
  sendAt?: Date;
}

/**
 * Edits one of the caller's own pending rows. The row is locked (`FOR UPDATE`)
 * for the whole transaction, so the worker cannot claim it between the status
 * check and the update. Another member's row is a 404, exactly like a missing
 * one; a row that left `pending` is a 400 because the caller did find it.
 */
export async function updateScheduled(
  input: UpdateScheduledInput,
): Promise<ScheduledMessageDTO> {
  const assignments: string[] = [];
  const params: (string | Date)[] = [];
  if (input.content !== undefined) {
    assignments.push('content = ?');
    params.push(input.content);
  }
  if (input.sendAt !== undefined) {
    assignments.push('send_at = ?');
    params.push(input.sendAt);
  }
  if (assignments.length === 0) {
    throw badRequest('INVALID_INPUT', 'At least one of content or sendAt is required');
  }

  return withTransaction(async (conn) => {
    const [rows] = await conn.execute<RowDataPacket[]>(
      `SELECT status FROM scheduled_messages
        WHERE id = ? AND room_id = ? AND sender_id = ?
        FOR UPDATE`,
      [input.id, input.roomId, input.senderId],
    );
    const row = rows[0];
    if (!row) {
      throw notFound('SCHEDULED_NOT_FOUND', 'Scheduled message not found');
    }
    if (String(row.status) !== 'pending') {
      throw badRequest('NOT_PENDING', 'Scheduled message is no longer pending');
    }
    await conn.execute<ResultSetHeader>(
      `UPDATE scheduled_messages SET ${assignments.join(', ')} WHERE id = ?`,
      [...params, input.id],
    );
    const [updated] = await conn.query<RowDataPacket[]>(
      `${SCHEDULED_SELECT} WHERE id = ?`,
      [input.id],
    );
    if (!updated[0]) {
      throw notFound('SCHEDULED_NOT_FOUND', 'Scheduled message not found');
    }
    return mapScheduled(updated[0]);
  });
}

/** Flips `sending` rows left behind by a crash back to `pending`; returns the count. */
export async function recoverStuckScheduled(): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE scheduled_messages SET status = 'pending' WHERE status = 'sending'`,
  );
  return result.affectedRows;
}

export interface ScheduledWorkerOptions {
  io: Server;
  /**
   * Bot gateway hook: the room's bots react to a scheduled message exactly as
   * they would to one typed in the socket. Fire-and-forget by contract.
   */
  onUserMessage?: (roomId: number, message: MessageDTO) => Promise<void> | void;
  /** Clock override for tests; defaults to now. */
  now?: Date;
  limit?: number;
}

export interface ScheduledTickResult {
  /**
   * Rows this tick claimed from `pending`: always
   * `sent + failed + deferred` (cancelled rows are part of `failed`).
   */
  processed: number;
  sent: number;
  failed: number;
  /**
   * Rows the shared send gate pushed back to `pending` with a later `send_at`
   * (room slow mode or the per-member rate limit). They were claimed but not
   * delivered; absent when no row was deferred.
   */
  deferred?: number;
  /**
   * Rows whose sender was banned or no longer a member when their turn came.
   * They are also counted in `failed` (they were not delivered); the extra
   * field is only present when at least one row was cancelled.
   */
  cancelled?: number;
}

interface DueRow extends RowDataPacket {
  id: number;
  room_id: number;
  sender_id: number;
  content: string;
}

/**
 * Delivers every row whose `send_at` has passed. The claim is a conditional
 * UPDATE (`pending` -> `sending`), so overlapping ticks or a second process
 * never deliver the same row twice. Delivery uses `sched:<id>` as the client
 * message id: if a crash lands between creating the message and marking the row
 * sent, the retry after recovery reuses the existing message instead of
 * posting a duplicate.
 */
export async function processDueScheduled(
  options: ScheduledWorkerOptions,
): Promise<ScheduledTickResult> {
  const now = options.now ?? new Date();
  const [rows] = await pool.query<DueRow[]>(
    `SELECT id, room_id, sender_id, content
       FROM scheduled_messages
      WHERE status = 'pending' AND send_at <= ?
      ORDER BY send_at ASC, id ASC
      LIMIT ?`,
    [now, options.limit ?? SCHEDULED_BATCH],
  );

  const result: ScheduledTickResult = { processed: 0, sent: 0, failed: 0 };
  for (const row of rows) {
    const [claim] = await pool.execute<ResultSetHeader>(
      `UPDATE scheduled_messages SET status = 'sending' WHERE id = ? AND status = 'pending'`,
      [row.id],
    );
    if (claim.affectedRows === 0) {
      // Cancelled or claimed by a concurrent tick between the scan and here.
      continue;
    }
    result.processed += 1;
    const outcome = await deliverDue(row, options);
    if (outcome === 'sent') {
      result.sent += 1;
    } else if (outcome === 'deferred') {
      result.deferred = (result.deferred ?? 0) + 1;
    } else {
      result.failed += 1;
      if (outcome === 'cancelled') {
        result.cancelled = (result.cancelled ?? 0) + 1;
      }
    }
  }
  return result;
}

type DeliveryOutcome = 'sent' | 'failed' | 'cancelled' | 'deferred';

/**
 * True while the sender may still post to the room: the account is active and
 * the membership row exists. The route checked this when the row was queued,
 * but leaving, being kicked or being banned in between must win.
 */
async function senderCanStillPost(roomId: number, senderId: number): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT u.status, rm.user_id AS membership
       FROM users u
       LEFT JOIN room_members rm ON rm.room_id = ? AND rm.user_id = u.id
      WHERE u.id = ?`,
    [roomId, senderId],
  );
  const row = rows[0];
  return Boolean(row) && String(row.status) === 'active' && row.membership != null;
}

/** Delivers one claimed row, or cancels it when the sender lost the right to post. */
async function deliverDue(
  row: DueRow,
  options: ScheduledWorkerOptions,
): Promise<DeliveryOutcome> {
  const id = Number(row.id);
  const roomId = Number(row.room_id);
  const senderId = Number(row.sender_id);
  try {
    if (!(await senderCanStillPost(roomId, senderId))) {
      await pool.execute(
        `UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ? AND status = 'sending'`,
        [id],
      );
      logger.info(
        { scheduledId: id, roomId, senderId },
        'scheduled message cancelled: sender is inactive or no longer a member',
      );
      return 'cancelled';
    }
    // Membership is not enough: the row paid this gate when it was queued, but
    // the room's slow mode or the shared rate limit may have moved since. Two
    // rows due in the same tick would otherwise both post.
    await assertCanSendMessage(roomId, senderId);
    const created = await createMessage({
      roomId,
      senderId,
      senderType: 'user',
      content: String(row.content),
      clientMsgId: `sched:${id}`,
    });
    const { duplicate, ...message } = created;
    await pool.execute(
      `UPDATE scheduled_messages SET status = 'sent', sent_message_id = ?
        WHERE id = ? AND status = 'sending'`,
      [message.id, id],
    );
    if (duplicate) {
      // The message already exists from an interrupted earlier attempt, so the
      // room may already have seen it: marking it sent is enough.
      logger.warn({ scheduledId: id, messageId: message.id }, 'scheduled message already delivered');
      return 'sent';
    }
    options.io.to(roomKey(roomId)).emit('message:new', { roomId, message });
    void notifyMentions(options.io, roomId, message, {
      id: senderId,
      name: message.senderName,
    }).catch((error: unknown) => {
      logger.error({ err: error, roomId, scheduledId: id }, 'scheduled mention notification failed');
    });
    if (options.onUserMessage) {
      void Promise.resolve(options.onUserMessage(roomId, message)).catch((error: unknown) => {
        logger.error({ err: error, roomId, scheduledId: id }, 'scheduled bot trigger failed');
      });
    }
    return 'sent';
  } catch (error) {
    if (isDeferrableGateError(error)) {
      return deferDue(row, error.code);
    }
    logger.error({ err: error, roomId, scheduledId: id }, 'scheduled message delivery failed');
    await pool
      .execute(
        `UPDATE scheduled_messages SET status = 'failed' WHERE id = ? AND status = 'sending'`,
        [id],
      )
      .catch((updateError: unknown) => {
        logger.error({ err: updateError, scheduledId: id }, 'scheduled message status update failed');
      });
    return 'failed';
  }
}

/** Gate errors that are temporary: pushing the row back beats failing it. */
function isDeferrableGateError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError && (error.code === 'SLOW_MODE' || error.code === 'RATE_LIMITED')
  );
}

/**
 * Pushes a claimed row back to `pending` with a future `send_at` when the send
 * gate would have rejected it. A deferral keeps the message queued instead of
 * failing it: both conditions clear on their own, and the first tick past the
 * window delivers the row. Slow mode's own window sets the pause, never less
 * than {@link SCHEDULED_DEFER_MIN_MS}, so the tick cannot spin on one row.
 */
async function deferDue(row: DueRow, code: string): Promise<DeliveryOutcome> {
  const id = Number(row.id);
  const roomId = Number(row.room_id);
  let delayMs = SCHEDULED_DEFER_MIN_MS;
  if (code === 'SLOW_MODE') {
    try {
      delayMs = Math.max(delayMs, (await getRoomSlowMode(roomId)) * 1000);
    } catch (error) {
      // The room may have gone away since the membership check; the minimum
      // pause is still the right answer.
      logger.warn(
        { err: error, roomId, scheduledId: id },
        'could not read slow mode while deferring',
      );
    }
  }
  // Anchored to the wall clock like the gate itself, which compares `send_at`
  // and the sender's last message against real time.
  const sendAt = new Date(Date.now() + delayMs);
  try {
    await pool.execute(
      `UPDATE scheduled_messages SET status = 'pending', send_at = ?
        WHERE id = ? AND status = 'sending'`,
      [sendAt, id],
    );
  } catch (error) {
    // The row is still `sending`, so recoverStuckScheduled reclaims it later;
    // this tick must not report it as deferred because nothing was rescheduled.
    logger.error({ err: error, roomId, scheduledId: id }, 'scheduled message deferral failed');
    return 'failed';
  }
  logger.info(
    { scheduledId: id, roomId, code, sendAt, delayMs },
    'scheduled message deferred by the send gate',
  );
  return 'deferred';
}
