import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import { createMessage, createPoll } from '../src/services/message';
import type { AuthUser, MessageDTO } from '../src/types';
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
let uploadRoot: string;
const sockets: Socket[] = [];
const NOTE_BODY = Buffer.from('bulk forwarded attachment\n', 'utf8');

beforeAll(async () => {
  uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bfa-forward-bulk-'));
  config.uploadDir = uploadRoot;
  server = await startTestServer();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.disconnect();
  }
});

afterAll(async () => {
  await server.close();
  fs.rmSync(uploadRoot, { recursive: true, force: true });
});

async function joinRoomAs(user: AuthUser, roomId: number): Promise<void> {
  const response = await request(server.url)
    .post(`/api/rooms/${roomId}/join`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .send({});
  expect(response.status).toBe(200);
}

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

function bulkForward(
  targetRoomId: number,
  user: AuthUser,
  body: { sourceRoomId: number; sourceSeqs: number[] },
): request.Test {
  return request(server.url)
    .post(`/api/rooms/${targetRoomId}/forward-bulk`)
    .set('Authorization', auth(user))
    .send(body);
}

async function listMessages(roomId: number, user: AuthUser): Promise<MessageDTO[]> {
  const response = await request(server.url)
    .get(`/api/rooms/${roomId}/messages`)
    .set('Authorization', auth(user));
  expect(response.status).toBe(200);
  return response.body.messages as MessageDTO[];
}

function votePoll(
  roomId: number,
  seq: number,
  user: AuthUser,
  optionIds: number[],
): request.Test {
  return request(server.url)
    .post(`/api/rooms/${roomId}/messages/${seq}/poll/votes`)
    .set('Authorization', auth(user))
    .send({ optionIds });
}

interface Pair {
  alice: AuthUser;
  bob: AuthUser;
  sourceRoomId: number;
  targetRoomId: number;
}

/** Two users in a source room and a target room; alice owns both. */
async function createPair(prefix: string): Promise<Pair> {
  const alice = await createTestUser(`${prefix}_alice`);
  const bob = await createTestUser(`${prefix}_bob`);
  const sourceRoomId = await createTestRoom(alice);
  const targetRoomId = await createTestRoom(alice);
  await joinRoomAs(bob, sourceRoomId);
  await joinRoomAs(bob, targetRoomId);
  return { alice, bob, sourceRoomId, targetRoomId };
}

async function textMessage(
  roomId: number,
  senderId: number,
  content: string,
): Promise<MessageDTO> {
  return createMessage({ roomId, senderId, senderType: 'user', content });
}

/** Creates a text message bound to one real attachment file. */
async function messageWithAttachment(
  roomId: number,
  sender: AuthUser,
): Promise<MessageDTO> {
  const storedName = randomBytes(24).toString('hex');
  await fs.promises.writeFile(path.join(uploadRoot, storedName), NOTE_BODY);
  const [inserted] = await pool.execute<ResultSetHeader>(
    `INSERT INTO message_attachments (room_id, uploader_id, filename, stored_name, mime, size)
     VALUES (?, ?, 'note.txt', ?, 'text/plain', ?)`,
    [roomId, sender.id, storedName, NOTE_BODY.length],
  );
  return createMessage({
    roomId,
    senderId: sender.id,
    senderType: 'user',
    content: 'with attachment',
    attachmentIds: [inserted.insertId],
  });
}

async function attachmentRow(attachmentId: number): Promise<RowDataPacket | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM message_attachments WHERE id = ?',
    [attachmentId],
  );
  return rows[0];
}

async function withdraw(roomId: number, seq: number, user: AuthUser): Promise<void> {
  const response = await request(server.url)
    .delete(`/api/rooms/${roomId}/messages/${seq}`)
    .set('Authorization', auth(user));
  expect(response.status).toBe(200);
}

describe('bulk message forwarding', () => {
  it('forwards the batch and broadcasts every copy', async () => {
    const { alice, bob, sourceRoomId, targetRoomId } = await createPair('fwd_bulk_ok');
    const first = await textMessage(sourceRoomId, alice.id, 'first');
    const second = await textMessage(sourceRoomId, alice.id, 'second');

    const socket = await connectClient(server.url, tokenFor(bob));
    sockets.push(socket);
    await joinRoomSocket(socket, targetRoomId);
    const events = ['first', 'second'].map((content) =>
      waitForEvent<{ roomId: number; message: MessageDTO }>(
        socket,
        'message:new',
        (payload) => payload.roomId === targetRoomId && payload.message.content === content,
      ),
    );

    const response = await bulkForward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeqs: [first.seq, second.seq],
    });

    expect(response.status).toBe(200);
    const messages = response.body.messages as MessageDTO[];
    expect(messages.map((message) => message.content)).toEqual(['first', 'second']);
    expect(messages.map((message) => message.senderId)).toEqual([bob.id, bob.id]);
    expect(messages.map((message) => message.forwardedFrom?.roomId)).toEqual([
      sourceRoomId,
      sourceRoomId,
    ]);
    expect(messages.map((message) => message.forwardedFrom?.senderName)).toEqual([
      'fwd_bulk_ok_alice',
      'fwd_bulk_ok_alice',
    ]);
    const delivered = await Promise.all(events);
    expect(delivered.map((event) => event.message.content)).toEqual(['first', 'second']);
    expect(delivered.map((event) => event.message.seq)).toEqual(
      messages.map((message) => message.seq),
    );

    const listed = await listMessages(targetRoomId, bob);
    expect(listed.map((message) => message.content)).toEqual(['first', 'second']);
  });

  it('copies messages in ascending source seq order', async () => {
    const { alice, bob, sourceRoomId, targetRoomId } = await createPair('fwd_bulk_order');
    const one = await textMessage(sourceRoomId, alice.id, 'one');
    const two = await textMessage(sourceRoomId, alice.id, 'two');
    const three = await textMessage(sourceRoomId, alice.id, 'three');

    const response = await bulkForward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeqs: [three.seq, one.seq, two.seq],
    });

    expect(response.status).toBe(200);
    const messages = response.body.messages as MessageDTO[];
    expect(messages.map((message) => message.content)).toEqual(['one', 'two', 'three']);
    expect(messages.map((message) => message.seq)).toEqual(
      [...messages.map((message) => message.seq)].sort((a, b) => a - b),
    );
    // The origin keeps the source order, and the target mirrors it.
    const listed = await listMessages(targetRoomId, bob);
    expect(listed.map((message) => message.content)).toEqual(['one', 'two', 'three']);
  });

  it('deduplicates repeated source seqs', async () => {
    const { alice, bob, sourceRoomId, targetRoomId } = await createPair('fwd_bulk_dup');
    const first = await textMessage(sourceRoomId, alice.id, 'first');
    const second = await textMessage(sourceRoomId, alice.id, 'second');

    const response = await bulkForward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeqs: [second.seq, first.seq, second.seq, first.seq, second.seq],
    });

    expect(response.status).toBe(200);
    const messages = response.body.messages as MessageDTO[];
    expect(messages.map((message) => message.content)).toEqual(['first', 'second']);
    const listed = await listMessages(targetRoomId, bob);
    expect(listed).toHaveLength(2);
  });

  it('rejects an empty seq list', async () => {
    const { bob, sourceRoomId, targetRoomId } = await createPair('fwd_bulk_empty');

    const response = await bulkForward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeqs: [],
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_INPUT');
    expect(await listMessages(targetRoomId, bob)).toHaveLength(0);
  });

  it('accepts the 10-seq maximum and rejects 11', async () => {
    const { alice, bob, sourceRoomId, targetRoomId } = await createPair('fwd_bulk_many');
    const seqs: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const created = await textMessage(sourceRoomId, alice.id, `bulk ${index}`);
      seqs.push(created.seq);
    }

    const rejected = await bulkForward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeqs: seqs,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('INVALID_INPUT');
    expect(rejected.body.error.message).toBe(
      'sourceRoomId must be a positive integer and sourceSeqs 1-10 positive integers',
    );
    expect(await listMessages(targetRoomId, bob)).toHaveLength(0);

    // The cap matches the 10-per-10s message rate limit, so the full batch is
    // still accepted as one unit.
    const accepted = await bulkForward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeqs: seqs.slice(0, 10),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.messages).toHaveLength(10);
  });

  it('rejects a caller who is not a member of the source room', async () => {
    const alice = await createTestUser('fwd_bulk_src_alice');
    const bob = await createTestUser('fwd_bulk_src_bob');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    await joinRoomAs(bob, targetRoomId);
    const source = await textMessage(sourceRoomId, alice.id, 'not visible');

    const response = await bulkForward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeqs: [source.seq],
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
    expect(await listMessages(targetRoomId, bob)).toHaveLength(0);
  });

  it('rejects a caller who is not a member of the target room', async () => {
    const alice = await createTestUser('fwd_bulk_dst_alice');
    const bob = await createTestUser('fwd_bulk_dst_bob');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    await joinRoomAs(bob, sourceRoomId);
    const source = await textMessage(sourceRoomId, alice.id, 'target only');

    const response = await bulkForward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeqs: [source.seq],
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
    expect(await listMessages(targetRoomId, alice)).toHaveLength(0);
  });

  it('rejects the whole batch when a source seq does not exist', async () => {
    const { alice, bob, sourceRoomId, targetRoomId } = await createPair('fwd_bulk_gone');
    const kept = await textMessage(sourceRoomId, alice.id, 'kept');

    const response = await bulkForward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeqs: [kept.seq, 999],
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MESSAGE_NOT_FOUND');
    expect(await listMessages(targetRoomId, bob)).toHaveLength(0);
  });

  it('rejects the whole batch when a source message was withdrawn', async () => {
    const { alice, bob, sourceRoomId, targetRoomId } = await createPair('fwd_bulk_del');
    const withdrawn = await textMessage(sourceRoomId, alice.id, 'withdrawn');
    const kept = await textMessage(sourceRoomId, alice.id, 'kept');
    await withdraw(sourceRoomId, withdrawn.seq, alice);

    const response = await bulkForward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeqs: [kept.seq, withdrawn.seq],
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MESSAGE_DELETED');
    expect(await listMessages(targetRoomId, bob)).toHaveLength(0);
  });

  it('copies attachments for every forwarded message', async () => {
    const { alice, bob, sourceRoomId, targetRoomId } = await createPair('fwd_bulk_att');
    const plain = await textMessage(sourceRoomId, alice.id, 'plain');
    const attached = await messageWithAttachment(sourceRoomId, alice);
    const sourceRow = await attachmentRow(attached.attachments[0].id);

    const response = await bulkForward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeqs: [plain.seq, attached.seq],
    });

    expect(response.status).toBe(200);
    const messages = response.body.messages as MessageDTO[];
    expect(messages).toHaveLength(2);
    expect(messages[0].attachments).toEqual([]);
    expect(messages[1].attachments).toHaveLength(1);
    const copy = messages[1].attachments[0];
    expect(copy.url).toBe(`/api/rooms/${targetRoomId}/attachments/${copy.id}`);

    const row = await attachmentRow(copy.id);
    expect(row).toBeTruthy();
    expect(Number(row?.room_id)).toBe(targetRoomId);
    expect(Number(row?.uploader_id)).toBe(bob.id);
    expect(Number(row?.message_id)).toBe(messages[1].id);
    expect(Number(row?.size)).toBe(NOTE_BODY.length);
    const storedName = String(row?.stored_name);
    expect(storedName).not.toBe(String(sourceRow?.stored_name));
    expect(await fs.promises.readFile(path.join(uploadRoot, storedName))).toEqual(NOTE_BODY);

    // The source row and file are untouched; the copy is a separate file.
    const original = await attachmentRow(attached.attachments[0].id);
    expect(String(original?.stored_name)).toBe(String(sourceRow?.stored_name));
    expect(
      await fs.promises.readFile(path.join(uploadRoot, String(sourceRow?.stored_name))),
    ).toEqual(NOTE_BODY);

    const listed = await listMessages(targetRoomId, bob);
    expect(listed[1].attachments).toHaveLength(1);
    expect(listed[1].attachments[0].id).toBe(copy.id);
  });

  it('forwards a poll inside a batch with its options and no votes', async () => {
    const { alice, bob, sourceRoomId, targetRoomId } = await createPair('fwd_bulk_poll');
    const plain = await textMessage(sourceRoomId, alice.id, 'plain');
    const poll = await createPoll({
      roomId: sourceRoomId,
      senderId: alice.id,
      question: 'Lunch?',
      options: ['yes', 'maybe', 'no'],
      multiple: true,
    });
    const optionIds = poll.poll!.options.map((option) => option.id);
    expect((await votePoll(sourceRoomId, poll.seq, bob, optionIds.slice(0, 2))).status).toBe(200);

    const response = await bulkForward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeqs: [plain.seq, poll.seq],
    });

    expect(response.status).toBe(200);
    const messages = response.body.messages as MessageDTO[];
    expect(messages).toHaveLength(2);
    const copy = messages[1];
    expect(copy.kind).toBe('poll');
    expect(copy.content).toBe('Lunch?');
    expect(copy.senderId).toBe(bob.id);
    expect(copy.forwardedFrom?.roomId).toBe(sourceRoomId);
    expect(copy.forwardedFrom?.senderName).toBe('fwd_bulk_poll_alice');
    const forwardedPoll = copy.poll!;
    expect(forwardedPoll.question).toBe('Lunch?');
    expect(forwardedPoll.multiple).toBe(true);
    expect(forwardedPoll.anonymous).toBe(false);
    expect(forwardedPoll.closesAt).toBeNull();
    expect(forwardedPoll.totalVotes).toBe(0);
    expect(forwardedPoll.options.map((option) => option.label)).toEqual([
      'yes',
      'maybe',
      'no',
    ]);
    expect(forwardedPoll.options.map((option) => option.count)).toEqual([0, 0, 0]);
    expect(forwardedPoll.options.map((option) => option.userIds)).toEqual([[], [], []]);

    // The copy owns fresh option ids and no vote rows.
    expect(forwardedPoll.options.map((option) => option.id)).not.toEqual(optionIds);
    const [votes] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM poll_votes WHERE poll_id = ?',
      [forwardedPoll.id],
    );
    expect(Number(votes[0]?.total)).toBe(0);

    // The source poll keeps bob's selection.
    const source = (await listMessages(sourceRoomId, alice)).find(
      (message) => message.seq === poll.seq,
    )!;
    expect(source.poll!.totalVotes).toBe(1);
    expect(source.poll!.options.map((option) => option.count)).toEqual([1, 1, 0]);

    const listed = await listMessages(targetRoomId, bob);
    expect(listed.map((message) => message.content)).toEqual(['plain', 'Lunch?']);
    expect(listed[1].poll!.totalVotes).toBe(0);
  });

  it('validates every source before writing any copy', async () => {
    const { alice, bob, sourceRoomId, targetRoomId } = await createPair('fwd_bulk_mix');
    const plain = await textMessage(sourceRoomId, alice.id, 'plain');
    const attached = await messageWithAttachment(sourceRoomId, alice);
    const poll = await createPoll({
      roomId: sourceRoomId,
      senderId: alice.id,
      question: 'Lunch?',
      options: ['yes', 'no'],
    });
    await withdraw(sourceRoomId, poll.seq, alice);

    const response = await bulkForward(targetRoomId, bob, {
      sourceRoomId,
      // The valid text comes first, so a forward-as-you-go implementation
      // would leave a copy behind before hitting the withdrawn poll.
      sourceSeqs: [plain.seq, attached.seq, poll.seq],
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MESSAGE_DELETED');
    expect(await listMessages(targetRoomId, bob)).toHaveLength(0);
  });
});
