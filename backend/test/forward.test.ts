import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import { createMessage } from '../src/services/message';
import type { AuthUser, MessageDTO } from '../src/types';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

let uploadRoot: string;
const NOTE_BODY = Buffer.from('forwarded attachment body\n', 'utf8');
const PNG_BODY = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const DEFAULT_USER_QUOTA_BYTES = 200 * 1024 * 1024;

beforeAll(() => {
  uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bfa-forward-'));
  config.uploadDir = uploadRoot;
});

afterEach(async () => {
  config.attachmentUserQuotaBytes = DEFAULT_USER_QUOTA_BYTES;
  await fs.promises.rm(uploadRoot, { recursive: true, force: true });
  await fs.promises.mkdir(uploadRoot, { recursive: true });
});

afterAll(() => {
  fs.rmSync(uploadRoot, { recursive: true, force: true });
});

async function joinRoomAs(user: AuthUser, roomId: number): Promise<void> {
  const response = await request(app)
    .post(`/api/rooms/${roomId}/join`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .send({});
  expect(response.status).toBe(200);
}

async function roomName(roomId: number): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT name FROM rooms WHERE id = ?', [
    roomId,
  ]);
  return String(rows[0].name);
}

interface StoredAttachment {
  id: number;
  storedName: string;
  body: Buffer;
}

/** Writes a real file and inserts an unbound attachment row for it. */
async function insertAttachment(
  roomId: number,
  sender: AuthUser,
  options: {
    filename?: string;
    mime?: string;
    body?: Buffer;
    writeFile?: boolean;
  } = {},
): Promise<StoredAttachment> {
  const body = options.body ?? NOTE_BODY;
  const storedName = randomBytes(24).toString('hex');
  if (options.writeFile !== false) {
    await fs.promises.writeFile(path.join(uploadRoot, storedName), body);
  }
  const [inserted] = await pool.execute<ResultSetHeader>(
    `INSERT INTO message_attachments (room_id, uploader_id, filename, stored_name, mime, size)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      roomId,
      sender.id,
      options.filename ?? 'note.txt',
      storedName,
      options.mime ?? 'text/plain',
      body.length,
    ],
  );
  return { id: inserted.insertId, storedName, body };
}

/** Creates a text message bound to one real (or deliberately missing) attachment. */
async function messageWithAttachment(
  roomId: number,
  sender: AuthUser,
  options: { content?: string; writeFile?: boolean } = {},
): Promise<MessageDTO> {
  const attachment = await insertAttachment(roomId, sender, { writeFile: options.writeFile });
  return createMessage({
    roomId,
    senderId: sender.id,
    senderType: 'user',
    content: options.content ?? 'with attachment',
    attachmentIds: [attachment.id],
  });
}

async function attachmentRow(
  attachmentId: number,
): Promise<RowDataPacket | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM message_attachments WHERE id = ?',
    [attachmentId],
  );
  return rows[0];
}

function forward(
  targetRoomId: number,
  user: AuthUser,
  body: { sourceRoomId: number; sourceSeq: number },
) {
  return request(app)
    .post(`/api/rooms/${targetRoomId}/forward`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .send(body);
}

function createPoll(
  roomId: number,
  user: AuthUser,
  body: Record<string, unknown>,
): request.Test {
  return request(app)
    .post(`/api/rooms/${roomId}/polls`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .send(body);
}

function vote(
  roomId: number,
  seq: number,
  user: AuthUser,
  optionIds: number[],
): request.Test {
  return request(app)
    .post(`/api/rooms/${roomId}/messages/${seq}/poll/votes`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .send({ optionIds });
}

async function listRoom(roomId: number, user: AuthUser): Promise<MessageDTO[]> {
  const response = await request(app)
    .get(`/api/rooms/${roomId}/messages`)
    .set('Authorization', `Bearer ${tokenFor(user)}`);
  expect(response.status).toBe(200);
  return response.body.messages as MessageDTO[];
}

describe('message forwarding', () => {
  it('copies a message into another room with an origin snapshot', async () => {
    const alice = await createTestUser('fwd_alice');
    const bob = await createTestUser('fwd_bob');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    await joinRoomAs(bob, sourceRoomId);
    await joinRoomAs(bob, targetRoomId);

    const source = await createMessage({
      roomId: sourceRoomId,
      senderId: alice.id,
      senderType: 'user',
      content: '**跨房** 内容',
    });

    const response = await forward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeq: source.seq,
    });

    expect(response.status).toBe(200);
    const message = response.body.message;
    expect(message.roomId).toBe(targetRoomId);
    expect(message.content).toBe('**跨房** 内容');
    expect(message.senderId).toBe(bob.id);
    expect(message.senderType).toBe('user');
    expect(message.deleted).toBe(false);
    expect(message.forwardedFrom).toEqual({
      roomId: sourceRoomId,
      roomName: await roomName(sourceRoomId),
      senderName: 'fwd_alice',
    });
  });

  it('rejects a deleted source message', async () => {
    const alice = await createTestUser('fwd_del_alice');
    const bob = await createTestUser('fwd_del_bob');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    await joinRoomAs(bob, sourceRoomId);
    await joinRoomAs(bob, targetRoomId);

    const source = await createMessage({
      roomId: sourceRoomId,
      senderId: alice.id,
      senderType: 'user',
      content: '将被撤回',
    });
    const deleted = await request(app)
      .delete(`/api/rooms/${sourceRoomId}/messages/${source.seq}`)
      .set('Authorization', `Bearer ${tokenFor(alice)}`);
    expect(deleted.status).toBe(200);

    const response = await forward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeq: source.seq,
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MESSAGE_DELETED');
  });

  it('copies attachments into the target room under the forwarder', async () => {
    const alice = await createTestUser('fwd_att_alice');
    const bob = await createTestUser('fwd_att_bob');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    await joinRoomAs(bob, sourceRoomId);
    await joinRoomAs(bob, targetRoomId);

    const first = await insertAttachment(sourceRoomId, alice);
    const second = await insertAttachment(sourceRoomId, alice, {
      filename: 'photo.png',
      mime: 'image/png',
      body: PNG_BODY,
    });
    const source = await createMessage({
      roomId: sourceRoomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'two files',
      attachmentIds: [first.id, second.id],
    });

    const response = await forward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeq: source.seq,
    });
    expect(response.status).toBe(200);
    const message = response.body.message as MessageDTO;
    expect(message.content).toBe('two files');
    expect(message.attachments).toHaveLength(2);
    expect(message.attachments.map((item) => item.filename)).toEqual(['note.txt', 'photo.png']);
    expect(message.attachments.map((item) => item.mime)).toEqual(['text/plain', 'image/png']);
    expect(message.attachments.map((item) => item.size)).toEqual([
      NOTE_BODY.length,
      PNG_BODY.length,
    ]);
    expect(message.attachments.map((item) => item.id)).not.toContain(first.id);
    expect(message.attachments.map((item) => item.id)).not.toContain(second.id);

    const storedNames = new Set<string>();
    for (const [index, dto] of message.attachments.entries()) {
      const sourceAttachment = [first, second][index];
      expect(dto.url).toBe(`/api/rooms/${targetRoomId}/attachments/${dto.id}`);
      const row = await attachmentRow(dto.id);
      expect(row).toBeTruthy();
      expect(Number(row?.room_id)).toBe(targetRoomId);
      expect(Number(row?.uploader_id)).toBe(bob.id);
      expect(Number(row?.message_id)).toBe(message.id);
      expect(Number(row?.size)).toBe(sourceAttachment.body.length);
      const storedName = String(row?.stored_name);
      expect(storedName).not.toBe(sourceAttachment.storedName);
      storedNames.add(storedName);
      expect(await fs.promises.readFile(path.join(uploadRoot, storedName))).toEqual(
        sourceAttachment.body,
      );
      // The source row still points at its original file, and the bytes are
      // untouched: forwarding copies, it never moves.
      const original = await attachmentRow(sourceAttachment.id);
      expect(String(original?.stored_name)).toBe(sourceAttachment.storedName);
      expect(
        await fs.promises.readFile(path.join(uploadRoot, sourceAttachment.storedName)),
      ).toEqual(sourceAttachment.body);
    }
    expect(storedNames.size).toBe(2);

    // The copy is downloadable from the target room by its new owner.
    const download = await request(app)
      .get(message.attachments[0].url)
      .set('Authorization', `Bearer ${tokenFor(bob)}`);
    expect(download.status).toBe(200);
    expect(download.text).toBe(NOTE_BODY.toString('utf8'));
  });

  it('forwards a message whose only content is an attachment', async () => {
    const alice = await createTestUser('fwd_att_only_alice');
    const bob = await createTestUser('fwd_att_only_bob');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    await joinRoomAs(bob, sourceRoomId);
    await joinRoomAs(bob, targetRoomId);

    const source = await messageWithAttachment(sourceRoomId, alice, { content: '' });

    const response = await forward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeq: source.seq,
    });
    expect(response.status).toBe(200);
    const message = response.body.message as MessageDTO;
    expect(message.content).toBe('');
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].filename).toBe('note.txt');
  });

  it('rejects the forward when a source attachment file is missing', async () => {
    const alice = await createTestUser('fwd_att_gone_alice');
    const bob = await createTestUser('fwd_att_gone_bob');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    await joinRoomAs(bob, sourceRoomId);
    await joinRoomAs(bob, targetRoomId);

    // The row exists but the file was never written (or vanished).
    const source = await messageWithAttachment(sourceRoomId, alice, { writeFile: false });
    const filesBefore = fs.readdirSync(uploadRoot).length;

    const response = await forward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeq: source.seq,
    });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
    expect(fs.readdirSync(uploadRoot).length).toBe(filesBefore);

    const list = await request(app)
      .get(`/api/rooms/${targetRoomId}/messages`)
      .set('Authorization', `Bearer ${tokenFor(bob)}`);
    expect(list.body.messages).toEqual([]);
    // The source row is untouched by the failed copy.
    const original = await attachmentRow(source.attachments[0].id);
    expect(Number(original?.message_id)).toBe(source.id);
  });

  it("counts the copy against the forwarder's quota, not the source owner's", async () => {
    const alice = await createTestUser('fwd_att_quota_ok_alice');
    const bob = await createTestUser('fwd_att_quota_ok_bob');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    await joinRoomAs(bob, sourceRoomId);
    await joinRoomAs(bob, targetRoomId);

    // The source owner already stores one file; the forwarder stores none, so
    // a quota equal to the file size must let the copy through.
    const source = await messageWithAttachment(sourceRoomId, alice);
    config.attachmentUserQuotaBytes = NOTE_BODY.length;

    const response = await forward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeq: source.seq,
    });
    expect(response.status).toBe(200);
    expect(response.body.message.attachments).toHaveLength(1);

    const [usage] = await pool.query<RowDataPacket[]>(
      'SELECT COALESCE(SUM(size), 0) AS used FROM message_attachments WHERE uploader_id = ?',
      [bob.id],
    );
    expect(Number(usage[0]?.used)).toBe(NOTE_BODY.length);
  });

  it("rejects a forward above the forwarder's quota and removes the copied file", async () => {
    const alice = await createTestUser('fwd_att_quota_bad_alice');
    const bob = await createTestUser('fwd_att_quota_bad_bob');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    await joinRoomAs(bob, sourceRoomId);
    await joinRoomAs(bob, targetRoomId);

    const source = await messageWithAttachment(sourceRoomId, alice);
    config.attachmentUserQuotaBytes = NOTE_BODY.length - 1;
    const filesBefore = fs.readdirSync(uploadRoot).length;

    const response = await forward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeq: source.seq,
    });
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('ATTACHMENT_QUOTA_EXCEEDED');
    expect(response.body.error.message).toContain('this forward is');
    // The file copied before the transaction failed must not linger.
    expect(fs.readdirSync(uploadRoot).length).toBe(filesBefore);

    const list = await request(app)
      .get(`/api/rooms/${targetRoomId}/messages`)
      .set('Authorization', `Bearer ${tokenFor(bob)}`);
    expect(list.body.messages).toEqual([]);
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM message_attachments WHERE uploader_id = ?',
      [bob.id],
    );
    expect(Number(rows[0]?.total)).toBe(0);
  });

  it('forwards a poll as a new open poll with no votes', async () => {
    const alice = await createTestUser('fwd_poll_alice');
    const bob = await createTestUser('fwd_poll_bob');
    const carol = await createTestUser('fwd_poll_carol');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    for (const user of [bob, carol]) {
      await joinRoomAs(user, sourceRoomId);
      await joinRoomAs(user, targetRoomId);
    }

    // A multi-choice poll with a deadline and real votes: the copy must keep
    // the flags and labels, drop the deadline and start from zero.
    const created = await createPoll(sourceRoomId, alice, {
      question: 'Where to eat?',
      options: ['noodles', 'dumplings', 'salad'],
      multiple: true,
      closesInMinutes: 60,
    });
    expect(created.status).toBe(201);
    const sourcePoll = created.body.message as MessageDTO;
    const sourcePollId = sourcePoll.poll!.id;
    const sourceOptionIds = sourcePoll.poll!.options.map((option) => option.id);
    expect(sourcePoll.poll!.closesAt).not.toBeNull();
    expect((await vote(sourceRoomId, sourcePoll.seq, bob, sourceOptionIds.slice(0, 2))).status).toBe(
      200,
    );
    expect((await vote(sourceRoomId, sourcePoll.seq, carol, sourceOptionIds.slice(2))).status).toBe(
      200,
    );

    const response = await forward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeq: sourcePoll.seq,
    });
    expect(response.status).toBe(200);
    const message = response.body.message as MessageDTO;
    expect(message.kind).toBe('poll');
    expect(message.content).toBe('Where to eat?');
    expect(message.senderId).toBe(bob.id);
    expect(message.forwardedFrom).toEqual({
      roomId: sourceRoomId,
      roomName: await roomName(sourceRoomId),
      senderName: 'fwd_poll_alice',
    });
    const poll = message.poll!;
    expect(poll.id).not.toBe(sourcePollId);
    expect(poll.question).toBe('Where to eat?');
    expect(poll.multiple).toBe(true);
    expect(poll.anonymous).toBe(false);
    expect(poll.closesAt).toBeNull();
    expect(poll.closed).toBe(false);
    expect(poll.totalVotes).toBe(0);
    expect(poll.options.map((option) => option.label)).toEqual([
      'noodles',
      'dumplings',
      'salad',
    ]);
    expect(poll.options.map((option) => option.count)).toEqual([0, 0, 0]);
    expect(poll.options.map((option) => option.userIds)).toEqual([[], [], []]);
    expect(poll.options.map((option) => option.id)).not.toEqual(sourceOptionIds);

    // The new poll row belongs to the forwarded message and starts reopened;
    // no vote row points at it, so the forwarder's poll is empty.
    const [pollRows] = await pool.query<RowDataPacket[]>(
      'SELECT id, multiple, anonymous, closes_at FROM polls WHERE message_id = ?',
      [message.id],
    );
    expect(pollRows).toHaveLength(1);
    expect(Number(pollRows[0].id)).toBe(poll.id);
    expect(Number(pollRows[0].multiple)).toBe(1);
    expect(Number(pollRows[0].anonymous)).toBe(0);
    expect(pollRows[0].closes_at).toBeNull();
    const [voteRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM poll_votes WHERE poll_id = ?',
      [poll.id],
    );
    expect(Number(voteRows[0]?.total)).toBe(0);

    // Source poll and its votes are untouched.
    const sourceList = await listRoom(sourceRoomId, alice);
    const original = sourceList.find((item) => item.seq === sourcePoll.seq)!;
    expect(original.poll!.id).toBe(sourcePollId);
    expect(original.poll!.closesAt).not.toBeNull();
    expect(original.poll!.totalVotes).toBe(2);
    expect(original.poll!.options.map((option) => option.count)).toEqual([1, 1, 1]);
    const [sourceVotes] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM poll_votes WHERE poll_id = ?',
      [sourcePollId],
    );
    expect(Number(sourceVotes[0]?.total)).toBe(3);

    // The forwarded poll is listed in the target room and accepts a fresh
    // vote from its new audience.
    const targetList = await listRoom(targetRoomId, carol);
    const listed = targetList.find((item) => item.seq === message.seq)!;
    expect(listed.poll!.totalVotes).toBe(0);
    expect(listed.poll!.options.map((option) => option.label)).toEqual([
      'noodles',
      'dumplings',
      'salad',
    ]);
    const newVote = await vote(
      targetRoomId,
      message.seq,
      carol,
      [listed.poll!.options[2].id],
    );
    expect(newVote.status).toBe(200);
    expect(newVote.body.message.poll.totalVotes).toBe(1);
  });

  it('keeps a forwarded poll anonymous without carrying voter ids', async () => {
    const alice = await createTestUser('fwd_poll_anon_alice');
    const bob = await createTestUser('fwd_poll_anon_bob');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    await joinRoomAs(bob, sourceRoomId);
    await joinRoomAs(bob, targetRoomId);

    const created = await createPoll(sourceRoomId, alice, {
      question: 'Secret?',
      options: ['yes', 'no'],
      anonymous: true,
    });
    expect(created.status).toBe(201);
    const sourcePoll = created.body.message as MessageDTO;
    const sourceOptionId = sourcePoll.poll!.options[0].id;
    expect((await vote(sourceRoomId, sourcePoll.seq, bob, [sourceOptionId])).status).toBe(200);

    const response = await forward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeq: sourcePoll.seq,
    });
    expect(response.status).toBe(200);
    const poll = (response.body.message as MessageDTO).poll!;
    expect(poll.anonymous).toBe(true);
    expect(poll.multiple).toBe(false);
    expect(poll.totalVotes).toBe(0);
    expect(poll.options.map((option) => option.label)).toEqual(['yes', 'no']);
    expect(poll.options.map((option) => option.count)).toEqual([0, 0]);
    expect(poll.options.map((option) => option.userIds)).toEqual([[], []]);

    // The source anonymous poll keeps its tally and still hides voters.
    const sourceList = await listRoom(sourceRoomId, alice);
    const original = sourceList.find((item) => item.seq === sourcePoll.seq)!;
    expect(original.poll!.totalVotes).toBe(1);
    expect(original.poll!.options[0].count).toBe(1);
    expect(original.poll!.options[0].userIds).toEqual([]);
  });

  it('rejects a withdrawn poll source message', async () => {
    const alice = await createTestUser('fwd_poll_del_alice');
    const bob = await createTestUser('fwd_poll_del_bob');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    await joinRoomAs(bob, sourceRoomId);
    await joinRoomAs(bob, targetRoomId);

    const created = await createPoll(sourceRoomId, alice, {
      question: 'Gone?',
      options: ['yes', 'no'],
    });
    expect(created.status).toBe(201);
    const poll = created.body.message as MessageDTO;
    const deleted = await request(app)
      .delete(`/api/rooms/${sourceRoomId}/messages/${poll.seq}`)
      .set('Authorization', `Bearer ${tokenFor(alice)}`);
    expect(deleted.status).toBe(200);

    const response = await forward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeq: poll.seq,
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MESSAGE_DELETED');
    expect(await listRoom(targetRoomId, bob)).toHaveLength(0);
  });

  it('returns 404 for an unknown source seq', async () => {
    const alice = await createTestUser('fwd_missing_alice');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);

    const response = await forward(targetRoomId, alice, {
      sourceRoomId,
      sourceSeq: 999,
    });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('rejects a caller who is not a member of the source room', async () => {
    const alice = await createTestUser('fwd_src_alice');
    const carol = await createTestUser('fwd_src_carol');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(carol);
    const source = await createMessage({
      roomId: sourceRoomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'source only',
    });

    const response = await forward(targetRoomId, carol, {
      sourceRoomId,
      sourceSeq: source.seq,
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
  });

  it('rejects a caller who is not a member of the target room', async () => {
    const alice = await createTestUser('fwd_dst_alice');
    const dave = await createTestUser('fwd_dst_dave');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    await joinRoomAs(dave, sourceRoomId);
    const source = await createMessage({
      roomId: sourceRoomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'not for outsiders',
    });

    const response = await forward(targetRoomId, dave, {
      sourceRoomId,
      sourceSeq: source.seq,
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
  });

  it('lists the forwarded message in the target room', async () => {
    const alice = await createTestUser('fwd_list_alice');
    const bob = await createTestUser('fwd_list_bob');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    await joinRoomAs(bob, sourceRoomId);
    await joinRoomAs(bob, targetRoomId);

    const source = await createMessage({
      roomId: sourceRoomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'forward me',
    });
    const forwarded = await forward(targetRoomId, bob, {
      sourceRoomId,
      sourceSeq: source.seq,
    });
    expect(forwarded.status).toBe(200);

    const list = await request(app)
      .get(`/api/rooms/${targetRoomId}/messages`)
      .set('Authorization', `Bearer ${tokenFor(bob)}`);
    expect(list.status).toBe(200);
    const listed = list.body.messages.find(
      (message: { seq: number }) => message.seq === forwarded.body.message.seq,
    );
    expect(listed).toBeTruthy();
    expect(listed.content).toBe('forward me');
    expect(listed.senderName).toBe('fwd_list_bob');
    expect(listed.forwardedFrom).toEqual({
      roomId: sourceRoomId,
      roomName: await roomName(sourceRoomId),
      senderName: 'fwd_list_alice',
    });
  });
});
