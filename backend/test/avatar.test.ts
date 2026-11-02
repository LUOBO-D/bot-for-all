import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import type { AuthUser } from '../src/types';
import { createTestRoom, createTestUser, startTestServer, tokenFor, type TestServer } from './helpers';

const PNG_BODY = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG_BODY = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const WEBP_BODY = Buffer.from('524946460000000057454250565038', 'hex');
const GIF_BODY = Buffer.from('4749463839610100010000003b', 'hex');

let server: TestServer;
let uploadRoot: string;
let originalUploadDir: string;

beforeAll(async () => {
  originalUploadDir = config.uploadDir;
  uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bfa-avatars-'));
  config.uploadDir = uploadRoot;
  server = await startTestServer();
});

afterEach(() => {
  config.rateLimitEnabled = false;
});

afterAll(async () => {
  await server.close();
  config.uploadDir = originalUploadDir;
  fs.rmSync(uploadRoot, { recursive: true, force: true });
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

interface UploadOptions {
  filename?: string;
  mime?: string;
  body?: Buffer;
}

function uploadAvatar(user: AuthUser | null, options: UploadOptions = {}) {
  const req = request(server.url).post('/api/me/avatar');
  if (user) {
    req.set('Authorization', auth(user));
  }
  return req.attach('file', options.body ?? PNG_BODY, {
    filename: options.filename ?? 'avatar.png',
    contentType: options.mime ?? 'image/png',
  });
}

function tokenOf(url: string): string {
  const token = new URL(url, 'http://localhost').searchParams.get('v');
  if (!token) {
    throw new Error(`Missing token in ${url}`);
  }
  return token;
}

function avatarFile(token: string, extension: string): string {
  return path.join(uploadRoot, 'avatars', `${token}.${extension}`);
}

async function storedAvatar(userId: number): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT avatar FROM users WHERE id = ?', [
    userId,
  ]);
  const value = rows[0]?.avatar;
  return value == null ? null : String(value);
}

function binaryParser(
  res: request.Response,
  callback: (error: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

function getAvatar(url: string) {
  return request(server.url).get(url).buffer(true).parse(binaryParser);
}

/** Error responses on the binary avatar route are buffered JSON. */
function errorCode(response: request.Response): string | undefined {
  const raw = Buffer.isBuffer(response.body)
    ? response.body.toString('utf8')
    : (response.text ?? '');
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === 'string' ? parsed.error.code : undefined;
  } catch {
    return undefined;
  }
}

async function createAvatar(user: AuthUser): Promise<string> {
  const response = await uploadAvatar(user);
  expect(response.status).toBe(200);
  return response.body.avatar as string;
}

describe('avatar upload', () => {
  it('stores the image under the random token and returns its public URL', async () => {
    const user = await createTestUser(`avatar_upload_${randomBytes(2).toString('hex')}`);

    const response = await uploadAvatar(user);

    expect(response.status).toBe(200);
    const url = response.body.avatar as string;
    expect(url).toMatch(new RegExp(`^/api/users/${user.id}/avatar\\?v=[0-9a-f]{32}$`));
    const token = tokenOf(url);
    expect(token).toHaveLength(32);
    expect(await storedAvatar(user.id)).toBe(token);

    const file = avatarFile(token, 'png');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file)).toEqual(PNG_BODY);

    // Every token names exactly one stored file.
    const files = fs.readdirSync(path.join(uploadRoot, 'avatars'));
    expect(files.filter((name) => name.startsWith(`${token}.`))).toEqual([`${token}.png`]);
  });

  it('accepts every allowed image type', async () => {
    const user = await createTestUser(`avatar_types_${randomBytes(2).toString('hex')}`);
    const cases = [
      { mime: 'image/png', body: PNG_BODY, ext: 'png', contentType: 'image/png' },
      { mime: 'image/jpeg', body: JPEG_BODY, ext: 'jpg', contentType: 'image/jpeg' },
      { mime: 'image/webp', body: WEBP_BODY, ext: 'webp', contentType: 'image/webp' },
      { mime: 'image/gif', body: GIF_BODY, ext: 'gif', contentType: 'image/gif' },
    ];

    for (const item of cases) {
      const response = await uploadAvatar(user, {
        filename: `avatar.${item.ext}`,
        mime: item.mime,
        body: item.body,
      });
      expect(response.status).toBe(200);
      const token = tokenOf(response.body.avatar as string);
      expect(fs.existsSync(avatarFile(token, item.ext))).toBe(true);

      const fetched = await getAvatar(response.body.avatar as string);
      expect(fetched.status).toBe(200);
      expect(fetched.headers['content-type']).toBe(item.contentType);
      expect(fetched.body).toEqual(item.body);
    }
  });

  it('deletes the previous file when a new avatar replaces it', async () => {
    const user = await createTestUser(`avatar_replace_${randomBytes(2).toString('hex')}`);

    const firstUrl = await createAvatar(user);
    const firstToken = tokenOf(firstUrl);
    const firstFile = avatarFile(firstToken, 'png');
    expect(fs.existsSync(firstFile)).toBe(true);

    const response = await uploadAvatar(user, {
      filename: 'next.jpg',
      mime: 'image/jpeg',
      body: JPEG_BODY,
    });
    expect(response.status).toBe(200);
    const secondUrl = response.body.avatar as string;
    const secondToken = tokenOf(secondUrl);
    expect(secondToken).not.toBe(firstToken);

    expect(fs.existsSync(firstFile)).toBe(false);
    expect(fs.existsSync(avatarFile(secondToken, 'jpg'))).toBe(true);
    expect(await storedAvatar(user.id)).toBe(secondToken);

    // The old URL is dead: its version no longer matches the stored token.
    const stale = await getAvatar(firstUrl);
    expect(stale.status).toBe(404);

    const current = await getAvatar(secondUrl);
    expect(current.status).toBe(200);
    expect(current.body).toEqual(JPEG_BODY);
  });

  it('rejects files that are not images, files over 2 MB, and missing files', async () => {
    const user = await createTestUser(`avatar_reject_${randomBytes(2).toString('hex')}`);

    const notImage = await uploadAvatar(user, {
      filename: 'notes.txt',
      mime: 'text/plain',
      body: Buffer.from('not an image', 'utf8'),
    });
    expect(notImage.status).toBe(400);
    expect(notImage.body.error.code).toBe('AVATAR_TYPE_NOT_ALLOWED');

    const tooLarge = await uploadAvatar(user, {
      body: Buffer.alloc(2 * 1024 * 1024 + 1, 0x89),
    });
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.error.code).toBe('AVATAR_TOO_LARGE');

    const missing = await request(server.url)
      .post('/api/me/avatar')
      .set('Authorization', auth(user));
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('AVATAR_REQUIRED');

    expect(await storedAvatar(user.id)).toBeNull();
  });

  it('requires authentication for upload and delete', async () => {
    const anonymousUpload = await uploadAvatar(null);
    expect(anonymousUpload.status).toBe(401);

    const anonymousDelete = await request(server.url).delete('/api/me/avatar');
    expect(anonymousDelete.status).toBe(401);
  });

  it('clears the token and removes the file on delete', async () => {
    const user = await createTestUser(`avatar_delete_${randomBytes(2).toString('hex')}`);
    const url = await createAvatar(user);
    const token = tokenOf(url);
    const file = avatarFile(token, 'png');
    expect(fs.existsSync(file)).toBe(true);

    const response = await request(server.url)
      .delete('/api/me/avatar')
      .set('Authorization', auth(user));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ avatar: null });
    expect(await storedAvatar(user.id)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);

    const gone = await getAvatar(url);
    expect(gone.status).toBe(404);

    const me = await request(server.url)
      .get('/api/auth/me')
      .set('Authorization', auth(user));
    expect(me.body.user.avatar).toBeNull();

    const again = await request(server.url)
      .delete('/api/me/avatar')
      .set('Authorization', auth(user));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ avatar: null });
  });
});

describe('public avatar reads', () => {
  it('serves the current image without authentication and with immutable caching', async () => {
    const user = await createTestUser(`avatar_public_${randomBytes(2).toString('hex')}`);
    const url = await createAvatar(user);

    const versioned = await getAvatar(url);
    expect(versioned.status).toBe(200);
    expect(versioned.headers['content-type']).toBe('image/png');
    expect(versioned.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(versioned.headers['x-content-type-options']).toBe('nosniff');
    expect(versioned.headers['content-length']).toBe(String(PNG_BODY.length));
    expect(versioned.body).toEqual(PNG_BODY);

    // The bare URL serves the same current avatar.
    const bare = await getAvatar(`/api/users/${user.id}/avatar`);
    expect(bare.status).toBe(200);
    expect(bare.body).toEqual(PNG_BODY);
  });

  it('returns 404 for a stale version, an unknown user, and a user without an avatar', async () => {
    const plain = await createTestUser(`avatar_plain_${randomBytes(2).toString('hex')}`);

    const noAvatar = await getAvatar(`/api/users/${plain.id}/avatar`);
    expect(noAvatar.status).toBe(404);
    expect(errorCode(noAvatar)).toBe('AVATAR_NOT_FOUND');

    const unknown = await getAvatar('/api/users/999999/avatar');
    expect(unknown.status).toBe(404);

    const user = await createTestUser(`avatar_stale_${randomBytes(2).toString('hex')}`);
    const url = await createAvatar(user);
    const staleToken = '0'.repeat(32);
    expect(staleToken).not.toBe(tokenOf(url));

    const stale = await getAvatar(`/api/users/${user.id}/avatar?v=${staleToken}`);
    expect(stale.status).toBe(404);
    expect(errorCode(stale)).toBe('AVATAR_NOT_FOUND');
  });

  it('treats legacy users.avatar values as no avatar', async () => {
    const user = await createTestUser(`avatar_legacy_${randomBytes(2).toString('hex')}`);
    const legacy = 'https://example.test/old-avatar.png';
    await pool.execute('UPDATE users SET avatar = ? WHERE id = ?', [legacy, user.id]);

    const me = await request(server.url)
      .get('/api/auth/me')
      .set('Authorization', auth(user));
    expect(me.status).toBe(200);
    expect(me.body.user.avatar).toBeNull();

    const fetched = await getAvatar(`/api/users/${user.id}/avatar`);
    expect(fetched.status).toBe(404);

    // Deleting clears the legacy value without trying to unlink a made-up path.
    const deleted = await request(server.url)
      .delete('/api/me/avatar')
      .set('Authorization', auth(user));
    expect(deleted.status).toBe(200);
    expect(await storedAvatar(user.id)).toBeNull();
  });
});

describe('avatar URLs in user DTOs', () => {
  it('returns the same public URL from auth, member, admin, message and saved DTOs', async () => {
    const username = `avatar_dto_${randomBytes(2).toString('hex')}`;
    const user = await createTestUser(username);
    const admin = await createTestUser(`avatar_dto_admin_${randomBytes(2).toString('hex')}`, 'admin');
    const url = await createAvatar(user);
    const roomId = await createTestRoom(user);
    const expected = url;

    const me = await request(server.url)
      .get('/api/auth/me')
      .set('Authorization', auth(user));
    expect(me.status).toBe(200);
    expect(me.body.user.avatar).toBe(expected);

    const login = await request(server.url)
      .post('/api/auth/login')
      .send({ username, password: 'password123' });
    expect(login.status).toBe(200);
    expect(login.body.user.avatar).toBe(expected);

    const members = await request(server.url)
      .get(`/api/rooms/${roomId}/members`)
      .set('Authorization', auth(user));
    expect(members.status).toBe(200);
    const member = (members.body.members as Array<{ userId: number; avatar: string | null }>).find(
      (row) => row.userId === user.id,
    );
    expect(member?.avatar).toBe(expected);

    const adminList = await request(server.url)
      .get(`/api/admin/users?q=${encodeURIComponent(username)}`)
      .set('Authorization', auth(admin));
    expect(adminList.status).toBe(200);
    const listed = (adminList.body.users as Array<{ id: number; avatar: string | null }>).find(
      (row) => row.id === user.id,
    );
    expect(listed?.avatar).toBe(expected);

    const detail = await request(server.url)
      .get(`/api/admin/users/${user.id}`)
      .set('Authorization', auth(admin));
    expect(detail.status).toBe(200);
    expect(detail.body.user.avatar).toBe(expected);

    await pool.execute<ResultSetHeader>(
      `INSERT INTO messages (room_id, seq, sender_id, sender_type, content, status)
       VALUES (?, 1, ?, 'user', 'hello avatar', 'done')`,
      [roomId, user.id],
    );

    const messages = await request(server.url)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', auth(user));
    expect(messages.status).toBe(200);
    expect(messages.body.messages[0].senderAvatar).toBe(expected);

    const saved = await request(server.url)
      .post(`/api/rooms/${roomId}/messages/1/save`)
      .set('Authorization', auth(user));
    expect(saved.status).toBe(200);

    const savedList = await request(server.url)
      .get('/api/me/saved')
      .set('Authorization', auth(user));
    expect(savedList.status).toBe(200);
    expect(savedList.body.items[0].message.senderAvatar).toBe(expected);
  });
});

describe('avatar upload rate limit', () => {
  it('allows 10 uploads per minute and rejects the eleventh', async () => {
    config.rateLimitEnabled = true;
    const user = await createTestUser(`avatar_rate_${randomBytes(2).toString('hex')}`);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await uploadAvatar(user);
      expect(response.status).toBe(200);
    }

    const limited = await uploadAvatar(user);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });
});
