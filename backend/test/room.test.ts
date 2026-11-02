import { describe, expect, it } from 'vitest';
import { createMessage, deleteMessage } from '../src/services/message';
import {
  createRoom,
  getRoomSummary,
  joinRoom,
  leaveRoom,
  listRooms,
  updateReadCursor,
  updateRoom,
} from '../src/services/room';
import { createTestUser, tokenFor } from './helpers';
import request from 'supertest';
import { createApp } from '../src/app';
import { config } from '../src/config';

describe('rooms', () => {
  it('creates private rooms with invite codes and enforces them', async () => {
    const owner = await createTestUser('room_owner');
    const outsider = await createTestUser('room_outsider');
    const room = await createRoom(owner.id, {
      name: 'private-room',
      topic: '',
      isPublic: false,
    });

    expect(room.inviteCode).toMatch(/^[0-9a-f]{8}$/);
    await expect(joinRoom(outsider.id, room.id)).rejects.toMatchObject({
      code: 'INVITE_REQUIRED',
    });
    await expect(joinRoom(outsider.id, room.id, 'bad-code')).rejects.toMatchObject({
      code: 'INVALID_INVITE',
    });

    const joined = await joinRoom(outsider.id, room.id, room.inviteCode ?? '');
    expect(joined.joined).toBe(true);
    expect(joined.memberCount).toBe(2);

    const outsiderView = await getRoomSummary(room.id, outsider.id);
    expect(outsiderView.inviteCode).toBeNull();
  });

  it('prevents the owner from leaving the room', async () => {
    const owner = await createTestUser('leave_owner');
    const room = await createRoom(owner.id, { name: 'owned', isPublic: true });

    await expect(leaveRoom(owner.id, room.id)).rejects.toMatchObject({
      code: 'OWNER_CANNOT_LEAVE',
    });
  });

  it('separates my rooms from public rooms', async () => {
    const owner = await createTestUser('list_owner');
    const member = await createTestUser('list_member');
    const mine = await createRoom(owner.id, { name: 'mine', isPublic: true });
    const open = await createRoom(owner.id, { name: 'open', isPublic: true });
    await joinRoom(member.id, mine.id);

    const ownerList = await listRooms(owner.id);
    expect(ownerList.mine.map((room) => room.id)).toContain(mine.id);
    expect(ownerList.mine.map((room) => room.id)).toContain(open.id);
    expect(ownerList.public.map((room) => room.id)).not.toContain(open.id);

    const memberList = await listRooms(member.id);
    expect(memberList.mine.map((room) => room.id)).toContain(mine.id);
    expect(memberList.public.map((room) => room.id)).toContain(open.id);
    expect(memberList.public.map((room) => room.id)).not.toContain(mine.id);
  });

  it('lets only the owner update room info', async () => {
    const owner = await createTestUser('update_owner');
    const member = await createTestUser('update_member');
    const room = await createRoom(owner.id, { name: 'before', isPublic: true });
    await joinRoom(member.id, room.id);

    const updated = await updateRoom(room.id, owner.id, 'user', {
      name: 'after',
      topic: 'new topic',
    });
    expect(updated.name).toBe('after');
    expect(updated.topic).toBe('new topic');

    await expect(
      updateRoom(room.id, member.id, 'user', { name: 'nope' }),
    ).rejects.toMatchObject({ code: 'ROOM_OWNER_REQUIRED' });
  });

  it('computes unread from the read cursor', async () => {
    const owner = await createTestUser('unread_owner');
    const member = await createTestUser('unread_member');
    const room = await createRoom(owner.id, { name: 'unread', isPublic: true });
    await joinRoom(member.id, room.id);

    for (let index = 1; index <= 3; index += 1) {
      await createMessage({
        roomId: room.id,
        senderId: owner.id,
        senderType: 'user',
        content: `m${index}`,
        clientMsgId: `unread-${index}`,
      });
    }

    await updateReadCursor(room.id, member.id, 2);
    const list = await listRooms(member.id);
    const summary = list.mine.find((item) => item.id === room.id);
    expect(summary?.unreadCount).toBe(1);
  });

  it('excludes own and recalled messages from unread', async () => {
    const owner = await createTestUser('unread2_owner');
    const member = await createTestUser('unread2_member');
    const room = await createRoom(owner.id, { name: 'unread2', isPublic: true });
    await joinRoom(member.id, room.id);

    const first = await createMessage({
      roomId: room.id,
      senderId: owner.id,
      senderType: 'user',
      content: 'other',
      clientMsgId: 'unread2-1',
    });
    const own = await createMessage({
      roomId: room.id,
      senderId: member.id,
      senderType: 'user',
      content: 'mine',
      clientMsgId: 'unread2-2',
    });
    const recalled = await createMessage({
      roomId: room.id,
      senderId: owner.id,
      senderType: 'user',
      content: 'gone',
      clientMsgId: 'unread2-3',
    });
    await deleteMessage(room.id, recalled.seq, owner.id, true);
    void first;
    void own;
    const list = await listRooms(member.id);
    const summary = list.mine.find((item) => item.id === room.id);
    // seq1 other unread; seq2 own excluded; seq3 recalled excluded.
    expect(summary?.unreadCount).toBe(1);
  });

  it('does not rate-limit members re-joining, but limits outsiders', async () => {
    config.rateLimitEnabled = true;
    try {
      const app = createApp();
      const owner = await createTestUser('rejoin_owner');
      const room = await createRoom(owner.id, { name: 'rejoin', isPublic: true });
      const headers = { Authorization: `Bearer ${tokenFor(owner)}` };
      for (let i = 0; i < 8; i += 1) {
        const res = await request(app).post(`/api/rooms/${room.id}/join`).set(headers).send({});
        expect(res.status).toBe(200);
      }
      const privateRoom = await createRoom(owner.id, { name: 'rejoin-private', isPublic: false });
      const outsider = await createTestUser('rejoin_outsider');
      const outsiderHeaders = { Authorization: `Bearer ${tokenFor(outsider)}` };
      let limited = 0;
      let rejected = 0;
      for (let i = 0; i < 8; i += 1) {
        const res = await request(app)
          .post(`/api/rooms/${privateRoom.id}/join`)
          .set(outsiderHeaders)
          .send({});
        if (res.status === 429) {
          limited += 1;
        } else if (res.status === 403) {
          rejected += 1;
        }
      }
      expect(rejected).toBeGreaterThan(0);
      expect(limited).toBeGreaterThan(0);
    } finally {
      config.rateLimitEnabled = false;
    }
  });
});
