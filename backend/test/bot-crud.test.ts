import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool, type RowDataPacket } from '../src/db';
import {
  createBot,
  disableBot,
  getBotById,
  getBotsForRoom,
  listBots,
  mountBot,
  toBotDto,
  unmountBot,
  updateBot,
} from '../src/services/bot';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

describe('bot CRUD', () => {
  it('encrypts keys and masks them in DTOs', async () => {
    const owner = await createTestUser('crud_owner');
    const roomId = await createTestRoom(owner);
    const bot = await createBot({
      actor: owner,
      scope: 'room',
      roomId,
      name: 'crud-bot',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'sk-secret-1234',
      model: 'fake-ok',
    });

    expect(toBotDto(bot).apiKeyMasked).toBe('sk-***1234');

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT api_key_encrypted FROM bots WHERE user_id = ?',
      [bot.userId],
    );
    expect(String(rows[0].api_key_encrypted)).not.toContain('sk-secret-1234');
    expect((await getBotById(bot.userId)).apiKey).toBe('sk-secret-1234');
  });

  it('disables a bot and removes its room membership', async () => {
    const owner = await createTestUser('disable_owner');
    const roomId = await createTestRoom(owner);
    const bot = await createBot({
      actor: owner,
      scope: 'room',
      roomId,
      name: 'disable-bot',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
    });

    await disableBot(bot.userId, owner);

    expect((await getBotById(bot.userId)).enabled).toBe(false);
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, bot.userId],
    );
    expect(rows).toHaveLength(0);
  });

  it('mounts and unmounts a global bot', async () => {
    const admin = await createTestUser('crud_admin', 'admin');
    const owner = await createTestUser('mount_owner');
    const roomId = await createTestRoom(owner);
    const bot = await createBot({
      actor: admin,
      scope: 'global',
      name: 'global-bot',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
    });

    await mountBot(roomId, bot.userId, owner);
    expect((await getBotsForRoom(roomId)).map((item) => item.userId)).toContain(bot.userId);

    await unmountBot(roomId, bot.userId, owner);
    expect((await getBotsForRoom(roomId)).map((item) => item.userId)).not.toContain(
      bot.userId,
    );
  });

  it('lets a global admin manage another owner’s room bot', async () => {
    const admin = await createTestUser('perm_admin', 'admin');
    const owner = await createTestUser('perm_owner');
    const roomId = await createTestRoom(owner);
    const bot = await createBot({
      actor: owner,
      scope: 'room',
      roomId,
      name: 'perm-bot',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
    });

    // Room bots are managed by the room owner or a global admin; the bot's
    // owner row alone does not grant rights.
    const updated = await updateBot(bot.userId, admin, {
      name: 'admin-renamed',
      model: 'fake-alt',
    });
    expect(updated.name).toBe('admin-renamed');
    expect(updated.model).toBe('fake-alt');

    const patch = await request(createApp())
      .patch(`/api/me/bots/${bot.userId}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ model: 'hijacked' });
    expect(patch.status).toBe(200);
    expect(patch.body.bot.model).toBe('hijacked');

    const removal = await request(createApp())
      .delete(`/api/me/bots/${bot.userId}`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(removal.status).toBe(200);
    expect(removal.body.disabled).toBe(true);

    // Mount/unmount stays an admin privilege.
    await mountBot(roomId, bot.userId, admin);
    await unmountBot(roomId, bot.userId, admin);

    const disabled = await getBotById(bot.userId);
    expect(disabled.name).toBe('admin-renamed');
    expect(disabled.model).toBe('hijacked');
    expect(disabled.enabled).toBe(false);
  });

  it('keeps listing bots when one row has corrupt ciphertext', async () => {
    const owner = await createTestUser('corrupt_owner');
    const roomId = await createTestRoom(owner);
    const good = await createBot({
      actor: owner,
      scope: 'room',
      roomId,
      name: 'good-bot',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'sk-secret-1234',
      model: 'fake-ok',
    });
    const corrupt = await createBot({
      actor: owner,
      scope: 'room',
      roomId,
      name: 'corrupt-bot',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
    });
    await pool.execute('UPDATE bots SET api_key_encrypted = ? WHERE user_id = ?', [
      'not-a-valid-payload',
      corrupt.userId,
    ]);

    const dtos = (await listBots(owner.id)).map(toBotDto);
    expect(dtos.find((item) => item.userId === corrupt.userId)?.apiKeyMasked).toBe('***');
    expect(dtos.find((item) => item.userId === good.userId)?.apiKeyMasked).toBe('sk-***1234');
    expect((await getBotById(corrupt.userId)).apiKey).toBe('');
  });

  it('re-enables a disabled bot through the API', async () => {
    const owner = await createTestUser('reenable_owner');
    const roomId = await createTestRoom(owner);
    const bot = await createBot({
      actor: owner,
      scope: 'room',
      roomId,
      name: 'reenable-bot',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
    });
    await disableBot(bot.userId, owner);

    const response = await request(createApp())
      .patch(`/api/me/bots/${bot.userId}`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .send({ enabled: true });

    expect(response.status).toBe(200);
    expect(response.body.bot.enabled).toBe(true);
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, bot.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('keeps global bot mounts across disable and re-enable', async () => {
    const admin = await createTestUser('global_toggle_admin', 'admin');
    const owner = await createTestUser('global_toggle_owner');
    const roomId = await createTestRoom(owner);
    const bot = await createBot({
      actor: admin,
      scope: 'global',
      name: 'global-toggle',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
    });
    await mountBot(roomId, bot.userId, owner);

    await disableBot(bot.userId, admin);
    const [mounted] = await pool.query<RowDataPacket[]>(
      'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, bot.userId],
    );
    expect(mounted).toHaveLength(1);
    expect((await getBotsForRoom(roomId)).map((item) => item.userId)).not.toContain(bot.userId);

    await updateBot(bot.userId, admin, { enabled: true });
    expect((await getBotsForRoom(roomId)).map((item) => item.userId)).toContain(bot.userId);
  });

  it('keeps global bot mounts when disabled through update', async () => {
    const admin = await createTestUser('global_patch_admin', 'admin');
    const owner = await createTestUser('global_patch_owner');
    const roomId = await createTestRoom(owner);
    const bot = await createBot({
      actor: admin,
      scope: 'global',
      name: 'global-patch',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
    });
    await mountBot(roomId, bot.userId, owner);

    await updateBot(bot.userId, admin, { enabled: false });

    const [mounted] = await pool.query<RowDataPacket[]>(
      'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, bot.userId],
    );
    expect(mounted).toHaveLength(1);
    expect((await getBotsForRoom(roomId)).map((item) => item.userId)).not.toContain(bot.userId);

    await updateBot(bot.userId, admin, { enabled: true });
    expect((await getBotsForRoom(roomId)).map((item) => item.userId)).toContain(bot.userId);
  });

  it('keeps room bot memberships when a room bot is re-enabled', async () => {
    const owner = await createTestUser('room_patch_owner');
    const roomId = await createTestRoom(owner);
    const bot = await createBot({
      actor: owner,
      scope: 'room',
      roomId,
      name: 'room-patch',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
    });

    await updateBot(bot.userId, owner, { enabled: false });
    const [removed] = await pool.query<RowDataPacket[]>(
      'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, bot.userId],
    );
    expect(removed).toHaveLength(0);

    await updateBot(bot.userId, owner, { enabled: true });
    const [restored] = await pool.query<RowDataPacket[]>(
      'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
      [roomId, bot.userId],
    );
    expect(restored).toHaveLength(1);
  });

  it('saves a key that literally contains the mask marker', async () => {
    const owner = await createTestUser('mask_owner');
    const roomId = await createTestRoom(owner);
    const bot = await createBot({
      actor: owner,
      scope: 'room',
      roomId,
      name: 'mask-bot',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'original-key',
      model: 'fake-ok',
    });

    const updated = await updateBot(bot.userId, owner, { apiKey: 'sk-live***key' });
    expect(updated.apiKey).toBe('sk-live***key');

    const unchanged = await updateBot(bot.userId, owner, {
      apiKey: toBotDto(updated).apiKeyMasked,
    });
    expect(unchanged.apiKey).toBe('sk-live***key');
  });
});
