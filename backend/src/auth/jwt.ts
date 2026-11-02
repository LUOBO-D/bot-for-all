import jwt, { type JwtPayload } from 'jsonwebtoken';
import { config } from '../config';
import { unauthorized } from '../errors';
import type { AuthUser, UserRole, UserType } from '../types';

export interface TokenPayload extends JwtPayload {
  sub: string;
  username: string;
  type: UserType;
  role: UserRole;
  /** Revocation counter the token was signed with; see `AuthUser.tokenVersion`. */
  ver: number;
}

export function signToken(user: AuthUser): string {
  return jwt.sign(
    {
      sub: String(user.id),
      username: user.username,
      type: user.type,
      role: user.role,
      ver: user.tokenVersion,
    },
    config.jwtSecret,
    { expiresIn: '7d', algorithm: 'HS256' },
  );
}

export function verifyToken(token: string): TokenPayload {
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof decoded === 'string' || !decoded.sub) {
      throw new Error('invalid payload');
    }
    const payload = decoded as TokenPayload;
    // Tokens minted before the revocation counter existed have no claim; they
    // count as version 0, the same value every row started with.
    payload.ver = typeof payload.ver === 'number' ? payload.ver : 0;
    return payload;
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}
