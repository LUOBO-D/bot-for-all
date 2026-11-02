import { pool, withTransaction, type RowDataPacket } from '../db';
import { badRequest } from '../errors';

export const NOTIFY_MODES = ['all', 'mention'] as const;

export type NotifyMode = (typeof NOTIFY_MODES)[number];

export interface UserSettings {
  notifyMode: NotifyMode;
  dndStart: string | null;
  dndEnd: string | null;
  dndAllowMentions: boolean;
}

export interface UpdateSettingsInput {
  notifyMode?: NotifyMode;
  dndStart?: string | null;
  dndEnd?: string | null;
  dndAllowMentions?: boolean;
}

const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const SETTINGS_SELECT =
  'SELECT notify_mode, dnd_start, dnd_end, dnd_allow_mentions FROM user_settings WHERE user_id = ?';

function mapSettings(row: RowDataPacket | undefined): UserSettings {
  // MySQL hands TIME back as 'HH:MM:SS'; the API contract is 'HH:MM' only.
  const rawStart = row?.dnd_start;
  const rawEnd = row?.dnd_end;
  return {
    notifyMode: row?.notify_mode === 'mention' ? 'mention' : 'all',
    dndStart: typeof rawStart === 'string' ? rawStart.slice(0, 5) : null,
    dndEnd: typeof rawEnd === 'string' ? rawEnd.slice(0, 5) : null,
    // TINYINT(1) arrives as 0/1; anything unexpected keeps the default, which
    // is "mentions still get through".
    dndAllowMentions:
      row?.dnd_allow_mentions == null ? true : Number(row.dnd_allow_mentions) === 1,
  };
}

/**
 * The DND window is a single optional pair: either both ends are known or DND
 * is off. Equal ends are rejected because a zero-length (or, read literally,
 * 24-hour) window is always a mistake in the UI.
 */
function assertDndWindow(start: string | null, end: string | null): void {
  if ((start == null) !== (end == null)) {
    throw badRequest('INVALID_INPUT', 'dndStart and dndEnd must be set together or cleared together');
  }
  if (start == null || end == null) {
    return;
  }
  if (!CLOCK_PATTERN.test(start)) {
    throw badRequest('INVALID_INPUT', 'dndStart must be HH:MM');
  }
  if (!CLOCK_PATTERN.test(end)) {
    throw badRequest('INVALID_INPUT', 'dndEnd must be HH:MM');
  }
  if (start === end) {
    throw badRequest('INVALID_INPUT', 'dndStart and dndEnd must differ');
  }
}

/**
 * Reads the user's settings, creating the default row first when it is missing.
 * `INSERT IGNORE` keeps the read cheap and race-free: concurrent first reads all
 * succeed and the existing row is never overwritten.
 */
async function ensureSettingsRow(userId: number): Promise<void> {
  // Committed before any row lock is taken. Doing this inside the update
  // transaction would make concurrent first writes all hold a shared
  // duplicate-key lock and then upgrade to SELECT ... FOR UPDATE, which
  // InnoDB reports as a deadlock.
  await pool.execute(
    `INSERT IGNORE INTO user_settings (user_id, notify_mode) VALUES (?, 'all')`,
    [userId],
  );
}

export async function getSettings(userId: number): Promise<UserSettings> {
  await ensureSettingsRow(userId);
  const [rows] = await pool.query<RowDataPacket[]>(SETTINGS_SELECT, [userId]);
  return mapSettings(rows[0]);
}

/**
 * Merges the patch onto the stored settings, so the response is always the
 * complete DTO. Omitted fields keep their old value; `null` on a DND end
 * clears it, and the pair is validated as merged — sending only `dndStart` to
 * a user who had no window is rejected.
 *
 * The row is created if needed and read `FOR UPDATE` inside a transaction:
 * two concurrent patches (say, notification mode and DND) then serialize, and
 * the second merges onto the first one's committed values instead of
 * overwriting the whole row with a stale copy.
 */
export async function updateSettings(
  userId: number,
  input: UpdateSettingsInput,
): Promise<UserSettings> {
  await ensureSettingsRow(userId);
  return withTransaction(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(`${SETTINGS_SELECT} FOR UPDATE`, [
      userId,
    ]);
    const current = mapSettings(rows[0]);
    const notifyMode = input.notifyMode ?? current.notifyMode;
    const dndStart = input.dndStart === undefined ? current.dndStart : input.dndStart;
    const dndEnd = input.dndEnd === undefined ? current.dndEnd : input.dndEnd;
    const dndAllowMentions = input.dndAllowMentions ?? current.dndAllowMentions;

    assertDndWindow(dndStart, dndEnd);

    await conn.execute(
      `UPDATE user_settings
          SET notify_mode = ?, dnd_start = ?, dnd_end = ?, dnd_allow_mentions = ?
        WHERE user_id = ?`,
      [notifyMode, dndStart, dndEnd, dndAllowMentions ? 1 : 0, userId],
    );
    return { notifyMode, dndStart, dndEnd, dndAllowMentions };
  });
}
