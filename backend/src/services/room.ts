import { randomBytes } from 'node:crypto';
import { pool, withTransaction, type ResultSetHeader, type RowDataPacket } from '../db';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import type { MemberDTO, RoomSummary } from '../types';
import { isDuplicateError, toIso } from '../utils';
import { isOnline } from './presence';

const ROOM_SELECT = `
  SELECT r.id, r.name, r.topic, r.owner_id, r.is_public, r.invite_code, r.max_seq,
         rm.role, rm.last_read_seq,
         (SELECT COUNT(*) FROM room_members x WHERE x.room_id = r.id) AS member_count,
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
  SELECT r.id, r.name, r.topic, r.owner_id, r.is_public, r.invite_code, r.max_seq,
         NULL AS role, 0 AS last_read_seq,
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
  WHERE r.is_public = 1 AND rm.user_id IS NULL
`;

function mapRoom(row: RowDataPacket, userId: number, joined: boolean): RoomSummary {
  const lastSeq = row.last_seq == null ? null : Number(row.last_seq);
  return {
    id: Number(row.id),
    name: String(row.name),
    topic: String(row.topic ?? ''),
    ownerId: Number(row.owner_id),
    isPublic: Boolean(row.is_public),
    inviteCode: Number(row.owner_id) === userId && row.invite_code ? String(row.invite_code) : null,
    memberCount: Number(row.member_count ?? 0),
    unreadCount: joined
      ? Math.max(Number(row.max_seq) - Number(row.last_read_seq ?? 0), 0)
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
  };
}

export async function listRooms(userId: number): Promise<{
  mine: RoomSummary[];
  public: RoomSummary[];
}> {
  const [mineRows] = await pool.query<RowDataPacket[]>(
    `${ROOM_SELECT} WHERE rm.user_id = ? ORDER BY r.id DESC`,
    [userId],
  );
  const [publicRows] = await pool.query<RowDataPacket[]>(
    `${PUBLIC_ROOM_SELECT} ORDER BY r.id DESC`,
    [userId],
  );
  return {
    mine: mineRows.map((row) => mapRoom(row, userId, true)),
    public: publicRows.map((row) => mapRoom(row, userId, false)),
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

export async function updateRoom(
  roomId: number,
  actorId: number,
  actorRole: 'admin' | 'user',
  patch: { name?: string; topic?: string },
): Promise<RoomSummary> {
  await assertMember(roomId, actorId);
  const ownerId = await getRoomOwnerId(roomId);
  if (actorRole !== 'admin' && ownerId !== actorId) {
    throw forbidden('ROOM_OWNER_REQUIRED', 'Only the room owner can edit the room');
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
  if (sets.length > 0) {
    await pool.query(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`, [...params, roomId]);
  }
  return getRoomSummary(roomId, actorId);
}

export async function leaveRoom(userId: number, roomId: number): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT owner_id FROM rooms WHERE id = ?',
    [roomId],
  );
  const room = rows[0];
  if (!room) {
    throw notFound('ROOM_NOT_FOUND', 'Room not found');
  }
  if (Number(room.owner_id) === userId) {
    throw badRequest('OWNER_CANNOT_LEAVE', 'Room owner cannot leave');
  }
  await pool.execute(
    'DELETE FROM room_members WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
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

export async function touchRead(roomId: number, userId: number): Promise<void> {
  await pool.execute(
    `UPDATE room_members rm
     JOIN rooms r ON r.id = rm.room_id
     SET rm.last_read_seq = r.max_seq
     WHERE rm.room_id = ? AND rm.user_id = ?`,
    [roomId, userId],
  );
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

export async function listMembers(roomId: number): Promise<MemberDTO[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT u.id, u.username, u.display_name, u.avatar, u.type, rm.role
     FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     LEFT JOIN bots b ON b.user_id = u.id AND u.type = 'bot'
     WHERE rm.room_id = ? AND (u.type <> 'bot' OR b.enabled = 1)
     ORDER BY FIELD(rm.role, 'owner', 'admin', 'member', 'bot'), u.id`,
    [roomId],
  );
  return rows.map((row) => ({
    userId: Number(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    avatar: row.avatar ? String(row.avatar) : null,
    type: row.type,
    role: row.role,
    online: isOnline(roomId, Number(row.id)),
  }));
}
