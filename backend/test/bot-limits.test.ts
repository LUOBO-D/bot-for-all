import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { pool, type RowDataPacket } from '../src/db';
import { createBot, getBotsForRoom } from '../src/services/bot';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

function roomBotBody(roomId: number): Record<string, unknown> {
  return {
    name: 'limit-bot',
    baseUrl: 'http://127.0.0.1:4010',
    apiKey: 'sk-limit-test',
    model: 'fake-ok',
    scope: 'room',
    roomId,
  };
}

function createRoomBot(token: string) {
  return (roomId: number) =>
    request(app)
      .post('/api/me/bots')
      .set('Authorization', `Bearer ${token}`)
      .send(roomBotBody(roomId));
}

const originals = {
  perRoom: config.botMaxPerRoom,
  perOwner: config.botMaxPerOwner,
  rateLimitEnabled: config.rateLimitEnabled,
};

afterEach(() => {
  config.botMaxPerRoom = originals.perRoom;
  config.botMaxPerOwner = originals.perOwner;
  config.rateLimitEnabled = originals.rateLimitEnabled;
});

describe('bot creation quotas', () => {
  it('rejects the 11th room bot in one room', async () => {
    const owner = await createTestUser('quota_room_owner');
    const roomId = await createTestRoom(owner);
    const create = createRoomBot(tokenFor(owner));

    for (let index = 0; index < config.botMaxPerRoom; index += 1) {
      const response = await create(roomId);
      expect(response.status).toBe(201);
    }

    const rejected = await create(roomId);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('BOT_LIMIT_REACHED');

    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS total FROM bots WHERE scope = 'room' AND room_id = ?",
      [roomId],
    );
    expect(Number(rows[0]?.total)).toBe(config.botMaxPerRoom);
  });

  it('rejects the 21st bot across rooms for one owner', async () => {
    const owner = await createTestUser('quota_owner_total');
    const roomA = await createTestRoom(owner);
    const roomB = await createTestRoom(owner);
    const roomC = await createTestRoom(owner);
    const create = createRoomBot(tokenFor(owner));

    for (let index = 0; index < config.botMaxPerRoom; index += 1) {
      expect((await create(roomA)).status).toBe(201);
      expect((await create(roomB)).status).toBe(201);
    }

    const rejected = await create(roomC);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('BOT_LIMIT_REACHED');

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM bots WHERE owner_user_id = ?',
      [owner.id],
    );
    expect(Number(rows[0]?.total)).toBe(config.botMaxPerOwner);
  });

  it('serializes concurrent creations so the quota cannot be raced', async () => {
    const owner = await createTestUser('quota_race_owner');
    const roomId = await createTestRoom(owner);
    const create = createRoomBot(tokenFor(owner));

    const responses = await Promise.all(
      Array.from({ length: config.botMaxPerRoom + 2 }, () => create(roomId)),
    );
    const created = responses.filter((response) => response.status === 201);
    const rejected = responses.filter((response) => response.status === 400);

    expect(created).toHaveLength(config.botMaxPerRoom);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((response) => response.body.error.code === 'BOT_LIMIT_REACHED')).toBe(
      true,
    );
  });

  it('rate limits bot creation to ten attempts per minute per user', async () => {
    config.rateLimitEnabled = true;
    const owner = await createTestUser('quota_rate_owner');
    const roomId = await createTestRoom(owner);
    const create = createRoomBot(tokenFor(owner));

    for (let index = 0; index < 10; index += 1) {
      expect((await create(roomId)).status).toBe(201);
    }
    const limited = await create(roomId);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('caps historical excess bots when reading a room fanout list', async () => {
    const owner = await createTestUser('quota_legacy_owner');
    const roomId = await createTestRoom(owner);

    // Simulate data created before the quota existed: raise the write limit
    // long enough to insert more rows than the current read cap allows.
    config.botMaxPerRoom = 20;
    config.botMaxPerOwner = 30;
    for (let index = 0; index < 11; index += 1) {
      await createBot({
        actor: owner,
        scope: 'room',
        roomId,
        name: `legacy-${index}`,
        baseUrl: 'http://127.0.0.1:4010',
        apiKey: 'sk-legacy',
        model: 'fake-ok',
      });
    }
    config.botMaxPerRoom = originals.perRoom;

    const bots = await getBotsForRoom(roomId);
    expect(bots).toHaveLength(originals.perRoom);
  });
});
