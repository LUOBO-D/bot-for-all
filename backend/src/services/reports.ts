import { pool, type ResultSetHeader, type RowDataPacket } from '../db';
import { badRequest, conflict, notFound } from '../errors';
import { isDuplicateError, toIso } from '../utils';

/** Column width of `message_reports.reason`; the route validates against it too. */
export const REPORT_REASON_MAX = 500;

/** Default and maximum page size of the admin queue. */
export const REPORT_LIST_LIMIT = 50;
export const REPORT_LIST_MAX_LIMIT = 200;

/** Hard cap on one CSV export; the header flags rows left behind beyond it. */
export const REPORT_EXPORT_LIMIT = 5000;

export type ReportStatus = 'open' | 'resolved' | 'dismissed';

/** `open` is the moderation queue; `all` keeps the handled rows visible. */
export type ReportFilter = 'open' | 'all';

/** A handled report may be re-classified, so the target status excludes `open`. */
export type ResolveStatus = Exclude<ReportStatus, 'open'>;

export interface ReportDTO {
  id: number;
  messageId: number;
  messageSeq: number;
  /**
   * Raw stored text, even for a withdrawn message: the moderator needs the
   * reported wording to judge it, which is the whole point of the report.
   */
  messageContent: string;
  messageDeleted: boolean;
  roomId: number;
  roomName: string;
  reporterId: number;
  reporterName: string;
  senderId: number;
  senderName: string;
  reason: string;
  status: ReportStatus;
  createdAt: string;
  resolvedBy: number | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
}

export interface CreateReportInput {
  roomId: number;
  seq: number;
  reporterId: number;
  reason: string;
}

export interface ListReportsInput {
  status?: ReportFilter;
  limit?: number;
  offset?: number;
}

export interface ListReportsResult {
  reports: ReportDTO[];
  total: number;
}

// One shape for the create response and both admin endpoints, so a row is
// byte-for-byte the same whether it arrives from POST, GET or PATCH.
const REPORT_SELECT = `
  SELECT r.id, r.message_id, r.room_id, r.reporter_id, r.reason, r.status,
         r.created_at, r.resolved_by, r.resolved_at,
         m.seq AS message_seq, m.content AS message_content, m.deleted_at,
         m.sender_id, rm.name AS room_name,
         COALESCE(NULLIF(reporter.display_name, ''), reporter.username) AS reporter_name,
         COALESCE(NULLIF(sender.display_name, ''), sender.username) AS sender_name,
         COALESCE(NULLIF(resolver.display_name, ''), resolver.username) AS resolver_name
  FROM message_reports r
  JOIN messages m ON m.id = r.message_id
  JOIN rooms rm ON rm.id = r.room_id
  JOIN users reporter ON reporter.id = r.reporter_id
  JOIN users sender ON sender.id = m.sender_id
  LEFT JOIN users resolver ON resolver.id = r.resolved_by
`;

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) {
    return REPORT_LIST_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), REPORT_LIST_MAX_LIMIT);
}

function clampOffset(offset: number | undefined): number {
  if (!offset || !Number.isFinite(offset)) {
    return 0;
  }
  return Math.max(Math.trunc(offset), 0);
}

function mapReport(row: RowDataPacket): ReportDTO {
  return {
    id: Number(row.id),
    messageId: Number(row.message_id),
    messageSeq: Number(row.message_seq),
    messageContent: String(row.message_content ?? ''),
    messageDeleted: row.deleted_at != null,
    roomId: Number(row.room_id),
    roomName: String(row.room_name),
    reporterId: Number(row.reporter_id),
    reporterName: String(row.reporter_name ?? ''),
    senderId: Number(row.sender_id),
    senderName: String(row.sender_name ?? ''),
    reason: String(row.reason),
    status: row.status as ReportStatus,
    createdAt: toIso(row.created_at),
    resolvedBy: row.resolved_by == null ? null : Number(row.resolved_by),
    resolvedByName: row.resolver_name == null ? null : String(row.resolver_name),
    resolvedAt: row.resolved_at == null ? null : toIso(row.resolved_at),
  };
}

async function getReportById(id: number): Promise<ReportDTO | null> {
  const [rows] = await pool.query<RowDataPacket[]>(`${REPORT_SELECT} WHERE r.id = ?`, [id]);
  const row = rows[0];
  return row ? mapReport(row) : null;
}

/**
 * Files a report on one message. The caller has already been proven to be a
 * member of `roomId`; this only validates the message itself: it must exist in
 * that room, still be visible, and not be the reporter's own message.
 */
export async function createReport(input: CreateReportInput): Promise<ReportDTO> {
  const [messageRows] = await pool.query<RowDataPacket[]>(
    'SELECT id, sender_id, deleted_at FROM messages WHERE room_id = ? AND seq = ?',
    [input.roomId, input.seq],
  );
  const message = messageRows[0];
  if (!message) {
    throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
  }
  if (message.deleted_at != null) {
    throw badRequest('MESSAGE_DELETED', 'Cannot report a withdrawn message');
  }
  if (Number(message.sender_id) === input.reporterId) {
    throw badRequest('CANNOT_REPORT_OWN', 'Cannot report your own message');
  }

  let reportId: number;
  try {
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO message_reports (message_id, room_id, reporter_id, reason)
       VALUES (?, ?, ?, ?)`,
      [Number(message.id), input.roomId, input.reporterId, input.reason],
    );
    reportId = result.insertId;
  } catch (error) {
    // The unique key on (message_id, reporter_id) is the duplicate guard, so a
    // concurrent double submit can never create two rows.
    if (isDuplicateError(error)) {
      throw conflict('REPORT_EXISTS', 'You have already reported this message');
    }
    throw error;
  }

  const report = await getReportById(reportId);
  if (!report) {
    throw new Error(`Report ${reportId} disappeared after insert`);
  }
  return report;
}

/** Newest first; `open` keeps only the queue, `all` also shows handled rows. */
export async function listReports(input: ListReportsInput = {}): Promise<ListReportsResult> {
  const limit = clampLimit(input.limit);
  const offset = clampOffset(input.offset);
  const where = input.status === 'open' ? " WHERE r.status = 'open'" : '';

  const [countRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM message_reports r${where}`,
  );
  const total = Number(countRows[0]?.total ?? 0);

  const [rows] = await pool.query<RowDataPacket[]>(
    `${REPORT_SELECT}${where} ORDER BY r.id DESC LIMIT ${limit} OFFSET ${offset}`,
  );

  return { reports: rows.map(mapReport), total };
}

export interface ReportExportResult {
  reports: ReportDTO[];
  truncated: boolean;
}

/**
 * Rows behind `GET /admin/reports/export`, newest first. The query asks for
 * one row past the cap so `truncated` is accurate without a second COUNT over
 * a potentially large table; the extra row is dropped before returning.
 */
export async function listReportsForExport(
  status: ReportFilter = 'open',
): Promise<ReportExportResult> {
  const where = status === 'open' ? " WHERE r.status = 'open'" : '';
  const [rows] = await pool.query<RowDataPacket[]>(
    `${REPORT_SELECT}${where} ORDER BY r.id DESC LIMIT ${REPORT_EXPORT_LIMIT + 1}`,
  );
  return {
    reports: rows.slice(0, REPORT_EXPORT_LIMIT).map(mapReport),
    truncated: rows.length > REPORT_EXPORT_LIMIT,
  };
}

/**
 * Marks a report handled. Re-classifying an already handled row (resolved →
 * dismissed or back) is allowed and simply overwrites the resolver and the
 * timestamp: the queue is the only source of truth for `open` items, and the
 * audit log keeps the full trail of who changed what. Returns `null` when no
 * such report exists so the route can answer 404.
 */
export async function resolveReport(
  id: number,
  status: ResolveStatus,
  actorId: number,
): Promise<ReportDTO | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM message_reports WHERE id = ?',
    [id],
  );
  if (!rows[0]) {
    return null;
  }
  await pool.execute<ResultSetHeader>(
    `UPDATE message_reports
        SET status = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP(3)
      WHERE id = ?`,
    [status, actorId, id],
  );
  return getReportById(id);
}
