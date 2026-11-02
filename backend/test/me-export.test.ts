import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import { joinRoom } from '../src/services/room';
import type { AuthUser } from '../src/types';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

// Attachment bytes live under a scratch tree so a forged `../` target still
// lands inside the directory this file removes on exit.
let uploadRoot: string;
let originalUploadDir: string;

beforeAll(() => {
  originalUploadDir = config.uploadDir;
  uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bfa-me-export-'));
  config.uploadDir = uploadRoot;
});

afterAll(() => {
  config.uploadDir = originalUploadDir;
  fs.rmSync(uploadRoot, { recursive: true, force: true });
});

afterEach(() => {
  config.rateLimitEnabled = false;
});

function exportRequest(actor: AuthUser | null): request.Test {
  const call = request(app).get('/api/me/export');
  return actor ? call.set('Authorization', `Bearer ${tokenFor(actor)}`) : call;
}

function binaryParser(
  res: request.Response,
  callback: (error: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

function zipRequest(actor: AuthUser | null): request.Test {
  const call = request(app)
    .get('/api/me/export')
    .query({ format: 'zip' })
    // A zip is binary: supertest's default parser would mangle it.
    .buffer(true)
    .parse(binaryParser);
  return actor ? call.set('Authorization', `Bearer ${tokenFor(actor)}`) : call;
}

async function insertMessage(
  roomId: number,
  sender: AuthUser,
  seq: number,
  content: string,
  deleted = false,
): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO messages
       (room_id, seq, sender_id, sender_type, content, status, deleted_at, created_at)
     VALUES (?, ?, ?, 'user', ?, 'done', ?, ?)`,
    [roomId, seq, sender.id, content, deleted ? new Date() : null, new Date()],
  );
  return result.insertId;
}

/** Bulk-inserts `count` messages from `sender` and returns their ids by seq. */
async function insertMessageBatch(
  roomId: number,
  sender: AuthUser,
  count: number,
): Promise<number[]> {
  const batchSize = 500;
  for (let start = 0; start < count; start += batchSize) {
    const size = Math.min(batchSize, count - start);
    const values = Array.from({ length: size }, (_unused, offset) => {
      const seq = start + offset + 1;
      return [roomId, seq, sender.id, 'user', `message-${seq}`, 'done', new Date()];
    });
    await pool.query(
      `INSERT INTO messages (room_id, seq, sender_id, sender_type, content, status, created_at)
       VALUES ?`,
      [values],
    );
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM messages WHERE room_id = ? ORDER BY seq',
    [roomId],
  );
  return rows.map((row) => Number(row.id));
}

interface AttachmentFixture {
  /** Bytes written under UPLOAD_DIR; omit for a row whose file is missing. */
  body?: Buffer;
  /** Defaults to a random name; pass one to forge an unsafe path. */
  storedName?: string;
}

async function insertAttachment(
  roomId: number,
  uploader: AuthUser,
  messageId: number,
  filename: string,
  fixture: AttachmentFixture = {},
): Promise<number> {
  const storedName = fixture.storedName ?? randomBytes(24).toString('hex');
  if (fixture.body) {
    fs.writeFileSync(path.join(uploadRoot, storedName), fixture.body);
  }
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO message_attachments
       (room_id, uploader_id, message_id, filename, stored_name, mime, size, created_at)
     VALUES (?, ?, ?, ?, ?, 'text/plain', ?, ?)`,
    [
      roomId,
      uploader.id,
      messageId,
      filename,
      storedName,
      fixture.body?.length ?? 42,
      new Date(),
    ],
  );
  return result.insertId;
}

describe('GET /api/me/export', () => {
  it('requires authentication', async () => {
    const response = await exportRequest(null);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('exports only the caller data with the promised document shape', async () => {
    const owner = await createTestUser('me_export_owner');
    const other = await createTestUser('me_export_other');
    await pool.execute(
      'UPDATE users SET display_name = ?, status_emoji = ?, status_text = ? WHERE id = ?',
      ['Owner Name', '🎧', '专注写代码', owner.id],
    );
    const roomId = await createTestRoom(owner);
    await joinRoom(other.id, roomId);

    const ownMessageId = await insertMessage(roomId, owner, 1, 'owner-visible');
    await insertMessage(roomId, other, 2, 'other-private');
    await insertMessage(roomId, owner, 3, 'recalled text', true);
    await insertAttachment(roomId, owner, ownMessageId, 'notes.txt');
    // An attachment on someone else's message must never surface here.
    const [otherRows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM messages WHERE room_id = ? AND seq = 2',
      [roomId],
    );
    const otherMessageId = Number(otherRows[0].id);
    await insertAttachment(roomId, other, otherMessageId, 'other.txt');

    // One bookmark belongs to the caller, another user's bookmark must not.
    await pool.execute(
      'INSERT INTO saved_messages (user_id, message_id, room_id, created_at) VALUES (?, ?, ?, ?)',
      [owner.id, ownMessageId, roomId, new Date()],
    );
    await pool.execute(
      'INSERT INTO saved_messages (user_id, message_id, room_id, created_at) VALUES (?, ?, ?, ?)',
      [other.id, ownMessageId, roomId, new Date()],
    );

    // One notification for the caller, one for the other user.
    await pool.execute(
      `INSERT INTO notifications
         (user_id, type, room_id, message_id, actor_id, detail, read_at)
       VALUES (?, 'mention', ?, ?, ?, NULL, NULL)`,
      [owner.id, roomId, otherMessageId, other.id],
    );
    await pool.execute(
      `INSERT INTO notifications
         (user_id, type, room_id, message_id, actor_id, detail, read_at)
       VALUES (?, 'mention', ?, ?, ?, NULL, NULL)`,
      [other.id, roomId, ownMessageId, owner.id],
    );

    const response = await exportRequest(owner);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="me-export-${owner.id}.json"`,
    );
    expect(response.headers['cache-control']).toBe('no-store');

    const body = response.body;
    expect(Number.isNaN(Date.parse(body.exportedAt))).toBe(false);
    expect(body.truncated).toBe(false);

    expect(Object.keys(body.profile).sort()).toEqual(
      [
        'id',
        'username',
        'displayName',
        'type',
        'role',
        'statusEmoji',
        'statusText',
        'createdAt',
      ].sort(),
    );
    expect(body.profile).toMatchObject({
      id: owner.id,
      username: 'me_export_owner',
      displayName: 'Owner Name',
      type: 'human',
      role: 'user',
      statusEmoji: '🎧',
      statusText: '专注写代码',
    });
    expect(Number.isNaN(Date.parse(body.profile.createdAt))).toBe(false);

    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0]).toMatchObject({ id: roomId, role: 'owner' });
    expect(Number.isNaN(Date.parse(body.rooms[0].joinedAt))).toBe(false);

    // Only the caller's two messages, newest first; the withdrawn row keeps
    // its stored content and carries the marker.
    expect(body.messages.map((message: { seq: number }) => message.seq)).toEqual([3, 1]);
    expect(
      body.messages.some((message: { content: string }) => message.content === 'other-private'),
    ).toBe(false);
    expect(body.messages[0]).toMatchObject({
      roomId,
      roomName: body.rooms[0].name,
      seq: 3,
      content: 'recalled text',
      deleted: true,
      attachments: [],
    });
    expect(body.messages[1]).toMatchObject({
      roomId,
      seq: 1,
      content: 'owner-visible',
      deleted: false,
    });
    expect(body.messages[1].attachments).toHaveLength(1);
    expect(body.messages[1].attachments[0]).toMatchObject({
      filename: 'notes.txt',
      mime: 'text/plain',
      size: 42,
    });
    expect(Number.isNaN(Date.parse(body.messages[1].attachments[0].createdAt))).toBe(false);
    // The first message was never edited, so the field is null rather than
    // omitted.
    expect(body.messages[1].editedAt).toBeNull();
    expect(body.messages[1].createdAt).toBeTypeOf('string');

    // The caller's bookmark, not the other user's bookmark on the same message.
    expect(body.saved).toHaveLength(1);
    expect(body.saved[0]).toMatchObject({
      messageId: ownMessageId,
      roomId,
      seq: 1,
      content: 'owner-visible',
      senderName: 'Owner Name',
      deleted: false,
    });
    expect(Number.isNaN(Date.parse(body.saved[0].savedAt))).toBe(false);

    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]).toMatchObject({
      type: 'mention',
      roomId,
      messageId: Number(otherMessageId),
      messageSeq: 2,
      actorName: 'me_export_other',
      content: 'other-private',
      readAt: null,
    });
    expect(Number.isNaN(Date.parse(body.notifications[0].createdAt))).toBe(false);
    // The bookmark/notification links are ids, never another user's message
    // copies inside the `messages` list.
    expect(
      body.messages.some((message: { content: string }) => message.content === 'other-private'),
    ).toBe(false);
  });

  it('caps messages, saved items and notifications and flags truncated', async () => {
    const owner = await createTestUser('me_export_capped');
    const actor = await createTestUser('me_export_actor');
    const roomId = await createTestRoom(owner);
    const ids = await insertMessageBatch(roomId, owner, 5001);

    const savedValues = ids.slice(0, 1001).map((messageId) => [
      owner.id,
      messageId,
      roomId,
      new Date(),
    ]);
    await pool.query(
      'INSERT INTO saved_messages (user_id, message_id, room_id, created_at) VALUES ?',
      [savedValues],
    );

    const notificationValues = ids.slice(0, 1001).map((messageId) => [
      owner.id,
      'mention',
      roomId,
      messageId,
      actor.id,
    ]);
    await pool.query(
      `INSERT INTO notifications (user_id, type, room_id, message_id, actor_id)
       VALUES ?`,
      [notificationValues],
    );

    const response = await exportRequest(owner);

    expect(response.status).toBe(200);
    expect(response.body.truncated).toBe(true);
    expect(response.body.messages).toHaveLength(5000);
    // Newest first: the 5000 newest ids are seq 5001..2, so seq 1 is omitted.
    expect(response.body.messages[0].seq).toBe(5001);
    expect(response.body.messages[4999].seq).toBe(2);
    expect(response.body.saved).toHaveLength(1000);
    expect(response.body.notifications).toHaveLength(1000);
    // The reply stayed parseable JSON with exactly the capped sections.
    expect(response.body.profile.username).toBe('me_export_capped');
  });

  it('mirrors saved visibility and redacts recalled content', async () => {
    const owner = await createTestUser('me_export_saved_owner');
    const roomId = await createTestRoom(owner);
    const messageId = await insertMessage(roomId, owner, 1, 'recalled saved', true);
    await pool.execute(
      'INSERT INTO saved_messages (user_id, message_id, room_id, created_at) VALUES (?, ?, ?, ?)',
      [owner.id, messageId, roomId, new Date()],
    );

    const visible = await exportRequest(owner);
    expect(visible.status).toBe(200);
    expect(visible.body.saved).toHaveLength(1);
    expect(visible.body.saved[0]).toMatchObject({ deleted: true, content: '' });

    await pool.execute('DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [
      roomId,
      owner.id,
    ]);
    const afterLeaving = await exportRequest(owner);
    expect(afterLeaving.status).toBe(200);
    expect(afterLeaving.body.saved).toEqual([]);
  });

  // Last in the file: the limiter's buckets live for the whole process and a
  // consumed key must not disturb later tests. The users table is truncated
  // between tests, so ids restart at 1; a second rate-limit test would collide
  // with this bucket.
  it('allows three exports per user per hour and rejects the fourth', async () => {
    const owner = await createTestUser('me_export_rate_owner');
    const other = await createTestUser('me_export_rate_other');
    config.rateLimitEnabled = true;
    try {
      // JSON and ZIP draw from the same bucket, in either order.
      expect((await zipRequest(owner)).status).toBe(200);
      expect((await exportRequest(owner)).status).toBe(200);
      expect((await zipRequest(owner)).status).toBe(200);

      const limited = await exportRequest(owner);
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');

      // The bucket is per user, not global.
      const otherResponse = await exportRequest(other);
      expect(otherResponse.status).toBe(200);
    } finally {
      config.rateLimitEnabled = false;
    }
  });
});

describe('GET /api/me/export?format=zip', () => {
  it('requires authentication', async () => {
    const response = await zipRequest(null);

    expect(response.status).toBe(401);
    // The binary parser keeps the JSON error body as raw bytes.
    expect(JSON.parse((response.body as Buffer).toString('utf8')).error.code).toBe(
      'UNAUTHORIZED',
    );
  });

  it('packs data.json and only attachments on the caller own messages', async () => {
    const owner = await createTestUser('me_export_zip_owner');
    const other = await createTestUser('me_export_zip_other');
    const roomId = await createTestRoom(owner);
    await joinRoom(other.id, roomId);

    const ownMessageId = await insertMessage(roomId, owner, 1, 'zip owner');
    const otherMessageId = await insertMessage(roomId, other, 2, 'zip other');
    const ownBody = Buffer.from('owner attachment bytes\n', 'utf8');
    const ownAttachmentId = await insertAttachment(roomId, owner, ownMessageId, 'notes.txt', {
      body: ownBody,
    });
    await insertAttachment(roomId, other, otherMessageId, 'other.txt', {
      body: Buffer.from('someone else bytes\n', 'utf8'),
    });

    const response = await zipRequest(owner);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="me-export-${owner.id}.zip"`,
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-export-skipped']).toBe('0');

    const zip = new AdmZip(response.body as Buffer);
    expect(
      zip
        .getEntries()
        .map((entry) => entry.entryName)
        .sort(),
    ).toEqual([`attachments/${ownAttachmentId}-notes.txt`, 'data.json']);
    expect(
      zip.readFile(`attachments/${ownAttachmentId}-notes.txt`)?.equals(ownBody),
    ).toBe(true);
    // Another user's file never reaches the caller's archive.
    expect(zip.getEntries().some((entry) => entry.entryName.includes('other.txt'))).toBe(
      false,
    );

    // `data.json` is the JSON export document, byte for byte (apart from the
    // export timestamp, which necessarily differs between two calls).
    const json = await exportRequest(owner);
    expect(json.status).toBe(200);
    const packed = JSON.parse(zip.readAsText('data.json'));
    expect(Number.isNaN(Date.parse(packed.exportedAt))).toBe(false);
    expect(packed.profile).toEqual(json.body.profile);
    expect(packed.rooms).toEqual(json.body.rooms);
    expect(packed.messages).toEqual(json.body.messages);
    expect(packed.saved).toEqual(json.body.saved);
    expect(packed.notifications).toEqual(json.body.notifications);
    expect(packed.truncated).toBe(json.body.truncated);
    expect(packed.messages.map((message: { seq: number }) => message.seq)).toEqual([1]);
    expect(packed.messages[0].attachments[0]).toMatchObject({
      id: ownAttachmentId,
      filename: 'notes.txt',
      size: ownBody.length,
    });
  });

  it('skips missing and unsafe attachment rows without failing the package', async () => {
    const owner = await createTestUser('me_export_zip_skips');
    const roomId = await createTestRoom(owner);
    const messageId = await insertMessage(roomId, owner, 1, 'skips');
    const keptBody = Buffer.from('kept bytes');
    const keptId = await insertAttachment(roomId, owner, messageId, 'kept.txt', {
      body: keptBody,
    });
    // Row without a file: the file was cleaned up or lost.
    await insertAttachment(roomId, owner, messageId, 'gone.txt');
    // Row whose stored name would leave UPLOAD_DIR: a corrupt row.
    await insertAttachment(roomId, owner, messageId, 'escape.txt', {
      storedName: '../escape.txt',
    });

    const response = await zipRequest(owner);

    expect(response.status).toBe(200);
    expect(response.headers['x-export-skipped']).toBe('2');

    const zip = new AdmZip(response.body as Buffer);
    expect(
      zip
        .getEntries()
        .map((entry) => entry.entryName)
        .sort(),
    ).toEqual([`attachments/${keptId}-kept.txt`, 'data.json']);
    expect(zip.readFile(`attachments/${keptId}-kept.txt`)?.equals(keptBody)).toBe(true);

    // The document still lists all three rows, so the skipped count explains
    // the difference between metadata and packed bytes.
    const packed = JSON.parse(zip.readAsText('data.json'));
    expect(packed.messages[0].attachments).toHaveLength(3);
  });

  it('sanitizes attachment names so no entry can escape attachments/', async () => {
    const owner = await createTestUser('me_export_zip_names');
    const roomId = await createTestRoom(owner);
    const messageId = await insertMessage(roomId, owner, 1, 'names');
    const body = Buffer.from('name bytes');
    const attachmentId = await insertAttachment(
      roomId,
      owner,
      messageId,
      '../../evil\nname.txt',
      { body },
    );

    const response = await zipRequest(owner);

    expect(response.status).toBe(200);
    const zip = new AdmZip(response.body as Buffer);
    const entryName = `attachments/${attachmentId}-_evilname.txt`;
    expect(
      zip.getEntries().some((entry) => entry.entryName === entryName),
    ).toBe(true);
    expect(zip.readFile(entryName)?.equals(body)).toBe(true);
    for (const entry of zip.getEntries()) {
      // `data.json` is the only entry at the root; everything else stays one
      // level below `attachments/` and carries no traversal marker.
      expect(entry.entryName).not.toContain('..');
      expect(entry.entryName).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
  });

  it('rejects an unknown format', async () => {
    const owner = await createTestUser('me_export_zip_format');
    const response = await request(app)
      .get('/api/me/export')
      .query({ format: 'tar' })
      .set('Authorization', `Bearer ${tokenFor(owner)}`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_FORMAT');
  });
});
