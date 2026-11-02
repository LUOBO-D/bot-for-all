import { pool, withTransaction, type RowDataPacket } from '../db';
import { badRequest, notFound } from '../errors';
import type { MemberDTO } from '../types';
import { toIso } from '../utils';
import { createNotification } from './notifications';
import { getMember } from './room';

export interface JoinRequestDTO {
  userId: number;
  username: string;
  displayName: string;
  createdAt: string;
}

const JOIN_REQUEST_SELECT = `
  SELECT jr.user_id, jr.created_at, u.username, u.display_name
  FROM room_join_requests jr
  JOIN users u ON u.id = jr.user_id
`;

function mapJoinRequest(row: RowDataPacket): JoinRequestDTO {
  return {
    userId: Number(row.user_id),
    username: String(row.username),
    displayName: String(row.display_name),
    createdAt: toIso(row.created_at),
  };
}

async function getJoinRequest(roomId: number, userId: number): Promise<JoinRequestDTO> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${JOIN_REQUEST_SELECT} WHERE jr.room_id = ? AND jr.user_id = ?`,
    [roomId, userId],
  );
  const row = rows[0];
  if (!row) {
    throw notFound('JOIN_REQUEST_NOT_FOUND', 'Join request not found');
  }
  return mapJoinRequest(row);
}

/**
 * Asks the owner of a private room for admission. Repeated requests while one
 * is already pending are idempotent and do not re-notify the owner; a request
 * that was previously rejected can be filed again.
 */
export async function requestJoin(
  roomId: number,
  applicant: { id: number; displayName: string },
): Promise<JoinRequestDTO> {
  const outcome = await withTransaction(async (conn) => {
    const [roomRows] = await conn.query<RowDataPacket[]>(
      'SELECT id, owner_id, is_public FROM rooms WHERE id = ?',
      [roomId],
    );
    const room = roomRows[0];
    if (!room) {
      throw notFound('ROOM_NOT_FOUND', 'Room not found');
    }
    const [memberRows] = await conn.query<RowDataPacket[]>(
      'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, applicant.id],
    );
    if (memberRows[0]) {
      throw badRequest('ALREADY_MEMBER', 'Already a member of this room');
    }
    if (room.is_public) {
      throw badRequest('PUBLIC_ROOM', 'Public rooms can be joined directly');
    }

    const [requestRows] = await conn.query<RowDataPacket[]>(
      `SELECT status FROM room_join_requests
       WHERE room_id = ? AND user_id = ? FOR UPDATE`,
      [roomId, applicant.id],
    );
    if (requestRows[0]?.status === 'pending') {
      return { ownerId: Number(room.owner_id), notify: false };
    }

    await conn.execute(
      `INSERT INTO room_join_requests (room_id, user_id, status)
       VALUES (?, ?, 'pending')
       ON DUPLICATE KEY UPDATE
         status = 'pending',
         created_at = CURRENT_TIMESTAMP(3),
         updated_at = CURRENT_TIMESTAMP(3)`,
      [roomId, applicant.id],
    );
    return { ownerId: Number(room.owner_id), notify: true };
  });

  if (outcome.notify) {
    await createNotification({
      userId: outcome.ownerId,
      type: 'join_request',
      roomId,
      actorId: applicant.id,
      detail: `${applicant.displayName} 请求加入房间`,
    });
  }
  return getJoinRequest(roomId, applicant.id);
}

/** Pending requests for a room, oldest first. Callers enforce moderator rights. */
export async function listJoinRequests(roomId: number): Promise<JoinRequestDTO[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${JOIN_REQUEST_SELECT}
     WHERE jr.room_id = ? AND jr.status = 'pending'
     ORDER BY jr.created_at, jr.user_id`,
    [roomId],
  );
  return rows.map(mapJoinRequest);
}

/**
 * Admits the applicant as a regular member and notifies them. Membership and
 * status flip share one transaction so a crash cannot leave them inconsistent.
 */
export async function approveJoinRequest(
  roomId: number,
  applicantId: number,
  actor: { id: number },
): Promise<MemberDTO> {
  await withTransaction(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT status FROM room_join_requests
       WHERE room_id = ? AND user_id = ? FOR UPDATE`,
      [roomId, applicantId],
    );
    const request = rows[0];
    if (!request) {
      throw notFound('JOIN_REQUEST_NOT_FOUND', 'Join request not found');
    }
    if (request.status !== 'pending') {
      throw badRequest('REQUEST_NOT_PENDING', 'Join request is not pending');
    }
    await conn.execute(
      `INSERT IGNORE INTO room_members (room_id, user_id, role) VALUES (?, ?, 'member')`,
      [roomId, applicantId],
    );
    await conn.execute(
      `UPDATE room_join_requests SET status = 'approved'
       WHERE room_id = ? AND user_id = ?`,
      [roomId, applicantId],
    );
  });

  const member = await getMember(roomId, applicantId);
  if (!member) {
    throw notFound('MEMBER_NOT_FOUND', 'Member not found after approval');
  }
  await createNotification({
    userId: applicantId,
    type: 'join_approved',
    roomId,
    actorId: actor.id,
    detail: '你的加入申请已通过',
  });
  return member;
}

export type JoinRequestDecision = 'approve' | 'reject';

/**
 * Applies one decision to a whole batch of pending requests. Every requested
 * request must exist and still be pending: the rows are locked and validated
 * before anything is written, so an unknown or already-handled id rolls the
 * entire batch back instead of applying it partially. Notifications go out
 * one per applicant after the commit; the caller broadcasts the roster change
 * once for the batch.
 */
export async function decideJoinRequestsBulk(
  roomId: number,
  userIds: number[],
  decision: JoinRequestDecision,
  actor: { id: number },
): Promise<{ updated: number }> {
  const targets = [...new Set(userIds)];
  if (targets.length === 0) {
    throw badRequest('INVALID_TARGET', 'userIds must contain at least one request');
  }

  const placeholders = targets.map(() => '?').join(', ');
  await withTransaction(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT user_id, status FROM room_join_requests
       WHERE room_id = ? AND user_id IN (${placeholders})
       FOR UPDATE`,
      [roomId, ...targets],
    );
    const statusByUser = new Map(rows.map((row) => [Number(row.user_id), String(row.status)]));
    if (targets.some((userId) => !statusByUser.has(userId))) {
      throw notFound('JOIN_REQUEST_NOT_FOUND', 'Join request not found');
    }
    if (targets.some((userId) => statusByUser.get(userId) !== 'pending')) {
      throw badRequest('REQUEST_NOT_PENDING', 'Join request is not pending');
    }

    if (decision === 'approve') {
      const values = targets.map(() => "(?, ?, 'member')").join(', ');
      await conn.query(
        `INSERT IGNORE INTO room_members (room_id, user_id, role) VALUES ${values}`,
        targets.flatMap((userId) => [roomId, userId]),
      );
    }
    await conn.query(
      `UPDATE room_join_requests SET status = ?
       WHERE room_id = ? AND user_id IN (${placeholders})`,
      [decision === 'approve' ? 'approved' : 'rejected', roomId, ...targets],
    );
  });

  const approved = decision === 'approve';
  for (const userId of targets) {
    await createNotification({
      userId,
      type: approved ? 'join_approved' : 'join_rejected',
      roomId,
      actorId: actor.id,
      detail: approved ? '你的加入申请已通过' : '你的加入申请被拒绝',
    });
  }
  return { updated: targets.length };
}

/** Declines a pending request and notifies the applicant; never touches membership. */
export async function rejectJoinRequest(
  roomId: number,
  applicantId: number,
  actor: { id: number },
): Promise<void> {
  await withTransaction(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT status FROM room_join_requests
       WHERE room_id = ? AND user_id = ? FOR UPDATE`,
      [roomId, applicantId],
    );
    const request = rows[0];
    if (!request) {
      throw notFound('JOIN_REQUEST_NOT_FOUND', 'Join request not found');
    }
    if (request.status !== 'pending') {
      throw badRequest('REQUEST_NOT_PENDING', 'Join request is not pending');
    }
    await conn.execute(
      `UPDATE room_join_requests SET status = 'rejected'
       WHERE room_id = ? AND user_id = ?`,
      [roomId, applicantId],
    );
  });

  await createNotification({
    userId: applicantId,
    type: 'join_rejected',
    roomId,
    actorId: actor.id,
    detail: '你的加入申请被拒绝',
  });
}
