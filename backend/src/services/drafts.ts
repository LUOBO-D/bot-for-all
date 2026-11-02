import { pool, type RowDataPacket } from '../db';
import { toIso } from '../utils';

/**
 * Per-user, per-room composer drafts. The row is private: two members of the
 * same room each have their own, and nothing is broadcast. The API caps the
 * body at {@link DRAFT_CONTENT_MAX}; an empty string clears the draft.
 */
export interface DraftDTO {
  content: string;
  updatedAt: string;
}

export const DRAFT_CONTENT_MAX = 4000;

/**
 * One entry of the cross-room draft box (`GET /me/drafts`). The room name is
 * joined in so the list is readable without loading every room first, and
 * `roomId` is what the client navigates back to.
 */
export interface DraftBoxItem {
  roomId: number;
  roomName: string;
  content: string;
  updatedAt: string;
}

/** The box is a glance, not an archive: newest 50 drafts is the whole list. */
export const DRAFT_BOX_LIMIT = 50;

interface DraftRow extends RowDataPacket {
  content: string;
  updated_at: Date | string;
}

interface DraftBoxRow extends DraftRow {
  room_id: number;
  room_name: string;
}

function mapDraft(row: DraftRow): DraftDTO {
  return { content: row.content, updatedAt: toIso(row.updated_at) };
}

/**
 * The caller's drafts across every room they still belong to, newest first.
 * The `room_members` join is the visibility rule: a draft written before
 * leaving a room stays in the table (rejoining restores it) but never appears
 * here, and the same join means another member's draft is unreachable by
 * construction. Empty rows cannot be created through `saveDraft` — they are
 * deleted — but the `content <> ''` guard keeps any legacy or imported blank
 * row out of the box as well. Ties on `updated_at` fall back to `room_id` so
 * the ordering is stable across requests.
 */
export async function listDraftBox(userId: number): Promise<DraftBoxItem[]> {
  const [rows] = await pool.query<DraftBoxRow[]>(
    `SELECT d.room_id, r.name AS room_name, d.content, d.updated_at
     FROM user_drafts d
     JOIN room_members rm ON rm.room_id = d.room_id AND rm.user_id = d.user_id
     JOIN rooms r ON r.id = d.room_id
     WHERE d.user_id = ? AND d.content <> ''
     ORDER BY d.updated_at DESC, d.room_id DESC
     LIMIT ?`,
    [userId, DRAFT_BOX_LIMIT],
  );
  return rows.map((row) => ({
    roomId: Number(row.room_id),
    roomName: row.room_name,
    content: row.content,
    updatedAt: toIso(row.updated_at),
  }));
}

/** The caller's draft for one room, or null when none is stored. */
export async function getDraft(userId: number, roomId: number): Promise<DraftDTO | null> {
  const [rows] = await pool.query<DraftRow[]>(
    'SELECT content, updated_at FROM user_drafts WHERE user_id = ? AND room_id = ?',
    [userId, roomId],
  );
  return rows[0] ? mapDraft(rows[0]) : null;
}

/**
 * Upserts the caller's draft and returns the stored DTO. `content === ''`
 * deletes the row instead, so "empty" has exactly one representation and a
 * cleared draft never reappears on another device.
 */
export async function saveDraft(
  userId: number,
  roomId: number,
  content: string,
): Promise<DraftDTO | null> {
  if (content === '') {
    await pool.execute('DELETE FROM user_drafts WHERE user_id = ? AND room_id = ?', [
      userId,
      roomId,
    ]);
    return null;
  }
  await pool.execute(
    `INSERT INTO user_drafts (user_id, room_id, content)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       content = VALUES(content),
       updated_at = CURRENT_TIMESTAMP(3)`,
    [userId, roomId, content],
  );
  return getDraft(userId, roomId);
}
