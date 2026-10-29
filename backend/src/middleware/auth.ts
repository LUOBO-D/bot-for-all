import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../auth/jwt';
import { pool, type RowDataPacket } from '../db';
import { forbidden, unauthorized } from '../errors';
import type { AuthUser } from '../types';

export async function getUserFromToken(token: string): Promise<AuthUser> {
  const payload = verifyToken(token);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, username, display_name, avatar, type, role, status
     FROM users WHERE id = ?`,
    [Number(payload.sub)],
  );
  const row = rows[0];
  if (!row) {
    throw unauthorized('User not found');
  }
  if (row.status === 'banned') {
    throw forbidden('BANNED', 'User is banned');
  }
  return {
    id: Number(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    avatar: row.avatar ? String(row.avatar) : null,
    type: row.type,
    role: row.role,
    status: row.status,
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
