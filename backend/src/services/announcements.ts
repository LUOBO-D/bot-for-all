import { pool, type ResultSetHeader, type RowDataPacket } from '../db';
import { toIso } from '../utils';

/** Column width of `announcements.body`; the route validates against it too. */
export const ANNOUNCEMENT_BODY_MAX = 1000;

/** How many rows the admin history returns; older posts are still kept. */
export const ANNOUNCEMENT_LIST_LIMIT = 20;

export interface AnnouncementDTO {
  id: number;
  body: string;
  actorName: string;
  active: boolean;
  createdAt: string;
}

// `display_name` is NOT NULL, but an empty one falls back to the username, the
// same way the admin user list renders owners.
const ANNOUNCEMENT_SELECT = `
  SELECT a.id, a.body, a.active, a.created_at,
         COALESCE(NULLIF(u.display_name, ''), u.username) AS actor_name
  FROM announcements a
  JOIN users u ON u.id = a.created_by
`;

function mapAnnouncement(row: RowDataPacket): AnnouncementDTO {
  return {
    id: Number(row.id),
    body: String(row.body),
    actorName: String(row.actor_name ?? ''),
    active: Number(row.active) === 1,
    createdAt: toIso(row.created_at),
  };
}

/** The banner every signed-in user sees: newest active post, or `null`. */
export async function getCurrentAnnouncement(): Promise<AnnouncementDTO | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${ANNOUNCEMENT_SELECT} WHERE a.active = 1 ORDER BY a.id DESC LIMIT 1`,
  );
  const row = rows[0];
  return row ? mapAnnouncement(row) : null;
}

export async function createAnnouncement(
  actorId: number,
  body: string,
): Promise<AnnouncementDTO> {
  const [result] = await pool.execute<ResultSetHeader>(
    'INSERT INTO announcements (body, created_by) VALUES (?, ?)',
    [body, actorId],
  );
  const [rows] = await pool.query<RowDataPacket[]>(
    `${ANNOUNCEMENT_SELECT} WHERE a.id = ?`,
    [result.insertId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`Announcement ${result.insertId} disappeared after insert`);
  }
  return mapAnnouncement(row);
}

/** Newest first, deactivated posts included so admins can see the history. */
export async function listAnnouncements(): Promise<AnnouncementDTO[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `${ANNOUNCEMENT_SELECT} ORDER BY a.id DESC LIMIT ${ANNOUNCEMENT_LIST_LIMIT}`,
  );
  return rows.map(mapAnnouncement);
}

/**
 * Rewrites the body only; `active`, `created_at` and `created_by` stay as they
 * were. Returns `null` when no such announcement exists so the route can
 * answer 404.
 */
export async function updateAnnouncement(
  id: number,
  body: string,
): Promise<AnnouncementDTO | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM announcements WHERE id = ?',
    [id],
  );
  if (rows.length === 0) {
    return null;
  }
  await pool.execute<ResultSetHeader>('UPDATE announcements SET body = ? WHERE id = ?', [
    body,
    id,
  ]);
  const [updated] = await pool.query<RowDataPacket[]>(
    `${ANNOUNCEMENT_SELECT} WHERE a.id = ?`,
    [id],
  );
  const row = updated[0];
  if (!row) {
    throw new Error(`Announcement ${id} disappeared after update`);
  }
  return mapAnnouncement(row);
}

/**
 * Flips `active` off, keeping the row for the admin history. Returns `false`
 * when no such announcement exists so the route can answer 404.
 */
export async function deactivateAnnouncement(id: number): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM announcements WHERE id = ?',
    [id],
  );
  if (rows.length === 0) {
    return false;
  }
  await pool.execute<ResultSetHeader>('UPDATE announcements SET active = 0 WHERE id = ?', [id]);
  return true;
}
