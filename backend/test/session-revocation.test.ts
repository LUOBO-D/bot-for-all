import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { hashPassword } from '../src/auth/password';
import { verifyToken } from '../src/auth/jwt';
import { createApp } from '../src/app';
import { pool, type RowDataPacket } from '../src/db';
import { getAuthUserById } from '../src/services/user';
import type { AuthUser } from '../src/types';
import {
  connectClient,
  createTestUser,
  startTestServer,
  tokenFor,
  waitForEvent,
  type TestServer,
} from './helpers';

const app = createApp();

const CURRENT_PASSWORD = 'session-current-pw';
const NEXT_PASSWORD = 'session-next-pw';

let server: TestServer;
const clients: Socket[] = [];

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
});

function bearer(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

async function tokenVersionOf(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT token_version FROM users WHERE id = ?',
    [userId],
  );
  return Number(rows[0]?.token_version);
}

/** Creates a user whose password is known, so the change endpoint can be exercised. */
async function createUserWithPassword(username: string): Promise<AuthUser> {
  const created = await createTestUser(username);
  await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [
    await hashPassword(CURRENT_PASSWORD),
    created.id,
  ]);
  const user = await getAuthUserById(created.id);
  if (!user) {
    throw new Error('Failed to reload test user');
  }
  return user;
}

function setStatus(actor: AuthUser, userId: number, status: 'active' | 'banned') {
  return request(app)
    .patch(`/api/admin/users/${userId}/status`)
    .set('Authorization', bearer(actor))
    .send({ status });
}

function bulkStatus(actor: AuthUser, userIds: number[], status: 'active' | 'banned') {
  return request(app)
    .patch('/api/admin/users/bulk-status')
    .set('Authorization', bearer(actor))
    .send({ userIds, status });
}

function changePassword(user: AuthUser, currentPassword: string, newPassword: string) {
  return request(app)
    .post('/api/auth/password')
    .set('Authorization', bearer(user))
    .send({ currentPassword, newPassword });
}

function me(token: string) {
  return request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
}

async function openClient(user: AuthUser): Promise<Socket> {
  const client = await connectClient(server.url, tokenFor(user));
  clients.push(client);
  return client;
}

function nextRevocation(socket: Socket): Promise<{ reason: string }> {
  return waitForEvent<{ reason: string }>(socket, 'session:revoked', () => true);
}

function nextDisconnect(socket: Socket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (!socket.connected) {
    resolve();
    return promise;
  }
  socket.once('disconnect', () => resolve());
  return promise;
}

describe('session revocation', () => {
  it('disconnects every socket of a banned user and revokes the old token', async () => {
    const admin = await createTestUser('revoke_ban_admin', 'admin');
    const target = await createTestUser('revoke_ban_target');
    const bystander = await createTestUser('revoke_ban_bystander');

    const targetOne = await openClient(target);
    const targetTwo = await openClient(target);
    const observer = await openClient(bystander);
    const revokedOne = nextRevocation(targetOne);
    const revokedTwo = nextRevocation(targetTwo);
    const closedOne = nextDisconnect(targetOne);
    const closedTwo = nextDisconnect(targetTwo);

    const response = await setStatus(admin, target.id, 'banned');
    expect(response.status).toBe(200);

    expect(await revokedOne).toEqual({ reason: 'banned' });
    expect(await revokedTwo).toEqual({ reason: 'banned' });
    await closedOne;
    await closedTwo;
    expect(targetOne.connected).toBe(false);
    expect(targetTwo.connected).toBe(false);
    // Revocation is scoped to the banned account.
    expect(observer.connected).toBe(true);

    expect(await tokenVersionOf(target.id)).toBe(1);

    // While banned the account state wins over the revocation: 403, not 401.
    const bannedMe = await me(tokenFor(target));
    expect(bannedMe.status).toBe(403);
    expect(bannedMe.body.error.code).toBe('BANNED');

    // Re-banning an already banned user must not bump the counter again.
    expect((await setStatus(admin, target.id, 'banned')).status).toBe(200);
    expect(await tokenVersionOf(target.id)).toBe(1);

    expect((await setStatus(admin, target.id, 'active')).status).toBe(200);
    expect(await tokenVersionOf(target.id)).toBe(1);

    // Unbanning does not revive pre-ban tokens: the version bump already did.
    const revokedMe = await me(tokenFor(target));
    expect(revokedMe.status).toBe(401);
    expect(revokedMe.body.error.code).toBe('UNAUTHORIZED');
  });

  it('disconnects and revokes every user a bulk ban actually bans', async () => {
    const admin = await createTestUser('revoke_bulk_admin', 'admin');
    const first = await createTestUser('revoke_bulk_first');
    const second = await createTestUser('revoke_bulk_second');
    const already = await createTestUser('revoke_bulk_already');
    await pool.execute("UPDATE users SET status = 'banned' WHERE id = ?", [already.id]);

    const firstClient = await openClient(first);
    const secondClient = await openClient(second);
    const firstRevoked = nextRevocation(firstClient);
    const secondRevoked = nextRevocation(secondClient);
    const firstClosed = nextDisconnect(firstClient);
    const secondClosed = nextDisconnect(secondClient);

    const response = await bulkStatus(admin, [first.id, second.id, already.id], 'banned');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: 2, unchanged: 1 });

    expect(await firstRevoked).toEqual({ reason: 'banned' });
    expect(await secondRevoked).toEqual({ reason: 'banned' });
    await firstClosed;
    await secondClosed;
    expect(firstClient.connected).toBe(false);
    expect(secondClient.connected).toBe(false);

    expect(await tokenVersionOf(first.id)).toBe(1);
    expect(await tokenVersionOf(second.id)).toBe(1);
    // The already banned row never transitioned, so its counter is untouched.
    expect(await tokenVersionOf(already.id)).toBe(0);

    const oldToken = await me(tokenFor(first));
    expect(oldToken.status).toBe(403);
    expect(oldToken.body.error.code).toBe('BANNED');
  });

  it('disconnects live sockets when the password changes', async () => {
    const user = await createUserWithPassword('revoke_pw_target');
    const client = await openClient(user);
    const revoked = nextRevocation(client);
    const closed = nextDisconnect(client);

    const response = await changePassword(user, CURRENT_PASSWORD, NEXT_PASSWORD);
    expect(response.status).toBe(200);
    expect(verifyToken(response.body.token).ver).toBe(1);

    expect(await revoked).toEqual({ reason: 'password_changed' });
    await closed;
    expect(client.connected).toBe(false);
    expect(await tokenVersionOf(user.id)).toBe(1);

    const oldMe = await me(tokenFor(user));
    expect(oldMe.status).toBe(401);
    expect(oldMe.body.error.code).toBe('UNAUTHORIZED');
    expect((await me(response.body.token)).status).toBe(200);
  });

  it('disconnects live sockets on logout-all', async () => {
    const user = await createTestUser('revoke_logout_target');
    const client = await openClient(user);
    const revoked = nextRevocation(client);
    const closed = nextDisconnect(client);

    const response = await request(app)
      .post('/api/auth/logout-all')
      .set('Authorization', bearer(user));

    expect(response.status).toBe(200);
    expect(verifyToken(response.body.token).ver).toBe(1);
    expect(await revoked).toEqual({ reason: 'logged_out_all' });
    await closed;
    expect(client.connected).toBe(false);
    expect(await tokenVersionOf(user.id)).toBe(1);

    expect((await me(tokenFor(user))).status).toBe(401);
    expect((await me(response.body.token)).status).toBe(200);
  });
});
