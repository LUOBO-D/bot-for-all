import fs from 'node:fs';
import { ZipArchive } from 'archiver';
import { Router, type Request } from 'express';
import { pool, type RowDataPacket } from '../db';
import { badRequest, tooMany, unauthorized } from '../errors';
import { logger } from '../logger';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { checkRate } from '../middleware/ratelimit';
import { resolveAttachmentPath } from '../services/attachment-cleanup';
import {
  DELETED_MESSAGE_TEXT,
  truncateContent,
} from '../services/notifications';
import type { AuthUser, UserRole, UserType } from '../types';
import { toIso } from '../utils';

/**
 * One-shot personal data export ("导出我的数据"). Every query is scoped to the
 * authenticated user id, so the response can only ever contain the caller's
 * own profile, memberships, messages, bookmarks and notifications. Message
 * and bookmark caps keep the document bounded; the extra row fetched past each
 * cap answers `truncated` without a second COUNT query.
 */
export const ME_EXPORT_MESSAGES_LIMIT = 5000;
export const ME_EXPORT_SAVED_LIMIT = 1000;
export const ME_EXPORT_NOTIFICATIONS_LIMIT = 1000;
export const ME_EXPORT_RATE_MAX = 3;
export const ME_EXPORT_RATE_WINDOW_MS = 60 * 60 * 1000;

export interface MeExportProfile {
  id: number;
  username: string;
  displayName: string;
  type: UserType;
  role: UserRole;
  statusEmoji: string | null;
  statusText: string | null;
  createdAt: string;
}

export interface MeExportRoom {
  id: number;
  name: string;
  role: string;
  joinedAt: string;
}

export interface MeExportAttachment {
  id: number;
  filename: string;
  mime: string;
  size: number;
  createdAt: string;
}

/** On-disk identity of an attachment that belongs to one of the caller's messages. */
interface MeExportAttachmentFile {
  id: number;
  filename: string;
  storedName: string;
}

export interface MeExportMessage {
  roomId: number;
  roomName: string;
  seq: number;
  content: string;
  createdAt: string;
  editedAt: string | null;
  /** Withdrawn rows stay in the export with their stored content and this flag. */
  deleted: boolean;
  attachments: MeExportAttachment[];
}

export interface MeExportSavedItem {
  messageId: number;
  roomId: number;
  roomName: string;
  seq: number;
  content: string;
  senderName: string;
  deleted: boolean;
  savedAt: string;
}

export interface MeExportNotification {
  id: number;
  type: string;
  roomId: number;
  roomName: string;
  messageId: number | null;
  messageSeq: number | null;
  actorName: string;
  content: string;
  createdAt: string;
  readAt: string | null;
}

export interface MeExportPayload {
  exportedAt: string;
  profile: MeExportProfile;
  rooms: MeExportRoom[];
  messages: MeExportMessage[];
  saved: MeExportSavedItem[];
  notifications: MeExportNotification[];
  /** True when at least one capped section omitted older rows. */
  truncated: boolean;
}

const router = Router();

router.use(requireAuth);

/** Longest filename part of a zip entry; the attachment id prefix is extra. */
const EXPORT_ENTRY_NAME_MAX = 120;

/**
 * Filename part of `attachments/<id>-<name>`. Path separators, control
 * characters, `..` runs and leading dots are replaced so no extractor can read
 * an entry as a path (Zip Slip); the numeric id prefix keeps names unique even
 * when two attachments share a display name.
 */
function archiveEntryFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '')
    .replace(/_+/g, '_')
    .trim();
  const chars = Array.from(cleaned.length > 0 ? cleaned : 'file');
  return chars.length > EXPORT_ENTRY_NAME_MAX
    ? chars.slice(0, EXPORT_ENTRY_NAME_MAX).join('')
    : chars.join('');
}

function currentUser(req: Request): AuthUser {
  return req.user as AuthUser;
}

async function loadProfile(userId: number): Promise<MeExportProfile> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, username, display_name, type, role, status_emoji, status_text, created_at
     FROM users WHERE id = ?`,
    [userId],
  );
  const row = rows[0];
  // Authentication loaded this row moments ago; a disappearance means the
  // account was deleted concurrently, which is an auth failure for this call.
  if (!row) {
    throw unauthorized('User not found');
  }
  return {
    id: Number(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    type: row.type as UserType,
    role: row.role as UserRole,
    statusEmoji: row.status_emoji == null ? null : String(row.status_emoji),
    statusText: row.status_text == null ? null : String(row.status_text),
    createdAt: toIso(row.created_at),
  };
}

async function loadRooms(userId: number): Promise<MeExportRoom[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT r.id, r.name, rm.role, rm.joined_at
     FROM room_members rm
     JOIN rooms r ON r.id = rm.room_id
     WHERE rm.user_id = ?
     ORDER BY rm.joined_at DESC, r.id DESC`,
    [userId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    role: String(row.role),
    joinedAt: toIso(row.joined_at),
  }));
}

interface RawMessageRow extends RowDataPacket {
  id: number;
  room_id: number;
  room_name: string;
  seq: number;
  content: string;
  created_at: unknown;
  edited_at: unknown;
  deleted_at: unknown;
}

async function loadMessages(userId: number): Promise<{
  messages: MeExportMessage[];
  truncated: boolean;
  attachmentFiles: MeExportAttachmentFile[];
}> {
  const [rows] = await pool.query<RawMessageRow[]>(
    `SELECT m.id, m.room_id, r.name AS room_name, m.seq, m.content,
            m.created_at, m.edited_at, m.deleted_at
     FROM messages m
     JOIN rooms r ON r.id = m.room_id
     WHERE m.sender_id = ?
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT ${ME_EXPORT_MESSAGES_LIMIT + 1}`,
    [userId],
  );
  const truncated = rows.length > ME_EXPORT_MESSAGES_LIMIT;
  const capped = rows.slice(0, ME_EXPORT_MESSAGES_LIMIT);
  const attachments = await loadAttachments(capped.map((row) => Number(row.id)));
  return {
    messages: capped.map((row) => ({
      roomId: Number(row.room_id),
      roomName: String(row.room_name),
      seq: Number(row.seq),
      // Withdrawn messages keep the column value; `deleted` carries the marker.
      content: String(row.content ?? ''),
      createdAt: toIso(row.created_at),
      editedAt: row.edited_at == null ? null : toIso(row.edited_at),
      deleted: row.deleted_at != null,
      attachments: attachments.byMessage.get(Number(row.id)) ?? [],
    })),
    truncated,
    attachmentFiles: attachments.files,
  };
}

async function loadAttachments(messageIds: number[]): Promise<{
  byMessage: Map<number, MeExportAttachment[]>;
  files: MeExportAttachmentFile[];
}> {
  const byMessage = new Map<number, MeExportAttachment[]>();
  const files: MeExportAttachmentFile[] = [];
  if (messageIds.length === 0) {
    return { byMessage, files };
  }
  // One IN list is bounded by the message cap above (5000 ids), which stays
  // well inside the driver's placeholder and packet limits. Every id here
  // belongs to a message the caller sent, so the files are theirs alone.
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, message_id, filename, stored_name, mime, size, created_at
     FROM message_attachments
     WHERE message_id IN (?)
     ORDER BY id`,
    [messageIds],
  );
  for (const row of rows) {
    const messageId = Number(row.message_id);
    const list = byMessage.get(messageId) ?? [];
    list.push({
      id: Number(row.id),
      filename: String(row.filename),
      mime: String(row.mime),
      size: Number(row.size),
      createdAt: toIso(row.created_at),
    });
    byMessage.set(messageId, list);
    files.push({
      id: Number(row.id),
      filename: String(row.filename),
      storedName: String(row.stored_name),
    });
  }
  return { byMessage, files };
}

async function loadSaved(userId: number): Promise<{
  saved: MeExportSavedItem[];
  truncated: boolean;
}> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT s.message_id, s.room_id, r.name AS room_name, m.seq, m.content,
            m.deleted_at, u.display_name AS sender_name, s.created_at AS saved_at
     FROM saved_messages s
     JOIN room_members rm ON rm.room_id = s.room_id AND rm.user_id = s.user_id
     JOIN messages m ON m.id = s.message_id
     JOIN rooms r ON r.id = s.room_id
     JOIN users u ON u.id = m.sender_id
     WHERE s.user_id = ?
     ORDER BY s.created_at DESC, s.message_id DESC
     LIMIT ${ME_EXPORT_SAVED_LIMIT + 1}`,
    [userId],
  );
  return {
    saved: rows.slice(0, ME_EXPORT_SAVED_LIMIT).map((row) => ({
      messageId: Number(row.message_id),
      roomId: Number(row.room_id),
      roomName: String(row.room_name),
      seq: Number(row.seq),
      content: row.deleted_at != null ? '' : String(row.content ?? ''),
      senderName: String(row.sender_name),
      deleted: row.deleted_at != null,
      savedAt: toIso(row.saved_at),
    })),
    truncated: rows.length > ME_EXPORT_SAVED_LIMIT,
  };
}

async function loadNotifications(userId: number): Promise<{
  notifications: MeExportNotification[];
  truncated: boolean;
}> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT n.id, n.type, n.room_id, r.name AS room_name, n.message_id,
            n.detail, n.read_at, n.created_at,
            m.seq AS message_seq, m.content AS message_content,
            m.deleted_at AS message_deleted_at,
            COALESCE(actor.display_name, '') AS actor_name,
            rm.user_id AS member_user_id
     FROM notifications n
     JOIN rooms r ON r.id = n.room_id
     LEFT JOIN messages m ON m.id = n.message_id
     LEFT JOIN users actor ON actor.id = n.actor_id
     LEFT JOIN room_members rm ON rm.room_id = n.room_id AND rm.user_id = n.user_id
     WHERE n.user_id = ?
     ORDER BY n.id DESC
     LIMIT ${ME_EXPORT_NOTIFICATIONS_LIMIT + 1}`,
    [userId],
  );
  return {
    notifications: rows.slice(0, ME_EXPORT_NOTIFICATIONS_LIMIT).map((row) => {
      const hasMessage = row.message_id != null;
      // Mirror the notification list: message content is only exposed while
      // the recipient still belongs to the room that granted that read.
      const visible = hasMessage && row.member_user_id != null;
      return {
        id: Number(row.id),
        type: String(row.type),
        roomId: Number(row.room_id),
        roomName: String(row.room_name ?? ''),
        messageId: visible ? Number(row.message_id) : null,
        messageSeq: visible && row.message_seq != null ? Number(row.message_seq) : null,
        actorName: String(row.actor_name ?? ''),
        content: hasMessage
          ? visible
            ? row.message_deleted_at != null
              ? DELETED_MESSAGE_TEXT
              : truncateContent(String(row.message_content ?? ''))
            : ''
          : String(row.detail ?? ''),
        createdAt: toIso(row.created_at),
        readAt: row.read_at == null ? null : toIso(row.read_at),
      };
    }),
    truncated: rows.length > ME_EXPORT_NOTIFICATIONS_LIMIT,
  };
}

interface MeExportDocument {
  payload: MeExportPayload;
  /** Files of the caller's own attachments, resolved on disk only for ZIP. */
  attachmentFiles: MeExportAttachmentFile[];
}

async function loadExportDocument(userId: number): Promise<MeExportDocument> {
  const [profile, rooms, messageResult, savedResult, notificationResult] = await Promise.all([
    loadProfile(userId),
    loadRooms(userId),
    loadMessages(userId),
    loadSaved(userId),
    loadNotifications(userId),
  ]);
  return {
    payload: {
      exportedAt: new Date().toISOString(),
      profile,
      rooms,
      messages: messageResult.messages,
      saved: savedResult.saved,
      notifications: notificationResult.notifications,
      truncated:
        messageResult.truncated || savedResult.truncated || notificationResult.truncated,
    },
    attachmentFiles: messageResult.attachmentFiles,
  };
}

// Mounted at /api/me: the whole document is assembled in memory (never on
// disk) and sent as a download. Three exports per user per hour keeps the
// multi-query document from being used as a cheap table scan. `?format=zip`
// adds the caller's own attachment bytes and spends the same bucket, so
// switching formats never buys extra exports.
router.get(
  '/export',
  asyncHandler(async (req, res) => {
    const userId = currentUser(req).id;
    const format = req.query.format;
    if (format !== undefined && format !== 'json' && format !== 'zip') {
      throw badRequest('INVALID_FORMAT', "format must be 'json' or 'zip'");
    }
    if (!(await checkRate(`me-export:${userId}`, ME_EXPORT_RATE_MAX, ME_EXPORT_RATE_WINDOW_MS))) {
      throw tooMany('Too many data exports, try again later');
    }

    const document = await loadExportDocument(userId);
    if (format !== 'zip') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="me-export-${userId}.json"`,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.send(JSON.stringify(document.payload));
      return;
    }

    // ZIP: `data.json` carries the same document as the JSON export, plus the
    // bytes of attachments on messages the caller sent. Missing files and rows
    // whose stored name would escape UPLOAD_DIR are skipped and counted in
    // X-Export-Skipped: one bad row must never cost the caller the rest of the
    // archive.
    const files: Array<{ name: string; path: string }> = [];
    let skipped = 0;
    for (const entry of document.attachmentFiles) {
      const absolute = resolveAttachmentPath(entry.storedName);
      if (!absolute) {
        skipped += 1;
        continue;
      }
      try {
        if (!(await fs.promises.stat(absolute)).isFile()) {
          skipped += 1;
          continue;
        }
      } catch {
        // The row outlived its file (cleanup, lost volume): skip it and report
        // the count instead of failing the whole export.
        skipped += 1;
        continue;
      }
      files.push({
        name: `attachments/${entry.id}-${archiveEntryFilename(entry.filename)}`,
        path: absolute,
      });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="me-export-${userId}.zip"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Files dropped above are invisible in the zip; surface the count so a
    // partial export is explainable after the fact.
    res.setHeader('X-Export-Skipped', String(skipped));

    // Streamed, never buffered: `data.json` is one string and each file is
    // appended as a read stream, so the process holds at most a chunk of one
    // attachment. Once the first byte is out the status line is spent, so a
    // mid-stream failure destroys the connection rather than leaving a
    // truncated zip that looks complete.
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const streams: fs.ReadStream[] = [];
    let torn = false;
    const tearDown = (): void => {
      if (torn) {
        return;
      }
      torn = true;
      for (const stream of streams) {
        stream.destroy();
      }
      archive.abort();
    };
    const fail = (error: unknown): void => {
      if (torn) {
        return;
      }
      logger.warn({ err: error, userId }, 'me export archive aborted mid-stream');
      tearDown();
      res.destroy();
    };
    archive.on('error', fail);
    archive.on('warning', fail);
    res.on('close', () => {
      if (!res.writableFinished) {
        tearDown();
      }
    });

    archive.pipe(res);
    archive.append(JSON.stringify(document.payload), { name: 'data.json' });
    for (const file of files) {
      const stream = fs.createReadStream(file.path);
      // The archive never sees a source error; without this listener it would
      // surface as an unhandled 'error' event and take the process down.
      stream.on('error', fail);
      streams.push(stream);
      archive.append(stream, { name: file.name });
    }
    void archive.finalize().catch(fail);
  }),
);

export default router;
