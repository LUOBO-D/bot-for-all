import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../auth/jwt';
import { pool, type RowDataPacket } from '../db';
import { forbidden, unauthorized } from '../errors';
import type { AuthUser } from '../types';

export async function getUserFromToken(token: string): Promise<AuthUser> {
  const payload = verifyToken(token);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, username, display_name, avatar, type, role, status, token_version
     FROM users WHERE id = ?`,
    [Number(payload.sub)],
  );
  const row = rows[0];
  if (!row) {
    throw unauthorized('User not found');
  }
  const tokenVersion = Number(row.token_version);
  // A ban is reported as 403 whether or not the token was issued before it:
  // banning also bumps the version, and callers must see the account state
  // rather than a generic revocation. The version check below then turns the
  // same token into 401 once the account is unbanned.
  if (row.status === 'banned') {
    throw forbidden('BANNED', 'User is banned');
  }
  // Anything that invalidates sessions (a password change, "log out everywhere") bumps the
  // stored counter, so a token signed with an older version is dead on arrival.
  if (payload.ver !== tokenVersion) {
    throw unauthorized('Token has been revoked');
  }
  return {
    id: Number(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    avatar: row.avatar ? String(row.avatar) : null,
    type: row.type,
    role: row.role,
    status: row.status,
    tokenVersion,
  };
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw unauthorized();
    }
    const user = await getUserFromToken(header.slice(7).trim());
    if (user.type === 'bot') {
      throw forbidden('BOT_FORBIDDEN', 'Bot accounts cannot access the API');
    }
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    next(forbidden('ADMIN_REQUIRED', 'Admin privileges required'));
    return;
  }
  next();
}
