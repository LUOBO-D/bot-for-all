import { pool, type RowDataPacket } from '../db';
import type { AuthUser, UserRole, UserStatus, UserType } from '../types';

export interface UserWithPassword extends AuthUser {
  passwordHash: string;
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
  };
}

export async function findUserByUsername(username: string): Promise<UserWithPassword | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, username, password_hash, display_name, avatar, type, role, status
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
    `SELECT id, username, display_name, avatar, type, role, status
     FROM users WHERE id = ?`,
    [id],
  );
  return rows[0] ? mapAuthUser(rows[0]) : null;
}
