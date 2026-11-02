import { pool, type RowDataPacket } from '../db';
import type { AuthUser, UserRole, UserStatus, UserType } from '../types';
import { toIso } from '../utils';

export interface UserWithPassword extends AuthUser {
  passwordHash: string;
}

// Admin listings render the same custom status. The two fields stay optional so
// the admin detail endpoint, which does not select them, remains type-compatible.
// The token version is deliberately left out: it is a server-side revocation
// counter, not something the admin UI renders.
export interface AdminUser extends Omit<AuthUser, 'tokenVersion'> {
  createdAt: string;
}

export interface ListUsersInput {
  q?: string;
  limit?: number;
  offset?: number;
}

export interface ListUsersResult {
  users: AdminUser[];
  total: number;
}

// Uploaded avatars are stored as a random 32-hex token in `users.avatar`; the
// file on disk is named after that token. Older rows may still hold anything
// else (a URL, an emoji, ...), which must never be turned into a public URL.
const AVATAR_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** True when a stored `users.avatar` value was minted by the avatar upload route. */
export function isAvatarToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && AVATAR_TOKEN_PATTERN.test(value);
}

/**
 * Public URL of a user's avatar, or null when the user has none. The token is
 * part of the query string so an avatar replacement changes the URL and the
 * immutable cache entry cannot go stale.
 */
export function avatarUrl(userId: number, value: string | null | undefined): string | null {
  return isAvatarToken(value) ? `/api/users/${userId}/avatar?v=${value}` : null;
}

function mapAuthUser(row: RowDataPacket): AuthUser {
  return {
    id: Number(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    avatar: row.avatar ? String(row.avatar) : null,
    type: row.type as UserType,
    role: row.role as UserRole,
    status: row.status as UserStatus,
    tokenVersion: Number(row.token_version),
    statusEmoji: row.status_emoji ? String(row.status_emoji) : null,
    statusText: row.status_text ? String(row.status_text) : null,
  };
}

// Columns every user DTO is built from; keep in sync with mapAuthUser.
const AUTH_USER_COLUMNS =
  'id, username, display_name, avatar, type, role, status, status_emoji, status_text, token_version';

export async function findUserByUsername(username: string): Promise<UserWithPassword | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${AUTH_USER_COLUMNS}, password_hash
     FROM users WHERE username = ?`,
    [username],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    ...mapAuthUser(row),
    passwordHash: String(row.password_hash),
  };
}

export async function getAuthUserById(id: number): Promise<AuthUser | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${AUTH_USER_COLUMNS}
     FROM users WHERE id = ?`,
    [id],
  );
  return rows[0] ? mapAuthUser(rows[0]) : null;
}

/**
 * Revokes every token issued for the user so far by bumping the stored counter,
 * and returns the reloaded row: its `tokenVersion` is the value a replacement
 * token must be signed with to stay valid. Returns null when the row is gone.
 */
export async function bumpTokenVersion(userId: number): Promise<AuthUser | null> {
  await pool.execute('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [userId]);
  return getAuthUserById(userId);
}

/**
 * Records "this user is online right now". Called from the socket layer on
 * connect and on disconnect; callers fire-and-forget, because a failed write
 * must never break the connection itself.
 */
export async function touchLastSeen(userId: number): Promise<void> {
  await pool.execute('UPDATE users SET last_seen_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [
    userId,
  ]);
}

const USER_LIST_COLUMNS = `${AUTH_USER_COLUMNS}, created_at`;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function mapAdminUser(row: RowDataPacket): AdminUser {
  // The revocation counter is not part of the admin DTO; dropping it keeps a
  // list row identical to the single-user response built in routes/admin.ts.
  const { tokenVersion: _tokenVersion, ...user } = mapAuthUser(row);
  return {
    ...user,
    avatar: avatarUrl(user.id, user.avatar),
    createdAt: toIso(row.created_at),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 50;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) {
    return 0;
  }
  return Math.max(Math.trunc(offset), 0);
}

// Shared by the admin user list and its CSV export: both search the same two
// columns, so the export can never drift from what the table shows.
function userSearchScope(q: string | undefined): { where: string; params: unknown[] } {
  const trimmed = q?.trim();
  if (!trimmed) {
    return { where: '', params: [] };
  }
  const pattern = `%${escapeLikePattern(trimmed)}%`;
  return {
    where: " WHERE (username LIKE ? ESCAPE '\\\\' OR display_name LIKE ? ESCAPE '\\\\')",
    params: [pattern, pattern],
  };
}

export async function listUsers(input: ListUsersInput = {}): Promise<ListUsersResult> {
  const limit = clampLimit(input.limit);
  const offset = clampOffset(input.offset);
  const { where, params } = userSearchScope(input.q);

  const [countRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM users${where}`,
    params,
  );
  const total = Number(countRows[0]?.total ?? 0);

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${USER_LIST_COLUMNS} FROM users${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  return { users: rows.map(mapAdminUser), total };
}

/** Rows carried by the one-shot admin user export. */
export const USER_EXPORT_LIMIT = 5000;

export interface UserExportResult {
  users: AdminUser[];
  truncated: boolean;
}

/**
 * Same filter and order as `listUsers`, sized for a single download. One row
 * past the cap is fetched so the route can advertise truncation in a header
 * before the body is written, without a second COUNT query.
 */
export async function listUsersForExport(q?: string): Promise<UserExportResult> {
  const { where, params } = userSearchScope(q);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${USER_LIST_COLUMNS} FROM users${where} ORDER BY id DESC LIMIT ${USER_EXPORT_LIMIT + 1}`,
    params,
  );
  return {
    users: rows.slice(0, USER_EXPORT_LIMIT).map(mapAdminUser),
    truncated: rows.length > USER_EXPORT_LIMIT,
  };
}

export interface UserProfilePatch {
  displayName?: string;
  statusEmoji?: string | null;
  statusText?: string | null;
}

// Blank (or whitespace-only) status input clears the column, so clients can
// either send null or an empty string to remove a status.
function normalizeStatus(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Applies the fields that are present in `patch` and returns the reloaded user.
 * Returns null when the row disappeared between the update and the read.
 */
export async function updateUserProfile(
  userId: number,
  patch: UserProfilePatch,
): Promise<AuthUser | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.displayName !== undefined) {
    sets.push('display_name = ?');
    params.push(patch.displayName);
  }
  if (patch.statusEmoji !== undefined) {
    sets.push('status_emoji = ?');
    params.push(normalizeStatus(patch.statusEmoji));
  }
  if (patch.statusText !== undefined) {
    sets.push('status_text = ?');
    params.push(normalizeStatus(patch.statusText));
  }
  if (sets.length > 0) {
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, userId]);
  }
  return getAuthUserById(userId);
}
