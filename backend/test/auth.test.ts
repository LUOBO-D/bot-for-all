import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
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
});
