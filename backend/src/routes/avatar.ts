import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { config } from '../config';
import { pool, withTransaction, type RowDataPacket } from '../db';
import { ApiError, badRequest, notFound, tooMany } from '../errors';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { checkRate } from '../middleware/ratelimit';
import { isAvatarToken } from '../services/user';
import type { AuthUser } from '../types';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const AVATAR_RATE_MAX = 10;
const AVATAR_RATE_WINDOW_MS = 60_000;
const AVATAR_DIR_NAME = 'avatars';

/** Canonical extension per accepted image type. */
const AVATAR_MIME_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const AVATAR_EXT_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const AVATAR_EXTENSIONS = Object.keys(AVATAR_EXT_MIME);

function avatarPath(token: string, extension: string): string {
  return path.join(config.uploadDir, AVATAR_DIR_NAME, `${token}.${extension}`);
}

/**
 * A token can be paired with any accepted extension, and the DB only stores
 * the token, so the file is located by probing the known extensions. Tokens
 * are generated server-side, so no client-controlled path ever reaches here.
 */
async function findAvatarFile(
  token: string,
): Promise<{ path: string; mime: string; size: number } | null> {
  for (const extension of AVATAR_EXTENSIONS) {
    const candidate = avatarPath(token, extension);
    try {
      const stat = await fs.promises.stat(candidate);
      if (stat.isFile()) {
        return { path: candidate, mime: AVATAR_EXT_MIME[extension], size: stat.size };
      }
    } catch {
      // Missing candidate; try the next extension.
    }
  }
  return null;
}

/** Best-effort removal of every file belonging to a token. */
async function removeAvatarFiles(token: string | null): Promise<void> {
  if (!isAvatarToken(token)) {
    return;
  }
  for (const extension of AVATAR_EXTENSIONS) {
    await fs.promises.unlink(avatarPath(token, extension)).catch(() => {
      // Already gone (or never written); nothing else to do.
    });
  }
}

const avatarUploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 8 },
  fileFilter(_req, file, callback) {
    const mime = file.mimetype.split(';')[0].trim().toLowerCase();
    if (AVATAR_MIME_EXT[mime] === undefined) {
      callback(
        new ApiError(
          400,
          'AVATAR_TYPE_NOT_ALLOWED',
          `Unsupported avatar type: ${file.mimetype}`,
        ),
      );
      return;
    }
    file.mimetype = mime;
    callback(null, true);
  },
});

/** Runs multer and turns its size/field errors into the API error envelope. */
function receiveAvatar(req: Request, res: Response, next: NextFunction): void {
  avatarUploader.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        next(
          badRequest(
            'AVATAR_TOO_LARGE',
            `Avatar must be at most ${AVATAR_MAX_BYTES / (1024 * 1024)} MB`,
          ),
        );
        return;
      }
      next(badRequest('AVATAR_INVALID', error.message));
      return;
    }
    next(error);
  });
}

const router = Router();

// Upload first counts the rate-limit hit, before multer parses the body, so a
// throttled request never writes an upload buffer.
router.post(
  '/avatar',
  requireAuth,
  asyncHandler(async (req, _res, next) => {
    const user = req.user as AuthUser;
    if (!(await checkRate(`avatar:upload:${user.id}`, AVATAR_RATE_MAX, AVATAR_RATE_WINDOW_MS))) {
      throw tooMany('Too many avatar uploads');
    }
    next();
  }),
  receiveAvatar,
  asyncHandler(async (req, res) => {
    const user = req.user as AuthUser;
    const file = req.file;
    if (!file) {
      throw badRequest('AVATAR_REQUIRED', 'A multipart file field named "file" is required');
    }
    const extension = AVATAR_MIME_EXT[file.mimetype];
    if (!extension) {
      throw badRequest(
        'AVATAR_TYPE_NOT_ALLOWED',
        `Unsupported avatar type: ${file.mimetype}`,
      );
    }

    const token = randomBytes(16).toString('hex');
    const destination = avatarPath(token, extension);
    await fs.promises.mkdir(path.join(config.uploadDir, AVATAR_DIR_NAME), {
      recursive: true,
    });
    await fs.promises.writeFile(destination, file.buffer, { flag: 'wx' });

    let previous: string | null;
    try {
      previous = await withTransaction(async (conn) => {
        // Lock the row so concurrent uploads from one account serialise: the
        // later request sees the earlier token and removes that file.
        const [rows] = await conn.query<RowDataPacket[]>(
          'SELECT avatar FROM users WHERE id = ? FOR UPDATE',
          [user.id],
        );
        const row = rows[0];
        if (!row) {
          throw new ApiError(401, 'UNAUTHORIZED', 'User not found');
        }
        const old = row.avatar == null ? null : String(row.avatar);
        await conn.execute('UPDATE users SET avatar = ? WHERE id = ?', [token, user.id]);
        return old;
      });
    } catch (error) {
      // The row still points at the old avatar, so this file is unreachable.
      await fs.promises.unlink(destination).catch(() => {
        // Best effort: keep the original error.
      });
      throw error;
    }

    await removeAvatarFiles(previous);
    res.json({ avatar: `/api/users/${user.id}/avatar?v=${token}` });
  }),
);

router.delete(
  '/avatar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user as AuthUser;
    const previous = await withTransaction(async (conn) => {
      const [rows] = await conn.query<RowDataPacket[]>(
        'SELECT avatar FROM users WHERE id = ? FOR UPDATE',
        [user.id],
      );
      const row = rows[0];
      if (!row) {
        throw new ApiError(401, 'UNAUTHORIZED', 'User not found');
      }
      const old = row.avatar == null ? null : String(row.avatar);
      // A legacy non-token value is still cleared; only real tokens own files.
      if (old !== null) {
        await conn.execute('UPDATE users SET avatar = NULL WHERE id = ?', [user.id]);
      }
      return old;
    });

    await removeAvatarFiles(previous);
    res.json({ avatar: null });
  }),
);

export default router;

export const userAvatarRouter = Router();

// Public: avatars are rendered in message lists and member panels, so the
// image must load before (or without) authentication. The token in `?v=` is
// the cache key: a mismatch means the browser holds a URL for an older avatar.
userAvatarRouter.get(
  '/:id/avatar',
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw notFound('AVATAR_NOT_FOUND', 'Avatar not found');
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT avatar FROM users WHERE id = ?',
      [userId],
    );
    const row = rows[0];
    const token = row?.avatar == null ? null : String(row.avatar);
    if (!row || !isAvatarToken(token)) {
      throw notFound('AVATAR_NOT_FOUND', 'Avatar not found');
    }

    const version = req.query.v;
    if (version !== undefined && (typeof version !== 'string' || version !== token)) {
      throw notFound('AVATAR_NOT_FOUND', 'Avatar not found');
    }

    const file = await findAvatarFile(token);
    if (!file) {
      throw notFound('AVATAR_NOT_FOUND', 'Avatar not found');
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', file.size);
    // The token is part of the URL, so one URL always names one image; it can
    // be cached forever. A replacement gets a new token and therefore a new URL.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    const stream = fs.createReadStream(file.path);
    stream.on('error', () => {
      res.destroy();
    });
    res.on('close', () => {
      stream.destroy();
    });
    stream.pipe(res);
  }),
);
