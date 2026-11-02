import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { pool, type RowDataPacket } from '../src/db';
import { getAuthUserById } from '../src/services/user';
import {
  getMember,
  joinRoom as joinRoomService,
  listMembers,
} from '../src/services/room';
import {
  connectClient,
  createTestRoom,
  createTestUser,
  delay,
  joinRoom,
  startTestServer,
  tokenFor,
  waitForEvent,
  type TestServer,
} from './helpers';
import type { AuthUser, MemberDTO } from '../src/types';

interface UserDto {
  id: number;
  username: string;
  displayName: string;
  statusEmoji: string | null;
  statusText: string | null;
}

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

async function openClient(token: string): Promise<Socket> {
  const client = await connectClient(server.url, token);
  clients.push(client);
  return client;
}

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

async function patchMe(
  user: AuthUser,
  body: Record<string, unknown>,
): Promise<{ status: number; body: { user?: UserDto; error?: { code: string } } }> {
  const response = await request(server.url)
    .patch('/api/auth/me')
    .set('Authorization', auth(user))
    .send(body);
  return { status: response.status, body: response.body };
}

async function fetchMe(user: AuthUser): Promise<UserDto> {
  const response = await request(server.url)
    .get('/api/auth/me')
    .set('Authorization', auth(user));
  expect(response.status).toBe(200);
  return response.body.user as UserDto;
}

async function membersViaApi(roomId: number, actor: AuthUser): Promise<MemberDTO[]> {
  const response = await request(server.url)
    .get(`/api/rooms/${roomId}/members`)
    .set('Authorization', auth(actor));
  expect(response.status).toBe(200);
  return response.body.members as MemberDTO[];
}

function memberOf(members: MemberDTO[], userId: number): MemberDTO {
  const found = members.find((entry) => entry.userId === userId);
  if (!found) {
    throw new Error(`member ${userId} missing from list`);
  }
  return found;
}

describe('user status migration', () => {
  it('adds nullable status columns to users', async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
          AND COLUMN_NAME IN ('status_emoji', 'status_text')
        ORDER BY COLUMN_NAME`,
    );
    expect(rows.map((row) => String(row.COLUMN_NAME))).toEqual([
      'status_emoji',
      'status_text',
    ]);
    for (const row of rows) {
      expect(String(row.IS_NULLABLE)).toBe('YES');
    }
  });
});

describe('PATCH /api/auth/me status', () => {
  it('stores an emoji and text and exposes them on /auth/me', async () => {
    const user = await createTestUser('status_set');

    const response = await patchMe(user, { statusEmoji: '🌊', statusText: '  忙 中  ' });
    expect(response.status).toBe(200);
    expect(response.body.user?.statusEmoji).toBe('🌊');
    // Surrounding whitespace is trimmed before it is stored.
    expect(response.body.user?.statusText).toBe('忙 中');

    const viaMe = await fetchMe(user);
    expect(viaMe.statusEmoji).toBe('🌊');
    expect(viaMe.statusText).toBe('忙 中');

    const stored = await getAuthUserById(user.id);
    expect(stored?.statusEmoji).toBe('🌊');
    expect(stored?.statusText).toBe('忙 中');
  });

  it('defaults to null for a user without a status', async () => {
    const user = await createTestUser('status_default');
    const viaMe = await fetchMe(user);
    expect(viaMe.statusEmoji).toBeNull();
    expect(viaMe.statusText).toBeNull();
  });

  it('clears the status with null or blank input', async () => {
    const user = await createTestUser('status_clear');
    await patchMe(user, { statusEmoji: '🌊', statusText: '忙' });

    const cleared = await patchMe(user, { statusEmoji: null, statusText: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.user?.statusEmoji).toBeNull();
    expect(cleared.body.user?.statusText).toBeNull();

    await patchMe(user, { statusEmoji: '🌊', statusText: '忙' });
    const whitespace = await patchMe(user, { statusText: '   ' });
    expect(whitespace.status).toBe(200);
    expect(whitespace.body.user?.statusText).toBeNull();
    // Fields that are absent from the body keep their stored value.
    expect(whitespace.body.user?.statusEmoji).toBe('🌊');
  });

  it('rejects an over-long emoji or text', async () => {
    const user = await createTestUser('status_toolong');

    const longEmoji = await patchMe(user, { statusEmoji: 'x'.repeat(17) });
    expect(longEmoji.status).toBe(400);
    expect(longEmoji.body.error?.code).toBe('INVALID_INPUT');

    const longText = await patchMe(user, { statusText: 'x'.repeat(65) });
    expect(longText.status).toBe(400);
    expect(longText.body.error?.code).toBe('INVALID_INPUT');

    const stored = await getAuthUserById(user.id);
    expect(stored?.statusEmoji).toBeNull();
    expect(stored?.statusText).toBeNull();
  });

  it('rejects an empty patch', async () => {
    const user = await createTestUser('status_empty');
    const response = await patchMe(user, {});
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('INVALID_INPUT');
  });

  it('still updates the display name without touching the status', async () => {
    const user = await createTestUser('status_displayname');
    await patchMe(user, { statusEmoji: '🌊', statusText: '忙' });

    const response = await patchMe(user, { displayName: '新名字' });
    expect(response.status).toBe(200);
    expect(response.body.user?.displayName).toBe('新名字');
    expect(response.body.user?.statusEmoji).toBe('🌊');
    expect(response.body.user?.statusText).toBe('忙');
  });
});

describe('member list status', () => {
  it('shows the status in every member list source', async () => {
    const owner = await createTestUser('status_owner');
    const member = await createTestUser('status_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    await patchMe(member, { statusEmoji: '🎧', statusText: '听歌中' });

    const viaApi = memberOf(await membersViaApi(roomId, owner), member.id);
    expect(viaApi.statusEmoji).toBe('🎧');
    expect(viaApi.statusText).toBe('听歌中');

    const listed = memberOf(await listMembers(roomId), member.id);
    expect(listed.statusEmoji).toBe('🎧');
    expect(listed.statusText).toBe('听歌中');

    const single = await getMember(roomId, member.id);
    expect(single?.statusEmoji).toBe('🎧');
    expect(single?.statusText).toBe('听歌中');

    // Other members keep their own (empty) status.
    expect(memberOf(await membersViaApi(roomId, owner), owner.id).statusEmoji).toBeNull();
  });
});

describe('members:changed broadcast', () => {
  it('notifies every room the user belongs to', async () => {
    const alice = await createTestUser('status_room_a_owner');
    const bob = await createTestUser('status_room_b_owner');
    const carol = await createTestUser('status_broadcast');
    const roomA = await createTestRoom(alice);
    const roomB = await createTestRoom(bob);
    await joinRoomService(carol.id, roomA);
    await joinRoomService(carol.id, roomB);
    // A room the user is not in must not hear about the change.
    const roomC = await createTestRoom(alice);

    const clientA = await openClient(tokenFor(alice));
    const clientB = await openClient(tokenFor(bob));
    const clientC = await openClient(tokenFor(alice));
    await joinRoom(clientA, roomA);
    await joinRoom(clientB, roomB);
    await joinRoom(clientC, roomC);

    const sawC = { hit: false };
    clientC.on('members:changed', () => {
      sawC.hit = true;
    });

    const eventA = waitForEvent<{ roomId: number }>(
      clientA,
      'members:changed',
      (payload) => payload.roomId === roomA,
    );
    const eventB = waitForEvent<{ roomId: number }>(
      clientB,
      'members:changed',
      (payload) => payload.roomId === roomB,
    );

    const response = await patchMe(carol, { statusEmoji: '🌊', statusText: '忙' });
    expect(response.status).toBe(200);

    expect(await eventA).toEqual({ roomId: roomA });
    expect(await eventB).toEqual({ roomId: roomB });
    // Give the unrelated room's socket time to receive anything it might get.
    await delay(150);
    expect(sawC.hit).toBe(false);
  });
});
