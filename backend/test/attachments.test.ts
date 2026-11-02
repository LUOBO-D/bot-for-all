import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { pool, type RowDataPacket } from '../src/db';
import { joinRoom as joinRoomService } from '../src/services/room';
import type { AttachmentDTO, AuthUser, MessageDTO } from '../src/types';
import {
  connectClient,
  createTestRoom,
  createTestUser,
  joinRoom as joinRoomSocket,
  startTestServer,
  tokenFor,
  type TestServer,
} from './helpers';

let server: TestServer;
let uploadRoot: string;
let owner: AuthUser;
let member: AuthUser;
let outsider: AuthUser;
let roomA: number;
let roomB: number;

const sockets: Socket[] = [];

const TEXT_BODY = Buffer.from('hello attachment\n', 'utf8');
const PNG_BODY = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PDF_BODY = Buffer.from('%PDF-1.4\n% test\n', 'utf8');
const VIDEO_BODY = Buffer.from('000000206674797069736f6d', 'hex');
const DEFAULT_USER_QUOTA_BYTES = 200 * 1024 * 1024;

beforeAll(async () => {
  uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bfa-attachments-'));
  config.uploadDir = uploadRoot;
  server = await startTestServer();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.disconnect();
  }
  config.rateLimitEnabled = false;
  config.attachmentUserQuotaBytes = DEFAULT_USER_QUOTA_BYTES;
});

afterAll(async () => {
  await server.close();
  fs.rmSync(uploadRoot, { recursive: true, force: true });
});

/**
 * The shared setup disables FK checks while truncating the parent tables, so
 * attachment rows survive there. Empty this table (and recreate fixtures)
 * after that hook has run.
 */
beforeEach(async () => {
  await pool.query('TRUNCATE TABLE message_attachments');
  owner = await createTestUser(`attach_owner_${randomBytes(2).toString('hex')}`);
  member = await createTestUser(`attach_member_${randomBytes(2).toString('hex')}`);
  outsider = await createTestUser(`attach_outsider_${randomBytes(2).toString('hex')}`);
  roomA = await createTestRoom(owner);
  roomB = await createTestRoom(member);
  // `member` is in both rooms; `outsider` is in neither.
  await joinRoomService(member.id, roomA);
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

async function uploadAttachment(
  roomId: number,
  actor: AuthUser | null,
  filename: string,
  mime: string,
  body: Buffer = TEXT_BODY,
): Promise<request.Response> {
  const req = request(server.url)
    .post(`/api/rooms/${roomId}/attachments`)
    .attach('file', body, { filename, contentType: mime });
  if (actor) {
    req.set('Authorization', auth(actor));
  }
  return req;
}

async function uploadPng(roomId: number, actor: AuthUser): Promise<AttachmentDTO> {
  const response = await uploadAttachment(roomId, actor, 'photo.png', 'image/png', PNG_BODY);
  expect(response.status).toBe(201);
  return response.body.attachment as AttachmentDTO;
}

async function download(
  roomId: number,
  attachmentId: number,
  actor: AuthUser | null,
): Promise<request.Response> {
  const req = request(server.url).get(`/api/rooms/${roomId}/attachments/${attachmentId}`);
  if (actor) {
    req.set('Authorization', auth(actor));
  }
  return req.buffer(true).parse(binaryParser);
}

function binaryParser(
  res: request.Response,
  callback: (error: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

/** Error responses on the binary download route arrive as a JSON Buffer. */
function errorCode(response: request.Response): string | undefined {
  const raw = Buffer.isBuffer(response.body)
    ? response.body.toString('utf8')
    : (response.text ?? '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) {
    return undefined;
  }
  const error = parsed.error;
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

async function connect(actor: AuthUser, roomId: number): Promise<Socket> {
  const socket = await connectClient(server.url, tokenFor(actor));
  sockets.push(socket);
  await joinRoomSocket(socket, roomId);
  return socket;
}

interface SendResult {
  ok: boolean;
  code?: string;
  message?: MessageDTO;
}

function sendWithAttachments(
  socket: Socket,
  roomId: number,
  content: string,
  attachmentIds: unknown,
  clientMsgId = randomBytes(8).toString('hex'),
): Promise<SendResult> {
  const { promise, resolve } = Promise.withResolvers<SendResult>();
  socket.emit(
    'message:send',
    { roomId, content, clientMsgId, attachmentIds },
    (response: unknown) => resolve(response as SendResult),
  );
  return promise;
}

/** Posts an attachment-only message so the upload stops being unbound. */
async function bindAttachment(
  roomId: number,
  actor: AuthUser,
  attachmentId: number,
): Promise<MessageDTO> {
  const socket = await connect(actor, roomId);
  const result = await sendWithAttachments(socket, roomId, '', [attachmentId]);
  expect(result.ok).toBe(true);
  return result.message as MessageDTO;
}

async function attachmentRow(
  id: number,
): Promise<RowDataPacket | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, message_id, room_id, uploader_id, filename, stored_name, mime, size FROM message_attachments WHERE id = ?',
    [id],
  );
  return rows[0];
}

async function messageCount(roomId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM messages WHERE room_id = ?',
    [roomId],
  );
  return Number(rows[0]?.total ?? 0);
}

describe('attachment upload', () => {
  it('stores an allowed file under a random name and returns the DTO', async () => {
    const response = await uploadAttachment(
      roomA,
      owner,
      'notes.txt',
      'text/plain',
      TEXT_BODY,
    );
    expect(response.status).toBe(201);
    const attachment = response.body.attachment as AttachmentDTO;
    expect(attachment.id).toBeGreaterThan(0);
    expect(attachment.filename).toBe('notes.txt');
    expect(attachment.mime).toBe('text/plain');
    expect(attachment.size).toBe(TEXT_BODY.length);
    expect(attachment.url).toBe(`/api/rooms/${roomA}/attachments/${attachment.id}`);

    const row = await attachmentRow(attachment.id);
    expect(row).toBeDefined();
    expect(row?.message_id).toBeNull();
    expect(row?.room_id).toBe(roomA);
    expect(row?.uploader_id).toBe(owner.id);
    expect(row?.filename).toBe('notes.txt');
    // Random storage name, not anything derived from the client filename.
    expect(String(row?.stored_name)).toMatch(/^[a-f0-9]{48}$/);
    expect(String(row?.stored_name)).not.toContain('notes');
  });

  it('keeps the original UTF-8 filename for display only', async () => {
    const response = await uploadAttachment(
      roomA,
      owner,
      '会议纪要.pdf',
      'application/pdf',
      PDF_BODY,
    );
    expect(response.status).toBe(201);
    expect(response.body.attachment.filename).toBe('会议纪要.pdf');
    expect(response.body.attachment.mime).toBe('application/pdf');
  });

  it('accepts the mp4 and webm video types', async () => {
    for (const [filename, mime] of [
      ['clip.mp4', 'video/mp4'],
      ['clip.webm', 'video/webm'],
    ] as const) {
      const response = await uploadAttachment(roomA, owner, filename, mime, VIDEO_BODY);
      expect(response.status, mime).toBe(201);
      expect(response.body.attachment.filename).toBe(filename);
      expect(response.body.attachment.mime).toBe(mime);
      expect(response.body.attachment.size).toBe(VIDEO_BODY.length);
    }
  });

  it('rejects a non-member before writing anything', async () => {
    const response = await uploadAttachment(roomA, outsider, 'x.txt', 'text/plain');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
    expect(await messageCount(roomA)).toBe(0);
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM message_attachments',
    );
    expect(Number(rows[0]?.total)).toBe(0);
  });

  it('rejects a MIME type outside the allow-list', async () => {
    const response = await uploadAttachment(
      roomA,
      owner,
      'page.html',
      'text/html',
      Buffer.from('<script>alert(1)</script>'),
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ATTACHMENT_TYPE_NOT_ALLOWED');
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM message_attachments',
    );
    expect(Number(rows[0]?.total)).toBe(0);
  });

  it('rejects files above 10 MB', async () => {
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
    const response = await uploadAttachment(roomA, owner, 'big.txt', 'text/plain', oversized);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ATTACHMENT_TOO_LARGE');
  });

  it('requires a file field', async () => {
    const response = await request(server.url)
      .post(`/api/rooms/${roomA}/attachments`)
      .set('Authorization', auth(owner));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ATTACHMENT_REQUIRED');
  });

  it('removes the file when the database insert fails', async () => {
    const before = fs.readdirSync(uploadRoot).length;
    await pool.query('RENAME TABLE message_attachments TO message_attachments_offline');
    try {
      const response = await uploadAttachment(roomA, owner, 'orphan.txt', 'text/plain');
      expect(response.status).toBe(500);
      expect(fs.readdirSync(uploadRoot).length).toBe(before);
    } finally {
      await pool.query('RENAME TABLE message_attachments_offline TO message_attachments');
    }
  });
});

describe('attachment download', () => {
  it('serves images inline with nosniff and the exact bytes', async () => {
    const attachment = await uploadPng(roomA, owner);
    await bindAttachment(roomA, owner, attachment.id);
    const response = await download(roomA, attachment.id, member);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toMatch(/^inline;/);
    expect(Buffer.compare(response.body as Buffer, PNG_BODY)).toBe(0);
  });

  it('forces non-media files to download', async () => {
    const response = await uploadAttachment(roomA, owner, '手册.pdf', 'application/pdf', PDF_BODY);
    expect(response.status).toBe(201);
    const attachment = response.body.attachment as AttachmentDTO;
    await bindAttachment(roomA, owner, attachment.id);

    const downloaded = await download(roomA, attachment.id, member);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['content-type']).toBe('application/pdf');
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
    expect(downloaded.headers['content-disposition']).toMatch(/^attachment;/);
    expect(downloaded.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent('手册.pdf')}`,
    );
    expect(Buffer.compare(downloaded.body as Buffer, PDF_BODY)).toBe(0);
  });

  it('serves audio inline', async () => {
    const body = Buffer.from('OggS fake audio', 'utf8');
    const upload = await uploadAttachment(roomA, owner, 'voice.ogg', 'audio/ogg', body);
    expect(upload.status).toBe(201);
    const attachment = upload.body.attachment as AttachmentDTO;
    await bindAttachment(roomA, owner, attachment.id);
    const downloaded = await download(roomA, attachment.id, member);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['content-type']).toBe('audio/ogg');
    expect(downloaded.headers['content-disposition']).toMatch(/^inline;/);
  });

  it('serves video inline with the exact bytes', async () => {
    const upload = await uploadAttachment(roomA, owner, 'clip.mp4', 'video/mp4', VIDEO_BODY);
    expect(upload.status).toBe(201);
    const attachment = upload.body.attachment as AttachmentDTO;
    await bindAttachment(roomA, owner, attachment.id);
    const downloaded = await download(roomA, attachment.id, member);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['content-type']).toBe('video/mp4');
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
    expect(downloaded.headers['content-disposition']).toMatch(/^inline;/);
    expect(Buffer.compare(downloaded.body as Buffer, VIDEO_BODY)).toBe(0);
  });

  it('hides an unbound upload from other members but serves the uploader', async () => {
    const attachment = await uploadPng(roomA, owner);

    const denied = await download(roomA, attachment.id, member);
    expect(denied.status).toBe(404);
    expect(errorCode(denied)).toBe('ATTACHMENT_NOT_FOUND');

    const allowed = await download(roomA, attachment.id, owner);
    expect(allowed.status).toBe(200);
    expect(Buffer.compare(allowed.body as Buffer, PNG_BODY)).toBe(0);
  });

  it('serves a bound attachment to every room member', async () => {
    const attachment = await uploadPng(roomA, owner);
    await bindAttachment(roomA, owner, attachment.id);

    for (const actor of [owner, member]) {
      const response = await download(roomA, attachment.id, actor);
      expect(response.status).toBe(200);
    }
  });

  it('hides a withdrawn message attachment from members and uploader', async () => {
    const attachment = await uploadPng(roomA, owner);
    const message = await bindAttachment(roomA, owner, attachment.id);

    const removed = await request(server.url)
      .delete(`/api/rooms/${roomA}/messages/${message.seq}`)
      .set('Authorization', auth(owner));
    expect(removed.status).toBe(200);

    for (const actor of [owner, member]) {
      const response = await download(roomA, attachment.id, actor);
      expect(response.status).toBe(404);
      expect(errorCode(response)).toBe('ATTACHMENT_NOT_FOUND');
    }
  });

  it('refuses download to a non-member', async () => {
    const attachment = await uploadPng(roomA, owner);
    const response = await download(roomA, attachment.id, outsider);
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe('NOT_MEMBER');
  });

  it('never resolves an attachment through another room id', async () => {
    const attachment = await uploadPng(roomA, owner);
    await bindAttachment(roomA, owner, attachment.id);
    // `member` belongs to both rooms, so this is not a membership rejection.
    const response = await download(roomB, attachment.id, member);
    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe('ATTACHMENT_NOT_FOUND');
  });

  it('returns 404 for an unknown attachment id', async () => {
    const response = await download(roomA, 999999, member);
    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe('ATTACHMENT_NOT_FOUND');
  });

  it('requires authentication', async () => {
    const attachment = await uploadPng(roomA, owner);
    const response = await download(roomA, attachment.id, null);
    expect(response.status).toBe(401);
  });
});

describe('message attachment binding', () => {
  it('binds attachments to an attachment-only message and hydrates reads', async () => {
    const attachment = await uploadPng(roomA, owner);
    const socket = await connect(owner, roomA);

    const result = await sendWithAttachments(socket, roomA, '', [attachment.id]);
    expect(result.ok).toBe(true);
    const message = result.message as MessageDTO;
    expect(message.content).toBe('');
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({
      id: attachment.id,
      filename: 'photo.png',
      mime: 'image/png',
      size: PNG_BODY.length,
      url: `/api/rooms/${roomA}/attachments/${attachment.id}`,
    });

    const row = await attachmentRow(attachment.id);
    expect(Number(row?.message_id)).toBe(message.id);

    // The list endpoint is a separate hydration path and must agree.
    const list = await request(server.url)
      .get(`/api/rooms/${roomA}/messages`)
      .set('Authorization', auth(member));
    expect(list.status).toBe(200);
    const listed = (list.body.messages as MessageDTO[]).find(
      (item) => item.id === message.id,
    );
    expect(listed?.attachments).toHaveLength(1);
    expect(listed?.attachments[0].url).toBe(message.attachments[0].url);
  });

  it('dedupes repeated attachment ids', async () => {
    const attachment = await uploadPng(roomA, owner);
    const socket = await connect(owner, roomA);

    const result = await sendWithAttachments(socket, roomA, 'one file', [
      attachment.id,
      attachment.id,
      attachment.id,
    ]);
    expect(result.ok).toBe(true);
    expect(result.message?.attachments).toHaveLength(1);
  });

  it('rejects empty content without attachments', async () => {
    const socket = await connect(owner, roomA);
    const result = await sendWithAttachments(socket, roomA, '', []);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_CONTENT');
    expect(await messageCount(roomA)).toBe(0);
  });

  it('rejects malformed or excessive attachment id lists', async () => {
    const socket = await connect(owner, roomA);

    for (const bad of ['12', [0], [-1], [1.5], Array.from({ length: 11 }, (_, i) => i + 1)]) {
      const result = await sendWithAttachments(socket, roomA, 'hello', bad);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('ATTACHMENT_INVALID');
    }
    expect(await messageCount(roomA)).toBe(0);
  });

  it('rolls back the message when an attachment is already bound', async () => {
    const attachment = await uploadPng(roomA, owner);
    const socket = await connect(owner, roomA);

    const first = await sendWithAttachments(socket, roomA, 'first', [attachment.id]);
    expect(first.ok).toBe(true);
    const before = await messageCount(roomA);

    const second = await sendWithAttachments(socket, roomA, 'second', [attachment.id]);
    expect(second.ok).toBe(false);
    expect(second.code).toBe('ATTACHMENT_INVALID');
    expect(await messageCount(roomA)).toBe(before);
    expect(Number((await attachmentRow(attachment.id))?.message_id)).toBe(first.message?.id);
  });

  it('rejects an attachment uploaded by another member', async () => {
    const attachment = await uploadPng(roomA, member);
    const socket = await connect(owner, roomA);

    const result = await sendWithAttachments(socket, roomA, 'steal', [attachment.id]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ATTACHMENT_INVALID');
    expect(await messageCount(roomA)).toBe(0);
    expect((await attachmentRow(attachment.id))?.message_id).toBeNull();
  });

  it('rejects an attachment uploaded in another room', async () => {
    const attachment = await uploadPng(roomB, member);
    const socket = await connect(member, roomA);

    const result = await sendWithAttachments(socket, roomA, 'wrong room', [attachment.id]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ATTACHMENT_INVALID');
    expect(await messageCount(roomA)).toBe(0);
    expect((await attachmentRow(attachment.id))?.message_id).toBeNull();
  });

  it('hides attachments once the message is withdrawn', async () => {
    const attachment = await uploadPng(roomA, owner);
    const socket = await connect(owner, roomA);
    const sent = await sendWithAttachments(socket, roomA, '', [attachment.id]);
    expect(sent.ok).toBe(true);
    const message = sent.message as MessageDTO;

    const removed = await request(server.url)
      .delete(`/api/rooms/${roomA}/messages/${message.seq}`)
      .set('Authorization', auth(owner));
    expect(removed.status).toBe(200);
    expect(removed.body.message.deleted).toBe(true);
    expect(removed.body.message.attachments).toEqual([]);

    const list = await request(server.url)
      .get(`/api/rooms/${roomA}/messages`)
      .set('Authorization', auth(member));
    const listed = (list.body.messages as MessageDTO[]).find(
      (item) => item.id === message.id,
    );
    expect(listed?.deleted).toBe(true);
    expect(listed?.attachments).toEqual([]);
    // The row is retained for cleanup/audit; only the DTO hides it.
    expect(Number((await attachmentRow(attachment.id))?.message_id)).toBe(message.id);
  });
});

describe('attachment quota', () => {
  /** Fabricates disk usage without writing a real file. */
  async function seedUsage(actor: AuthUser, roomId: number, bytes: number): Promise<void> {
    await pool.execute(
      `INSERT INTO message_attachments (room_id, uploader_id, filename, stored_name, mime, size)
       VALUES (?, ?, 'seeded.bin', ?, 'application/octet-stream', ?)`,
      [roomId, actor.id, randomBytes(24).toString('hex'), bytes],
    );
  }

  it('rejects an upload above the per-user quota and deletes the landed file', async () => {
    config.attachmentUserQuotaBytes = 2 * 1024 * 1024;
    await seedUsage(owner, roomA, 1.5 * 1024 * 1024);
    const filesBefore = fs.readdirSync(uploadRoot).length;

    const response = await uploadAttachment(
      roomA,
      owner,
      'extra.txt',
      'text/plain',
      Buffer.alloc(600 * 1024, 0x61),
    );
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('ATTACHMENT_QUOTA_EXCEEDED');
    expect(response.body.error.message).toContain('1.5 MiB used');
    expect(response.body.error.message).toContain('2.0 MiB');
    // Multer wrote the file before the handler ran; the rejection removes it.
    expect(fs.readdirSync(uploadRoot).length).toBe(filesBefore);
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM message_attachments WHERE uploader_id = ?',
      [owner.id],
    );
    expect(Number(rows[0]?.total)).toBe(1);
  });

  it('treats a quota of 0 as unlimited', async () => {
    config.attachmentUserQuotaBytes = 0;
    await seedUsage(owner, roomA, 500 * 1024 * 1024);

    const response = await uploadAttachment(roomA, owner, 'ok.txt', 'text/plain');
    expect(response.status).toBe(201);
  });

  it('keeps counting withdrawn attachments against the quota', async () => {
    const attachment = await uploadPng(roomA, owner);
    const message = await bindAttachment(roomA, owner, attachment.id);
    const removed = await request(server.url)
      .delete(`/api/rooms/${roomA}/messages/${message.seq}`)
      .set('Authorization', auth(owner));
    expect(removed.status).toBe(200);

    // The row still occupies disk, so the full size fills the quota.
    config.attachmentUserQuotaBytes = PNG_BODY.length;
    const response = await uploadAttachment(
      roomA,
      owner,
      'one.txt',
      'text/plain',
      Buffer.from('x'),
    );
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('ATTACHMENT_QUOTA_EXCEEDED');
  });
});
