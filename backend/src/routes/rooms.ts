import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { ZipArchive } from 'archiver';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config';
import { pool, withTransaction, type ResultSetHeader, type RowDataPacket } from '../db';
import { ApiError, badRequest, conflict, forbidden, notFound, tooMany } from '../errors';
import { logger } from '../logger';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { checkRate } from '../middleware/ratelimit';
import { resolveAttachmentPath } from '../services/attachment-cleanup';
import { DRAFT_CONTENT_MAX, getDraft, saveDraft } from '../services/drafts';
import {
  approveJoinRequest,
  decideJoinRequestsBulk,
  listJoinRequests,
  rejectJoinRequest,
  requestJoin,
} from '../services/join-requests';
import { createNotification } from '../services/notifications';
import {
  assertCanSendMessage,
  attachReactions,
  attachmentUrl,
  closePoll,
  createPoll,
  deleteMessage,
  editMessage,
  forwardMessage,
  forwardMessages,
  getMessageBySeq,
  getPollExport,
  getPollMyVotes,
  listExportAttachments,
  listMessageEdits,
  listMessages,
  listMessagesForExport,
  listPinned,
  listRoomAttachments,
  pinMessage,
  POLL_OPTION_MAX,
  POLL_OPTIONS_MAX,
  POLL_OPTIONS_MIN,
  POLL_QUESTION_MAX,
  ROOM_ARCHIVE_MAX_BYTES,
  ROOM_ARCHIVE_MAX_FILES,
  ROOM_ATTACHMENT_PAGE_LIMIT,
  searchMessagesPage,
  selectRoomArchive,
  toggleReaction,
  unpinMessage,
  votePoll,
} from '../services/message';
import type { RoomArchiveEntry } from '../services/message';
import { createReport, REPORT_REASON_MAX } from '../services/reports';
import { removeSaved, saveMessage } from '../services/saved';
import {
  cancelScheduled,
  listScheduled,
  parseSendAt,
  scheduleMessage,
  SCHEDULED_CONTENT_MAX,
  updateScheduled,
} from '../services/scheduled';
import {
  assertTranslationEnabled,
  TRANSLATE_CONTENT_MAX,
  TRANSLATE_DEFAULT_TARGET_LANG,
  TRANSLATE_RATE_MAX,
  TRANSLATE_RATE_WINDOW_MS,
  TRANSLATE_TARGET_LANG_MAX,
  translateText,
} from '../services/translation';
import {
  BULK_INVITE_MAX,
  assertMember,
  createRoom,
  getMemberRole,
  getRoomName,
  getRoomOwnerId,
  getRoomSlowMode,
  getRoomSummary,
  inviteMember,
  inviteMembers,
  isRoomMember,
  joinRoom,
  leaveRoom,
  listMembers,
  listRooms,
  markAllRoomsRead,
  previewRoomRetention,
  removeMember,
  removeMembers,
  rotateInviteCode,
  searchPublicRooms,
  setMemberRole,
  setMemberRoles,
  setRoomArchived,
  setRoomFavorite,
  setRoomGroup,
  setRoomMuted,
  transferOwnership,
  updateReadCursor,
  updateRoom,
} from '../services/room';
import { evictUserFromRoom, roomKey } from '../socket';
import { broadcastMessageUpdated, getSocketServer } from '../socket/broadcast';
import type { AuthUser, MessageDTO } from '../types';
import { formatMiB } from '../utils';

const router = Router();

router.use(requireAuth);

const createRoomSchema = z.object({
  name: z.string().min(1).max(64),
  topic: z.string().max(255).optional(),
  isPublic: z.boolean().optional(),
});

const updateRoomSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  topic: z.string().max(255).optional(),
  announcement: z.string().max(2000).optional(),
  slowModeSeconds: z.number().int().min(0).max(3600).optional(),
  retentionDays: z.number().int().min(0).max(3650).optional(),
});

// Optional `days` previews a policy the dialog has not saved yet; omitted, the
// room's stored retention_days applies.
const retentionPreviewQuerySchema = z.object({
  days: z.coerce.number().int().min(0).max(3650).optional(),
});

const muteSchema = z.object({
  muted: z.boolean(),
});

const favoriteSchema = z.object({
  favorite: z.boolean(),
});

const groupSchema = z.object({
  group: z.string().max(32).nullable(),
});

const archiveSchema = z.object({
  archived: z.boolean(),
});

const joinSchema = z.object({
  inviteCode: z.string().min(1).max(16).optional(),
});

// One decision applied to a whole page of pending requests; deduplicated ids
// count once, and the endpoint is all-or-nothing across the batch.
const joinRequestBulkSchema = z.object({
  userIds: z.array(z.number().int().positive()).min(1).max(100),
  action: z.enum(['approve', 'reject']),
});

const readSchema = z.object({
  seq: z.number().int().nonnegative(),
});

const SEARCH_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Rejects impossible days such as `2026-02-30`, not just malformed input. */
function isSearchDate(value: string): boolean {
  if (!SEARCH_DATE.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const searchDateSchema = z.string().trim().refine(isSearchDate, 'expected YYYY-MM-DD');

const searchSchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  // Counts matches already shown, so it indexes into the filtered result set.
  // Beyond the safe-integer range the value can no longer be escaped as a
  // literal MySQL would parse, so it is rejected here rather than as a 500.
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  senderId: z.coerce.number().int().positive().optional(),
  from: searchDateSchema.optional(),
  to: searchDateSchema.optional(),
});

const SEARCH_FIELD_MESSAGES: Record<string, string> = {
  q: 'q must be 1-100 characters',
  limit: 'limit must be an integer between 1 and 50',
  offset: 'offset must be a non-negative integer',
  senderId: 'senderId must be a positive integer',
  from: 'from must be a valid YYYY-MM-DD date',
  to: 'to must be a valid YYYY-MM-DD date',
};

const listQuerySchema = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
  afterSeq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const attachmentListSchema = z.object({
  type: z.enum(['image', 'video', 'file', 'audio', 'all']).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  senderId: z.coerce.number().int().positive().optional(),
  from: searchDateSchema.optional(),
  to: searchDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(ROOM_ATTACHMENT_PAGE_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// The archive takes the same narrowing as the gallery but no paging: one zip
// always carries the whole filtered set.
const attachmentArchiveSchema = z.object({
  type: z.enum(['image', 'video', 'file', 'audio', 'all']).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  senderId: z.coerce.number().int().positive().optional(),
  from: searchDateSchema.optional(),
  to: searchDateSchema.optional(),
});

const ATTACHMENT_FIELD_MESSAGES: Record<string, string> = {
  type: 'type must be image, video, file, audio or all',
  q: 'q must be 1-100 characters',
  senderId: 'senderId must be a positive integer',
  from: 'from must be a valid YYYY-MM-DD date',
  to: 'to must be a valid YYYY-MM-DD date',
  limit: `limit must be an integer between 1 and ${ROOM_ATTACHMENT_PAGE_LIMIT}`,
  offset: 'offset must be a non-negative integer',
};

const editMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
});

const reactionSchema = z.object({
  emoji: z.string().trim().min(1).max(16),
});

const createPollSchema = z.object({
  question: z.string().trim().min(1).max(POLL_QUESTION_MAX),
  options: z
    .array(z.string().trim().min(1).max(POLL_OPTION_MAX))
    .min(POLL_OPTIONS_MIN)
    .max(POLL_OPTIONS_MAX),
  multiple: z.boolean().optional(),
  anonymous: z.boolean().optional(),
  // 1 minute .. 7 days, matching the documented API range.
  closesInMinutes: z.number().int().min(1).max(10080).optional(),
});

const pollVoteSchema = z.object({
  optionIds: z.array(z.number().int().positive()).max(10),
});

const reportSchema = z.object({
  reason: z.string().trim().min(1).max(REPORT_REASON_MAX),
});

const translateSchema = z.object({
  targetLang: z.string().trim().min(1).max(TRANSLATE_TARGET_LANG_MAX).optional(),
});

const bulkDeleteSchema = z.object({
  seqs: z.array(z.number().int().positive()).min(1).max(50),
});

const pinsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// The time window itself (>=1s and <=30d ahead) is checked by `parseSendAt`,
// which owns the rule; zod only rejects a non-ISO string up front.
const scheduleMessageSchema = z.object({
  content: z.string().trim().min(1).max(SCHEDULED_CONTENT_MAX),
  sendAt: z.string().trim().datetime({ offset: true }),
});

// PATCH edits either half of a queued message; at least one field is required.
const updateScheduledSchema = z
  .object({
    content: z.string().trim().min(1).max(SCHEDULED_CONTENT_MAX).optional(),
    sendAt: z.string().trim().datetime({ offset: true }).optional(),
  })
  .refine((value) => value.content !== undefined || value.sendAt !== undefined);

// Public-room discovery: q is optional, limit/offset page newest-first.
const publicRoomsQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const forwardSchema = z.object({
  sourceRoomId: z.number().int().positive(),
  sourceSeq: z.number().int().positive(),
});

// The batch is bounded by the per-member message rate limit (10 per 10s), so
// a full batch spends one window's worth of prechecks and cannot starve the
// copies it just charged for.
const FORWARD_BULK_MAX = 10;

const forwardBulkSchema = z.object({
  sourceRoomId: z.number().int().positive(),
  sourceSeqs: z.array(z.number().int().positive()).min(1).max(FORWARD_BULK_MAX),
});

const memberRoleSchema = z.object({
  role: z.enum(['admin', 'member']),
});

const memberRolesSchema = z.object({
  userIds: z.array(z.number().int().positive()).min(1).max(100),
  role: z.enum(['admin', 'member']),
});

const removeMembersSchema = z.object({
  userIds: z.array(z.number().int().positive()).min(1).max(100),
});

const inviteMemberSchema = z.object({
  username: z.string().trim().min(3).max(32),
});

const inviteMembersSchema = z.object({
  usernames: z.array(z.string().max(64)).min(1).max(BULK_INVITE_MAX),
});

const transferSchema = z.object({
  userId: z.number().int().positive(),
});

const exportQuerySchema = z.object({
  format: z.enum(['markdown', 'json', 'zip']),
});

// Drafts are free text, so no trimming: the user's spacing is part of the
// draft, and only the exact empty string clears the row.
const draftSchema = z.object({
  content: z.string().max(DRAFT_CONTENT_MAX),
});

function currentUser(req: Request): AuthUser {
  return req.user as AuthUser;
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function parseRoomId(req: Request): number {
  const roomId = Number(req.params.id);
  if (!Number.isInteger(roomId) || roomId <= 0) {
    throw badRequest('INVALID_ROOM_ID', 'Invalid room id');
  }
  return roomId;
}

function parseSeq(req: Request): number {
  const seq = Number(req.params.seq);
  if (!Number.isInteger(seq) || seq <= 0) {
    throw badRequest('INVALID_SEQ', 'Invalid message seq');
  }
  return seq;
}

function parseUserId(req: Request): number {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw badRequest('INVALID_USER_ID', 'Invalid user id');
  }
  return userId;
}

function parseAttachmentId(req: Request): number {
  const attachmentId = Number(req.params.attachmentId);
  if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
    throw badRequest('INVALID_ATTACHMENT_ID', 'Invalid attachment id');
  }
  return attachmentId;
}

/** Upload cap and the only MIME types a room may store. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_MIME: Readonly<Record<string, true>> = {
  'image/png': true,
  'image/jpeg': true,
  'image/gif': true,
  'image/webp': true,
  'video/mp4': true,
  'video/webm': true,
  'application/pdf': true,
  'text/plain': true,
  'application/zip': true,
  'audio/mpeg': true,
  'audio/ogg': true,
  'audio/webm': true,
};

/**
 * Stores uploads under a random name. The original filename is only ever a
 * display string, so no client-controlled byte reaches the filesystem path.
 */
const attachmentStorage = multer.diskStorage({
  destination(_req, _file, callback) {
    fs.mkdir(config.uploadDir, { recursive: true }, (error) => {
      callback(error, config.uploadDir);
    });
  },
  filename(_req, _file, callback) {
    callback(null, randomBytes(24).toString('hex'));
  },
});

const attachmentUploader = multer({
  storage: attachmentStorage,
  limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1, fields: 8 },
  fileFilter(_req, file, callback) {
    // Ignore any `; charset=...` parameter and casing: the stored value is
    // always one of the canonical allow-list entries.
    const mime = file.mimetype.split(';')[0].trim().toLowerCase();
    if (ALLOWED_ATTACHMENT_MIME[mime] !== true) {
      callback(
        new ApiError(
          400,
          'ATTACHMENT_TYPE_NOT_ALLOWED',
          `Unsupported file type: ${file.mimetype}`,
        ),
      );
      return;
    }
    file.mimetype = mime;
    callback(null, true);
  },
});

/**
 * Runs multer and translates its errors into the API envelope. Multer removes
 * its own accepted files on limit/filter aborts; the explicit unlink covers a
 * partial write when the storage layer itself failed halfway.
 */
function uploadAttachment(req: Request, res: Response, next: NextFunction): void {
  attachmentUploader.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    const partial = req.file;
    if (partial?.path) {
      void fs.promises.unlink(partial.path).catch(() => {
        // The file may already be gone (multer cleans up limit/filter aborts).
      });
    }
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        next(
          new ApiError(
            400,
            'ATTACHMENT_TOO_LARGE',
            `File must be at most ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB`,
          ),
        );
        return;
      }
      next(new ApiError(400, 'ATTACHMENT_INVALID', error.message));
      return;
    }
    next(error);
  });
}

/**
 * Busboy hands multipart filenames over as latin1 bytes. Re-decode when the
 * result is valid UTF-8 (the browser case), strip any path components and
 * control characters, and cap the display name to fit the column.
 */
function normalizeOriginalFilename(original: string): string {
  let name = original;
  const decoded = Buffer.from(original, 'latin1').toString('utf8');
  if (!decoded.includes('\uFFFD')) {
    name = decoded;
  }
  name = (name.split(/[/\\]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length === 0) {
    return 'file';
  }
  const chars = Array.from(name);
  return chars.length > 200 ? chars.slice(0, 200).join('') : name;
}

function contentDispositionValue(disposition: 'inline' | 'attachment', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Cap on the filename part of an archive entry; the seq/id prefix is extra. */
const ARCHIVE_ENTRY_NAME_MAX = 120;

/**
 * Entry name inside the media archive: `seq-attachmentId-filename`. The
 * attachment id is unique, so two files can never collide even when they share
 * a display name. Separators, `..` runs, control characters and leading dots
 * are replaced so no extractor can read the entry as a path.
 */
function archiveEntryName(entry: RoomArchiveEntry): string {
  const cleaned = entry.filename
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '')
    .replace(/_+/g, '_')
    .trim();
  const chars = Array.from(cleaned.length > 0 ? cleaned : 'file');
  const name =
    chars.length > ARCHIVE_ENTRY_NAME_MAX
      ? chars.slice(0, ARCHIVE_ENTRY_NAME_MAX).join('')
      : chars.join('');
  return `${entry.messageSeq}-${entry.id}-${name}`;
}

/** `20261101T132530Z`: filesystem-safe, sortable and time-zone free. */
function archiveStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Files and source bytes one room export zip may carry. */
export const EXPORT_MAX_ATTACHMENTS = 100;
export const EXPORT_MAX_BYTES = 200 * 1024 * 1024;

// Global admin, room owner, or a room_members.role='admin' moderator.
async function isModerator(roomId: number, user: AuthUser): Promise<boolean> {
  if (user.role === 'admin') {
    return true;
  }
  const ownerId = await getRoomOwnerId(roomId);
  if (ownerId === user.id) {
    return true;
  }
  return (await getMemberRole(roomId, user.id)) === 'admin';
}

async function assertModerator(roomId: number, user: AuthUser): Promise<void> {
  if (!(await isModerator(roomId, user))) {
    throw forbidden('ROOM_OWNER_REQUIRED', 'Only a room moderator can do this');
  }
}

interface ExportRoom {
  id: number;
  name: string;
  topic: string;
  announcement: string;
}

/** `1536` → `1.5 KB`, mirroring the size column of the client's file list. */
function formatAttachmentSize(bytes: number): string {
  const size = Number.isFinite(bytes) && bytes > 0 ? Math.trunc(bytes) : 0;
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Readable transcript: room header, then one `[time] sender: text` line per
 * message followed by the metadata that belongs to it — forward origin, edit
 * stamp, files, poll tally and reactions. A withdrawn message renders as its
 * marker alone: its body, attachments, poll and reactions stay hidden, just
 * as they are in the room itself. Voter identities are never written, so an
 * anonymous ballot cannot leak through the transcript.
 */
function toMarkdownExport(room: ExportRoom, messages: MessageDTO[]): string {
  const lines = [`# ${room.name}`, ''];
  if (room.topic) {
    lines.push(`**话题**: ${room.topic}`);
  }
  if (room.announcement) {
    lines.push(`**公告**: ${room.announcement}`);
  }
  if (room.topic || room.announcement) {
    lines.push('');
  }
  for (const message of messages) {
    if (message.deleted) {
      lines.push(`[${message.createdAt}] ${message.senderName}: [消息已撤回]`);
      continue;
    }
    // The marker records that the body was edited; the revision history (and
    // therefore the replaced text) is deliberately not part of the export.
    const edited = message.editedAt ? '（已编辑）' : '';
    lines.push(`[${message.createdAt}] ${message.senderName}: ${message.content}${edited}`);
    if (message.forwardedFrom) {
      lines.push(
        `> 转发自 ${message.forwardedFrom.roomName} · ${message.forwardedFrom.senderName}`,
      );
    }
    for (const attachment of message.attachments) {
      lines.push(
        `- 附件: ${attachment.filename} (${attachment.mime}, ${formatAttachmentSize(attachment.size)})`,
      );
    }
    const poll = message.poll;
    if (poll) {
      const kind = [poll.multiple ? '多选' : '单选'];
      if (poll.anonymous) {
        kind.push('匿名');
      }
      if (poll.closed) {
        kind.push('已截止');
      } else if (poll.closesAt) {
        kind.push(`截止 ${poll.closesAt}`);
      }
      lines.push(`投票: ${kind.join(' · ')}`);
      for (const option of poll.options) {
        lines.push(`- ${option.label}: ${option.count} 票`);
      }
    }
    if (message.reactions.length > 0) {
      const tally = message.reactions.map((reaction) => `${reaction.emoji} ${reaction.count}`);
      lines.push(`反应: ${tally.join(', ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// RFC 4180 quoting plus spreadsheet formula neutralization: Excel/Sheets
// execute cells starting with = + - @ (or a tab/CR) even when quoted, so
// prepend an apostrophe before quoting. Option labels and display names are
// user data, so every exported cell goes through here.
function csvCell(value: string | number): string {
  const raw = String(value);
  const text = /^\s*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await listRooms(currentUser(req).id));
  }),
);

// Declared before the /:id routes so "public" is never parsed as a room id.
// Searches public rooms the caller has not joined yet; paged newest-first.
router.get(
  '/public',
  asyncHandler(async (req, res) => {
    const parsed = publicRoomsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'Invalid search parameters');
    }
    res.json(await searchPublicRooms(currentUser(req).id, parsed.data));
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = createRoomSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const user = currentUser(req);
    if (!(await checkRate(`room:create:${user.id}`, 5, 60_000))) {
      throw tooMany('Too many rooms created, try again later');
    }
    const room = await createRoom(user.id, parsed.data);
    res.status(201).json({ room });
  }),
);

// Must stay above the /:id routes: "read-all" is a fixed path, not a room id.
// Updates only the caller's membership rows, one per joined room.
router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const updated = await markAllRoomsRead(currentUser(req).id);
    res.json({ updated });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const parsed = updateRoomSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    if (
      parsed.data.name === undefined &&
      parsed.data.topic === undefined &&
      parsed.data.announcement === undefined &&
      parsed.data.slowModeSeconds === undefined &&
      parsed.data.retentionDays === undefined
    ) {
      throw badRequest('INVALID_INPUT', 'Nothing to update');
    }
    const user = currentUser(req);
    const roomId = parseRoomId(req);
    const room = await updateRoom(roomId, user.id, user.role, parsed.data);
    getSocketServer()?.to(roomKey(roomId)).emit('room:updated', {
      roomId,
      name: room.name,
      topic: room.topic,
      announcement: room.announcement,
      slowModeSeconds: room.slowModeSeconds,
      retentionDays: room.retentionDays,
    });
    res.json({ room });
  }),
);

// Read-only count of what the retention sweep would delete, so the settings
// dialog can warn before the policy is saved. `?days=` previews a draft value.
router.get(
  '/:id/retention/preview',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const parsed = retentionPreviewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'days must be an integer between 0 and 3650');
    }
    const user = currentUser(req);
    res.json(await previewRoomRetention(roomId, user.id, user.role, parsed.data.days));
  }),
);

router.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const parsed = readSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'seq must be a non-negative integer');
    }
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    await updateReadCursor(roomId, user.id, parsed.data.seq);
    getSocketServer()?.to(roomKey(roomId)).emit('read:updated', {
      roomId,
      userId: user.id,
      seq: parsed.data.seq,
    });
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/join',
  asyncHandler(async (req, res) => {
    const parsed = joinSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'Invalid invite code');
    }
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    // Members re-join on every openRoom and must never consume quota (all
    // local-demo/NAT clients share one IP when TRUST_PROXY is off).
    if (!(await isRoomMember(roomId, user.id))) {
      // Per user+ip+room: blocks invite-code brute force, including
      // multi-account rotation from one IP, without cross-user interference.
      if (!(await checkRate(`room:join:${user.id}:${clientIp(req)}:${roomId}`, 5, 60_000))) {
        throw tooMany('Too many join attempts for this room, try again later');
      }
    }
    const room = await joinRoom(user.id, roomId, parsed.data.inviteCode);
    res.json({ room });
  }),
);

// Owner (or global admin) mints a new invite code for a private room; the
// previous code stops working at once.
router.post(
  '/:id/invite-code/rotate',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    res.json({ inviteCode: await rotateInviteCode(roomId, user.id, user.role) });
  }),
);

// Private rooms: any signed-in non-member may ask the owner for admission.
router.post(
  '/:id/request',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    if (!(await checkRate(`room:request:${user.id}:${roomId}`, 5, 60_000))) {
      throw tooMany('Too many join requests for this room, try again later');
    }
    res.json({ request: await requestJoin(roomId, user) });
  }),
);

router.get(
  '/:id/requests',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    await assertModerator(roomId, currentUser(req));
    res.json({ requests: await listJoinRequests(roomId) });
  }),
);

router.post(
  '/:id/requests/bulk',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await assertModerator(roomId, user);
    const parsed = joinRequestBulkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        "userIds must be 1-100 user ids and action must be 'approve' or 'reject'",
      );
    }
    const result = await decideJoinRequestsBulk(
      roomId,
      parsed.data.userIds,
      parsed.data.action,
      user,
    );
    // One roster broadcast for the batch, never one per decided request.
    getSocketServer()?.to(roomKey(roomId)).emit('members:changed', { roomId });
    res.json(result);
  }),
);

router.post(
  '/:id/requests/:userId/approve',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const applicantId = parseUserId(req);
    const user = currentUser(req);
    await assertModerator(roomId, user);
    const member = await approveJoinRequest(roomId, applicantId, user);
    getSocketServer()?.to(roomKey(roomId)).emit('members:changed', { roomId });
    res.json({ member });
  }),
);

router.post(
  '/:id/requests/:userId/reject',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const applicantId = parseUserId(req);
    const user = currentUser(req);
    await assertModerator(roomId, user);
    await rejectJoinRequest(roomId, applicantId, user);
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/leave',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await leaveRoom(user.id, roomId);
    const io = getSocketServer();
    if (io) {
      await evictUserFromRoom(io, roomId, user.id);
    }
    res.json({ ok: true });
  }),
);

// Per-user mute: stored on the membership row and never broadcast.
router.post(
  '/:id/mute',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const parsed = muteSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'muted must be a boolean');
    }
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const muted = await setRoomMuted(roomId, user.id, parsed.data.muted);
    res.json({ muted });
  }),
);

// Per-user favourite: also stored on the membership row, never broadcast.
router.post(
  '/:id/favorite',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const parsed = favoriteSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'favorite must be a boolean');
    }
    const user = currentUser(req);
    const favorite = await setRoomFavorite(roomId, user.id, parsed.data.favorite);
    res.json({ favorite });
  }),
);

// Per-user sidebar group: stored on the membership row, never broadcast.
router.post(
  '/:id/group',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const parsed = groupSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'group must be a string of at most 32 characters');
    }
    const user = currentUser(req);
    const group = await setRoomGroup(roomId, user.id, parsed.data.group);
    res.json({ group });
  }),
);

// Per-user archive flag: also stored on the membership row, never broadcast.
router.post(
  '/:id/archive',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const parsed = archiveSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'archived must be a boolean');
    }
    const user = currentUser(req);
    const archived = await setRoomArchived(roomId, user.id, parsed.data.archived);
    res.json({ archived });
  }),
);

// Moderators invite an existing active user by username; the invitee gets a
// room_invite notification (no message attached) and the room sees the change.
router.post(
  '/:id/members',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const parsed = inviteMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'username must be 3-32 characters');
    }
    const user = currentUser(req);
    if (!(await checkRate(`member-invite:${user.id}:${roomId}`, 30, 60_000))) {
      throw tooMany('Too many invites, try again later');
    }
    const member = await inviteMember(roomId, user.id, user.role, parsed.data.username);
    getSocketServer()?.to(roomKey(roomId)).emit('members:changed', { roomId });
    const roomName = await getRoomName(roomId);
    await createNotification({
      userId: member.userId,
      type: 'room_invite',
      roomId,
      actorId: user.id,
      detail: `${user.displayName} 邀请你加入「${roomName}」`,
    });
    res.json({ member });
  }),
);

// Bulk invite: same rights as the single-member route and all-or-nothing, so
// the room never sees a half-applied batch. After the commit it broadcasts the
// roster change once and notifies every invitee individually.
router.post(
  '/:id/members/bulk',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const parsed = inviteMembersSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', `usernames must be 1-${BULK_INVITE_MAX} usernames`);
    }
    const user = currentUser(req);
    if (!(await checkRate(`member-invite:${user.id}:${roomId}`, 30, 60_000))) {
      throw tooMany('Too many invites, try again later');
    }
    const result = await inviteMembers(roomId, user.id, user.role, parsed.data.usernames);
    getSocketServer()?.to(roomKey(roomId)).emit('members:changed', { roomId });
    const roomName = await getRoomName(roomId);
    for (const userId of result.userIds) {
      await createNotification({
        userId,
        type: 'room_invite',
        roomId,
        actorId: user.id,
        detail: `${user.displayName} 邀请你加入「${roomName}」`,
      });
    }
    res.json({ invited: result.invited });
  }),
);

router.get(
  '/:id/members',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    await assertMember(roomId, currentUser(req).id);
    res.json({ members: await listMembers(roomId) });
  }),
);

// Bulk role change: same rights as the single-member route and all-or-nothing,
// so the room never sees a half-applied batch.
router.patch(
  '/:id/members/roles',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const parsed = memberRolesSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        "userIds must be 1-100 user ids and role must be 'admin' or 'member'",
      );
    }
    const result = await setMemberRoles(
      roomId,
      user.id,
      user.role,
      parsed.data.userIds,
      parsed.data.role,
    );
    getSocketServer()?.to(roomKey(roomId)).emit('members:changed', { roomId });
    res.json(result);
  }),
);

router.patch(
  '/:id/members/:userId',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const targetId = parseUserId(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const parsed = memberRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_ROLE', "role must be 'admin' or 'member'");
    }
    const member = await setMemberRole(roomId, user.id, user.role, targetId, parsed.data.role);
    getSocketServer()?.to(roomKey(roomId)).emit('members:changed', { roomId });
    res.json({ member });
  }),
);

// Bulk removal: owner or global admin only, all-or-nothing, and every removed
// member is evicted from the room's live sockets before the single broadcast.
// Declared before the single-member route so "members" is never a user id.
router.delete(
  '/:id/members',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    if (!(await checkRate(`member-remove:${user.id}:${roomId}`, 30, 60_000))) {
      throw tooMany('Too many removals, try again later');
    }
    const parsed = removeMembersSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'userIds must be 1-100 user ids');
    }
    const result = await removeMembers(roomId, user.id, user.role, parsed.data.userIds);
    const io = getSocketServer();
    if (io) {
      for (const targetId of new Set(parsed.data.userIds)) {
        await evictUserFromRoom(io, roomId, targetId);
      }
      io.to(roomKey(roomId)).emit('members:changed', { roomId });
    }
    res.json(result);
  }),
);

router.delete(
  '/:id/members/:userId',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const targetId = parseUserId(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    if (!(await checkRate(`member-remove:${user.id}:${roomId}`, 30, 60_000))) {
      throw tooMany('Too many removals, try again later');
    }
    await removeMember(roomId, user.id, user.role, targetId);
    const io = getSocketServer();
    if (io) {
      await evictUserFromRoom(io, roomId, targetId);
      io.to(roomKey(roomId)).emit('members:changed', { roomId });
    }
    res.json({ ok: true });
  }),
);

// Ownership handover: the current owner names another human member as owner.
router.post(
  '/:id/transfer',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    const parsed = transferSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_TARGET', 'userId must be a positive integer');
    }
    await assertMember(roomId, user.id);
    const { ownerId, member } = await transferOwnership(roomId, user.id, parsed.data.userId);
    const io = getSocketServer();
    if (io) {
      io.to(roomKey(roomId)).emit('members:changed', { roomId });
      io.to(roomKey(roomId)).emit('room:owner', { roomId, ownerId });
    }
    res.json({ ownerId, member });
  }),
);

router.get(
  '/:id/search',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    if (!(await checkRate(`room-search:${user.id}`, 30, 60_000))) {
      throw tooMany('Too many searches, try again later');
    }
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? '');
      throw badRequest(
        'INVALID_INPUT',
        SEARCH_FIELD_MESSAGES[field] ?? 'Invalid search parameters',
      );
    }
    const { q, limit, offset, senderId, from, to } = parsed.data;
    if (from && to && from > to) {
      throw badRequest('INVALID_INPUT', 'from must not be after to');
    }
    const { messages, hasMore } = await searchMessagesPage(roomId, q, limit ?? 20, offset ?? 0, {
      senderId,
      from,
      to,
    });
    res.json({ messages, hasMore });
  }),
);

// Downloadable transcript of the whole room. Members only: the file holds every
// message in the room, which is more than a public preview should expose.
router.get(
  '/:id/export',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    // An export walks every message in the room and renders it, so it is far
    // more expensive than a page read; five per ten minutes is plenty.
    if (!(await checkRate(`room-export:${user.id}:${roomId}`, 5, 10 * 60_000))) {
      throw tooMany('Too many exports, try again later');
    }
    const parsed = exportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest('INVALID_FORMAT', "format must be 'markdown', 'json' or 'zip'");
    }
    const summary = await getRoomSummary(roomId, user.id);
    const room: ExportRoom = {
      id: summary.id,
      name: summary.name,
      topic: summary.topic,
      announcement: summary.announcement,
    };
    const messages = await listMessagesForExport(roomId);
    const format = parsed.data.format;
    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="room-${roomId}.json"`);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.send(JSON.stringify({ room, messages }));
      return;
    }
    // The JSON export keeps its existing shape, so the tally is loaded only
    // for the transcript, where it is rendered next to each message.
    const markdown = toMarkdownExport(room, await attachReactions(messages));
    if (format === 'markdown') {
      res.setHeader('Content-Disposition', `attachment; filename="room-${roomId}.md"`);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(markdown);
      return;
    }

    // ZIP: the transcript above plus the files its live messages carry. The
    // caps mirror the media archive (100 files, 200 MiB of source bytes) and
    // are checked against the rows before any disk access, so an oversized
    // room is refused without stat-ing a single file. A room with no
    // attachments still exports: the zip then holds `room.md` alone.
    const attachments = await listExportAttachments(
      roomId,
      messages[messages.length - 1]?.seq ?? 0,
    );
    if (attachments.length > EXPORT_MAX_ATTACHMENTS) {
      throw new ApiError(
        413,
        'EXPORT_TOO_LARGE',
        `The exported messages carry ${attachments.length} attachments, ` +
          `over the ${EXPORT_MAX_ATTACHMENTS}-file export limit`,
      );
    }
    const totalBytes = attachments.reduce((sum, entry) => sum + entry.size, 0);
    if (totalBytes > EXPORT_MAX_BYTES) {
      throw new ApiError(
        413,
        'EXPORT_TOO_LARGE',
        `The exported attachments add up to ${formatMiB(totalBytes)} MiB, over the ` +
          `${formatMiB(EXPORT_MAX_BYTES)} MiB export limit`,
      );
    }

    const files: Array<{ name: string; path: string }> = [];
    let skipped = 0;
    for (const entry of attachments) {
      const absolute = resolveAttachmentPath(entry.storedName);
      if (!absolute) {
        // A stored name that would leave UPLOAD_DIR means a corrupt row; one
        // bad row must not cost the caller every other file.
        skipped += 1;
        continue;
      }
      try {
        if (!(await fs.promises.stat(absolute)).isFile()) {
          skipped += 1;
          continue;
        }
      } catch {
        // The row outlived its file (manual cleanup, lost volume): skip it
        // and report the count instead of failing the whole export.
        skipped += 1;
        continue;
      }
      files.push({ name: `attachments/${archiveEntryName(entry)}`, path: absolute });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="room-${roomId}.zip"`);
    // Room files are private; never let a proxy cache a partial or full zip.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Files dropped above are invisible in the zip; surface the count so a
    // partial export is explainable after the fact.
    res.setHeader('X-Export-Skipped', String(skipped));

    // Streamed, never buffered: the transcript is one string, and each file
    // is appended as a read stream, so the process holds at most a chunk of
    // one attachment. Once the first byte is out the status line is spent, so
    // a mid-stream failure destroys the connection rather than leaving a
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
      logger.warn({ err: error, roomId }, 'room export aborted mid-stream');
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
    archive.append(markdown, { name: 'room.md' });
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

// The caller's own draft for this room. Private by construction: the query is
// scoped to (user, room), so another member's draft is never addressable.
router.get(
  '/:id/draft',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    res.json({ draft: await getDraft(user.id, roomId) });
  }),
);

// Last write wins. An empty body clears the row and answers `{ draft: null }`;
// saving is capped per user (not per room) so switching rooms cannot multiply
// the debounce traffic a single client can generate.
router.put(
  '/:id/draft',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const parsed = draftSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        `content must be a string of at most ${DRAFT_CONTENT_MAX} characters`,
      );
    }
    if (!(await checkRate(`room:draft:${user.id}`, 60, 60_000))) {
      throw tooMany('Too many draft saves, try again later');
    }
    res.json({ draft: await saveDraft(user.id, roomId, parsed.data.content) });
  }),
);

router.get(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    await assertMember(roomId, currentUser(req).id);
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'Invalid pagination parameters');
    }
    const result = await listMessages(roomId, parsed.data);
    res.json(result);
  }),
);

// Room attachment upload. Membership is checked before multer runs, so a
// stranger never causes a byte to be written. The file lands under a random
// name; the DB row is the only pointer, and any failure below removes the file.
router.post(
  '/:id/attachments',
  asyncHandler(async (req, _res, next) => {
    const user = currentUser(req);
    await assertMember(parseRoomId(req), user.id);
    // Counted before multer runs: a rejected request must not write a byte.
    if (!(await checkRate(`attachment-upload:${user.id}`, 30, 60_000))) {
      throw tooMany('Too many uploads, try again later');
    }
    next();
  }),
  uploadAttachment,
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    const file = req.file;
    if (!file) {
      throw badRequest('ATTACHMENT_REQUIRED', 'A multipart file field named "file" is required');
    }
    const filename = normalizeOriginalFilename(file.originalname);
    const quotaBytes = config.attachmentUserQuotaBytes;
    const maxFiles = config.attachmentUserMaxFiles;
    let attachmentId: number;
    try {
      // A zero-byte file is never useful and still costs a row plus an inode;
      // rejecting it here keeps the quota accounting honest.
      if (file.size === 0) {
        throw badRequest('ATTACHMENT_EMPTY', 'Attachment must not be empty');
      }
      attachmentId = await withTransaction(async (conn) => {
        // Locking the uploader's row serialises concurrent uploads from the
        // same user, so two requests cannot both pass the COUNT/SUM checks.
        await conn.execute<RowDataPacket[]>('SELECT id FROM users WHERE id = ? FOR UPDATE', [
          user.id,
        ]);
        // COUNT/SUM cover unbound and withdrawn attachments too: they still
        // take up disk space, so reclaiming quota by deleting a message is not
        // possible.
        const [usage] = await conn.execute<RowDataPacket[]>(
          `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS used
           FROM message_attachments WHERE uploader_id = ?`,
          [user.id],
        );
        const files = Number(usage[0]?.files ?? 0);
        if (files + 1 > maxFiles) {
          throw new ApiError(
            413,
            'ATTACHMENT_QUOTA_EXCEEDED',
            `Attachment quota exceeded: ${files} of ${maxFiles} files used ` +
              '(this upload adds 1)',
          );
        }
        if (quotaBytes > 0) {
          const used = Number(usage[0]?.used ?? 0);
          if (used + file.size > quotaBytes) {
            throw new ApiError(
              413,
              'ATTACHMENT_QUOTA_EXCEEDED',
              `Attachment quota exceeded: ${formatMiB(used)} MiB used of ` +
                `${formatMiB(quotaBytes)} MiB (this upload is ${formatMiB(file.size)} MiB)`,
            );
          }
        }
        const [inserted] = await conn.execute<ResultSetHeader>(
          `INSERT INTO message_attachments
             (room_id, uploader_id, filename, stored_name, mime, size)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [roomId, user.id, filename, file.filename, file.mimetype, file.size],
        );
        return inserted.insertId;
      });
    } catch (error) {
      // No row references the file now, so leaving it behind would only leak
      // disk space (quota rejection included).
      await fs.promises.unlink(file.path).catch(() => {
        // Best effort: the original error is what the client should see.
      });
      throw error;
    }
    res.status(201).json({
      attachment: {
        id: attachmentId,
        filename,
        mime: file.mimetype,
        size: file.size,
        url: attachmentUrl(roomId, attachmentId),
      },
    });
  }),
);

// Room media library: the attachments carried by live messages, newest first.
// `type` buckets them (image / video / audio / everything else), `q` matches
// the file name literally, `senderId` and the `from`/`to` UTC days narrow by
// the carrying message, and offset pagination walks the whole set. Non-members
// get 403; malformed filters get 400.
router.get(
  '/:id/attachments',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    await assertMember(roomId, currentUser(req).id);
    const parsed = attachmentListSchema.safeParse(req.query);
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? '');
      throw badRequest(
        'INVALID_INPUT',
        ATTACHMENT_FIELD_MESSAGES[field] ?? 'Invalid media filters',
      );
    }
    const { from, to } = parsed.data;
    if (from && to && from > to) {
      throw badRequest('INVALID_INPUT', 'from must not be after to');
    }
    res.json(await listRoomAttachments(roomId, parsed.data));
  }),
);

// ZIP of every file the media filters match. Visibility is the gallery's own
// WHERE (see `selectRoomArchive`), and the selection is capped — 100 files and
// 200 MiB of source bytes — so one request cannot pin the process on disk
// reads. Each file is streamed into the archive as it is reached: at most a
// chunk of it is ever in memory. Once the first byte is out the status line is
// spent, so a read failure destroys the connection instead of leaving a
// truncated zip that looks complete.
router.get(
  '/:id/attachments/archive',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    await assertMember(roomId, currentUser(req).id);
    const parsed = attachmentArchiveSchema.safeParse(req.query);
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? '');
      throw badRequest(
        'INVALID_INPUT',
        ATTACHMENT_FIELD_MESSAGES[field] ?? 'Invalid media filters',
      );
    }
    const { from, to } = parsed.data;
    if (from && to && from > to) {
      throw badRequest('INVALID_INPUT', 'from must not be after to');
    }

    const selection = await selectRoomArchive(roomId, parsed.data);
    if (selection.overflow) {
      throw new ApiError(
        413,
        'ARCHIVE_TOO_LARGE',
        `The filtered set has more than ${ROOM_ARCHIVE_MAX_FILES} files ` +
          `(limit ${ROOM_ARCHIVE_MAX_FILES}); narrow the filters`,
      );
    }

    const files: Array<{ name: string; path: string }> = [];
    let skipped = 0;
    let totalBytes = 0;
    for (const entry of selection.entries) {
      const absolute = resolveAttachmentPath(entry.storedName);
      if (!absolute) {
        // A stored name that would leave UPLOAD_DIR means a corrupt row; one
        // bad row must not cost the caller every other file.
        skipped += 1;
        continue;
      }
      totalBytes += entry.size;
      files.push({ name: archiveEntryName(entry), path: absolute });
    }
    if (totalBytes > ROOM_ARCHIVE_MAX_BYTES) {
      throw new ApiError(
        413,
        'ARCHIVE_TOO_LARGE',
        `The filtered files add up to ${formatMiB(totalBytes)} MiB, over the ` +
          `${formatMiB(ROOM_ARCHIVE_MAX_BYTES)} MiB archive limit; narrow the filters`,
      );
    }
    if (files.length === 0) {
      throw notFound('ARCHIVE_EMPTY', 'No attachments match these filters');
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="room-${roomId}-media-${archiveStamp()}.zip"`,
    );
    // Room files are private; never let a proxy cache a partial or full zip.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Corrupt rows skipped above are invisible in the zip; surface the count so
    // a partial archive is explainable after the fact.
    res.setHeader('X-Archive-Skipped', String(skipped));

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
      logger.warn({ err: error, roomId }, 'media archive aborted mid-stream');
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

// Attachment download. Members only, and the row must belong to the room in
// the path. An unbound upload is private to its uploader, and a withdrawn
// message hides its attachments from everyone. Images/audio render inline;
// everything else (PDF, zip, text) is forced to download so an uploaded
// document can never execute in the app's origin. `stored_name` is the only
// filesystem input.
router.get(
  '/:id/attachments/:attachmentId',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const attachmentId = parseAttachmentId(req);
    // One join decides visibility without a second query, so a non-uploader
    // cannot tell an unbound attachment apart from a missing one.
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT a.stored_name, a.filename, a.mime, a.uploader_id, a.message_id, m.deleted_at
       FROM message_attachments a
       LEFT JOIN messages m ON m.id = a.message_id
       WHERE a.id = ? AND a.room_id = ?`,
      [attachmentId, roomId],
    );
    const row = rows[0];
    if (!row) {
      throw notFound('ATTACHMENT_NOT_FOUND', 'Attachment not found');
    }
    const hidden =
      row.message_id == null
        ? Number(row.uploader_id) !== user.id
        : row.deleted_at != null;
    if (hidden) {
      throw notFound('ATTACHMENT_NOT_FOUND', 'Attachment not found');
    }
    // Stored names are random; anything with a separator or `..` is treated as
    // missing rather than resolved outside UPLOAD_DIR.
    const absolute = resolveAttachmentPath(String(row.stored_name));
    if (!absolute) {
      throw notFound('ATTACHMENT_NOT_FOUND', 'Attachment not found');
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absolute);
    } catch {
      throw notFound('ATTACHMENT_NOT_FOUND', 'Attachment not found');
    }
    if (!stat.isFile()) {
      throw notFound('ATTACHMENT_NOT_FOUND', 'Attachment not found');
    }

    const mime = String(row.mime);
    const inline =
      mime.startsWith('image/') ||
      mime.startsWith('audio/') ||
      mime.startsWith('video/');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader(
      'Content-Disposition',
      contentDispositionValue(inline ? 'inline' : 'attachment', String(row.filename)),
    );
    // Attachments are private to the room; never let a proxy cache them.
    res.setHeader('Cache-Control', 'private, no-store');

    const stream = fs.createReadStream(absolute);
    stream.on('error', () => {
      res.destroy();
    });
    res.on('close', () => {
      stream.destroy();
    });
    stream.pipe(res);
  }),
);

// Delayed send: the row is stored now and the background worker posts the real
// message once `sendAt` has passed. Nothing is broadcast until then.
router.post(
  '/:id/messages/schedule',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const parsed = scheduleMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        `content must be 1-${SCHEDULED_CONTENT_MAX} characters and sendAt an ISO 8601 timestamp`,
      );
    }
    // A queued message is still a message: it costs the sender a slow-mode
    // window and a slot in the shared per-room rate limit now, not at send time.
    await assertCanSendMessage(roomId, user.id);
    const scheduled = await scheduleMessage({
      roomId,
      senderId: user.id,
      content: parsed.data.content,
      sendAt: parseSendAt(parsed.data.sendAt),
    });
    res.status(201).json({ scheduled });
  }),
);

// The caller's own queue, earliest first; other members' schedules stay hidden.
router.get(
  '/:id/messages/scheduled',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    res.json({ messages: await listScheduled(roomId, user.id) });
  }),
);

router.delete(
  '/:id/messages/scheduled/:scheduledId',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const scheduledId = Number(req.params.scheduledId);
    if (!Number.isInteger(scheduledId) || scheduledId <= 0) {
      throw badRequest('INVALID_SCHEDULED_ID', 'Invalid scheduled message id');
    }
    await cancelScheduled(roomId, user.id, scheduledId);
    res.json({ ok: true });
  }),
);

// Edits a queued message in place. Only the owner's own pending row can move;
// the content/time rules are exactly the create route's.
router.patch(
  '/:id/messages/scheduled/:scheduledId',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const scheduledId = Number(req.params.scheduledId);
    if (!Number.isInteger(scheduledId) || scheduledId <= 0) {
      throw badRequest('INVALID_SCHEDULED_ID', 'Invalid scheduled message id');
    }
    const parsed = updateScheduledSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        `content must be 1-${SCHEDULED_CONTENT_MAX} characters, sendAt an ISO 8601 timestamp, and at least one is required`,
      );
    }
    const scheduled = await updateScheduled({
      roomId,
      senderId: user.id,
      id: scheduledId,
      content: parsed.data.content,
      sendAt: parsed.data.sendAt === undefined ? undefined : parseSendAt(parsed.data.sendAt),
    });
    res.json({ scheduled });
  }),
);

// Copies a message from another room (both rooms must be joined) into this one.
router.post(
  '/:id/forward',
  asyncHandler(async (req, res) => {
    const targetRoomId = parseRoomId(req);
    const parsed = forwardSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        'sourceRoomId and sourceSeq must be positive integers',
      );
    }
    const user = currentUser(req);
    if (parsed.data.sourceRoomId === targetRoomId) {
      throw badRequest('INVALID_TARGET', 'Cannot forward a message into its own room');
    }
    await assertMember(targetRoomId, user.id);
    await assertMember(parsed.data.sourceRoomId, user.id);
    // Forwarding posts into the target room, so it pays the same slow-mode and
    // message-rate cost as typing the message there.
    await assertCanSendMessage(targetRoomId, user.id);
    if (!(await checkRate(`forward:${user.id}`, 20, 60_000))) {
      throw tooMany('Too many forwards, try again later');
    }
    const message = await forwardMessage({
      sourceRoomId: parsed.data.sourceRoomId,
      sourceSeq: parsed.data.sourceSeq,
      targetRoomId,
      userId: user.id,
    });
    getSocketServer()?.to(roomKey(targetRoomId)).emit('message:new', {
      roomId: targetRoomId,
      message,
    });
    res.json({ message });
  }),
);

// Forwards several messages from another room in one call. All sources are
// validated before anything is written, so a single unsupported seq rejects
// the batch without partial results; the response lists copies in source-seq
// order.
router.post(
  '/:id/forward-bulk',
  asyncHandler(async (req, res) => {
    const targetRoomId = parseRoomId(req);
    const parsed = forwardBulkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        `sourceRoomId must be a positive integer and sourceSeqs 1-${FORWARD_BULK_MAX} positive integers`,
      );
    }
    const user = currentUser(req);
    if (parsed.data.sourceRoomId === targetRoomId) {
      throw badRequest('INVALID_TARGET', 'Cannot forward messages into their own room');
    }
    await assertMember(targetRoomId, user.id);
    await assertMember(parsed.data.sourceRoomId, user.id);
    // One batch costs a fixed slot rather than one per message, so a caller
    // cannot turn a batch of forwarded rows into as many hits on the
    // single-forward gate.
    if (!(await checkRate(`forward-bulk:${user.id}`, 10, 60_000))) {
      throw tooMany('Too many bulk forwards, try again later');
    }
    const seqs = [...new Set(parsed.data.sourceSeqs)];
    // Slow mode is a per-message gate, so a batch would slip several copies
    // through one window; a slow room only accepts forwards one at a time.
    if (seqs.length > 1 && (await getRoomSlowMode(targetRoomId)) > 0) {
      throw badRequest('SLOW_MODE', '慢速模式下请逐条转发');
    }
    // Charge the whole batch up front: every copy would pay the slow-mode and
    // message-rate gate on its own, so a batch that cannot afford all of them
    // must not write any of them. Each seq therefore costs one precheck, and
    // the copies below never re-run the gate.
    for (const _seq of seqs) {
      await assertCanSendMessage(targetRoomId, user.id);
    }
    const messages = await forwardMessages(
      {
        sourceRoomId: parsed.data.sourceRoomId,
        sourceSeqs: parsed.data.sourceSeqs,
        targetRoomId,
        userId: user.id,
      },
      (message) => {
        getSocketServer()?.to(roomKey(targetRoomId)).emit('message:new', {
          roomId: targetRoomId,
          message,
        });
      },
    );
    res.json({ messages });
  }),
);

router.patch(
  '/:id/messages/:seq',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const parsed = editMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'content must be 1-4000 characters');
    }
    if (!(await checkRate(`edit:${user.id}:${roomId}`, 20, 60_000))) {
      throw tooMany('Too many edits');
    }
    const message = await editMessage(roomId, seq, user.id, parsed.data.content);
    broadcastMessageUpdated(roomId, message);
    res.json({ message });
  }),
);

router.delete(
  '/:id/messages/:seq',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const canModerate = await isModerator(roomId, user);
    const message = await deleteMessage(roomId, seq, user.id, canModerate);
    broadcastMessageUpdated(roomId, message);
    res.json({ message });
  }),
);

router.get(
  '/:id/messages/:seq/edits',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    res.json(await listMessageEdits(roomId, seq));
  }),
);

// On-demand translation. Nothing is persisted: the provider response is
// returned to the caller and kept only in the process-local translation cache,
// so the message row never carries derived text.
router.post(
  '/:id/messages/:seq/translate',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    assertTranslationEnabled();
    const parsed = translateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        `targetLang must be 1-${TRANSLATE_TARGET_LANG_MAX} characters`,
      );
    }
    const message = await getMessageBySeq(roomId, seq);
    if (!message) {
      throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
    }
    if (message.deleted) {
      throw conflict('MESSAGE_DELETED', 'Message has been deleted');
    }
    const content = message.content.trim();
    if (content.length === 0) {
      throw badRequest('MESSAGE_EMPTY', 'Message has no text to translate');
    }
    if (content.length > TRANSLATE_CONTENT_MAX) {
      throw badRequest(
        'MESSAGE_TOO_LONG',
        `Message must be at most ${TRANSLATE_CONTENT_MAX} characters`,
      );
    }
    if (!(await checkRate(`translate:${user.id}`, TRANSLATE_RATE_MAX, TRANSLATE_RATE_WINDOW_MS))) {
      throw tooMany('Too many translation requests');
    }
    const targetLang = parsed.data.targetLang ?? TRANSLATE_DEFAULT_TARGET_LANG;
    const text = await translateText({
      messageId: message.id,
      editedAt: message.editedAt,
      text: content,
      targetLang,
    });
    res.json({ text, targetLang });
  }),
);

// Personal bookmark: stored per user and never broadcast, so saving a message
// stays invisible to the rest of the room. Repeating either call is a no-op.
router.post(
  '/:id/messages/:seq/save',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    res.json(await saveMessage(roomId, seq, user.id));
  }),
);

router.delete(
  '/:id/messages/:seq/save',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    res.json(await removeSaved(roomId, seq, user.id));
  }),
);

router.post(
  '/:id/messages/bulk-delete',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    await assertModerator(roomId, user);
    const parsed = bulkDeleteSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'seqs must contain 1-50 positive integers');
    }
    const seqs = [...new Set(parsed.data.seqs)];
    let deleted = 0;
    let skipped = 0;
    for (const seq of seqs) {
      const existing = await getMessageBySeq(roomId, seq);
      if (!existing || existing.deleted) {
        skipped += 1;
        continue;
      }
      // The pre-check above only classifies the message; a message removed in
      // between reads is skipped instead of failing the whole batch.
      const message = await deleteMessage(roomId, seq, user.id, true).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) {
          return null;
        }
        throw error;
      });
      if (!message) {
        skipped += 1;
        continue;
      }
      broadcastMessageUpdated(roomId, message);
      deleted += 1;
    }
    res.json({ deleted, skipped });
  }),
);

router.post(
  '/:id/messages/:seq/reactions',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const parsed = reactionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'emoji must be 1-16 characters');
    }
    if (!(await checkRate(`reaction:${user.id}:${roomId}`, 60, 60_000))) {
      throw tooMany('Too many reactions');
    }
    const message = await toggleReaction(roomId, seq, user.id, parsed.data.emoji);
    broadcastMessageUpdated(roomId, message);
    res.json({ message });
  }),
);

// A poll is a message plus fixed options. Creation goes through the same
// slow-mode and message-rate gate as a socket `message:send`, so a poll cannot
// be used to bypass the room's posting limits.
router.post(
  '/:id/polls',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const parsed = createPollSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'INVALID_INPUT',
        `question must be 1-${POLL_QUESTION_MAX} characters, options must be ` +
          `${POLL_OPTIONS_MIN}-${POLL_OPTIONS_MAX} unique items of 1-${POLL_OPTION_MAX} ` +
          'characters, and closesInMinutes must be 1-10080',
      );
    }
    await assertCanSendMessage(roomId, user.id);
    const closesInMinutes = parsed.data.closesInMinutes;
    const message = await createPoll({
      roomId,
      senderId: user.id,
      question: parsed.data.question,
      options: parsed.data.options,
      multiple: parsed.data.multiple ?? false,
      anonymous: parsed.data.anonymous ?? false,
      closesAt: closesInMinutes == null ? null : new Date(Date.now() + closesInMinutes * 60_000),
    });
    getSocketServer()?.to(roomKey(roomId)).emit('message:new', { roomId, message });
    res.status(201).json({ message });
  }),
);

// The caller's own selection. Anonymous polls hide `userIds` in the hydrated
// DTO, so the client reads its initial choice from here instead; it works the
// same way for visible polls, but there the DTO already carries the answer.
router.get(
  '/:id/messages/:seq/poll/my-votes',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const optionIds = await getPollMyVotes({ roomId, seq, userId: user.id });
    res.json({ optionIds });
  }),
);

// Replaces the caller's vote set. Every member sees the new tallies; the
// response and broadcast carry the full, hydrated poll.
router.post(
  '/:id/messages/:seq/poll/votes',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const parsed = pollVoteSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'optionIds must contain at most 10 option ids');
    }
    if (!(await checkRate(`pollvote:${user.id}:${roomId}`, 60, 60_000))) {
      throw tooMany('Too many votes');
    }
    const message = await votePoll({
      roomId,
      seq,
      userId: user.id,
      optionIds: parsed.data.optionIds,
    });
    broadcastMessageUpdated(roomId, message);
    res.json({ message });
  }),
);

// Ends a poll early for everyone. The author and room/global moderators may
// close it; the service re-checks under a row lock, so a poll that already
// expired answers 409 instead of being restamped.
router.post(
  '/:id/messages/:seq/poll/close',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const message = await closePoll({
      roomId,
      seq,
      userId: user.id,
      moderator: await isModerator(roomId, user),
    });
    broadcastMessageUpdated(roomId, message);
    res.json({ message });
  }),
);

// Downloadable tally for one poll. Members only, and anonymous polls drop the
// voters column entirely: the service never returns those names, so the file
// cannot leak a secret ballot. The filename is derived from the seq, never from
// user data, so no header needs sanitizing.
router.get(
  '/:id/messages/:seq/poll/export',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    await assertMember(roomId, currentUser(req).id);
    const poll = await getPollExport({ roomId, seq });
    const rows = [poll.anonymous ? 'option,votes' : 'option,votes,voters'];
    for (const option of poll.options) {
      const cells = [csvCell(option.label), csvCell(option.count)];
      if (!poll.anonymous) {
        cells.push(csvCell(option.voters.join('|')));
      }
      rows.push(cells.join(','));
    }
    // RFC 4180 rows end in CRLF; the trailing one terminates the last record.
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="poll-${seq}.csv"`);
    res.send(`${rows.join('\r\n')}\r\n`);
  }),
);

// Any member can flag someone else's visible message; admins review the queue.
// Reporting is private: nothing is broadcast to the room.
router.post(
  '/:id/messages/:seq/report',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', `reason must be 1-${REPORT_REASON_MAX} characters`);
    }
    const report = await createReport({
      roomId,
      seq,
      reporterId: user.id,
      reason: parsed.data.reason,
    });
    res.status(201).json({ report });
  }),
);

router.post(
  '/:id/messages/:seq/pin',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    await assertModerator(roomId, user);
    const message = await pinMessage(roomId, seq, user.id);
    broadcastMessageUpdated(roomId, message);
    res.json({ message });
  }),
);

router.delete(
  '/:id/messages/:seq/pin',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    const seq = parseSeq(req);
    const user = currentUser(req);
    await assertMember(roomId, user.id);
    await assertModerator(roomId, user);
    const message = await unpinMessage(roomId, seq);
    broadcastMessageUpdated(roomId, message);
    res.json({ message });
  }),
);

router.get(
  '/:id/pins',
  asyncHandler(async (req, res) => {
    const roomId = parseRoomId(req);
    await assertMember(roomId, currentUser(req).id);
    const parsed = pinsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'Invalid limit');
    }
    res.json({ messages: await listPinned(roomId, parsed.data.limit ?? 20) });
  }),
);

export default router;
