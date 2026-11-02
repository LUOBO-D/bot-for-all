import { Router, type Request } from 'express';
import { hashSync } from 'bcryptjs';
import { z } from 'zod';
import { createCaptcha, verifyCaptcha } from '../auth/captcha';
import { signToken } from '../auth/jwt';
import { hashPassword, verifyPassword } from '../auth/password';
import { pool, type ResultSetHeader } from '../db';
import { ApiError, badRequest, conflict, forbidden, tooMany, unauthorized } from '../errors';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { checkRate } from '../middleware/ratelimit';
import {
  avatarUrl,
  bumpTokenVersion,
  findUserByUsername,
  getAuthUserById,
  updateUserProfile,
} from '../services/user';
import { listUserRoomIds } from '../services/room';
import { disconnectUserSockets, roomKey } from '../socket';
import { getSocketServer } from '../socket/broadcast';
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
    avatar: avatarUrl(user.id, user.avatar),
    type: user.type,
    role: user.role,
    statusEmoji: user.statusEmoji ?? null,
    statusText: user.statusText ?? null,
  };
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** Login budget per username and per client IP (10 minutes). */
const LOGIN_RATE_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_USERNAME_RATE_MAX = 10;
/**
 * A credential-stuffing run rotates usernames so every per-name bucket starts
 * empty; the IP cap counts the whole client regardless of the name tried.
 */
export const LOGIN_IP_RATE_MAX = 60;

/**
 * Folds a login name to the identity the database compares. `users.username`
 * uses utf8mb4_0900_ai_ci, so "Élodie", "élodie" and "e\u0301lodie" all resolve
 * to the same account; keying the rate limit on the raw input would grant each
 * spelling its own attempt budget.
 */
export function normalizeLoginUsername(username: string): string {
  return username.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

router.get(
  '/captcha',
  asyncHandler(async (req, res) => {
    if (!(await checkRate(`captcha:${clientIp(req)}`, 30, 60_000))) {
      throw tooMany('Too many captcha requests');
    }
    res.json(await createCaptcha());
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
    if (!(await checkRate(`register:${clientIp(req)}`, 5, 60 * 60 * 1000))) {
      throw badRequest('RATE_LIMITED', 'Too many registrations');
    }
    if (!(await verifyCaptcha(input.captchaId, input.captchaText))) {
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
    // IP first: rotating the username must not buy more attempts than a single
    // client is allowed, whichever spelling each request uses.
    if (
      !(await checkRate(`login-ip:${clientIp(req)}`, LOGIN_IP_RATE_MAX, LOGIN_RATE_WINDOW_MS))
    ) {
      throw badRequest('RATE_LIMITED', 'Too many login attempts');
    }
    if (
      !(await checkRate(
        `login:${clientIp(req)}:${normalizeLoginUsername(input.username)}`,
        LOGIN_USERNAME_RATE_MAX,
        LOGIN_RATE_WINDOW_MS,
      ))
    ) {
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

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    // Reload so the custom status columns (not loaded by the token middleware)
    // are always current in the answer.
    const current = req.user as AuthUser;
    const user = await getAuthUserById(current.id);
    if (!user) {
      throw unauthorized('User not found');
    }
    res.json({ user: userDto(user) });
  }),
);

const profileSchema = z
  .object({
    displayName: z.string().min(1).max(64).optional(),
    statusEmoji: z.string().max(16).nullable().optional(),
    statusText: z.string().max(64).nullable().optional(),
  })
  .refine(
    (value) =>
      value.displayName !== undefined ||
      value.statusEmoji !== undefined ||
      value.statusText !== undefined,
    { message: 'At least one profile field is required' },
  );

// Only the fields present in the body are written, so a display-name edit keeps
// the status untouched and vice versa. Blank status input clears the column.
router.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const user = req.user as AuthUser;
    const updated = await updateUserProfile(user.id, parsed.data);
    if (!updated) {
      throw unauthorized('User not found');
    }
    // Members of every room the user belongs to re-render their member list.
    const io = getSocketServer();
    if (io) {
      const roomIds = await listUserRoomIds(user.id);
      for (const roomId of roomIds) {
        io.to(roomKey(roomId)).emit('members:changed', { roomId });
      }
    }
    res.json({ user: userDto(updated) });
  }),
);

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: z.string().min(8).max(72),
});

// A password change revokes every session issued before it: the stored token version
// is bumped, so older tokens stop passing the auth middleware. The response
// carries a token for the device that made the change, which stays signed in.
router.post(
  '/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const user = req.user as AuthUser;
    if (!(await checkRate(`password:${user.id}`, 5, 15 * 60_000))) {
      throw badRequest('RATE_LIMITED', 'Too many password change attempts');
    }
    const input = parsed.data;
    const stored = await findUserByUsername(user.username);
    if (!stored) {
      throw unauthorized('User not found');
    }
    const ok = await verifyPassword(input.currentPassword, stored.passwordHash);
    if (!ok) {
      throw new ApiError(401, 'INVALID_PASSWORD', 'Current password is incorrect');
    }
    if (input.currentPassword === input.newPassword) {
      throw badRequest('SAME_PASSWORD', 'New password must differ from the current one');
    }
    const passwordHash = await hashPassword(input.newPassword);
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id]);
    const updated = await bumpTokenVersion(user.id);
    if (!updated) {
      throw unauthorized('User not found');
    }
    // Every socket authenticated with a pre-change token is now stale; the
    // response token lets the calling device reconnect immediately.
    await disconnectUserSockets(user.id, 'password_changed');
    res.json({ ok: true, token: signToken(updated) });
  }),
);

// "Log out everywhere": bumping the version kills every token handed out so far,
// while the fresh one in the response keeps this device signed in.
router.post(
  '/logout-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user as AuthUser;
    const updated = await bumpTokenVersion(user.id);
    if (!updated) {
      throw unauthorized('User not found');
    }
    await disconnectUserSockets(user.id, 'logged_out_all');
    res.json({ ok: true, token: signToken(updated) });
  }),
);

export default router;
