import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { getMember, listMembers } from '../src/services/room';
import type { AuthUser, MemberDTO } from '../src/types';
import {
  connectClient,
  createTestRoom,
  createTestUser,
  delay,
  startTestServer,
  tokenFor,
  type TestServer,
} from './helpers';

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

async function openClient(user: AuthUser): Promise<Socket> {
  const client = await connectClient(server.url, tokenFor(user));
  clients.push(client);
  return client;
}

/**
 * The socket writes `last_seen_at` fire-and-forget, so a read taken right after
 * connect/disconnect may still see the previous value. Poll until it matches.
 */
async function waitForLastSeen(
  read: () => Promise<MemberDTO | null>,
  accept: (value: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = (await read())?.lastSeenAt ?? null;
    if (value !== null && accept(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for lastSeenAt (last value: ${String(value)})`);
    }
    await delay(25);
  }
}

function parse(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`lastSeenAt is not a parseable date: ${value}`);
  }
  return ms;
}

describe('member last seen', () => {
  it('stamps lastSeenAt when a socket connects', async () => {
    const user = await createTestUser('seen-connect');
    const roomId = await createTestRoom(user);

    await openClient(user);

    const value = await waitForLastSeen(
      () => getMember(roomId, user.id),
      () => true,
    );
    expect(Number.isNaN(Date.parse(value))).toBe(false);
    expect(parse(value)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('updates lastSeenAt again on disconnect', async () => {
    const user = await createTestUser('seen-disconnect');
    const roomId = await createTestRoom(user);

    const client = await openClient(user);
    const connectedAt = await waitForLastSeen(
      () => getMember(roomId, user.id),
      () => true,
    );

    // Millisecond precision: leave a gap so the disconnect stamp is strictly
    // later than the connect one instead of racing it.
    await delay(50);
    client.close();

    const disconnectedAt = await waitForLastSeen(
      () => getMember(roomId, user.id),
      (value) => parse(value) > parse(connectedAt),
    );
    expect(parse(disconnectedAt)).toBeGreaterThan(parse(connectedAt));
  });

  it('leaves lastSeenAt null for users that never connected', async () => {
    const user = await createTestUser('seen-never');
    const roomId = await createTestRoom(user);

    const member = await getMember(roomId, user.id);
    expect(member?.lastSeenAt).toBeNull();

    const [listed] = await listMembers(roomId);
    expect(listed.lastSeenAt).toBeNull();
  });

  it('reports the same lastSeenAt from the member list and the single member', async () => {
    const owner = await createTestUser('seen-owner');
    const roomId = await createTestRoom(owner);

    await openClient(owner);
    const expected = await waitForLastSeen(
      () => getMember(roomId, owner.id),
      () => true,
    );

    const single = await getMember(roomId, owner.id);
    const listed = await listMembers(roomId);
    const fromList = listed.find((member) => member.userId === owner.id);
    expect(fromList?.lastSeenAt).toBe(expected);
    expect(single?.lastSeenAt).toBe(expected);

    const response = await request(server.url)
      .get(`/api/rooms/${roomId}/members`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .expect(200);
    const members = response.body.members as MemberDTO[];
    expect(members.find((member) => member.userId === owner.id)?.lastSeenAt).toBe(expected);
  });
});
