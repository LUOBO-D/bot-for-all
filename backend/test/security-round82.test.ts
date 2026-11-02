import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import { assertCanSendMessage, createMessage, editMessage } from '../src/services/message';
import { createNotification } from '../src/services/notifications';
import { joinRoom as joinRoomService } from '../src/services/room';
import type { AuthUser, MessageDTO, NotificationDTO } from '../src/types';
import {
  createTestRoom,
  createTestUser,
  startTestServer,
  tokenFor,
  type TestServer,
} from './helpers';

/**
 * Round 82 regressions: bulk forwarding must pay the per-message gate up
 * front, attachments have a row cap next to the byte quota, notification
 * previews stop following messages the recipient can no longer read, invites
 * and removals are rate limited and idempotent, and search/export are capped.
 */
let server: TestServer;
let uploadRoot: string;
const DEFAULT_MAX_FILES = 1000;
const TEXT_BODY = Buffer.from('round 82 attachment\n', 'utf8');

beforeAll(async () => {
  uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bfa-round82-'));
  config.uploadDir = uploadRoot;
  server = await startTestServer();
});

afterEach(() => {
  config.rateLimitEnabled = false;
  config.attachmentUserMaxFiles = DEFAULT_MAX_FILES;
});

afterAll(async () => {
  await server.close();
  fs.rmSync(uploadRoot, { recursive: true, force: true });
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

async function joinRoomAs(user: AuthUser, roomId: number): Promise<void> {
  const response = await request(server.url)
    .post(`/api/rooms/${roomId}/join`)
    .set('Authorization', auth(user))
    .send({});
  expect(response.status).toBe(200);
}

function forwardOne(
  targetRoomId: number,
  user: AuthUser,
  body: { sourceRoomId: number; sourceSeq: number },
): request.Test {
  return request(server.url)
    .post(`/api/rooms/${targetRoomId}/forward`)
    .set('Authorization', auth(user))
    .send(body);
}

function forwardBulk(
  targetRoomId: number,
  user: AuthUser,
  body: { sourceRoomId: number; sourceSeqs: number[] },
): request.Test {
  return request(server.url)
    .post(`/api/rooms/${targetRoomId}/forward-bulk`)
    .set('Authorization', auth(user))
    .send(body);
}

async function messageCount(roomId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM messages WHERE room_id = ?',
    [roomId],
  );
  return Number(rows[0]?.total ?? 0);
}

async function attachmentCount(uploaderId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM message_attachments WHERE uploader_id = ?',
    [uploaderId],
  );
  return Number(rows[0]?.total ?? 0);
}

function uploadAttachment(
  roomId: number,
  actor: AuthUser,
  filename: string,
  mime: string,
  body: Buffer = TEXT_BODY,
): request.Test {
  return request(server.url)
    .post(`/api/rooms/${roomId}/attachments`)
    .set('Authorization', auth(actor))
    .attach('file', body, { filename, contentType: mime });
}

/** A message row plus one real file/attachment row, owned by `sender`. */
async function messageWithAttachment(
  roomId: number,
  sender: AuthUser,
): Promise<MessageDTO> {
  const storedName = randomBytes(24).toString('hex');
  await fs.promises.writeFile(path.join(uploadRoot, storedName), TEXT_BODY);
  const [inserted] = await pool.execute<ResultSetHeader>(
    `INSERT INTO message_attachments (room_id, uploader_id, filename, stored_name, mime, size)
     VALUES (?, ?, 'note.txt', ?, 'text/plain', ?)`,
    [roomId, sender.id, storedName, TEXT_BODY.length],
  );
  return createMessage({
    roomId,
    senderId: sender.id,
    senderType: 'user',
    content: 'with attachment',
    attachmentIds: [inserted.insertId],
  });
}

/** An attachment row with no file behind it, to fill the row cap cheaply. */
async function seedAttachmentRow(user: AuthUser, roomId: number): Promise<void> {
  await pool.execute(
    `INSERT INTO message_attachments (room_id, uploader_id, filename, stored_name, mime, size)
     VALUES (?, ?, 'seed.bin', ?, 'application/octet-stream', 1)`,
    [roomId, user.id, randomBytes(24).toString('hex')],
  );
}

async function listNotifications(user: AuthUser): Promise<{
  items: NotificationDTO[];
  total: number;
  unread: number;
}> {
  const response = await request(server.url)
    .get('/api/notifications')
    .set('Authorization', auth(user));
  expect(response.status).toBe(200);
  return response.body as { items: NotificationDTO[]; total: number; unread: number };
}

describe('bulk forward guards', () => {
  it('refuses to forward into the source room itself', async () => {
    const alice = await createTestUser('r82_same_alice');
    const roomId = await createTestRoom(alice);
    const first = await createMessage({
      roomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'one',
    });
    const second = await createMessage({
      roomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'two',
    });

    const bulk = await forwardBulk(roomId, alice, {
      sourceRoomId: roomId,
      sourceSeqs: [first.seq, second.seq],
    });
    expect(bulk.status).toBe(400);
    expect(bulk.body.error.code).toBe('INVALID_TARGET');

    const single = await forwardOne(roomId, alice, {
      sourceRoomId: roomId,
      sourceSeq: first.seq,
    });
    expect(single.status).toBe(400);
    expect(single.body.error.code).toBe('INVALID_TARGET');

    // Nothing was copied into the room.
    expect(await messageCount(roomId)).toBe(2);
  });

  it('rejects a multi-message batch into a slow-mode room but allows one by one', async () => {
    const alice = await createTestUser('r82_slow_alice');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    const first = await createMessage({
      roomId: sourceRoomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'one',
    });
    const second = await createMessage({
      roomId: sourceRoomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'two',
    });

    const patched = await request(server.url)
      .patch(`/api/rooms/${targetRoomId}`)
      .set('Authorization', auth(alice))
      .send({ slowModeSeconds: 60 });
    expect(patched.status).toBe(200);

    const bulk = await forwardBulk(targetRoomId, alice, {
      sourceRoomId,
      sourceSeqs: [first.seq, second.seq],
    });
    expect(bulk.status).toBe(400);
    expect(bulk.body.error.code).toBe('SLOW_MODE');
    expect(bulk.body.error.message).toBe('慢速模式下请逐条转发');
    expect(await messageCount(targetRoomId)).toBe(0);

    // A single forward is still one message and passes the per-message gate.
    const single = await forwardBulk(targetRoomId, alice, {
      sourceRoomId,
      sourceSeqs: [first.seq],
    });
    expect(single.status).toBe(200);
    expect(single.body.messages).toHaveLength(1);
    expect(await messageCount(targetRoomId)).toBe(1);
  });

  it('spends the whole message window on a 10-seq batch and rejects the next', async () => {
    config.rateLimitEnabled = true;
    const alice = await createTestUser('r82_cap_alice');
    // This test drains a whole message window, and the in-process buckets
    // outlive the per-test table truncation. Take a room id the other tests
    // do not use (they settle on 1 and 2) so the drained window cannot leak
    // into a sibling test that reuses those ids.
    await createTestRoom(alice);
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    const seqs: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const created = await createMessage({
        roomId: sourceRoomId,
        senderId: alice.id,
        senderType: 'user',
        content: `bulk ${index}`,
      });
      seqs.push(created.seq);
    }

    // The cap equals the 10-per-10s message bucket, so the ten prechecks use
    // the window up exactly and the copies still land.
    const batch = await forwardBulk(targetRoomId, alice, {
      sourceRoomId,
      sourceSeqs: seqs,
    });
    expect(batch.status).toBe(200);
    expect(batch.body.messages).toHaveLength(10);
    expect(await messageCount(targetRoomId)).toBe(10);

    // A second batch inside the same window cannot afford a single precheck.
    const next = await forwardBulk(targetRoomId, alice, {
      sourceRoomId,
      sourceSeqs: [seqs[0]],
    });
    expect(next.status).toBe(429);
    expect(next.body.error.code).toBe('RATE_LIMITED');
    expect(await messageCount(targetRoomId)).toBe(10);
  });

  it('prechecks every seq and writes nothing when one precheck fails', async () => {
    config.rateLimitEnabled = true;
    const alice = await createTestUser('r82_pre_alice');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    const first = await createMessage({
      roomId: sourceRoomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'one',
    });
    const second = await createMessage({
      roomId: sourceRoomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'two',
    });

    // Leave exactly one slot in the target room's per-user message bucket
    // (10 per 10s), so the first precheck passes and the second one fails.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await assertCanSendMessage(targetRoomId, alice.id);
    }

    const response = await forwardBulk(targetRoomId, alice, {
      sourceRoomId,
      sourceSeqs: [first.seq, second.seq],
    });
    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('RATE_LIMITED');
    // The batch is all-or-nothing: the first copy must not have been written.
    expect(await messageCount(targetRoomId)).toBe(0);
  });
});

describe('attachment guards', () => {
  it('rejects a zero-byte upload and removes the landed file', async () => {
    const owner = await createTestUser('r82_empty_owner');
    const roomId = await createTestRoom(owner);
    const filesBefore = fs.readdirSync(uploadRoot).length;

    const response = await uploadAttachment(
      roomId,
      owner,
      'empty.txt',
      'text/plain',
      Buffer.alloc(0),
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ATTACHMENT_EMPTY');
    // Multer wrote the empty file before the handler ran; the rejection
    // removes it and no row is left behind.
    expect(fs.readdirSync(uploadRoot).length).toBe(filesBefore);
    expect(await attachmentCount(owner.id)).toBe(0);
  });

  it('rejects an upload once the per-user file cap is reached', async () => {
    config.attachmentUserMaxFiles = 2;
    const owner = await createTestUser('r82_files_owner');
    const roomId = await createTestRoom(owner);
    await seedAttachmentRow(owner, roomId);
    await seedAttachmentRow(owner, roomId);
    const filesBefore = fs.readdirSync(uploadRoot).length;

    const response = await uploadAttachment(roomId, owner, 'third.txt', 'text/plain');
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('ATTACHMENT_QUOTA_EXCEEDED');
    expect(response.body.error.message).toContain('2 of 2 files');
    expect(fs.readdirSync(uploadRoot).length).toBe(filesBefore);
    expect(await attachmentCount(owner.id)).toBe(2);

    // One more slot is enough for the very same upload.
    config.attachmentUserMaxFiles = 3;
    const allowed = await uploadAttachment(roomId, owner, 'third.txt', 'text/plain');
    expect(allowed.status).toBe(201);
    expect(await attachmentCount(owner.id)).toBe(3);
  });

  it('rejects a forwarded copy above the file cap and removes the copied file', async () => {
    config.attachmentUserMaxFiles = 2;
    const alice = await createTestUser('r82_fwd_files_alice');
    const bob = await createTestUser('r82_fwd_files_bob');
    const sourceRoomId = await createTestRoom(alice);
    const targetRoomId = await createTestRoom(alice);
    await joinRoomAs(bob, sourceRoomId);
    await joinRoomAs(bob, targetRoomId);

    const source = await messageWithAttachment(sourceRoomId, alice);
    await seedAttachmentRow(bob, targetRoomId);
    await seedAttachmentRow(bob, targetRoomId);
    const filesBefore = fs.readdirSync(uploadRoot).length;

    const response = await forwardOne(targetRoomId, bob, {
      sourceRoomId,
      sourceSeq: source.seq,
    });
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('ATTACHMENT_QUOTA_EXCEEDED');
    expect(response.body.error.message).toContain('2 of 2 files');
    // The copy made before the transaction failed must not linger.
    expect(fs.readdirSync(uploadRoot).length).toBe(filesBefore);
    expect(await messageCount(targetRoomId)).toBe(0);
    expect(await attachmentCount(bob.id)).toBe(2);
  });

  it('caps uploads at 30 per user per minute without writing a rejected file', async () => {
    config.rateLimitEnabled = true;
    const owner = await createTestUser('r82_upload_rate_owner');
    const roomId = await createTestRoom(owner);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await uploadAttachment(roomId, owner, `file-${attempt}.txt`, 'text/plain');
      expect(response.status).toBe(201);
    }
    const filesBefore = fs.readdirSync(uploadRoot).length;

    const limited = await uploadAttachment(roomId, owner, 'one-too-many.txt', 'text/plain');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    // The gate runs before multer, so the rejected request never touches disk.
    expect(fs.readdirSync(uploadRoot).length).toBe(filesBefore);
    expect(await attachmentCount(owner.id)).toBe(30);
  });
});

describe('notification content visibility', () => {
  it('stops previewing a message after the recipient leaves the room', async () => {
    const owner = await createTestUser('r82_notif_owner');
    const bob = await createTestUser('r82_notif_bob');
    const roomId = await createTestRoom(owner);
    await joinRoomService(bob.id, roomId);
    const message = await createMessage({
      roomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'original text',
    });
    await pool.execute(
      `INSERT INTO notifications (user_id, type, room_id, message_id, actor_id)
       VALUES (?, 'mention', ?, ?, ?)`,
      [bob.id, roomId, message.id, owner.id],
    );

    // While bob is a member the notification follows the message.
    const member = await listNotifications(bob);
    expect(member.items[0]).toMatchObject({
      messageId: message.id,
      messageSeq: message.seq,
      content: 'original text',
    });

    // The owner edits after bob left: the old notification must not follow.
    const left = await request(server.url)
      .post(`/api/rooms/${roomId}/leave`)
      .set('Authorization', auth(bob));
    expect(left.status).toBe(200);
    await editMessage(roomId, message.seq, owner.id, 'edited secret');

    const after = await listNotifications(bob);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({
      id: member.items[0].id,
      messageId: null,
      messageSeq: null,
      content: '',
    });
    // The row still counts for the list and the badge.
    expect(after.total).toBe(1);
    expect(after.unread).toBe(1);

    // Invites carry no message, so they keep their own text.
    const invite = await createNotification({
      userId: bob.id,
      type: 'room_invite',
      roomId,
      actorId: owner.id,
      detail: '邀请你加入「room」',
    });
    const withInvite = await listNotifications(bob);
    const inviteItem = withInvite.items.find((item) => item.id === invite.id);
    expect(inviteItem).toMatchObject({ messageId: null, content: '邀请你加入「room」' });
  });
});

describe('room invite notifications', () => {
  async function invite(
    roomId: number,
    actor: AuthUser,
    username: string,
  ): Promise<request.Response> {
    return request(server.url)
      .post(`/api/rooms/${roomId}/members`)
      .set('Authorization', auth(actor))
      .send({ username });
  }

  async function inviteRows(userId: number, roomId: number): Promise<RowDataPacket[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, detail, read_at FROM notifications
       WHERE user_id = ? AND room_id = ? AND type = 'room_invite'
       ORDER BY id`,
      [userId, roomId],
    );
    return rows;
  }

  it('keeps one pending invite when the same user is invited again', async () => {
    const owner = await createTestUser('r82_invite_owner');
    const bob = await createTestUser('r82_invite_bob');
    const roomId = await createTestRoom(owner);

    expect((await invite(roomId, owner, bob.username)).status).toBe(200);
    const [firstRow] = await inviteRows(bob.id, roomId);
    expect(firstRow).toBeDefined();

    // Bob leaves and is invited again: the pending row is rewritten, not
    // duplicated.
    const left = await request(server.url)
      .post(`/api/rooms/${roomId}/leave`)
      .set('Authorization', auth(bob));
    expect(left.status).toBe(200);
    expect((await invite(roomId, owner, bob.username)).status).toBe(200);

    const rows = await inviteRows(bob.id, roomId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].id)).toBe(Number(firstRow.id));
    expect(String(rows[0].detail)).toContain('邀请你加入');
  });

  it('starts a new row once the previous invite was read', async () => {
    const owner = await createTestUser('r82_invite_read_owner');
    const bob = await createTestUser('r82_invite_read_bob');
    const roomId = await createTestRoom(owner);

    expect((await invite(roomId, owner, bob.username)).status).toBe(200);
    const read = await request(server.url)
      .post('/api/notifications/read')
      .set('Authorization', auth(bob))
      .send({});
    expect(read.status).toBe(200);

    const left = await request(server.url)
      .post(`/api/rooms/${roomId}/leave`)
      .set('Authorization', auth(bob));
    expect(left.status).toBe(200);
    expect((await invite(roomId, owner, bob.username)).status).toBe(200);

    const rows = await inviteRows(bob.id, roomId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.read_at == null)).toHaveLength(1);
  });
});

describe('abuse rate limits', () => {
  it('caps invites at 30 per actor per room across both invite routes', async () => {
    config.rateLimitEnabled = true;
    const owner = await createTestUser('r82_invite_rate_owner');
    const bob = await createTestUser('r82_invite_rate_bob');
    const roomId = await createTestRoom(owner);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await request(server.url)
        .post(`/api/rooms/${roomId}/members`)
        .set('Authorization', auth(owner))
        .send({ username: bob.username });
      expect(response.status).not.toBe(429);
    }

    const limited = await request(server.url)
      .post(`/api/rooms/${roomId}/members/bulk`)
      .set('Authorization', auth(owner))
      .send({ usernames: [bob.username] });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('caps removals at 30 per actor per room across both remove routes', async () => {
    config.rateLimitEnabled = true;
    const owner = await createTestUser('r82_remove_rate_owner');
    const outsider = await createTestUser('r82_remove_rate_outsider');
    const roomId = await createTestRoom(owner);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      // An unknown target still costs a slot: the gate runs before the lookup.
      const response = await request(server.url)
        .delete(`/api/rooms/${roomId}/members/${outsider.id}`)
        .set('Authorization', auth(owner));
      expect(response.status).not.toBe(429);
    }

    const limited = await request(server.url)
      .delete(`/api/rooms/${roomId}/members`)
      .set('Authorization', auth(owner))
      .send({ userIds: [outsider.id] });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('caps room search at 30 per user per minute', async () => {
    config.rateLimitEnabled = true;
    const owner = await createTestUser('r82_search_rate_owner');
    const roomId = await createTestRoom(owner);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await request(server.url)
        .get(`/api/rooms/${roomId}/search?q=hello`)
        .set('Authorization', auth(owner));
      expect(response.status).toBe(200);
    }

    const limited = await request(server.url)
      .get(`/api/rooms/${roomId}/search?q=hello`)
      .set('Authorization', auth(owner));
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('caps global search at 30 per user per minute', async () => {
    config.rateLimitEnabled = true;
    const owner = await createTestUser('r82_gsearch_rate_owner');
    await createTestRoom(owner);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await request(server.url)
        .get('/api/search/messages?q=hello')
        .set('Authorization', auth(owner));
      expect(response.status).toBe(200);
    }

    const limited = await request(server.url)
      .get('/api/search/messages?q=hello')
      .set('Authorization', auth(owner));
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('caps room exports at 5 per user per room per 10 minutes', async () => {
    config.rateLimitEnabled = true;
    const owner = await createTestUser('r82_export_rate_owner');
    const roomId = await createTestRoom(owner);
    await createMessage({
      roomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'export me',
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(server.url)
        .get(`/api/rooms/${roomId}/export?format=json`)
        .set('Authorization', auth(owner));
      expect(response.status).toBe(200);
    }

    const limited = await request(server.url)
      .get(`/api/rooms/${roomId}/export?format=json`)
      .set('Authorization', auth(owner));
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });
});
