import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { encryptSecret } from '../src/bot/crypto';
import { pool, type RowDataPacket } from '../src/db';
import {
  createBot,
  disableBot,
  getBotById,
  getBotsForRoom,
  updateBot,
} from '../src/services/bot';
import { joinRoom } from '../src/services/room';
import type { AuthUser } from '../src/types';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

async function insertRoomBot(
  roomId: number,
  owner: AuthUser,
  username: string,
  options: { enabled?: boolean; member?: boolean } = {},
): Promise<number> {
  const botUser = await createTestUser(username, 'user', 'bot');
  await pool.execute(
    `INSERT INTO bots
       (user_id, base_url, api_key_encrypted, model, system_prompt, trigger_mode,
        owner_user_id, scope, room_id, temperature, max_tokens, enabled)
     VALUES (?, 'http://127.0.0.1:4010', ?, 'fake-ok', 'bot prompt', 'mention',
             ?, 'room', ?, 0.70, 1024, ?)`,
    [
      botUser.id,
      encryptSecret('test-key'),
      owner.id,
      roomId,
      options.enabled === false ? 0 : 1,
    ],
  );
  if (options.member !== false) {
    await pool.execute(
      'INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)',
      [roomId, botUser.id, 'bot'],
    );
  }
  return botUser.id;
}

async function hasMembership(roomId: number, userId: number): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  return Boolean(rows[0]);
}

async function roomBotIds(roomId: number): Promise<number[]> {
  return (await getBotsForRoom(roomId)).map((bot) => bot.userId);
}

describe('room bot ownership', () => {
  it('lets the room owner manage every room bot, including admin-owned ones', async () => {
    const owner = await createTestUser('own_owner');
    const member = await createTestUser('own_member');
    const admin = await createTestUser('own_admin', 'admin');
    const roomId = await createTestRoom(owner);
    await joinRoom(member.id, roomId);
    await joinRoom(admin.id, roomId);

    const ownerBot = await createBot({
      actor: owner,
      scope: 'room',
      roomId,
      name: 'owner-bot',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
    });
    const adminBot = await createBot({
      actor: admin,
      scope: 'room',
      roomId,
      name: 'admin-bot',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
    });

    // The room owner may manage a bot whose owner row belongs to an admin.
    const edited = await updateBot(adminBot.userId, owner, {
      model: 'owner-model',
      systemPrompt: 'owner-prompt',
    });
    expect(edited.model).toBe('owner-model');
    expect(edited.systemPrompt).toBe('owner-prompt');

    // A plain member with no ownership rights cannot manage either bot.
    await expect(
      updateBot(ownerBot.userId, member, { model: 'member-model' }),
    ).rejects.toMatchObject({ code: 'ROOM_OWNER_REQUIRED' });

    // A global admin can manage room bots too.
    const adminEdit = await updateBot(ownerBot.userId, admin, { model: 'admin-model' });
    expect(adminEdit.model).toBe('admin-model');
    await disableBot(adminBot.userId, owner);
    expect((await getBotById(adminBot.userId)).enabled).toBe(false);
    expect(await hasMembership(roomId, adminBot.userId)).toBe(false);

    await updateBot(adminBot.userId, admin, { enabled: true });
    expect((await getBotById(adminBot.userId)).enabled).toBe(true);
    expect(await hasMembership(roomId, adminBot.userId)).toBe(true);
    expect(await roomBotIds(roomId)).toEqual(
      expect.arrayContaining([ownerBot.userId, adminBot.userId]),
    );
  });

  it('transfers every room bot with ownership and cuts off the old owner', async () => {
    const owner = await createTestUser('transfer_owner');
    const successor = await createTestUser('transfer_successor');
    const admin = await createTestUser('transfer_admin', 'admin');
    const roomId = await createTestRoom(owner);
    await joinRoom(successor.id, roomId);

    const ownerBot = await createBot({
      actor: owner,
      scope: 'room',
      roomId,
      name: 'transfer-owner-bot',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
      systemPrompt: 'keep me',
      triggerMode: 'all',
    });
    const adminBot = await createBot({
      actor: admin,
      scope: 'room',
      roomId,
      name: 'transfer-admin-bot',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
    });

    const transfer = await request(app)
      .post(`/api/rooms/${roomId}/transfer`)
      .set('Authorization', auth(owner))
      .send({ userId: successor.id });
    expect(transfer.status).toBe(200);

    for (const botId of [ownerBot.userId, adminBot.userId]) {
      const moved = await getBotById(botId);
      expect(moved.ownerUserId).toBe(successor.id);
      expect(moved.enabled).toBe(true);
      expect(moved.roomId).toBe(roomId);
      expect(await hasMembership(roomId, botId)).toBe(true);
    }
    const preserved = await getBotById(ownerBot.userId);
    expect(preserved.systemPrompt).toBe('keep me');
    expect(preserved.triggerMode).toBe('all');

    await expect(
      updateBot(ownerBot.userId, owner, { model: 'old-owner-model' }),
    ).rejects.toMatchObject({ code: 'ROOM_OWNER_REQUIRED' });
    await expect(disableBot(ownerBot.userId, owner)).rejects.toMatchObject({
      code: 'ROOM_OWNER_REQUIRED',
    });
    const oldOwnerPatch = await request(app)
      .patch(`/api/me/bots/${ownerBot.userId}`)
      .set('Authorization', auth(owner))
      .send({ model: 'old-owner-model' });
    expect(oldOwnerPatch.status).toBe(403);
    expect(oldOwnerPatch.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const newOwnerEdit = await updateBot(ownerBot.userId, successor, {
      model: 'new-owner-model',
    });
    expect(newOwnerEdit.model).toBe('new-owner-model');
    await disableBot(adminBot.userId, successor);
    expect((await getBotById(adminBot.userId)).enabled).toBe(false);
    expect(await hasMembership(roomId, adminBot.userId)).toBe(false);

    // The transferred bots stay visible to the room while active.
    expect(await roomBotIds(roomId)).toContain(ownerBot.userId);
  });

  it('disables a kicked member’s room bots and drops their memberships', async () => {
    const owner = await createTestUser('kick_owner');
    const member = await createTestUser('kick_member');
    const roomId = await createTestRoom(owner);
    const otherRoomId = await createTestRoom(owner);
    await joinRoom(member.id, roomId);

    const kickedBot = await insertRoomBot(roomId, member, 'kick_room_bot');
    const untouchedBot = await insertRoomBot(otherRoomId, member, 'kick_other_bot');

    const response = await request(app)
      .delete(`/api/rooms/${roomId}/members/${member.id}`)
      .set('Authorization', auth(owner));
    expect(response.status).toBe(200);

    expect(await hasMembership(roomId, member.id)).toBe(false);
    expect(await hasMembership(roomId, kickedBot)).toBe(false);
    expect((await getBotById(kickedBot)).enabled).toBe(false);
    expect(await roomBotIds(roomId)).not.toContain(kickedBot);

    // Only the room the member was removed from is cleaned up.
    expect((await getBotById(untouchedBot)).enabled).toBe(true);
    expect(await hasMembership(otherRoomId, untouchedBot)).toBe(true);
  });

  it('disables a leaving member’s room bots and drops their memberships', async () => {
    const owner = await createTestUser('leave_owner');
    const member = await createTestUser('leave_member');
    const roomId = await createTestRoom(owner);
    await joinRoom(member.id, roomId);
    const botId = await insertRoomBot(roomId, member, 'leave_room_bot');

    const response = await request(app)
      .post(`/api/rooms/${roomId}/leave`)
      .set('Authorization', auth(member));
    expect(response.status).toBe(200);

    expect(await hasMembership(roomId, member.id)).toBe(false);
    expect(await hasMembership(roomId, botId)).toBe(false);
    expect((await getBotById(botId)).enabled).toBe(false);
    expect(await roomBotIds(roomId)).not.toContain(botId);
  });

  it('disables every room bot owned by a banned user but leaves global bots alone', async () => {
    const admin = await createTestUser('ban_admin', 'admin');
    const target = await createTestUser('ban_target');
    const firstRoom = await createTestRoom(target);
    const secondRoom = await createTestRoom(target);
    const firstBot = await insertRoomBot(firstRoom, target, 'ban_bot_one');
    const secondBot = await insertRoomBot(secondRoom, target, 'ban_bot_two');

    const globalBot = await createBot({
      actor: admin,
      scope: 'global',
      name: 'ban-global-bot',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
    });
    await pool.execute('UPDATE bots SET owner_user_id = ? WHERE user_id = ?', [
      target.id,
      globalBot.userId,
    ]);

    const response = await request(app)
      .patch(`/api/admin/users/${target.id}/status`)
      .set('Authorization', auth(admin))
      .send({ status: 'banned' });
    expect(response.status).toBe(200);

    for (const [roomId, botId] of [
      [firstRoom, firstBot],
      [secondRoom, secondBot],
    ] as const) {
      expect(await hasMembership(roomId, botId)).toBe(false);
      expect((await getBotById(botId)).enabled).toBe(false);
      expect(await roomBotIds(roomId)).not.toContain(botId);
    }
    expect((await getBotById(globalBot.userId)).enabled).toBe(true);
  });

  it('disables room bots when users are banned in a bulk update', async () => {
    const admin = await createTestUser('bulk_ban_admin', 'admin');
    const first = await createTestUser('bulk_ban_first');
    const second = await createTestUser('bulk_ban_second');
    const firstRoom = await createTestRoom(first);
    const secondRoom = await createTestRoom(second);
    const firstBot = await insertRoomBot(firstRoom, first, 'bulk_ban_bot_one');
    const secondBot = await insertRoomBot(secondRoom, second, 'bulk_ban_bot_two');

    const response = await request(app)
      .patch('/api/admin/users/bulk-status')
      .set('Authorization', auth(admin))
      .send({ userIds: [first.id, second.id], status: 'banned' });
    expect(response.status).toBe(200);
    expect(response.body.updated).toBe(2);

    expect((await getBotById(firstBot)).enabled).toBe(false);
    expect((await getBotById(secondBot)).enabled).toBe(false);
    expect(await hasMembership(firstRoom, firstBot)).toBe(false);
    expect(await hasMembership(secondRoom, secondBot)).toBe(false);
  });

  it('only activates bots with an active account, membership and active room member owner', async () => {
    const owner = await createTestUser('filter_owner');
    const roomId = await createTestRoom(owner);
    const botId = await insertRoomBot(roomId, owner, 'filter_bot');

    expect(await roomBotIds(roomId)).toContain(botId);

    await pool.execute("UPDATE users SET status = 'banned' WHERE id = ?", [botId]);
    expect(await roomBotIds(roomId)).not.toContain(botId);
    await pool.execute("UPDATE users SET status = 'active' WHERE id = ?", [botId]);

    await pool.execute('DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [
      roomId,
      botId,
    ]);
    expect(await roomBotIds(roomId)).not.toContain(botId);
    await pool.execute(
      'INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)',
      [roomId, botId, 'bot'],
    );

    await pool.execute("UPDATE users SET status = 'banned' WHERE id = ?", [owner.id]);
    expect(await roomBotIds(roomId)).not.toContain(botId);
    await pool.execute("UPDATE users SET status = 'active' WHERE id = ?", [owner.id]);

    await pool.execute('DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [
      roomId,
      owner.id,
    ]);
    expect(await roomBotIds(roomId)).not.toContain(botId);
    await pool.execute(
      'INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)',
      [roomId, owner.id, 'owner'],
    );
    expect(await roomBotIds(roomId)).toContain(botId);
  });

  it('lets an admin delete a room bot through the admin API', async () => {
    const owner = await createTestUser('admin_del_owner');
    const admin = await createTestUser('admin_del_admin', 'admin');
    const roomId = await createTestRoom(owner);
    const botId = await insertRoomBot(roomId, owner, 'admin_del_bot');

    const response = await request(app)
      .delete(`/api/admin/bots/${botId}`)
      .set('Authorization', auth(admin));
    expect(response.status).toBe(200);
    expect(response.body.disabled).toBe(true);

    expect((await getBotById(botId)).enabled).toBe(false);
    expect(await hasMembership(roomId, botId)).toBe(false);
  });
});
