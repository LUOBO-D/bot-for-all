import { pool, type RowDataPacket } from '../db';
import { logger } from '../logger';
import { toIso } from '../utils';

export interface RecordAuditInput {
  actorId: number;
  action: string;
  targetType: string;
  targetId?: number | null;
  detail?: unknown;
}

export interface AuditEntry {
  id: number;
  actorId: number;
  actorName: string;
  action: string;
  targetType: string;
  targetId: number | null;
  detail: unknown;
  createdAt: string;
}

/** Optional filters shared by the audit list and its CSV export. */
export interface AuditFilter {
  /** Exact action name. */
  action?: string;
  /** Literal substring of the actor's username or display name. */
  actor?: string;
  /** Inclusive lower bound as `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive upper bound as `YYYY-MM-DD`; the day itself is included. */
  to?: string;
}

export interface ListAuditInput extends AuditFilter {
  limit?: number;
  offset?: number;
}

export interface ListAuditResult {
  entries: AuditEntry[];
  total: number;
}

/** `WHERE` clause plus bound params, ready to interpolate after the FROM list. */
export interface AuditScope {
  where: string;
  params: unknown[];
  /** True when the filter reads `users`, so count queries must join it too. */
  joinsActor: boolean;
}

const AUDIT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Rejects impossible dates such as `2026-02-30`, not just malformed ones. */
export function isAuditDate(value: string): boolean {
  if (!AUDIT_DATE_PATTERN.test(value)) {
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

/** `%`, `_` and `\` are LIKE syntax; escape them so `actor` stays literal. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Builds the audit filter clause. Timestamps are stored as UTC `TIMESTAMP`s
 * (the pool runs with `timezone: 'Z'`), so day boundaries are plain strings;
 * `to` stays inclusive by comparing against the next midnight.
 */
export function buildAuditScope(filter: AuditFilter = {}): AuditScope {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const action = filter.action?.trim();
  if (action) {
    conditions.push('a.action = ?');
    params.push(action);
  }

  const actor = filter.actor?.trim();
  if (actor) {
    // Callers must LEFT JOIN users AS u; a missing user never matches.
    conditions.push(
      "(u.username LIKE ? ESCAPE '\\\\' OR u.display_name LIKE ? ESCAPE '\\\\')",
    );
    const pattern = `%${escapeLikePattern(actor)}%`;
    params.push(pattern, pattern);
  }

  const from = filter.from?.trim();
  if (from) {
    conditions.push('a.created_at >= ?');
    params.push(`${from} 00:00:00`);
  }

  const to = filter.to?.trim();
  if (to) {
    conditions.push('a.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(`${to} 00:00:00`);
  }

  return {
    where: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
    joinsActor: Boolean(actor),
  };
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) {
    return 50;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 200);
}

function clampOffset(offset: number | undefined): number {
  if (!offset || !Number.isFinite(offset)) {
    return 0;
  }
  return Math.max(Math.trunc(offset), 0);
}

function parseDetail(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  if (typeof text !== 'string') {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    // Hand-edited or legacy rows may hold non-JSON text; surface it verbatim.
    return text;
  }
}

function mapAuditEntry(row: RowDataPacket): AuditEntry {
  return {
    id: Number(row.id),
    actorId: Number(row.actor_id),
    actorName: String(row.actor_name ?? ''),
    action: String(row.action),
    targetType: String(row.target_type),
    targetId: row.target_id === null || row.target_id === undefined
      ? null
      : Number(row.target_id),
    detail: parseDetail(row.detail),
    createdAt: toIso(row.created_at),
  };
}

/**
 * Best-effort audit write: a logging failure must never break the admin action
 * it is recording.
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    await pool.execute(
      `INSERT INTO admin_audit_log (actor_id, action, target_type, target_id, detail)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.actorId,
        input.action,
        input.targetType,
        input.targetId ?? null,
        input.detail === undefined ? null : JSON.stringify(input.detail),
      ],
    );
  } catch (error) {
    logger.error(
      { err: error, action: input.action, targetType: input.targetType },
      'failed to record admin audit entry',
    );
  }
}

export async function listAudit(input: ListAuditInput = {}): Promise<ListAuditResult> {
  const limit = clampLimit(input.limit);
  const offset = clampOffset(input.offset);
  const { where, params, joinsActor } = buildAuditScope(input);
  const countJoin = joinsActor ? ' LEFT JOIN users u ON u.id = a.actor_id' : '';

  const [countRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM admin_audit_log a${countJoin}${where}`,
    params,
  );
  const total = Number(countRows[0]?.total ?? 0);

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.id, a.actor_id, u.display_name AS actor_name, a.action,
            a.target_type, a.target_id, a.detail, a.created_at
     FROM admin_audit_log a
     LEFT JOIN users u ON u.id = a.actor_id
     ${where}
     ORDER BY a.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  return { entries: rows.map(mapAuditEntry), total };
}
