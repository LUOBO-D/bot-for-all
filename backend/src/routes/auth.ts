import { Router, type Request } from 'express';
import { hashSync } from 'bcryptjs';
import { z } from 'zod';
import { createCaptcha, verifyCaptcha } from '../auth/captcha';
import { signToken } from '../auth/jwt';
import { hashPassword, verifyPassword } from '../auth/password';
import { pool, type ResultSetHeader } from '../db';
import { badRequest, conflict, forbidden, tooMany, unauthorized } from '../errors';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { checkRate } from '../middleware/ratelimit';
import { findUserByUsername, getAuthUserById } from '../services/user';
import type { AuthUser } from '../types';
import { isDuplicateError } from '../utils';

const router = Router();

// Verify against a real hash even when the username does not exist, so login
// timing does not reveal whether an account is registered.
const DUMMY_PASSWORD_HASH = hashSync('botforall-invalid-password', 10);

const registerSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/, 'Username must be 3-32 chars: letters, digits, underscore'),
  password: z.string().min(8).max(72),
  displayName: z.string().min(1).max(64).optional(),
  captchaId: z.string().optional(),
  captchaText: z.string().optional(),
});

const loginSchema = z.object({
  username: z.string().min(1).max(32),
  password: z.string().min(1).max(72),
});

function userDto(user: AuthUser) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar,
    type: user.type,
    role: user.role,
  };
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

router.get(
  '/captcha',
  asyncHandler(async (req, res) => {
    if (!checkRate(`captcha:${clientIp(req)}`, 30, 60_000)) {
      throw tooMany('Too many captcha requests');
    }
    res.json(createCaptcha());
  }),
);

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const input = parsed.data;
    if (!checkRate(`register:${clientIp(req)}`, 5, 60 * 60 * 1000)) {
      throw badRequest('RATE_LIMITED', 'Too many registrations');
    }
    if (!verifyCaptcha(input.captchaId, input.captchaText)) {
      throw badRequest('CAPTCHA_INVALID', 'Invalid captcha');
    }
    const passwordHash = await hashPassword(input.password);
    let userId: number;
    try {
      const [result] = await pool.execute<ResultSetHeader>(
        `INSERT INTO users (username, password_hash, display_name, type, role, status)
         VALUES (?, ?, ?, 'human', 'user', 'active')`,
        [input.username, passwordHash, input.displayName ?? input.username],
      );
      userId = result.insertId;
    } catch (error) {
      if (isDuplicateError(error)) {
        throw conflict('USERNAME_TAKEN', 'Username already exists');
      }
      throw error;
    }
    const user = await getAuthUserById(userId);
    if (!user) {
      throw badRequest('USER_NOT_FOUND', 'User was not created');
    }
    res.status(201).json({ token: signToken(user), user: userDto(user) });
  }),
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'Invalid input');
    }
    const input = parsed.data;
    if (!checkRate(`login:${clientIp(req)}:${input.username}`, 10, 10 * 60 * 1000)) {
      throw badRequest('RATE_LIMITED', 'Too many login attempts');
    }
    const user = await findUserByUsername(input.username);
    const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const ok = await verifyPassword(input.password, passwordHash);
    if (!user || !ok) {
      throw unauthorized('Invalid username or password');
    }
    if (user.type === 'bot') {
      throw forbidden('BOT_LOGIN_FORBIDDEN', 'Bot accounts cannot log in');
    }
    if (user.status === 'banned') {
      throw forbidden('BANNED', 'User is banned');
    }
    res.json({ token: signToken(user), user: userDto(user) });
  }),
);

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: userDto(req.user as AuthUser) });
});

const profileSchema = z.object({
  displayName: z.string().min(1).max(64),
});

router.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'Display name must be 1-64 characters');
    }
    const user = req.user as AuthUser;
    await pool.execute('UPDATE users SET display_name = ? WHERE id = ?', [
      parsed.data.displayName,
      user.id,
    ]);
    const updated = await getAuthUserById(user.id);
    if (!updated) {
      throw unauthorized('User not found');
    }
    res.json({ user: userDto(updated) });
  }),
);

export default router;
