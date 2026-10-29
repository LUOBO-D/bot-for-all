import jwt, { type JwtPayload } from 'jsonwebtoken';
import { config } from '../config';
import { unauthorized } from '../errors';
import type { AuthUser, UserRole, UserType } from '../types';

export interface TokenPayload extends JwtPayload {
  sub: string;
  username: string;
  type: UserType;
  role: UserRole;
}

export function signToken(user: AuthUser): string {
  return jwt.sign(
    {
      sub: String(user.id),
      username: user.username,
      type: user.type,
      role: user.role,
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
    return decoded as TokenPayload;
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}
