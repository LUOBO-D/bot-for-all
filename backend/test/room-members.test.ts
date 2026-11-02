import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMessage } from '../src/services/message';
import { joinRoom as joinRoomService, listMembers } from '../src/services/room';
import {
  createTestRoom,
  createTestUser,
  startTestServer,
  tokenFor,
  type TestServer,
} from './helpers';
import type { AuthUser, MemberDTO } from '../src/types';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

async function seedMessage(roomId: number, senderId: number, content: string): Promise<number> {
  const message = await createMessage({
    roomId,
    senderId,
    senderType: 'user',
    content,
    clientMsgId: `member-${roomId}-${senderId}-${content.length}-${Math.random().toString(16).slice(2)}`,
  });
  return message.seq;
}

async function members(roomId: number, actor: AuthUser): Promise<MemberDTO[]> {
  const response = await request(server.url)
    .get(`/api/rooms/${roomId}/members`)
    .set('Authorization', auth(actor));
  expect(response.status).toBe(200);
  return response.body.members as MemberDTO[];
}

describe('room member roles', () => {
  it('lets the owner promote a member to admin', async () => {
    const owner = await createTestUser('role_owner');
    const member = await createTestUser('role_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const response = await request(server.url)
      .patch(`/api/rooms/${roomId}/members/${member.id}`)
      .set('Authorization', auth(owner))
      .send({ role: 'admin' });

    expect(response.status).toBe(200);
    expect(response.body.member).toMatchObject({ userId: member.id, role: 'admin' });

    const list = await members(roomId, owner);
    expect(list.find((entry) => entry.userId === member.id)?.role).toBe('admin');

    const demoted = await request(server.url)
      .patch(`/api/rooms/${roomId}/members/${member.id}`)
      .set('Authorization', auth(owner))
      .send({ role: 'member' });
    expect(demoted.status).toBe(200);
    expect(demoted.body.member.role).toBe('member');
    expect((await listMembers(roomId)).find((entry) => entry.userId === member.id)?.role).toBe(
      'member',
    );
  });

  it('rejects role changes from non-owners, for owners, and for invalid roles', async () => {
    const owner = await createTestUser('role_owner2');
    const admin = await createTestUser('role_admin2');
    const plain = await createTestUser('role_plain2');
    const outsider = await createTestUser('role_outsider2');
    const roomId = await createTestRoom(owner);
    await joinRoomService(admin.id, roomId);
    await joinRoomService(plain.id, roomId);
    await request(server.url)
      .patch(`/api/rooms/${roomId}/members/${admin.id}`)
      .set('Authorization', auth(owner))
      .send({ role: 'admin' });

    const byAdmin = await request(server.url)
      .patch(`/api/rooms/${roomId}/members/${plain.id}`)
      .set('Authorization', auth(admin))
      .send({ role: 'admin' });
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const byPlain = await request(server.url)
      .patch(`/api/rooms/${roomId}/members/${admin.id}`)
      .set('Authorization', auth(plain))
      .send({ role: 'member' });
    expect(byPlain.status).toBe(403);
    expect(byPlain.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const invalid = await request(server.url)
      .patch(`/api/rooms/${roomId}/members/${plain.id}`)
      .set('Authorization', auth(owner))
      .send({ role: 'owner' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_ROLE');

    const onOwner = await request(server.url)
      .patch(`/api/rooms/${roomId}/members/${owner.id}`)
      .set('Authorization', auth(owner))
      .send({ role: 'member' });
    expect(onOwner.status).toBe(403);
    expect(onOwner.body.error.code).toBe('NOT_ALLOWED');

    const missing = await request(server.url)
      .patch(`/api/rooms/${roomId}/members/${outsider.id}`)
      .set('Authorization', auth(owner))
      .send({ role: 'admin' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('MEMBER_NOT_FOUND');
  });

  it('lets a global admin assign roles without being the room owner', async () => {
    const owner = await createTestUser('role_gowner');
    const globalAdmin = await createTestUser('role_global', 'admin');
    const member = await createTestUser('role_gmember');
    const roomId = await createTestRoom(owner);
    await joinRoomService(globalAdmin.id, roomId);
    await joinRoomService(member.id, roomId);

    const response = await request(server.url)
      .patch(`/api/rooms/${roomId}/members/${member.id}`)
      .set('Authorization', auth(globalAdmin))
      .send({ role: 'admin' });

    expect(response.status).toBe(200);
    expect(response.body.member.role).toBe('admin');
  });
});

describe('room moderators', () => {
  it('lets a room admin pin and delete other members messages', async () => {
    const owner = await createTestUser('mod_owner');
    const admin = await createTestUser('mod_admin');
    const plain = await createTestUser('mod_plain');
    const roomId = await createTestRoom(owner);
    await joinRoomService(admin.id, roomId);
    await joinRoomService(plain.id, roomId);
    await request(server.url)
      .patch(`/api/rooms/${roomId}/members/${admin.id}`)
      .set('Authorization', auth(owner))
      .send({ role: 'admin' });

    const ownerSeq = await seedMessage(roomId, owner.id, 'owner note');
    const plainSeq = await seedMessage(roomId, plain.id, 'plain note');

    const pinDenied = await request(server.url)
      .post(`/api/rooms/${roomId}/messages/${ownerSeq}/pin`)
      .set('Authorization', auth(plain));
    expect(pinDenied.status).toBe(403);
    expect(pinDenied.body.error.code).toBe('ROOM_OWNER_REQUIRED');

    const pinned = await request(server.url)
      .post(`/api/rooms/${roomId}/messages/${ownerSeq}/pin`)
      .set('Authorization', auth(admin));
    expect(pinned.status).toBe(200);
    expect(pinned.body.message.pinned).toBe(true);

    const unpinned = await request(server.url)
      .delete(`/api/rooms/${roomId}/messages/${ownerSeq}/pin`)
      .set('Authorization', auth(admin));
    expect(unpinned.status).toBe(200);
    expect(unpinned.body.message.pinned).toBe(false);

    const plainDelete = await request(server.url)
      .delete(`/api/rooms/${roomId}/messages/${ownerSeq}`)
      .set('Authorization', auth(plain));
    expect(plainDelete.status).toBe(403);
    expect(plainDelete.body.error.code).toBe('NOT_PERMITTED');

    const adminDelete = await request(server.url)
      .delete(`/api/rooms/${roomId}/messages/${plainSeq}`)
      .set('Authorization', auth(admin));
    expect(adminDelete.status).toBe(200);
    expect(adminDelete.body.message.deleted).toBe(true);
  });

  it('keeps self-delete working for plain members', async () => {
    const owner = await createTestUser('mod_self_owner');
    const plain = await createTestUser('mod_self_plain');
    const roomId = await createTestRoom(owner);
    await joinRoomService(plain.id, roomId);
    const seq = await seedMessage(roomId, plain.id, 'own message');

    const response = await request(server.url)
      .delete(`/api/rooms/${roomId}/messages/${seq}`)
      .set('Authorization', auth(plain));
    expect(response.status).toBe(200);
    expect(response.body.message.deleted).toBe(true);
  });
});

describe('room member removal', () => {
  it('stops a room admin from kicking admins or the owner, but allows members', async () => {
    const owner = await createTestUser('kick_owner');
    const admin = await createTestUser('kick_admin');
    const peerAdmin = await createTestUser('kick_peer_admin');
    const plain = await createTestUser('kick_plain');
    const roomId = await createTestRoom(owner);
    for (const user of [admin, peerAdmin, plain]) {
      await joinRoomService(user.id, roomId);
    }
    for (const target of [admin, peerAdmin]) {
      await request(server.url)
        .patch(`/api/rooms/${roomId}/members/${target.id}`)
        .set('Authorization', auth(owner))
        .send({ role: 'admin' });
    }

    const kickOwner = await request(server.url)
      .delete(`/api/rooms/${roomId}/members/${owner.id}`)
      .set('Authorization', auth(admin));
    expect(kickOwner.status).toBe(403);
    expect(kickOwner.body.error.code).toBe('NOT_ALLOWED');

    const kickAdmin = await request(server.url)
      .delete(`/api/rooms/${roomId}/members/${peerAdmin.id}`)
      .set('Authorization', auth(admin));
    expect(kickAdmin.status).toBe(403);
    expect(kickAdmin.body.error.code).toBe('NOT_ALLOWED');

    const kickMember = await request(server.url)
      .delete(`/api/rooms/${roomId}/members/${plain.id}`)
      .set('Authorization', auth(admin));
    expect(kickMember.status).toBe(200);
    expect(kickMember.body.ok).toBe(true);

    const list = await members(roomId, owner);
    expect(list.some((entry) => entry.userId === plain.id)).toBe(false);
  });

  it('lets the owner kick members and blocks the kicked user afterwards', async () => {
    const owner = await createTestUser('kick_owner2');
    const member = await createTestUser('kick_member2');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const kicked = await request(server.url)
      .delete(`/api/rooms/${roomId}/members/${member.id}`)
      .set('Authorization', auth(owner));
    expect(kicked.status).toBe(200);

    const after = await request(server.url)
      .get(`/api/rooms/${roomId}/members`)
      .set('Authorization', auth(member));
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('NOT_MEMBER');

    const read = await request(server.url)
      .get(`/api/rooms/${roomId}/messages`)
      .set('Authorization', auth(member));
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe('NOT_MEMBER');
  });

  it('rejects kicking the owner, kicking yourself, and kicking non-members', async () => {
    const owner = await createTestUser('kick_owner3');
    const member = await createTestUser('kick_member3');
    const outsider = await createTestUser('kick_outsider3');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const self = await request(server.url)
      .delete(`/api/rooms/${roomId}/members/${owner.id}`)
      .set('Authorization', auth(owner));
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('NOT_ALLOWED');

    const missing = await request(server.url)
      .delete(`/api/rooms/${roomId}/members/${outsider.id}`)
      .set('Authorization', auth(owner));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('MEMBER_NOT_FOUND');

    const byPlain = await request(server.url)
      .delete(`/api/rooms/${roomId}/members/${owner.id}`)
      .set('Authorization', auth(member));
    expect(byPlain.status).toBe(403);
    expect(byPlain.body.error.code).toBe('NOT_ALLOWED');
  });

  it('lets a global admin kick room admins but never the owner', async () => {
    const owner = await createTestUser('kick_gowner');
    const globalAdmin = await createTestUser('kick_global', 'admin');
    const admin = await createTestUser('kick_gadmin');
    const roomId = await createTestRoom(owner);
    await joinRoomService(globalAdmin.id, roomId);
    await joinRoomService(admin.id, roomId);
    await request(server.url)
      .patch(`/api/rooms/${roomId}/members/${admin.id}`)
      .set('Authorization', auth(owner))
      .send({ role: 'admin' });

    const kickAdmin = await request(server.url)
      .delete(`/api/rooms/${roomId}/members/${admin.id}`)
      .set('Authorization', auth(globalAdmin));
    expect(kickAdmin.status).toBe(200);

    const kickOwner = await request(server.url)
      .delete(`/api/rooms/${roomId}/members/${owner.id}`)
      .set('Authorization', auth(globalAdmin));
    expect(kickOwner.status).toBe(403);
    expect(kickOwner.body.error.code).toBe('NOT_ALLOWED');
  });
});
