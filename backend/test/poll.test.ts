import request from 'supertest';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { pool, type RowDataPacket } from '../src/db';
import { createMessage } from '../src/services/message';
import { joinRoom as joinRoomService, setMemberRole } from '../src/services/room';
import type { AuthUser, MessageDTO, PollDTO } from '../src/types';
import {
  connectClient,
  createTestRoom,
  createTestUser,
  joinRoom as joinRoomSocket,
  startTestServer,
  tokenFor,
  waitForEvent,
  type TestServer,
} from './helpers';

let server: TestServer;
const sockets: Socket[] = [];

beforeAll(async () => {
  server = await startTestServer();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.disconnect();
  }
  config.rateLimitEnabled = false;
});

afterAll(async () => {
  await server.close();
});

/**
 * The shared setup truncates `messages` with foreign-key checks disabled, so
 * poll rows would survive as orphans and collide with the ids that restart at
 * 1. Clear them here, after the shared hook has emptied the parent table.
 */
beforeEach(async () => {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of ['poll_votes', 'poll_options', 'polls']) {
      await conn.query(`TRUNCATE TABLE ${table}`);
    }
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    conn.release();
  }
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

function pollOf(message: MessageDTO): PollDTO {
  if (!message.poll) {
    throw new Error(`message ${message.seq} has no poll`);
  }
  return message.poll;
}

async function createPoll(
  roomId: number,
  actor: AuthUser,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(server.url)
    .post(`/api/rooms/${roomId}/polls`)
    .set('Authorization', auth(actor))
    .send(body);
}

async function vote(
  roomId: number,
  seq: number,
  actor: AuthUser,
  optionIds: number[],
): Promise<request.Response> {
  return request(server.url)
    .post(`/api/rooms/${roomId}/messages/${seq}/poll/votes`)
    .set('Authorization', auth(actor))
    .send({ optionIds });
}

async function myVotes(
  roomId: number,
  seq: number,
  actor: AuthUser,
): Promise<request.Response> {
  return request(server.url)
    .get(`/api/rooms/${roomId}/messages/${seq}/poll/my-votes`)
    .set('Authorization', auth(actor));
}

async function closePoll(
  roomId: number,
  seq: number,
  actor: AuthUser,
): Promise<request.Response> {
  return request(server.url)
    .post(`/api/rooms/${roomId}/messages/${seq}/poll/close`)
    .set('Authorization', auth(actor));
}

async function listRoom(roomId: number, actor: AuthUser): Promise<MessageDTO[]> {
  const response = await request(server.url)
    .get(`/api/rooms/${roomId}/messages`)
    .set('Authorization', auth(actor));
  expect(response.status).toBe(200);
  return response.body.messages as MessageDTO[];
}

async function countPolls(roomId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS total FROM messages WHERE room_id = ? AND kind = 'poll'",
    [roomId],
  );
  return Number(rows[0]?.total ?? 0);
}

interface MessageEvent {
  roomId: number;
  message: MessageDTO;
}

const VALID_POLL = {
  question: 'Where to eat?',
  options: ['Pizza', 'Sushi'],
  multiple: false,
};

describe('poll creation', () => {
  it('creates a poll message, returns the hydrated DTO and broadcasts it', async () => {
    const owner = await createTestUser('poll_create_owner');
    const roomId = await createTestRoom(owner);
    const socket = await connectClient(server.url, tokenFor(owner));
    sockets.push(socket);
    await joinRoomSocket(socket, roomId);

    const broadcast = waitForEvent<MessageEvent>(
      socket,
      'message:new',
      (payload) => payload.roomId === roomId && payload.message.kind === 'poll',
    );

    const response = await createPoll(roomId, owner, VALID_POLL);
    expect(response.status).toBe(201);
    const message = response.body.message as MessageDTO;
    expect(message.kind).toBe('poll');
    expect(message.content).toBe('Where to eat?');
    expect(message.senderId).toBe(owner.id);
    const poll = pollOf(message);
    expect(poll.question).toBe('Where to eat?');
    expect(poll.multiple).toBe(false);
    expect(poll.closesAt).toBeNull();
    expect(poll.closed).toBe(false);
    expect(poll.totalVotes).toBe(0);
    expect(poll.options.map((option) => option.label)).toEqual(['Pizza', 'Sushi']);
    for (const option of poll.options) {
      expect(option.count).toBe(0);
      expect(option.userIds).toEqual([]);
    }

    const event = await broadcast;
    expect(pollOf(event.message).options).toHaveLength(2);

    const stored = (await listRoom(roomId, owner)).find((item) => item.seq === message.seq);
    expect(stored?.kind).toBe('poll');
    expect(pollOf(stored as MessageDTO).question).toBe('Where to eat?');
  });

  it('rejects malformed payloads and non-members', async () => {
    const owner = await createTestUser('poll_invalid_owner');
    const outsider = await createTestUser('poll_invalid_outsider');
    const roomId = await createTestRoom(owner);

    const invalidBodies: Record<string, unknown>[] = [
      { question: '', options: ['A', 'B'] },
      { question: 'x'.repeat(301), options: ['A', 'B'] },
      { question: 'Q', options: ['A'] },
      { question: 'Q', options: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'] },
      { question: 'Q', options: ['A', ''] },
      { question: 'Q', options: ['A', 'x'.repeat(101)] },
      { question: 'Q', options: ['A', 'B'], closesInMinutes: 0 },
      { question: 'Q', options: ['A', 'B'], closesInMinutes: 10081 },
      { question: 'Q', options: ['A', 'B'], closesInMinutes: 1.5 },
      { question: 'Q', options: ['A', 'B'], multiple: 'yes' },
    ];
    for (const body of invalidBodies) {
      const response = await createPoll(roomId, owner, body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }

    // Trimmed, case-insensitive duplicates are rejected by the service.
    const duplicate = await createPoll(roomId, owner, {
      question: 'Pick one',
      options: ['Yes', '  yes '],
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.code).toBe('INVALID_OPTION');

    const byOutsider = await createPoll(roomId, outsider, VALID_POLL);
    expect(byOutsider.status).toBe(403);
    expect(byOutsider.body.error.code).toBe('NOT_MEMBER');
    expect(await countPolls(roomId)).toBe(0);
  });

  it('sets closesAt from closesInMinutes and reports closed from the current time', async () => {
    const owner = await createTestUser('poll_deadline_owner');
    const roomId = await createTestRoom(owner);
    const before = Date.now();

    const response = await createPoll(roomId, owner, {
      question: 'Deadline?',
      options: ['Yes', 'No'],
      multiple: true,
      closesInMinutes: 60,
    });
    expect(response.status).toBe(201);
    const poll = pollOf(response.body.message as MessageDTO);
    expect(poll.multiple).toBe(true);
    expect(poll.closesAt).not.toBeNull();
    const closesAt = new Date(String(poll.closesAt)).getTime();
    expect(closesAt).toBeGreaterThanOrEqual(before + 60 * 60_000 - 5_000);
    expect(closesAt).toBeLessThanOrEqual(Date.now() + 60 * 60_000 + 5_000);
    expect(poll.closed).toBe(false);

    // Move the deadline into the past without touching the original DTO.
    await pool.execute('UPDATE polls SET closes_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id = ?', [
      poll.id,
    ]);
    const stored = (await listRoom(roomId, owner)).find((item) => item.seq === response.body.message.seq);
    expect(pollOf(stored as MessageDTO).closed).toBe(true);
  });
});

describe('poll voting', () => {
  it('replaces the single-choice selection and clears it with an empty list', async () => {
    const owner = await createTestUser('poll_vote_owner');
    const roomId = await createTestRoom(owner);
    const created = await createPoll(roomId, owner, VALID_POLL);
    const message = created.body.message as MessageDTO;
    const poll = pollOf(message);
    const [pizza, sushi] = poll.options;

    const first = await vote(roomId, message.seq, owner, [pizza.id]);
    expect(first.status).toBe(200);
    let current = pollOf(first.body.message as MessageDTO);
    expect(current.totalVotes).toBe(1);
    expect(current.options[0].count).toBe(1);
    expect(current.options[0].userIds).toEqual([owner.id]);
    expect(current.options[1].count).toBe(0);
    expect(current.options[1].userIds).toEqual([]);

    // Re-voting is replacement, not addition.
    const second = await vote(roomId, message.seq, owner, [sushi.id]);
    expect(second.status).toBe(200);
    current = pollOf(second.body.message as MessageDTO);
    expect(current.totalVotes).toBe(1);
    expect(current.options[0].count).toBe(0);
    expect(current.options[1].count).toBe(1);
    expect(current.options[1].userIds).toEqual([owner.id]);

    const cleared = await vote(roomId, message.seq, owner, []);
    expect(cleared.status).toBe(200);
    current = pollOf(cleared.body.message as MessageDTO);
    expect(current.totalVotes).toBe(0);
    expect(current.options.map((option) => option.count)).toEqual([0, 0]);

    const stored = (await listRoom(roomId, owner)).find((item) => item.seq === message.seq);
    expect(pollOf(stored as MessageDTO).totalVotes).toBe(0);
  });

  it('accepts several options on a multiple-choice poll and counts each member once', async () => {
    const owner = await createTestUser('poll_multi_owner');
    const member = await createTestUser('poll_multi_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const response = await createPoll(roomId, owner, {
      question: 'Which toppings?',
      options: ['Cheese', 'Olives', 'Basil'],
      multiple: true,
    });
    expect(response.status).toBe(201);
    const message = response.body.message as MessageDTO;
    const [cheese, olives, basil] = pollOf(message).options;

    const ownerVote = await vote(roomId, message.seq, owner, [cheese.id, basil.id]);
    expect(ownerVote.status).toBe(200);
    let poll = pollOf(ownerVote.body.message as MessageDTO);
    expect(poll.totalVotes).toBe(1);
    expect(poll.options.map((option) => option.count)).toEqual([1, 0, 1]);

    const memberVote = await vote(roomId, message.seq, member, [olives.id, basil.id]);
    expect(memberVote.status).toBe(200);
    poll = pollOf(memberVote.body.message as MessageDTO);
    expect(poll.totalVotes).toBe(2);
    expect(poll.options.map((option) => option.count)).toEqual([1, 1, 2]);
    expect(poll.options[2].userIds).toEqual([owner.id, member.id].sort((a, b) => a - b));
  });

  it('rejects single-choice multi-select, foreign options and oversized lists', async () => {
    const owner = await createTestUser('poll_vote_invalid_owner');
    const roomId = await createTestRoom(owner);
    const first = (await createPoll(roomId, owner, VALID_POLL)).body.message as MessageDTO;
    const second = (
      await createPoll(roomId, owner, {
        question: 'Second?',
        options: ['One', 'Two'],
      })
    ).body.message as MessageDTO;

    const multiOnSingle = await vote(roomId, first.seq, owner, [
      pollOf(first).options[0].id,
      pollOf(first).options[1].id,
    ]);
    expect(multiOnSingle.status).toBe(400);
    expect(multiOnSingle.body.error.code).toBe('INVALID_OPTION');

    const foreign = await vote(roomId, first.seq, owner, [pollOf(second).options[0].id]);
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe('INVALID_OPTION');

    const tooMany = await vote(
      roomId,
      first.seq,
      owner,
      Array.from({ length: 11 }, (_value, index) => index + 1),
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('INVALID_INPUT');

    const text = await createMessage({
      roomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'just text',
    });
    const onText = await vote(roomId, text.seq, owner, []);
    expect(onText.status).toBe(404);
    expect(onText.body.error.code).toBe('POLL_NOT_FOUND');

    const missing = await vote(roomId, 9999, owner, []);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('rejects a closed poll and a withdrawn poll', async () => {
    const owner = await createTestUser('poll_closed_owner');
    const roomId = await createTestRoom(owner);

    const closedMessage = (await createPoll(roomId, owner, VALID_POLL)).body.message as MessageDTO;
    await pool.execute('UPDATE polls SET closes_at = DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE id = ?', [
      pollOf(closedMessage).id,
    ]);
    const closed = await vote(roomId, closedMessage.seq, owner, []);
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('POLL_CLOSED');

    const deletedMessage = (
      await createPoll(roomId, owner, { question: 'Withdraw me?', options: ['Yes', 'No'] })
    ).body.message as MessageDTO;
    const deleted = await request(server.url)
      .delete(`/api/rooms/${roomId}/messages/${deletedMessage.seq}`)
      .set('Authorization', auth(owner));
    expect(deleted.status).toBe(200);
    expect((deleted.body.message as MessageDTO).deleted).toBe(true);
    expect((deleted.body.message as MessageDTO).poll).toBeNull();

    const withdrawn = await vote(roomId, deletedMessage.seq, owner, []);
    expect(withdrawn.status).toBe(409);
    expect(withdrawn.body.error.code).toBe('MESSAGE_DELETED');
  });

  it('refuses votes from non-members', async () => {
    const owner = await createTestUser('poll_vote_member_owner');
    const outsider = await createTestUser('poll_vote_outsider');
    const roomId = await createTestRoom(owner);
    const message = (await createPoll(roomId, owner, VALID_POLL)).body.message as MessageDTO;

    const response = await vote(roomId, message.seq, outsider, [pollOf(message).options[0].id]);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
  });

  it('broadcasts message:updated with the new tallies', async () => {
    const owner = await createTestUser('poll_broadcast_owner');
    const roomId = await createTestRoom(owner);
    const message = (await createPoll(roomId, owner, VALID_POLL)).body.message as MessageDTO;
    const socket = await connectClient(server.url, tokenFor(owner));
    sockets.push(socket);
    await joinRoomSocket(socket, roomId);

    const broadcast = waitForEvent<MessageEvent>(
      socket,
      'message:updated',
      (payload) => payload.roomId === roomId && payload.message.seq === message.seq,
    );
    const response = await vote(roomId, message.seq, owner, [pollOf(message).options[1].id]);
    expect(response.status).toBe(200);
    const event = await broadcast;
    expect(pollOf(event.message).totalVotes).toBe(1);
    expect(pollOf(event.message).options[1].count).toBe(1);
  });
});

describe('poll closing', () => {
  it('lets the author close early, broadcasts it and rejects later votes', async () => {
    const owner = await createTestUser('poll_close_author');
    const roomId = await createTestRoom(owner);
    const message = (
      await createPoll(roomId, owner, { question: 'Close me?', options: ['Yes', 'No'] })
    ).body.message as MessageDTO;
    const socket = await connectClient(server.url, tokenFor(owner));
    sockets.push(socket);
    await joinRoomSocket(socket, roomId);

    const broadcast = waitForEvent<MessageEvent>(
      socket,
      'message:updated',
      (payload) => payload.roomId === roomId && payload.message.seq === message.seq,
    );
    const response = await closePoll(roomId, message.seq, owner);
    expect(response.status).toBe(200);
    const closed = pollOf(response.body.message as MessageDTO);
    expect(closed.closed).toBe(true);
    expect(closed.closesAt).not.toBeNull();
    expect(Date.parse(closed.closesAt as string)).toBeLessThanOrEqual(Date.now());

    const event = await broadcast;
    expect(pollOf(event.message).closed).toBe(true);

    const late = await vote(roomId, message.seq, owner, [pollOf(message).options[0].id]);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('POLL_CLOSED');
  });

  it('lets the room owner, a room admin and a global admin close another member poll', async () => {
    const owner = await createTestUser('poll_close_owner');
    const author = await createTestUser('poll_close_author_member');
    const roomAdmin = await createTestUser('poll_close_room_admin');
    const globalAdmin = await createTestUser('poll_close_global_admin', 'admin');
    const roomId = await createTestRoom(owner);
    await joinRoomService(author.id, roomId);
    await joinRoomService(roomAdmin.id, roomId);
    await joinRoomService(globalAdmin.id, roomId);
    await setMemberRole(roomId, owner.id, 'user', roomAdmin.id, 'admin');

    const forOwner = (
      await createPoll(roomId, author, { question: 'Owner closes?', options: ['Yes', 'No'] })
    ).body.message as MessageDTO;
    expect((await closePoll(roomId, forOwner.seq, owner)).status).toBe(200);

    const forRoomAdmin = (
      await createPoll(roomId, author, { question: 'Room admin closes?', options: ['Yes', 'No'] })
    ).body.message as MessageDTO;
    expect((await closePoll(roomId, forRoomAdmin.seq, roomAdmin)).status).toBe(200);

    const forGlobalAdmin = (
      await createPoll(roomId, author, { question: 'Global admin closes?', options: ['Yes', 'No'] })
    ).body.message as MessageDTO;
    expect((await closePoll(roomId, forGlobalAdmin.seq, globalAdmin)).status).toBe(200);
  });

  it('refuses a plain member and leaves the poll open', async () => {
    const owner = await createTestUser('poll_close_denied_owner');
    const author = await createTestUser('poll_close_denied_author');
    const member = await createTestUser('poll_close_denied_member');
    const outsider = await createTestUser('poll_close_denied_outsider');
    const roomId = await createTestRoom(owner);
    await joinRoomService(author.id, roomId);
    await joinRoomService(member.id, roomId);

    const message = (
      await createPoll(roomId, author, { question: 'Not yours?', options: ['Yes', 'No'] })
    ).body.message as MessageDTO;
    const denied = await closePoll(roomId, message.seq, member);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');

    const stillOpen = await vote(roomId, message.seq, member, [pollOf(message).options[0].id]);
    expect(stillOpen.status).toBe(200);

    const nonMember = await closePoll(roomId, message.seq, outsider);
    expect(nonMember.status).toBe(403);
    expect(nonMember.body.error.code).toBe('NOT_MEMBER');
  });

  it('rejects an expired or already closed poll, a text message and a withdrawn poll', async () => {
    const owner = await createTestUser('poll_close_state_owner');
    const roomId = await createTestRoom(owner);

    const expiredMessage = (
      await createPoll(roomId, owner, { question: 'Already over?', options: ['Yes', 'No'] })
    ).body.message as MessageDTO;
    await pool.execute(
      'UPDATE polls SET closes_at = DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE id = ?',
      [pollOf(expiredMessage).id],
    );
    const expired = await closePoll(roomId, expiredMessage.seq, owner);
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe('POLL_CLOSED');

    const closedMessage = (
      await createPoll(roomId, owner, { question: 'Close twice?', options: ['Yes', 'No'] })
    ).body.message as MessageDTO;
    expect((await closePoll(roomId, closedMessage.seq, owner)).status).toBe(200);
    const twice = await closePoll(roomId, closedMessage.seq, owner);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('POLL_CLOSED');

    const text = await createMessage({
      roomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'not a poll',
    });
    const onText = await closePoll(roomId, text.seq, owner);
    expect(onText.status).toBe(404);
    expect(onText.body.error.code).toBe('POLL_NOT_FOUND');

    const withdrawnMessage = (
      await createPoll(roomId, owner, { question: 'Withdraw?', options: ['Yes', 'No'] })
    ).body.message as MessageDTO;
    const deleted = await request(server.url)
      .delete(`/api/rooms/${roomId}/messages/${withdrawnMessage.seq}`)
      .set('Authorization', auth(owner));
    expect(deleted.status).toBe(200);
    const withdrawn = await closePoll(roomId, withdrawnMessage.seq, owner);
    expect(withdrawn.status).toBe(404);
    expect(withdrawn.body.error.code).toBe('POLL_NOT_FOUND');

    const missing = await closePoll(roomId, 9999, owner);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('POLL_NOT_FOUND');
  });
});

describe('poll hydration on message DTO paths', () => {
  it('includes the poll in history, search, pins, saved, export and global search', async () => {
    const owner = await createTestUser('poll_hydrate_owner');
    const roomId = await createTestRoom(owner);
    const message = (
      await createPoll(roomId, owner, {
        question: 'Hydration check?',
        options: ['Alpha', 'Beta'],
        closesInMinutes: 30,
      })
    ).body.message as MessageDTO;
    expect((await vote(roomId, message.seq, owner, [pollOf(message).options[0].id])).status).toBe(200);

    const headers = { Authorization: auth(owner) };

    const pinned = await request(server.url)
      .post(`/api/rooms/${roomId}/messages/${message.seq}/pin`)
      .set(headers);
    expect(pinned.status).toBe(200);
    expect(pollOf(pinned.body.message as MessageDTO).totalVotes).toBe(1);

    const pins = await request(server.url).get(`/api/rooms/${roomId}/pins`).set(headers);
    expect(pins.status).toBe(200);
    expect(pollOf((pins.body.messages as MessageDTO[])[0]).totalVotes).toBe(1);

    const search = await request(server.url)
      .get(`/api/rooms/${roomId}/search?q=Hydration`)
      .set(headers);
    expect(search.status).toBe(200);
    expect(pollOf((search.body.messages as MessageDTO[])[0]).question).toBe('Hydration check?');

    const saved = await request(server.url)
      .post(`/api/rooms/${roomId}/messages/${message.seq}/save`)
      .set(headers);
    expect(saved.status).toBe(200);
    const savedList = await request(server.url).get('/api/me/saved').set(headers);
    expect(savedList.status).toBe(200);
    const savedItem = savedList.body.items[0] as { message: MessageDTO };
    expect(pollOf(savedItem.message).options.map((option) => option.label)).toEqual([
      'Alpha',
      'Beta',
    ]);

    const exported = await request(server.url)
      .get(`/api/rooms/${roomId}/export?format=json`)
      .set(headers);
    expect(exported.status).toBe(200);
    const exportedMessage = (exported.body.messages as MessageDTO[]).find(
      (item) => item.seq === message.seq,
    );
    expect(pollOf(exportedMessage as MessageDTO).closed).toBe(false);

    const globalSearch = await request(server.url)
      .get('/api/search/messages?q=Hydration')
      .set(headers);
    expect(globalSearch.status).toBe(200);
    expect(pollOf((globalSearch.body.messages as MessageDTO[])[0]).totalVotes).toBe(1);
  });

  it('keeps plain text messages at kind text with a null poll', async () => {
    const owner = await createTestUser('poll_text_owner');
    const roomId = await createTestRoom(owner);
    const text = await createMessage({
      roomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'plain',
    });

    const stored = (await listRoom(roomId, owner)).find((item) => item.seq === text.seq);
    expect(stored?.kind).toBe('text');
    expect(stored?.poll).toBeNull();
  });
});

describe('poll send limits', () => {
  it('enforces the room slow mode exactly like a socket message', async () => {
    const owner = await createTestUser('poll_slow_owner');
    const roomId = await createTestRoom(owner);
    const patched = await request(server.url)
      .patch(`/api/rooms/${roomId}`)
      .set('Authorization', auth(owner))
      .send({ slowModeSeconds: 1 });
    expect(patched.status).toBe(200);

    const first = await createPoll(roomId, owner, VALID_POLL);
    expect(first.status).toBe(201);

    const second = await createPoll(roomId, owner, {
      question: 'Too soon?',
      options: ['Yes', 'No'],
    });
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('SLOW_MODE');
    expect(second.body.error.message).toContain('慢速模式');
    expect(await countPolls(roomId)).toBe(1);
  });

  it('shares the per-member message rate limit', async () => {
    config.rateLimitEnabled = true;
    const owner = await createTestUser('poll_rate_owner');
    const roomId = await createTestRoom(owner);

    for (let index = 0; index < 10; index += 1) {
      const response = await createPoll(roomId, owner, {
        question: `Rate ${index}?`,
        options: ['Yes', 'No'],
      });
      expect(response.status).toBe(201);
    }
    const limited = await createPoll(roomId, owner, { question: 'Rate 10?', options: ['Yes', 'No'] });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(await countPolls(roomId)).toBe(10);
  });
});

describe('anonymous polls', () => {
  it('stores the flag, keeps the tallies and hides every voter id', async () => {
    const owner = await createTestUser('poll_anon_owner');
    const member = await createTestUser('poll_anon_member');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);

    const response = await createPoll(roomId, owner, {
      question: 'Secret ballot?',
      options: ['Yes', 'No'],
      multiple: true,
      anonymous: true,
    });
    expect(response.status).toBe(201);
    const message = response.body.message as MessageDTO;
    const poll = pollOf(message);
    expect(poll.anonymous).toBe(true);
    for (const option of poll.options) {
      expect(option.userIds).toEqual([]);
    }

    const [yes, no] = poll.options;
    expect((await vote(roomId, message.seq, owner, [yes.id])).status).toBe(200);
    const memberVote = await vote(roomId, message.seq, member, [yes.id, no.id]);
    expect(memberVote.status).toBe(200);
    const seenByMember = pollOf(memberVote.body.message as MessageDTO);
    expect(seenByMember.anonymous).toBe(true);
    expect(seenByMember.totalVotes).toBe(2);
    expect(seenByMember.options.map((option) => option.count)).toEqual([2, 1]);
    for (const option of seenByMember.options) {
      expect(option.userIds).toEqual([]);
    }

    const stored = (await listRoom(roomId, owner)).find((item) => item.seq === message.seq);
    const storedPoll = pollOf(stored as MessageDTO);
    expect(storedPoll.anonymous).toBe(true);
    expect(storedPoll.totalVotes).toBe(2);
    expect(storedPoll.options.map((option) => option.userIds)).toEqual([[], []]);

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT anonymous FROM polls WHERE id = ?',
      [poll.id],
    );
    expect(Number(rows[0]?.anonymous)).toBe(1);
  });

  it('returns only the caller own selection from my-votes', async () => {
    const owner = await createTestUser('poll_anon_votes_owner');
    const member = await createTestUser('poll_anon_votes_member');
    const lurker = await createTestUser('poll_anon_votes_lurker');
    const roomId = await createTestRoom(owner);
    await joinRoomService(member.id, roomId);
    await joinRoomService(lurker.id, roomId);

    const message = (
      await createPoll(roomId, owner, {
        question: 'Pick any',
        options: ['One', 'Two', 'Three'],
        multiple: true,
        anonymous: true,
      })
    ).body.message as MessageDTO;
    const [one, two, three] = pollOf(message).options;

    expect((await vote(roomId, message.seq, owner, [one.id, three.id])).status).toBe(200);
    expect((await vote(roomId, message.seq, member, [two.id])).status).toBe(200);

    const ownerVotes = await myVotes(roomId, message.seq, owner);
    expect(ownerVotes.status).toBe(200);
    expect(ownerVotes.body.optionIds).toEqual([one.id, three.id].sort((a, b) => a - b));

    const memberVotes = await myVotes(roomId, message.seq, member);
    expect(memberVotes.status).toBe(200);
    expect(memberVotes.body.optionIds).toEqual([two.id]);

    const lurkerVotes = await myVotes(roomId, message.seq, lurker);
    expect(lurkerVotes.status).toBe(200);
    expect(lurkerVotes.body.optionIds).toEqual([]);

    // Re-voting replaces the set, and my-votes follows immediately.
    expect((await vote(roomId, message.seq, member, [three.id])).status).toBe(200);
    const replaced = await myVotes(roomId, message.seq, member);
    expect(replaced.body.optionIds).toEqual([three.id]);
  });

  it('refuses non-members and reports missing, withdrawn or text messages as POLL_NOT_FOUND', async () => {
    const owner = await createTestUser('poll_anon_errors_owner');
    const outsider = await createTestUser('poll_anon_errors_outsider');
    const roomId = await createTestRoom(owner);
    const message = (
      await createPoll(roomId, owner, {
        question: 'Private?',
        options: ['Yes', 'No'],
        anonymous: true,
      })
    ).body.message as MessageDTO;

    const denied = await myVotes(roomId, message.seq, outsider);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('NOT_MEMBER');

    const text = await createMessage({
      roomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'not a poll',
    });
    const onText = await myVotes(roomId, text.seq, owner);
    expect(onText.status).toBe(404);
    expect(onText.body.error.code).toBe('POLL_NOT_FOUND');

    const missing = await myVotes(roomId, 9999, owner);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('POLL_NOT_FOUND');

    const deleted = await request(server.url)
      .delete(`/api/rooms/${roomId}/messages/${message.seq}`)
      .set('Authorization', auth(owner));
    expect(deleted.status).toBe(200);
    const onWithdrawn = await myVotes(roomId, message.seq, owner);
    expect(onWithdrawn.status).toBe(404);
    expect(onWithdrawn.body.error.code).toBe('POLL_NOT_FOUND');
  });

  it('leaves visible polls exposing voter ids', async () => {
    const owner = await createTestUser('poll_visible_owner');
    const roomId = await createTestRoom(owner);
    const message = (await createPoll(roomId, owner, VALID_POLL)).body.message as MessageDTO;
    const poll = pollOf(message);
    expect(poll.anonymous).toBe(false);
    const [pizza] = poll.options;

    const voted = await vote(roomId, message.seq, owner, [pizza.id]);
    expect(voted.status).toBe(200);
    const current = pollOf(voted.body.message as MessageDTO);
    expect(current.anonymous).toBe(false);
    expect(current.options[0].userIds).toEqual([owner.id]);
    expect(current.options[1].userIds).toEqual([]);

    const mine = await myVotes(roomId, message.seq, owner);
    expect(mine.status).toBe(200);
    expect(mine.body.optionIds).toEqual([pizza.id]);
  });
});
