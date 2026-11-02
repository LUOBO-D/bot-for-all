import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config, validateEnv } from '../src/config';
import { pool, type ResultSetHeader, type RowDataPacket } from '../src/db';
import {
  runRoomRetention,
  startRoomRetentionScheduler,
} from '../src/services/retention';
import { joinRoom as joinRoomService, setMemberRole } from '../src/services/room';
import type { AuthUser, RoomSummary } from '../src/types';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

let uploadRoot: string;
let originalUploadDir: string;
let owner: AuthUser;
let roomId: number;
let nextSeq: number;

beforeAll(() => {
  originalUploadDir = config.uploadDir;
  uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bfa-room-retention-'));
  config.uploadDir = uploadRoot;
});

beforeEach(async () => {
  fs.rmSync(uploadRoot, { recursive: true, force: true });
  fs.mkdirSync(uploadRoot, { recursive: true });
  owner = await createTestUser(`retention_owner_${randomBytes(3).toString('hex')}`);
  roomId = await createTestRoom(owner);
  nextSeq = 1;
});

afterAll(() => {
  config.uploadDir = originalUploadDir;
  fs.rmSync(uploadRoot, { recursive: true, force: true });
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

async function patchRoom(
  room: number,
  actor: AuthUser,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(app).patch(`/api/rooms/${room}`).set('Authorization', auth(actor)).send(body);
}

async function setRetention(room: number, days: number): Promise<void> {
  await pool.execute('UPDATE rooms SET retention_days = ? WHERE id = ?', [days, room]);
}

async function createMessage(
  room: number,
  ageDays: number,
  options: { pinned?: boolean; content?: string; kind?: 'text' | 'poll' } = {},
): Promise<number> {
  const seq = nextSeq;
  nextSeq += 1;
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO messages
       (room_id, seq, sender_id, sender_type, content, kind, status, created_at, pinned_at, pinned_by)
     VALUES (?, ?, ?, 'user', ?, ?, 'done', TIMESTAMPADD(DAY, -?, NOW(3)), ?, ?)`,
    [
      room,
      seq,
      owner.id,
      options.content ?? 'seed',
      options.kind ?? 'text',
      ageDays,
      options.pinned ? new Date() : null,
      options.pinned ? owner.id : null,
    ],
  );
  return result.insertId;
}

async function messageExists(messageId: number): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT id FROM messages WHERE id = ?', [
    messageId,
  ]);
  return rows.length > 0;
}

interface AttachmentFixture {
  id: number;
  storedName: string;
  file: string;
}

async function createAttachment(room: number, messageId: number): Promise<AttachmentFixture> {
  const storedName = randomBytes(12).toString('hex');
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO message_attachments
       (room_id, uploader_id, message_id, filename, stored_name, mime, size, created_at)
     VALUES (?, ?, ?, 'file.txt', ?, 'text/plain', 4, TIMESTAMPADD(DAY, -10, NOW(3)))`,
    [room, owner.id, messageId, storedName],
  );
  const file = path.join(uploadRoot, storedName);
  fs.writeFileSync(file, 'data');
  return { id: result.insertId, storedName, file };
}

async function attachmentExists(attachmentId: number): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id FROM message_attachments WHERE id = ?',
    [attachmentId],
  );
  return rows.length > 0;
}

describe('room retention API', () => {
  it('lets the owner set retentionDays and returns it in the room summary', async () => {
    const response = await patchRoom(roomId, owner, { retentionDays: 7 });
    expect(response.status).toBe(200);
    expect((response.body.room as RoomSummary).retentionDays).toBe(7);

    const mine = await request(app).get('/api/rooms').set('Authorization', auth(owner));
    expect(mine.status).toBe(200);
    expect((mine.body.mine as RoomSummary[]).find((room) => room.id === roomId)?.retentionDays).toBe(
      7,
    );

    // Joining returns the same summary DTO, including the policy.
    const outsider = await createTestUser(`retention_outsider_${randomBytes(3).toString('hex')}`);
    const joined = await request(app)
      .post(`/api/rooms/${roomId}/join`)
      .set('Authorization', auth(outsider))
      .send({});
    expect(joined.status).toBe(200);
    expect((joined.body.room as RoomSummary).retentionDays).toBe(7);
  });

  it('defaults new rooms to keep messages forever', async () => {
    const mine = await request(app).get('/api/rooms').set('Authorization', auth(owner));
    const room = (mine.body.mine as RoomSummary[]).find((entry) => entry.id === roomId);
    expect(room?.retentionDays).toBe(0);
  });

  it('lets a room admin or a global admin change retention, but not a plain member', async () => {
    const member = await createTestUser(`retention_member_${randomBytes(3).toString('hex')}`);
    await joinRoomService(member.id, roomId);

    const denied = await patchRoom(roomId, member, { retentionDays: 30 });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('ROOM_MODERATOR_REQUIRED');

    await setMemberRole(roomId, owner.id, 'user', member.id, 'admin');
    const allowed = await patchRoom(roomId, member, { retentionDays: 30 });
    expect(allowed.status).toBe(200);
    expect((allowed.body.room as RoomSummary).retentionDays).toBe(30);

    // A global admin may moderate a room without joining it.
    const admin = await createTestUser(`retention_admin_${randomBytes(3).toString('hex')}`, 'admin');
    const global = await patchRoom(roomId, admin, { retentionDays: 3650 });
    expect(global.status).toBe(200);
    expect((global.body.room as RoomSummary).retentionDays).toBe(3650);
  });

  it('rejects retentionDays outside 0..3650 or not an integer', async () => {
    for (const retentionDays of [-1, 3651, 1.5, '7']) {
      const response = await patchRoom(roomId, owner, { retentionDays });
      expect(response.status, `retentionDays=${JSON.stringify(retentionDays)}`).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }

    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT retention_days FROM rooms WHERE id = ?',
      [roomId],
    );
    expect(Number(rows[0]?.retention_days)).toBe(0);
  });
});

describe('room retention sweep', () => {
  it('deletes expired messages and keeps fresh and pinned ones', async () => {
    await setRetention(roomId, 7);
    const expired = await createMessage(roomId, 8);
    const fresh = await createMessage(roomId, 1);
    const pinned = await createMessage(roomId, 8, { pinned: true });

    const result = await runRoomRetention();

    expect(result).toEqual({ rows: 1, files: 0, errors: 0 });
    expect(await messageExists(expired)).toBe(false);
    expect(await messageExists(fresh)).toBe(true);
    expect(await messageExists(pinned)).toBe(true);
  });

  it("applies each room's own window and leaves retention 0 rooms untouched", async () => {
    const room30 = await createTestRoom(owner);
    const roomOff = await createTestRoom(owner);
    await setRetention(roomId, 7);
    await setRetention(room30, 30);
    await setRetention(roomOff, 0);

    const expired = await createMessage(roomId, 8);
    const within30 = await createMessage(room30, 8);
    const expiredButOff = await createMessage(roomOff, 400);

    expect(await runRoomRetention()).toEqual({ rows: 1, files: 0, errors: 0 });
    expect(await messageExists(expired)).toBe(false);
    expect(await messageExists(within30)).toBe(true);
    expect(await messageExists(expiredButOff)).toBe(true);
  });

  it('deletes attachments with the message and unlinks their files after commit', async () => {
    await setRetention(roomId, 7);
    const expired = await createMessage(roomId, 8);
    const attachment = await createAttachment(roomId, expired);

    expect(await runRoomRetention()).toEqual({ rows: 1, files: 1, errors: 0 });
    expect(await messageExists(expired)).toBe(false);
    expect(await attachmentExists(attachment.id)).toBe(false);
    expect(fs.existsSync(attachment.file)).toBe(false);
  });

  it('keeps the attachment file of a pinned message', async () => {
    await setRetention(roomId, 7);
    const pinned = await createMessage(roomId, 8, { pinned: true });
    const attachment = await createAttachment(roomId, pinned);

    expect(await runRoomRetention()).toEqual({ rows: 0, files: 0, errors: 0 });
    expect(await attachmentExists(attachment.id)).toBe(true);
    expect(fs.existsSync(attachment.file)).toBe(true);
  });

  it('does not fail when the attachment file is already gone', async () => {
    await setRetention(roomId, 7);
    const expired = await createMessage(roomId, 8);
    const attachment = await createAttachment(roomId, expired);
    fs.rmSync(attachment.file, { force: true });

    expect(await runRoomRetention()).toEqual({ rows: 1, files: 0, errors: 0 });
    expect(await attachmentExists(attachment.id)).toBe(false);
  });

  it('cascades reactions, edits, reports, saved rows, polls and notifications', async () => {
    await setRetention(roomId, 7);
    const expired = await createMessage(roomId, 8, { kind: 'poll' });
    const reporter = await createTestUser(`retention_reporter_${randomBytes(3).toString('hex')}`);

    await pool.execute('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', [
      expired,
      owner.id,
      '👍',
    ]);
    await pool.execute(
      `INSERT INTO message_edits (message_id, room_id, old_content, edited_by)
       VALUES (?, ?, 'before', ?)`,
      [expired, roomId, owner.id],
    );
    await pool.execute(
      `INSERT INTO message_reports (message_id, room_id, reporter_id, reason)
       VALUES (?, ?, ?, 'spam')`,
      [expired, roomId, reporter.id],
    );
    await pool.execute('INSERT INTO saved_messages (user_id, message_id, room_id) VALUES (?, ?, ?)', [
      owner.id,
      expired,
      roomId,
    ]);
    const [pollResult] = await pool.execute<ResultSetHeader>(
      'INSERT INTO polls (message_id) VALUES (?)',
      [expired],
    );
    const pollId = pollResult.insertId;
    const [optionResult] = await pool.execute<ResultSetHeader>(
      'INSERT INTO poll_options (poll_id, label) VALUES (?, ?)',
      [pollId, 'yes'],
    );
    await pool.execute('INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES (?, ?, ?)', [
      pollId,
      optionResult.insertId,
      owner.id,
    ]);
    await pool.execute(
      `INSERT INTO notifications (user_id, type, room_id, message_id, actor_id)
       VALUES (?, 'mention', ?, ?, ?)`,
      [reporter.id, roomId, expired, owner.id],
    );

    // A fresh message keeps its own child rows: only expired messages cascade.
    const fresh = await createMessage(roomId, 1);
    await pool.execute('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', [
      fresh,
      owner.id,
      '🔥',
    ]);

    expect(await runRoomRetention()).toEqual({ rows: 1, files: 0, errors: 0 });
    expect(await messageExists(expired)).toBe(false);
    expect(await messageExists(fresh)).toBe(true);

    const [counts] = await pool.execute<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM message_reactions WHERE message_id = ?) AS reactions,
         (SELECT COUNT(*) FROM message_edits WHERE message_id = ?) AS edits,
         (SELECT COUNT(*) FROM message_reports WHERE message_id = ?) AS reports,
         (SELECT COUNT(*) FROM saved_messages WHERE message_id = ?) AS saved,
         (SELECT COUNT(*) FROM polls WHERE message_id = ?) AS polls,
         (SELECT COUNT(*) FROM notifications WHERE message_id = ?) AS notifications,
         (SELECT COUNT(*) FROM poll_options WHERE poll_id = ?) AS options,
         (SELECT COUNT(*) FROM poll_votes WHERE poll_id = ?) AS votes`,
      [expired, expired, expired, expired, expired, expired, pollId, pollId],
    );
    expect(counts[0]).toMatchObject({
      reactions: 0,
      edits: 0,
      reports: 0,
      saved: 0,
      polls: 0,
      notifications: 0,
      options: 0,
      votes: 0,
    });

    const [freshRows] = await pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS reactions FROM message_reactions WHERE message_id = ?',
      [fresh],
    );
    expect(Number(freshRows[0].reactions)).toBe(1);
  });

  it('deletes one bounded batch per sweep and leaves the rest for later', async () => {
    await setRetention(roomId, 1);
    for (let index = 0; index < 120; index += 1) {
      await createMessage(roomId, 2);
    }

    expect(await runRoomRetention({ batchSize: 50 })).toEqual({ rows: 50, files: 0, errors: 0 });
    expect(await runRoomRetention({ batchSize: 50 })).toEqual({ rows: 50, files: 0, errors: 0 });
    expect(await runRoomRetention({ batchSize: 50 })).toEqual({ rows: 20, files: 0, errors: 0 });
    expect(await runRoomRetention({ batchSize: 50 })).toEqual({ rows: 0, files: 0, errors: 0 });
  });

  it('runs a sweep at startup and unrefs its timer', async () => {
    await setRetention(roomId, 7);
    const expired = await createMessage(roomId, 8);

    const timer = startRoomRetentionScheduler();
    try {
      await expect.poll(() => messageExists(expired), { timeout: 5000 }).toBe(false);
      expect(timer.hasRef()).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });

  it('applies sweep defaults and rejects out-of-range intervals', () => {
    const baseEnv = {
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      JWT_SECRET: process.env.JWT_SECRET ?? 'x'.repeat(32),
      BOT_KEY_SECRET: process.env.BOT_KEY_SECRET ?? 'a1'.repeat(32),
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? 'test-admin-password',
    };

    expect(validateEnv(baseEnv).ROOM_RETENTION_SWEEP_MS).toBe(21_600_000);
    expect(validateEnv({ ...baseEnv, ROOM_RETENTION_SWEEP_MS: '60000' }).ROOM_RETENTION_SWEEP_MS).toBe(
      60_000,
    );
    expect(() => validateEnv({ ...baseEnv, ROOM_RETENTION_SWEEP_MS: '59999' })).toThrow(
      /ROOM_RETENTION_SWEEP_MS/,
    );
    expect(() => validateEnv({ ...baseEnv, ROOM_RETENTION_SWEEP_MS: '86400001' })).toThrow(
      /ROOM_RETENTION_SWEEP_MS/,
    );
  });
});
