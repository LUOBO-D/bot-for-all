import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRoom, getRoomSummary, joinRoom, setMemberRole } from '../src/services/room';
import type { AuthUser, RoomSummary } from '../src/types';
import { createTestRoom, createTestUser, startTestServer, tokenFor, type TestServer } from './helpers';

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

async function newPrivateRoom(owner: AuthUser): Promise<RoomSummary> {
  return createRoom(owner.id, {
    name: `priv-${randomBytes(3).toString('hex')}`,
    topic: '',
    isPublic: false,
  });
}

async function rotate(roomId: number, actor: AuthUser): Promise<request.Response> {
  return request(server.url)
    .post(`/api/rooms/${roomId}/invite-code/rotate`)
    .set('Authorization', auth(actor));
}

async function join(roomId: number, actor: AuthUser, inviteCode?: string): Promise<request.Response> {
  return request(server.url)
    .post(`/api/rooms/${roomId}/join`)
    .set('Authorization', auth(actor))
    .send(inviteCode === undefined ? {} : { inviteCode });
}

describe('POST /api/rooms/:id/invite-code/rotate', () => {
  it('mints a new code, invalidates the old one, and lets the new one in', async () => {
    const owner = await createTestUser('rotate_owner');
    const outsider = await createTestUser('rotate_outsider');
    const room = await newPrivateRoom(owner);
    const oldCode = room.inviteCode;
    expect(oldCode).toMatch(/^[0-9a-f]{8}$/);

    const response = await rotate(room.id, owner);
    expect(response.status).toBe(200);
    const newCode = response.body.inviteCode as string;
    expect(newCode).toMatch(/^[0-9a-f]{8}$/);
    expect(newCode).not.toBe(oldCode);

    const stale = await join(room.id, outsider, oldCode ?? '');
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('INVALID_INVITE');

    const fresh = await join(room.id, outsider, newCode);
    expect(fresh.status).toBe(200);
    expect((fresh.body.room as RoomSummary).joined).toBe(true);

    // The owner sees the rotated code; everyone else still sees nothing.
    expect((await getRoomSummary(room.id, owner.id)).inviteCode).toBe(newCode);
    expect((await getRoomSummary(room.id, outsider.id)).inviteCode).toBeNull();
  });

  it('rotates again to a different code', async () => {
    const owner = await createTestUser('rotate_twice_owner');
    const room = await newPrivateRoom(owner);

    const first = await rotate(room.id, owner);
    const second = await rotate(room.id, owner);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.inviteCode).not.toBe(first.body.inviteCode);
    expect((await getRoomSummary(room.id, owner.id)).inviteCode).toBe(second.body.inviteCode);
  });

  it('rejects members and room admins who are not the owner', async () => {
    const owner = await createTestUser('rotate_owner2');
    const member = await createTestUser('rotate_member');
    const roomAdmin = await createTestUser('rotate_admin');
    const room = await newPrivateRoom(owner);
    await joinRoom(member.id, room.id, room.inviteCode ?? '');
    await joinRoom(roomAdmin.id, room.id, room.inviteCode ?? '');
    await setMemberRole(room.id, owner.id, 'user', roomAdmin.id, 'admin');

    for (const actor of [member, roomAdmin]) {
      const response = await rotate(room.id, actor);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ROOM_OWNER_REQUIRED');
    }
    expect((await getRoomSummary(room.id, owner.id)).inviteCode).toBe(room.inviteCode);
  });

  it('rejects public rooms even for the owner', async () => {
    const owner = await createTestUser('rotate_public_owner');
    const roomId = await createTestRoom(owner);

    const response = await rotate(roomId, owner);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('PUBLIC_ROOM');
  });

  it('lets a global admin rotate a private room they do not own', async () => {
    const owner = await createTestUser('rotate_owner3');
    const admin = await createTestUser('rotate_global_admin', 'admin');
    const room = await newPrivateRoom(owner);

    const response = await rotate(room.id, admin);
    expect(response.status).toBe(200);
    const newCode = response.body.inviteCode as string;
    expect(newCode).toMatch(/^[0-9a-f]{8}$/);
    expect(newCode).not.toBe(room.inviteCode);
    expect((await getRoomSummary(room.id, owner.id)).inviteCode).toBe(newCode);
  });

  it('returns 404 for a room that does not exist', async () => {
    const owner = await createTestUser('rotate_owner4');
    const response = await rotate(999_999_999, owner);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ROOM_NOT_FOUND');
  });

  it('requires authentication', async () => {
    const owner = await createTestUser('rotate_owner5');
    const room = await newPrivateRoom(owner);
    const response = await request(server.url).post(`/api/rooms/${room.id}/invite-code/rotate`);
    expect(response.status).toBe(401);
  });
});
