import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import {
  ROOM_ARCHIVE_MAX_BYTES,
  ROOM_ARCHIVE_MAX_FILES,
  type RoomAttachmentDTO,
} from '../src/services/message';
import { joinRoom } from '../src/services/room';
import type { AuthUser } from '../src/types';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const TEXT = Buffer.from('hello archive\n', 'utf8');

let baseRoot: string;
let uploadRoot: string;
let originalUploadDir: string;
let owner: AuthUser;
let member: AuthUser;
let outsider: AuthUser;
let roomId: number;
let otherRoomId: number;
let nextSeq: number;

beforeAll(() => {
  originalUploadDir = config.uploadDir;
  // The upload dir is a subdirectory so a forged `../` target still lands
  // inside the temp tree the suite cleans up.
  baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bfa-media-archive-'));
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
  owner = await createTestUser(`archive_owner_${randomBytes(3).toString('hex')}`);
  member = await createTestUser(`archive_member_${randomBytes(3).toString('hex')}`);
  outsider = await createTestUser(`archive_outsider_${randomBytes(3).toString('hex')}`);
  roomId = await createTestRoom(owner);
  otherRoomId = await createTestRoom(owner);
  // `member` belongs to roomId only; `outsider` belongs to neither room.
  await joinRoom(member.id, roomId);
  nextSeq = 1;
});

async function insertMessage(
  room: number,
  sender: AuthUser,
  options: { seq?: number; deleted?: boolean; createdAt?: string } = {},
): Promise<number> {
  const seq = options.seq ?? nextSeq;
  nextSeq = Math.max(nextSeq, seq + 1);
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO messages
       (room_id, seq, sender_id, sender_type, content, status, deleted_at, created_at)
     VALUES (?, ?, ?, 'user', ?, 'done', ?, ?)`,
    [
      room,
      seq,
      sender.id,
      `message-${seq}`,
      options.deleted ? new Date() : null,
      options.createdAt ?? new Date(),
    ],
  );
  return result.insertId;
}

interface AttachmentFixture {
  room?: number;
  uploader?: AuthUser;
  messageId: number | null;
  filename: string;
  mime: string;
  /** Bytes written to disk; omit for rows whose file must not exist. */
  body?: Buffer;
  /** Defaults to a random name; pass one to forge an unsafe path. */
  storedName?: string;
  /** Defaults to the body length (or 1024 without a body). */
  size?: number;
  createdAt?: Date;
}

async function insertAttachment(fixture: AttachmentFixture): Promise<number> {
  const storedName = fixture.storedName ?? randomBytes(24).toString('hex');
  if (fixture.body) {
    const absolute = path.join(uploadRoot, storedName);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, fixture.body);
  }
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO message_attachments
       (room_id, uploader_id, message_id, filename, stored_name, mime, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixture.room ?? roomId,
      (fixture.uploader ?? owner).id,
      fixture.messageId,
      fixture.filename,
      storedName,
      fixture.mime,
      fixture.size ?? fixture.body?.length ?? 1024,
      fixture.createdAt ?? new Date(),
    ],
  );
  return result.insertId;
}

/** One live message carrying one attachment; returns the attachment id. */
async function seedFile(
  sender: AuthUser,
  file: { filename: string; mime: string; body?: Buffer; createdAt?: string },
  room: number = roomId,
): Promise<number> {
  const messageId = await insertMessage(room, sender, { createdAt: file.createdAt });
  return insertAttachment({
    room,
    uploader: sender,
    messageId,
    filename: file.filename,
    mime: file.mime,
    body: file.body ?? TEXT,
  });
}

function binaryParser(
  res: request.Response,
  callback: (error: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

function archiveRequest(
  actor: AuthUser | null,
  query: Record<string, string | number> = {},
  room: number = roomId,
): request.Test {
  const req = request(app).get(`/api/rooms/${room}/attachments/archive`).query(query);
  if (actor) {
    req.set('Authorization', `Bearer ${tokenFor(actor)}`);
  }
  // A zip is binary: supertest's default parser would mangle it.
  return req.buffer(true).parse(binaryParser);
}

function entryNames(response: request.Response): string[] {
  const zip = new AdmZip(response.body as Buffer);
  return zip.getEntries().map((entry) => entry.entryName);
}

/** `${seq}-${attachmentId}-${filename}`: the id is the second field. */
function entryAttachmentId(name: string): number {
  const match = /^(\d+)-(\d+)-/.exec(name);
  if (!match) {
    throw new Error(`Unexpected archive entry name: ${name}`);
  }
  return Number(match[2]);
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

async function listedIds(
  actor: AuthUser,
  query: Record<string, string | number> = {},
): Promise<number[]> {
  const response = await request(app)
    .get(`/api/rooms/${roomId}/attachments`)
    .query({ ...query, limit: 50 })
    .set('Authorization', `Bearer ${tokenFor(actor)}`);
  expect(response.status).toBe(200);
  return (response.body.attachments as RoomAttachmentDTO[])
    .map((attachment) => attachment.id)
    .sort((a, b) => a - b);
}

async function archivedIds(
  actor: AuthUser,
  query: Record<string, string | number> = {},
): Promise<number[]> {
  const response = await archiveRequest(actor, query);
  expect(response.status).toBe(200);
  return entryNames(response)
    .map(entryAttachmentId)
    .sort((a, b) => a - b);
}

describe('room media archive', () => {
  it('streams a zip whose entries carry the message seq, attachment id and filename', async () => {
    const firstMessage = await insertMessage(roomId, owner, { seq: 4 });
    const image = await insertAttachment({
      messageId: firstMessage,
      filename: 'holiday.png',
      mime: 'image/png',
      body: PNG,
    });
    const secondMessage = await insertMessage(roomId, member, { seq: 5 });
    const document = await insertAttachment({
      messageId: secondMessage,
      uploader: member,
      filename: 'notes.txt',
      mime: 'text/plain',
      body: TEXT,
    });

    const response = await archiveRequest(member);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="room-\d+-media-\d{8}T\d{6}Z\.zip"$/,
    );
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-archive-skipped']).toBe('0');

    const zip = new AdmZip(response.body as Buffer);
    const entries = zip.getEntries();
    // Newest message first, exactly like the gallery.
    expect(entries.map((entry) => entry.entryName)).toEqual([
      `5-${document}-notes.txt`,
      `4-${image}-holiday.png`,
    ]);
    expect(entries[0].getData().equals(TEXT)).toBe(true);
    expect(entries[1].getData().equals(PNG)).toBe(true);
  });

  it('applies the same filters and exclusions as the media list', async () => {
    const imageId = await seedFile(owner, {
      filename: 'photo.png',
      mime: 'image/png',
      body: PNG,
      createdAt: '2024-06-15 12:00:00.000',
    });
    const audioId = await seedFile(member, {
      filename: 'voice.ogg',
      mime: 'audio/ogg',
      createdAt: '2024-06-15 13:00:00.000',
    });
    const documentId = await seedFile(member, {
      filename: 'report.pdf',
      mime: 'application/pdf',
      createdAt: '2024-06-16 09:00:00.000',
    });
    const videoId = await seedFile(member, {
      filename: 'tour.mp4',
      mime: 'video/mp4',
      createdAt: '2024-06-16 10:00:00.000',
    });
    // Invisible everywhere: a withdrawn message, an unbound upload, another room.
    const withdrawnMessage = await insertMessage(roomId, owner, {
      deleted: true,
      createdAt: '2024-06-15 12:00:00.000',
    });
    await insertAttachment({
      messageId: withdrawnMessage,
      filename: 'withdrawn.png',
      mime: 'image/png',
      body: PNG,
    });
    await insertAttachment({
      messageId: null,
      filename: 'unbound.png',
      mime: 'image/png',
      body: PNG,
    });
    await seedFile(owner, { filename: 'elsewhere.png', mime: 'image/png' }, otherRoomId);

    // Every query must produce exactly the list endpoint's ids.
    const queries: Array<Record<string, string | number>> = [
      {},
      { type: 'image' },
      { type: 'audio' },
      { type: 'video' },
      { type: 'file' },
      { senderId: member.id },
      { from: '2024-06-15', to: '2024-06-15' },
      { q: 'report' },
      { q: '.png' },
      { q: 'o' },
      { q: 'report', type: 'file', senderId: member.id, from: '2024-06-16', to: '2024-06-16' },
      { type: 'file', senderId: member.id, from: '2024-06-16', to: '2024-06-16' },
    ];
    for (const query of queries) {
      expect(await archivedIds(member, query)).toEqual(await listedIds(member, query));
    }

    expect(await archivedIds(member)).toEqual(
      [imageId, audioId, documentId, videoId].sort((a, b) => a - b),
    );
    expect(await archivedIds(member, { type: 'image' })).toEqual([imageId]);
    expect(await archivedIds(member, { type: 'video' })).toEqual([videoId]);
    expect(await archivedIds(member, { type: 'file' })).toEqual([documentId]);
    expect(await archivedIds(member, { q: 'report' })).toEqual([documentId]);
    expect(await archivedIds(member, { q: '.png' })).toEqual([imageId]);
    expect(await archivedIds(member, { from: '2024-06-15', to: '2024-06-15' })).toEqual(
      [imageId, audioId].sort((a, b) => a - b),
    );
  });

  it('applies the name filter literally, including LIKE metacharacters', async () => {
    const percent = await seedFile(owner, {
      filename: '100% done.txt',
      mime: 'text/plain',
    });
    const plainHundred = await seedFile(owner, {
      filename: '100x done.txt',
      mime: 'text/plain',
    });
    const underscore = await seedFile(owner, {
      filename: 'a_b.txt',
      mime: 'text/plain',
    });
    const plainX = await seedFile(owner, {
      filename: 'axb.txt',
      mime: 'text/plain',
    });
    const backslash = await seedFile(owner, {
      filename: 'back\\slash.txt',
      mime: 'text/plain',
    });
    const plainSlash = await seedFile(owner, {
      filename: 'backslash.txt',
      mime: 'text/plain',
    });

    // Every query must yield exactly the gallery's ids: the zip and the list
    // share one WHERE, so a wildcard leak would show up on both sides equally.
    const queries: Array<Record<string, string | number>> = [
      { q: '100%' },
      { q: 'a_b' },
      { q: 'back\\slash' },
      { q: '100' },
      { q: 'done', type: 'file' },
    ];
    for (const query of queries) {
      expect(await archivedIds(member, query)).toEqual(await listedIds(member, query));
    }

    expect(await archivedIds(member, { q: '100%' })).toEqual([percent]);
    expect(await archivedIds(member, { q: '100%' })).not.toContain(plainHundred);
    expect(await archivedIds(member, { q: 'a_b' })).toEqual([underscore]);
    expect(await archivedIds(member, { q: 'a_b' })).not.toContain(plainX);
    expect(await archivedIds(member, { q: 'back\\slash' })).toEqual([backslash]);
    expect(await archivedIds(member, { q: 'back\\slash' })).not.toContain(plainSlash);
    expect(await archivedIds(member, { q: '100' })).toEqual(
      [percent, plainHundred].sort((a, b) => a - b),
    );
  });

  it('answers 404 ARCHIVE_EMPTY when nothing matches', async () => {
    await seedFile(owner, { filename: 'photo.png', mime: 'image/png', body: PNG });

    const response = await archiveRequest(member, { type: 'audio' });

    expect(response.status).toBe(404);
    expect(errorBody(response)).toMatchObject({ code: 'ARCHIVE_EMPTY' });
  });

  it('refuses a selection of more than 100 files', async () => {
    const messageId = await insertMessage(roomId, owner);
    const rows = Array.from({ length: ROOM_ARCHIVE_MAX_FILES + 1 }, (_, index) => [
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

    const response = await archiveRequest(member);

    expect(response.status).toBe(413);
    const body = errorBody(response);
    expect(body.code).toBe('ARCHIVE_TOO_LARGE');
    expect(body.message).toContain(String(ROOM_ARCHIVE_MAX_FILES));
  });

  it('allows exactly 100 files', async () => {
    const messageId = await insertMessage(roomId, owner);
    for (let index = 0; index < ROOM_ARCHIVE_MAX_FILES; index += 1) {
      await insertAttachment({
        messageId,
        filename: `file-${index}.txt`,
        mime: 'text/plain',
        body: Buffer.from(`body ${index}`),
      });
    }

    const response = await archiveRequest(member);

    expect(response.status).toBe(200);
    const names = entryNames(response);
    expect(names).toHaveLength(ROOM_ARCHIVE_MAX_FILES);
    expect(new Set(names).size).toBe(ROOM_ARCHIVE_MAX_FILES);
  });

  it('refuses more than 200 MiB of files', async () => {
    const messageId = await insertMessage(roomId, owner);
    await insertAttachment({
      messageId,
      filename: 'huge.bin',
      mime: 'application/octet-stream',
      size: ROOM_ARCHIVE_MAX_BYTES + 1,
    });

    const response = await archiveRequest(member);

    expect(response.status).toBe(413);
    expect(errorBody(response)).toMatchObject({ code: 'ARCHIVE_TOO_LARGE' });
  });

  it('skips stored names that would escape the upload directory', async () => {
    const messageId = await insertMessage(roomId, owner, { seq: 3 });
    const good = await insertAttachment({
      messageId,
      filename: 'good.txt',
      mime: 'text/plain',
      body: TEXT,
    });
    // Both targets exist on disk; only the row with a flat stored name may be
    // read. `..` and a subdirectory are refused by resolveAttachmentPath.
    await insertAttachment({
      messageId,
      filename: 'escape.txt',
      mime: 'text/plain',
      storedName: '../escape.txt',
      body: Buffer.from('outside the upload dir'),
    });
    await insertAttachment({
      messageId,
      filename: 'nested.txt',
      mime: 'text/plain',
      storedName: 'sub/nested.txt',
      body: Buffer.from('in a subdirectory'),
    });

    const response = await archiveRequest(member);

    expect(response.status).toBe(200);
    expect(response.headers['x-archive-skipped']).toBe('2');
    const zip = new AdmZip(response.body as Buffer);
    expect(zip.getEntries().map((entry) => entry.entryName)).toEqual([
      `3-${good}-good.txt`,
    ]);
    expect(zip.readAsText(`3-${good}-good.txt`)).toBe(TEXT.toString('utf8'));
  });

  it('answers 404 ARCHIVE_EMPTY when every row is unreadable', async () => {
    const messageId = await insertMessage(roomId, owner);
    await insertAttachment({
      messageId,
      filename: 'escape.txt',
      mime: 'text/plain',
      storedName: '../escape.txt',
    });

    const response = await archiveRequest(member);

    expect(response.status).toBe(404);
    expect(errorBody(response)).toMatchObject({ code: 'ARCHIVE_EMPTY' });
  });

  it('keeps entry names flat and unique even for hostile filenames', async () => {
    const messageId = await insertMessage(roomId, owner, { seq: 7 });
    const first = await insertAttachment({
      messageId,
      filename: '../../etc/passwd',
      mime: 'text/plain',
      body: Buffer.from('one'),
    });
    // Same display name, different row: the attachment id keeps them apart.
    const second = await insertAttachment({
      messageId,
      filename: '../../etc/passwd',
      mime: 'text/plain',
      body: Buffer.from('two'),
    });

    const names = entryNames(await archiveRequest(member));

    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^7-${first}-`)),
        expect.stringMatching(new RegExp(`^7-${second}-`)),
      ]),
    );
    for (const name of names) {
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      expect(name.startsWith('.')).toBe(false);
      expect(name.includes('..')).toBe(false);
    }
  });

  it('tears the response down when a selected file cannot be read', async () => {
    const messageId = await insertMessage(roomId, owner);
    // The row is valid but the file is gone: a truncated zip must never look
    // like a complete download.
    await insertAttachment({
      messageId,
      filename: 'vanished.txt',
      mime: 'text/plain',
      body: TEXT,
    });
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT stored_name FROM message_attachments',
    );
    fs.rmSync(path.join(uploadRoot, rows[0].stored_name));

    await expect(archiveRequest(member)).rejects.toThrow();
  });

  it('rejects non-members and anonymous callers', async () => {
    await seedFile(owner, { filename: 'photo.png', mime: 'image/png', body: PNG });

    const anonymous = await archiveRequest(null);
    expect(anonymous.status).toBe(401);

    const stranger = await archiveRequest(outsider);
    expect(stranger.status).toBe(403);
    expect(errorBody(stranger)).toMatchObject({ code: 'NOT_MEMBER' });
  });

  it('rejects invalid filters with 400', async () => {
    await seedFile(owner, { filename: 'photo.png', mime: 'image/png', body: PNG });

    const queries: Array<Record<string, string | number>> = [
      { type: 'document' },
      { q: '' },
      { q: '   ' },
      { q: 'x'.repeat(101) },
      { senderId: 0 },
      { senderId: 'abc' },
      { from: '2024-13-01' },
      { from: '2024-06-16', to: '2024-06-15' },
    ];
    for (const query of queries) {
      const response = await archiveRequest(member, query);
      expect(response.status).toBe(400);
      expect(errorBody(response)).toMatchObject({ code: 'INVALID_INPUT' });
    }
  });
});
