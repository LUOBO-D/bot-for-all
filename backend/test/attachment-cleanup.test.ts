import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config, validateEnv } from '../src/config';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import {
  runAttachmentCleanup,
  resolveAttachmentPath,
  startAttachmentCleanupScheduler,
} from '../src/services/attachment-cleanup';
import type { AuthUser } from '../src/types';
import { createTestRoom, createTestUser } from './helpers';

let uploadRoot: string;
let originalUploadDir: string;
let owner: AuthUser;
let roomId: number;
let nextSeq: number;

beforeAll(() => {
  originalUploadDir = config.uploadDir;
  uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bfa-attachment-cleanup-'));
  config.uploadDir = uploadRoot;
});

beforeEach(async () => {
  fs.rmSync(uploadRoot, { recursive: true, force: true });
  fs.mkdirSync(uploadRoot, { recursive: true });
  owner = await createTestUser(`cleanup_owner_${randomBytes(3).toString('hex')}`);
  roomId = await createTestRoom(owner);
  nextSeq = 1;
});

afterAll(() => {
  config.uploadDir = originalUploadDir;
  fs.rmSync(uploadRoot, { recursive: true, force: true });
});

/** Inserts a message; `deletedHoursAgo` set means it was withdrawn that long ago. */
async function createMessage(deletedHoursAgo: number | null): Promise<number> {
  const seq = nextSeq;
  nextSeq += 1;
  const result =
    deletedHoursAgo == null
      ? await pool.execute<ResultSetHeader>(
          `INSERT INTO messages
             (room_id, seq, sender_id, sender_type, content, status, created_at, deleted_at)
           VALUES (?, ?, ?, 'user', 'seed', 'done', TIMESTAMPADD(HOUR, -100, NOW(3)), NULL)`,
          [roomId, seq, owner.id],
        )
      : await pool.execute<ResultSetHeader>(
          `INSERT INTO messages
             (room_id, seq, sender_id, sender_type, content, status, created_at, deleted_at)
           VALUES (?, ?, ?, 'user', 'seed', 'done',
                   TIMESTAMPADD(HOUR, -100, NOW(3)), TIMESTAMPADD(HOUR, -?, NOW(3)))`,
          [roomId, seq, owner.id, deletedHoursAgo],
        );
  return result[0].insertId;
}

interface AttachmentFixture {
  id: number;
  storedName: string;
}

async function createAttachment(options: {
  messageId?: number | null;
  storedName?: string;
  ageHours?: number;
}): Promise<AttachmentFixture> {
  const storedName = options.storedName ?? randomBytes(12).toString('hex');
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO message_attachments
       (room_id, uploader_id, message_id, filename, stored_name, mime, size, created_at)
     VALUES (?, ?, ?, 'file.txt', ?, 'text/plain', 6, TIMESTAMPADD(HOUR, -?, NOW(3)))`,
    [roomId, owner.id, options.messageId ?? null, storedName, options.ageHours ?? 25],
  );
  return { id: result.insertId, storedName };
}

function writeStoredFile(storedName: string): string {
  const absolute = path.join(uploadRoot, storedName);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, 'data');
  return absolute;
}

/** Inserts `count` unbound rows whose `created_at` is 25 hours old. */
async function insertOldUnboundAttachments(count: number): Promise<void> {
  const rows = Array.from({ length: count }, () => [
    roomId,
    owner.id,
    null,
    'file.txt',
    randomBytes(12).toString('hex'),
    'text/plain',
    6,
  ]);
  await pool.query(
    `INSERT INTO message_attachments
       (room_id, uploader_id, message_id, filename, stored_name, mime, size)
     VALUES ?`,
    [rows],
  );
  await pool.query('UPDATE message_attachments SET created_at = TIMESTAMPADD(HOUR, -25, NOW(3))');
}

async function attachmentExists(id: number): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id FROM message_attachments WHERE id = ?',
    [id],
  );
  return rows.length > 0;
}

async function messageExists(id: number): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT id FROM messages WHERE id = ?', [id]);
  return rows.length > 0;
}

describe('attachment cleanup', () => {
  it('deletes old unbound attachments and their files', async () => {
    const attachment = await createAttachment({ ageHours: 25 });
    writeStoredFile(attachment.storedName);

    const result = await runAttachmentCleanup({ ttlHours: 24 });

    expect(result).toEqual({ rows: 1, files: 1, errors: 0 });
    expect(await attachmentExists(attachment.id)).toBe(false);
    expect(fs.existsSync(path.join(uploadRoot, attachment.storedName))).toBe(false);
  });

  it("deletes attachments of messages withdrawn longer than the TTL", async () => {
    const messageId = await createMessage(30);
    const attachment = await createAttachment({ messageId, ageHours: 25 });
    writeStoredFile(attachment.storedName);

    const result = await runAttachmentCleanup({ ttlHours: 24 });

    expect(result).toEqual({ rows: 1, files: 1, errors: 0 });
    expect(await attachmentExists(attachment.id)).toBe(false);
    expect(fs.existsSync(path.join(uploadRoot, attachment.storedName))).toBe(false);
    // Withdrawing a message deletes only its attachments, never the message.
    expect(await messageExists(messageId)).toBe(true);
  });

  it('leaves fresh, live-message and recently-withdrawn attachments alone', async () => {
    const fresh = await createAttachment({ ageHours: 1 });
    writeStoredFile(fresh.storedName);

    const liveMessageId = await createMessage(null);
    const live = await createAttachment({ messageId: liveMessageId, ageHours: 100 });
    writeStoredFile(live.storedName);

    const recentWithdrawal = await createMessage(1);
    const withdrawn = await createAttachment({ messageId: recentWithdrawal, ageHours: 100 });
    writeStoredFile(withdrawn.storedName);

    const result = await runAttachmentCleanup({ ttlHours: 24 });

    expect(result).toEqual({ rows: 0, files: 0, errors: 0 });
    for (const attachment of [fresh, live, withdrawn]) {
      expect(await attachmentExists(attachment.id)).toBe(true);
      expect(fs.existsSync(path.join(uploadRoot, attachment.storedName))).toBe(true);
    }
  });

  it('does not fail when the file is already missing', async () => {
    const attachment = await createAttachment({ ageHours: 25 });

    const result = await runAttachmentCleanup({ ttlHours: 24 });

    expect(result).toEqual({ rows: 1, files: 0, errors: 0 });
    expect(await attachmentExists(attachment.id)).toBe(false);
  });

  it('refuses unsafe stored names without touching files outside the upload dir', async () => {
    const outsideName = `escape-${randomBytes(4).toString('hex')}.txt`;
    const outsidePath = path.resolve(uploadRoot, '..', outsideName);
    fs.writeFileSync(outsidePath, 'do not delete');

    const traversal = await createAttachment({ storedName: `../${outsideName}`, ageHours: 25 });
    const dotDot = await createAttachment({ storedName: '..', ageHours: 25 });
    const nested = await createAttachment({ storedName: 'nested/file.txt', ageHours: 25 });

    const result = await runAttachmentCleanup({ ttlHours: 24 });

    expect(result).toEqual({ rows: 3, files: 0, errors: 3 });
    expect(fs.existsSync(outsidePath)).toBe(true);
    for (const attachment of [traversal, dotDot, nested]) {
      expect(await attachmentExists(attachment.id)).toBe(false);
    }
    fs.rmSync(outsidePath, { force: true });

    expect(resolveAttachmentPath('abc')).toBe(path.join(uploadRoot, 'abc'));
    expect(resolveAttachmentPath('../abc')).toBeNull();
    expect(resolveAttachmentPath('..')).toBeNull();
    expect(resolveAttachmentPath('nested/file.txt')).toBeNull();
    expect(resolveAttachmentPath('')).toBeNull();
  });

  it('deletes at most 500 rows per sweep and leaves the rest for the next one', async () => {
    await insertOldUnboundAttachments(505);

    expect(await runAttachmentCleanup({ ttlHours: 24, limit: 1000 })).toEqual({
      rows: 500,
      files: 0,
      errors: 0,
    });
    expect(await runAttachmentCleanup({ ttlHours: 24 })).toEqual({
      rows: 5,
      files: 0,
      errors: 0,
    });
    expect(await runAttachmentCleanup({ ttlHours: 24 })).toEqual({
      rows: 0,
      files: 0,
      errors: 0,
    });
  });

  it('splits a backlog between concurrent sweeps without double-deleting', async () => {
    await insertOldUnboundAttachments(505);

    const [first, second] = await Promise.all([
      runAttachmentCleanup({ ttlHours: 24 }),
      runAttachmentCleanup({ ttlHours: 24 }),
    ]);

    // `SKIP LOCKED` may skip a whole locked batch, so a peer can come back
    // empty while rows remain; what matters is that no row is claimed twice
    // and a later sweep still drains the rest.
    expect(first.rows).toBeLessThanOrEqual(500);
    expect(second.rows).toBeLessThanOrEqual(500);
    expect(first.files + second.files).toBe(0);
    expect(first.errors + second.errors).toBe(0);

    const swept = first.rows + second.rows;
    expect(swept).toBeLessThanOrEqual(505);
    const followUp = await runAttachmentCleanup({ ttlHours: 24 });
    expect(followUp.rows).toBe(505 - swept);
    expect(followUp.files).toBe(0);
    expect(followUp.errors).toBe(0);

    const [remaining] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM message_attachments',
    );
    expect(Number(remaining[0].count)).toBe(0);
  });

  it('sweeps once at startup and unrefs its timer', async () => {
    const attachment = await createAttachment({ ageHours: 25 });
    const timer = startAttachmentCleanupScheduler();
    try {
      await expect.poll(() => attachmentExists(attachment.id), { timeout: 5000 }).toBe(false);
      expect(timer.hasRef()).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });

  it('applies cleanup defaults and rejects out-of-range values', () => {
    const baseEnv = {
      DATABASE_URL: 'mysql://root:devroot@127.0.0.1:3306/chat_test',
      JWT_SECRET: 'x'.repeat(32),
      BOT_KEY_SECRET: 'a1'.repeat(32),
      ADMIN_PASSWORD: 'test-admin-password',
    };

    const env = validateEnv(baseEnv);
    expect(env.ATTACHMENT_ORPHAN_TTL_HOURS).toBe(24);
    expect(env.ATTACHMENT_CLEANUP_INTERVAL_MS).toBe(21_600_000);

    expect(() => validateEnv({ ...baseEnv, ATTACHMENT_ORPHAN_TTL_HOURS: '0' })).toThrow(
      /ATTACHMENT_ORPHAN_TTL_HOURS/,
    );
    expect(() => validateEnv({ ...baseEnv, ATTACHMENT_ORPHAN_TTL_HOURS: '8761' })).toThrow(
      /ATTACHMENT_ORPHAN_TTL_HOURS/,
    );
    expect(() =>
      validateEnv({ ...baseEnv, ATTACHMENT_CLEANUP_INTERVAL_MS: '59999' }),
    ).toThrow(/ATTACHMENT_CLEANUP_INTERVAL_MS/);
    expect(() =>
      validateEnv({ ...baseEnv, ATTACHMENT_CLEANUP_INTERVAL_MS: '86400001' }),
    ).toThrow(/ATTACHMENT_CLEANUP_INTERVAL_MS/);
    expect(
      validateEnv({
        ...baseEnv,
        ATTACHMENT_ORPHAN_TTL_HOURS: '8760',
        ATTACHMENT_CLEANUP_INTERVAL_MS: '60000',
      }).ATTACHMENT_ORPHAN_TTL_HOURS,
    ).toBe(8760);
  });
});
