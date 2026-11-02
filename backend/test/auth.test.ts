import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { normalizeLoginUsername } from '../src/routes/auth';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

describe('auth', () => {
  it('registers a user and returns a token', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', password: 'password123' });

    expect(response.status).toBe(201);
    expect(typeof response.body.token).toBe('string');
    expect(response.body.user.username).toBe('alice');
  });

  it('rejects a duplicate username', async () => {
    await createTestUser('bob');
    const response = await request(app)
      .post('/api/auth/register')
      .send({ username: 'bob', password: 'password123' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('USERNAME_TAKEN');
  });

  it('logs in with valid credentials', async () => {
    await createTestUser('carol');
    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'carol', password: 'password123' });

    expect(response.status).toBe(200);
    expect(response.body.user.username).toBe('carol');
  });

  it('rejects bot account login', async () => {
    await createTestUser('bot_login', 'user', 'bot');
    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'bot_login', password: 'password123' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('BOT_LOGIN_FORBIDDEN');
  });

  it('requires a token for /api/auth/me', async () => {
    const response = await request(app).get('/api/auth/me');
    expect(response.status).toBe(401);
  });

  it('updates the display name', async () => {
    const user = await createTestUser('profile_user');
    const response = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ displayName: '新名字' });

    expect(response.status).toBe(200);
    expect(response.body.user.displayName).toBe('新名字');
  });

  it('folds case and accent into one login rate-limit bucket', async () => {
    expect(normalizeLoginUsername('Élodie')).toBe('elodie');
    expect(normalizeLoginUsername('E\u0301LODIE')).toBe('elodie');
    expect(normalizeLoginUsername(' security_admin ')).toBe(' security_admin ');

    await createTestUser('login_norm_Élodie');
    const variants = [
      'login_norm_Élodie',
      'LOGIN_NORM_ELODIE',
      'login_norm_élodie',
      'Login_Norm_E\u0301lodie',
    ];
    config.rateLimitEnabled = true;
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await request(app)
          .post('/api/auth/login')
          .send({ username: variants[attempt % variants.length], password: 'definitely-wrong' });
        expect(response.status).toBe(401);
      }
      // A different spelling still shares the bucket, so the 11th fails on the
      // limiter instead of buying another ten guesses.
      const limited = await request(app)
        .post('/api/auth/login')
        .send({ username: 'LOGIN_NORM_E\u0301LODIE', password: 'definitely-wrong' });
      expect(limited.status).toBe(400);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
    } finally {
      config.rateLimitEnabled = false;
    }
  });
});
