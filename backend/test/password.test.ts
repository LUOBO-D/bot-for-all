import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();
const OLD_PASSWORD = 'password123';
const NEW_PASSWORD = 'brand-new-secret-42';

function changePassword(token: string | undefined, body: Record<string, unknown>) {
  const req = request(app).post('/api/auth/password');
  return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(body);
}

function login(username: string, password: string) {
  return request(app).post('/api/auth/login').send({ username, password });
}

let originalRateLimit: boolean;

beforeEach(() => {
  originalRateLimit = config.rateLimitEnabled;
});

afterEach(() => {
  config.rateLimitEnabled = originalRateLimit;
});

describe('POST /api/auth/password', () => {
  it('replaces the stored credential: old password fails, new one logs in', async () => {
    const user = await createTestUser('pw_change');

    const response = await changePassword(tokenFor(user), {
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, token: expect.any(String) });

    const stale = await login('pw_change', OLD_PASSWORD);
    expect(stale.status).toBe(401);

    const fresh = await login('pw_change', NEW_PASSWORD);
    expect(fresh.status).toBe(200);
    expect(fresh.body.user.username).toBe('pw_change');
  });

  it('rejects a wrong current password and keeps the old credential', async () => {
    const user = await createTestUser('pw_wrong');

    const response = await changePassword(tokenFor(user), {
      currentPassword: 'not-the-password',
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_PASSWORD');

    const unchanged = await login('pw_wrong', OLD_PASSWORD);
    expect(unchanged.status).toBe(200);
  });

  it('rejects a new password shorter than 8 characters', async () => {
    const user = await createTestUser('pw_weak');

    const response = await changePassword(tokenFor(user), {
      currentPassword: OLD_PASSWORD,
      newPassword: 'short',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_INPUT');

    const unchanged = await login('pw_weak', OLD_PASSWORD);
    expect(unchanged.status).toBe(200);
  });

  it('rejects a new password identical to the current one', async () => {
    const user = await createTestUser('pw_same');

    const response = await changePassword(tokenFor(user), {
      currentPassword: OLD_PASSWORD,
      newPassword: OLD_PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('SAME_PASSWORD');
  });

  it('requires authentication', async () => {
    const response = await changePassword(undefined, {
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rate limits repeated attempts', async () => {
    config.rateLimitEnabled = true;
    // A second user keeps this bucket key away from the single-user tests above.
    await createTestUser('pw_limiter_pad');
    const user = await createTestUser('pw_limiter');
    const token = tokenFor(user);

    const statuses: number[] = [];
    let current = OLD_PASSWORD;
    let activeToken = token;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const next = `rate-limit-pass-${attempt}`;
      const attemptResponse = await changePassword(activeToken, {
        currentPassword: current,
        newPassword: next,
      });
      statuses.push(attemptResponse.status);
      if (attemptResponse.status === 200) {
        current = next;
        activeToken = String(attemptResponse.body.token);
      }
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 400]);

    const limited = await changePassword(activeToken, {
      currentPassword: current,
      newPassword: 'rate-limit-pass-blocked',
    });
    expect(limited.status).toBe(400);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });
});
