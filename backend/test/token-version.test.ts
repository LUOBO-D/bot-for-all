import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { signToken, verifyToken } from '../src/auth/jwt';
import { createApp } from '../src/app';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import { getAuthUserById } from '../src/services/user';
import type { AuthUser } from '../src/types';

const app = createApp();

const CURRENT_PASSWORD = 'token-version-current';
const NEXT_PASSWORD = 'token-version-next';

/** Creates a user whose password is known, so the change endpoint can be exercised. */
async function createUser(username: string): Promise<AuthUser> {
  const passwordHash = await hashPassword(CURRENT_PASSWORD);
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO users (username, password_hash, display_name, type, role, status)
     VALUES (?, ?, ?, 'human', 'user', 'active')`,
    [username, passwordHash, username],
  );
  const user = await getAuthUserById(result.insertId);
  if (!user) {
    throw new Error('Failed to create test user');
  }
  return user;
}

function me(token: string) {
  return request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
}

function changePassword(token: string, body: Record<string, string>) {
  return request(app)
    .post('/api/auth/password')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function logoutAll(token: string) {
  return request(app).post('/api/auth/logout-all').set('Authorization', `Bearer ${token}`);
}

async function storedTokenVersion(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT token_version FROM users WHERE id = ?',
    [userId],
  );
  return Number(rows[0]?.token_version);
}

describe('token version', () => {
  it('starts at 0 and keeps the existing token usable until the version changes', async () => {
    const user = await createUser('tv_before');
    const token = signToken(user);

    expect(user.tokenVersion).toBe(0);
    expect(verifyToken(token).ver).toBe(0);
    expect((await me(token)).status).toBe(200);
  });

  it('revokes the old token and returns a working one after a password change', async () => {
    const user = await createUser('tv_change');
    const oldToken = signToken(user);

    const response = await changePassword(oldToken, {
      currentPassword: CURRENT_PASSWORD,
      newPassword: NEXT_PASSWORD,
    });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(typeof response.body.token).toBe('string');
    expect(verifyToken(response.body.token).ver).toBe(1);
    expect(await storedTokenVersion(user.id)).toBe(1);

    const rejected = await me(oldToken);
    expect(rejected.status).toBe(401);
    expect(rejected.body.error.code).toBe('UNAUTHORIZED');

    expect((await me(response.body.token)).status).toBe(200);

    // The new credential is the one that logs in from now on.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: user.username, password: NEXT_PASSWORD });
    expect(login.status).toBe(200);
    expect(verifyToken(login.body.token).ver).toBe(1);
  });

  it('revokes every session on logout-all and keeps the caller signed in', async () => {
    const user = await createUser('tv_logout');
    const thisDevice = signToken(user);
    const otherDevice = signToken(user);

    const response = await logoutAll(thisDevice);

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(verifyToken(response.body.token).ver).toBe(1);
    expect(await storedTokenVersion(user.id)).toBe(1);

    expect((await me(thisDevice)).status).toBe(401);
    expect((await me(otherDevice)).status).toBe(401);
    expect((await me(response.body.token)).status).toBe(200);
  });

  it('revokes the token returned by an earlier logout-all on the next one', async () => {
    const user = await createUser('tv_logout_twice');
    const first = await logoutAll(signToken(user));
    expect(first.status).toBe(200);

    const second = await logoutAll(first.body.token);
    expect(second.status).toBe(200);
    expect(verifyToken(second.body.token).ver).toBe(2);
    expect(await storedTokenVersion(user.id)).toBe(2);

    expect((await me(first.body.token)).status).toBe(401);
    expect((await me(second.body.token)).status).toBe(200);
  });

  it('requires authentication for logout-all and for password changes', async () => {
    const anonymousLogout = await request(app).post('/api/auth/logout-all');
    expect(anonymousLogout.status).toBe(401);
    expect(anonymousLogout.body.error.code).toBe('UNAUTHORIZED');

    const anonymousChange = await request(app)
      .post('/api/auth/password')
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: NEXT_PASSWORD });
    expect(anonymousChange.status).toBe(401);
    expect(anonymousChange.body.error.code).toBe('UNAUTHORIZED');
  });
});
