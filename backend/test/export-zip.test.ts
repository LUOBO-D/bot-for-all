import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { pool, type ResultSetHeader } from '../src/db';
import { EXPORT_MAX_ATTACHMENTS, EXPORT_MAX_BYTES } from '../src/routes/rooms';
import { joinRoom } from '../src/services/room';
import type { AuthUser } from '../src/types';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const TEXT = Buffer.from('hello export zip\n', 'utf8');
const MiB = 1024 * 1024;

let baseRoot: string;
let uploadRoot: string;
let originalUploadDir: string;
let owner: AuthUser;
let member: AuthUser;
let outsider: AuthUser;
let roomId: number;
let nextSeq: number;

beforeAll(() => {
  originalUploadDir = config.uploadDir;
  // The upload dir is a subdirectory so a forged `../` target still lands
  // inside the temp tree the suite cleans up.
  baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bfa-export-zip-'));
  uploadRoot = path.join(baseRoot, 'uploads');
  config.uploadDir = uploadRoot;
});

afterAll(() => {
  config.uploadDir = originalUploadDir;
  fs.rmSync(baseRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  fs.rmSync(baseRoot, { recursive: true, force: true });
  fs.mkdirSync(uploadRoot, { recursive: true });
  // The shared setup truncates with FK checks off; make sure no row from a
  // previous file points into this run's upload directory.
  await pool.query('TRUNCATE TABLE message_attachments');
  owner = await createTestUser(`export_owner_${randomBytes(3).toString('hex')}`);
  member = await createTestUser(`export_member_${randomBytes(3).toString('hex')}`);
  outsider = await createTestUser(`export_outsider_${randomBytes(3).toString('hex')}`);
  roomId = await createTestRoom(owner);
  // `member` belongs to roomId; `outsider` belongs to no room.
  await joinRoom(member.id, roomId);
  nextSeq = 1;
});

async function insertMessage(
  sender: AuthUser,
  options: { seq?: number; deleted?: boolean; content?: string } = {},
): Promise<number> {
  const seq = options.seq ?? nextSeq;
  nextSeq = Math.max(nextSeq, seq + 1);
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO messages
       (room_id, seq, sender_id, sender_type, content, status, deleted_at, created_at)
     VALUES (?, ?, ?, 'user', ?, 'done', ?, ?)`,
    [
      roomId,
      seq,
      sender.id,
      options.content ?? `message-${seq}`,
      options.deleted ? new Date() : null,
      new Date(),
    ],
  );
  return result.insertId;
}

interface AttachmentFixture {
  messageId: number;
  uploader?: AuthUser;
  filename: string;
  mime: string;
  /** Bytes written to disk; omit for rows whose file must not exist. */
  body?: Buffer;
  /** Defaults to a random name; pass one to forge an unsafe path. */
  storedName?: string;
  /** Defaults to the body length (or 1024 without a body). */
  size?: number;
}

async function insertAttachment(fixture: AttachmentFixture): Promise<number> {
  const storedName = fixture.storedName ?? randomBytes(24).toString('hex');
  if (fixture.body) {
    fs.writeFileSync(path.join(uploadRoot, storedName), fixture.body);
  }
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO message_attachments
       (room_id, uploader_id, message_id, filename, stored_name, mime, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      roomId,
      (fixture.uploader ?? owner).id,
      fixture.messageId,
      fixture.filename,
      storedName,
      fixture.mime,
      fixture.size ?? fixture.body?.length ?? 1024,
      new Date(),
    ],
  );
  return result.insertId;
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
  const req = request(app)
    .get(`/api/rooms/${roomId}/export`)
    .query({ format: 'zip' })
    // A zip is binary: supertest's default parser would mangle it.
    .buffer(true)
    .parse(binaryParser);
  if (actor) {
    req.set('Authorization', `Bearer ${tokenFor(actor)}`);
  }
  return req;
}

function markdownRequest(actor: AuthUser): request.Test {
  return request(app)
    .get(`/api/rooms/${roomId}/export`)
    .query({ format: 'markdown' })
    .set('Authorization', `Bearer ${tokenFor(actor)}`);
}

function entryNames(response: request.Response): string[] {
  return new AdmZip(response.body as Buffer)
    .getEntries()
    .map((entry) => entry.entryName);
}

function readEntry(response: request.Response, name: string): Buffer {
  const entry = new AdmZip(response.body as Buffer).getEntry(name);
  if (!entry) {
    throw new Error(`Missing zip entry: ${name}`);
  }
  return entry.getData();
}

function errorBody(response: request.Response): { code?: string; message?: string } {
  const raw = Buffer.isBuffer(response.body)
    ? response.body.toString('utf8')
    : (response.text ?? '');
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: string; message?: string } };
    return parsed.error ?? {};
  } catch {
    return {};
  }
}

describe('room export zip', () => {
  it('streams room.md plus the attachments of live messages, with their bytes', async () => {
    const first = await insertMessage(owner, { seq: 1, content: 'hello zip' });
    const imageId = await insertAttachment({
      messageId: first,
      filename: 'holiday.png',
      mime: 'image/png',
      body: PNG,
    });
    const second = await insertMessage(member, { seq: 2, content: 'with notes' });
    const documentId = await insertAttachment({
      messageId: second,
      uploader: member,
      filename: 'notes.txt',
      mime: 'text/plain',
      body: TEXT,
    });

    const response = await zipRequest(member);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="room-${roomId}.zip"`,
    );
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-export-skipped']).toBe('0');
    expect(entryNames(response)).toEqual([
      'room.md',
      `attachments/1-${imageId}-holiday.png`,
      `attachments/2-${documentId}-notes.txt`,
    ]);
    expect(readEntry(response, `attachments/1-${imageId}-holiday.png`).equals(PNG)).toBe(true);
    expect(readEntry(response, `attachments/2-${documentId}-notes.txt`).equals(TEXT)).toBe(true);

    // `room.md` is byte-for-byte the existing markdown export.
    const markdown = await markdownRequest(member);
    expect(markdown.status).toBe(200);
    expect(readEntry(response, 'room.md').toString('utf8')).toBe(markdown.text);
    expect(markdown.text).toContain('hello zip');
    expect(markdown.text).toContain('holiday.png');
  });

  it('leaves withdrawn messages and their attachments out of the zip', async () => {
    const live = await insertMessage(owner, { seq: 1, content: 'still here' });
    const keptId = await insertAttachment({
      messageId: live,
      filename: 'kept.txt',
      mime: 'text/plain',
      body: TEXT,
    });
    const doomed = await insertMessage(owner, { seq: 2, content: 'gone', deleted: true });
    await insertAttachment({
      messageId: doomed,
      filename: 'secret.txt',
      mime: 'text/plain',
      body: Buffer.from('secret', 'utf8'),
    });

    const response = await zipRequest(owner);

    expect(response.status).toBe(200);
    expect(entryNames(response)).toEqual(['room.md', `attachments/1-${keptId}-kept.txt`]);
    expect(response.headers['x-export-skipped']).toBe('0');
    const transcript = readEntry(response, 'room.md').toString('utf8');
    expect(transcript).toContain('still here');
    expect(transcript).toContain('[消息已撤回]');
    expect(transcript).not.toContain('secret.txt');
  });

  it('exports a zip with only room.md when the room has no attachments', async () => {
    await insertMessage(owner, { content: 'no files here' });

    const response = await zipRequest(owner);

    expect(response.status).toBe(200);
    expect(entryNames(response)).toEqual(['room.md']);
    expect(response.headers['x-export-skipped']).toBe('0');
    expect(readEntry(response, 'room.md').toString('utf8')).toContain('no files here');
  });

  it('sanitizes attachment filenames so no entry can escape attachments/', async () => {
    const messageId = await insertMessage(owner);
    const attachmentId = await insertAttachment({
      messageId,
      filename: '../evil name.txt',
      mime: 'text/plain',
      body: TEXT,
    });

    const response = await zipRequest(owner);

    expect(response.status).toBe(200);
    expect(entryNames(response)).toEqual([
      'room.md',
      `attachments/1-${attachmentId}-_evil name.txt`,
    ]);
    for (const name of entryNames(response)) {
      expect(name.split('/')).not.toContain('..');
    }
  });

  it('refuses more than 100 attachments with 413 EXPORT_TOO_LARGE', async () => {
    const messageId = await insertMessage(owner);
    const rows = Array.from({ length: EXPORT_MAX_ATTACHMENTS + 1 }, (_, index) => [
      roomId,
      owner.id,
      messageId,
      `file-${index}.txt`,
      randomBytes(16).toString('hex'),
      'text/plain',
      8,
      new Date(),
    ]);
    await pool.query(
      `INSERT INTO message_attachments
         (room_id, uploader_id, message_id, filename, stored_name, mime, size, created_at)
       VALUES ?`,
      [rows],
    );

    const response = await zipRequest(owner);

    expect(response.status).toBe(413);
    expect(errorBody(response)).toMatchObject({ code: 'EXPORT_TOO_LARGE' });
  });

  it('refuses attachments totalling over 200 MiB with 413 EXPORT_TOO_LARGE', async () => {
    const messageId = await insertMessage(owner);
    const perFile = 10 * MiB;
    const rows = Array.from({ length: Math.floor(EXPORT_MAX_BYTES / perFile) + 1 }, (_, index) => [
      roomId,
      owner.id,
      messageId,
      `large-${index}.bin`,
      randomBytes(16).toString('hex'),
      'application/zip',
      perFile,
      new Date(),
    ]);
    await pool.query(
      `INSERT INTO message_attachments
         (room_id, uploader_id, message_id, filename, stored_name, mime, size, created_at)
       VALUES ?`,
      [rows],
    );

    const response = await zipRequest(owner);

    expect(response.status).toBe(413);
    expect(errorBody(response)).toMatchObject({ code: 'EXPORT_TOO_LARGE' });
  });

  it('skips missing files and unsafe stored names, reporting the count', async () => {
    const messageId = await insertMessage(owner, { content: 'partial' });
    const keptId = await insertAttachment({
      messageId,
      filename: 'kept.txt',
      mime: 'text/plain',
      body: TEXT,
    });
    // A row whose file was removed outside the app.
    await insertAttachment({ messageId, filename: 'lost.txt', mime: 'text/plain' });
    // A corrupt row whose stored name would leave UPLOAD_DIR.
    await insertAttachment({
      messageId,
      filename: 'escape.txt',
      mime: 'text/plain',
      storedName: '../escape',
      body: Buffer.from('outside', 'utf8'),
    });

    const response = await zipRequest(owner);

    expect(response.status).toBe(200);
    expect(entryNames(response)).toEqual(['room.md', `attachments/1-${keptId}-kept.txt`]);
    expect(response.headers['x-export-skipped']).toBe('2');
  });

  it('rejects a non-member with 403', async () => {
    const response = await zipRequest(outsider);

    expect(response.status).toBe(403);
    expect(errorBody(response)).toMatchObject({ code: 'NOT_MEMBER' });
  });
});
