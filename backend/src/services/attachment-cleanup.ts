import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { withTransaction, type RowDataPacket } from '../db';
import { logger } from '../logger';

/** Rows one sweep deletes at most; a larger backlog is left for the next tick. */
export const ATTACHMENT_CLEANUP_BATCH_SIZE = 500;

/** Mirrors the zod bounds in `config.ts`, which direct callers bypass. */
const TTL_HOURS_MIN = 1;
const TTL_HOURS_MAX = 8760;

export interface AttachmentCleanupOptions {
  /** Age threshold; defaults to `config.attachmentOrphanTtlHours`. */
  ttlHours?: number;
  /** Batch size; defaults to and never exceeds `ATTACHMENT_CLEANUP_BATCH_SIZE`. */
  limit?: number;
}

export interface AttachmentCleanupResult {
  /** Attachment rows deleted in this sweep. */
  rows: number;
  /** Files removed from disk. */
  files: number;
  /** Rows whose file was refused or could not be removed. */
  errors: number;
}

/**
 * Resolves a stored name to an absolute path under `UPLOAD_DIR`, or `null`
 * when the name could escape it. The download route uses this same function,
 * so cleanup can never unlink a file the download route would refuse to serve.
 */
export function resolveAttachmentPath(storedName: string): string | null {
  if (
    storedName.length === 0 ||
    storedName.includes('\0') ||
    storedName.includes('/') ||
    storedName.includes('\\') ||
    path.basename(storedName) !== storedName
  ) {
    return null;
  }
  const root = path.resolve(config.uploadDir);
  const absolute = path.resolve(root, storedName);
  if (!absolute.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return absolute;
}

/**
 * Deletes one batch of expired attachments.
 *
 * Eligible rows are unbound uploads (`message_id IS NULL`) and rows bound to a
 * message withdrawn at least `ttlHours` ago. Attachments of live messages are
 * never touched. The select locks rows with `FOR UPDATE SKIP LOCKED` inside the
 * delete transaction, so several backend instances can sweep concurrently
 * without deleting the same row twice or blocking each other.
 *
 * Files are unlinked only after the transaction commits: a rollback must not
 * leave a live row pointing at a removed file. Unlinking is best-effort — a
 * missing file is not an error, and an unsafe `stored_name` or a failed unlink
 * is only counted (and logged), because the row is already gone and retrying
 * forever would keep an expired row alive.
 */
export async function runAttachmentCleanup(
  options: AttachmentCleanupOptions = {},
): Promise<AttachmentCleanupResult> {
  const ttlHours = Math.min(
    TTL_HOURS_MAX,
    Math.max(TTL_HOURS_MIN, Math.trunc(options.ttlHours ?? config.attachmentOrphanTtlHours)),
  );
  const limit = Math.min(
    ATTACHMENT_CLEANUP_BATCH_SIZE,
    Math.max(1, Math.trunc(options.limit ?? ATTACHMENT_CLEANUP_BATCH_SIZE)),
  );

  const deleted = await withTransaction(async (conn) => {
    const [selected] = await conn.query<RowDataPacket[]>(
      `SELECT a.id, a.stored_name
         FROM message_attachments a
         LEFT JOIN messages m ON m.id = a.message_id
        WHERE (a.message_id IS NULL AND a.created_at < TIMESTAMPADD(HOUR, ?, NOW(3)))
           OR (m.deleted_at IS NOT NULL AND m.deleted_at < TIMESTAMPADD(HOUR, ?, NOW(3)))
        ORDER BY a.id
        LIMIT ?
        FOR UPDATE OF a SKIP LOCKED`,
      [-ttlHours, -ttlHours, limit],
    );
    if (selected.length === 0) {
      return [];
    }
    const ids = selected.map((row) => Number(row.id));
    await conn.query('DELETE FROM message_attachments WHERE id IN (?)', [ids]);
    return selected;
  });

  let files = 0;
  let errors = 0;
  for (const row of deleted) {
    const storedName = String(row.stored_name);
    const absolute = resolveAttachmentPath(storedName);
    if (!absolute) {
      errors += 1;
      logger.warn(
        { attachmentId: Number(row.id), storedName },
        'refusing unsafe attachment path during cleanup',
      );
      continue;
    }
    try {
      await fs.promises.unlink(absolute);
      files += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Already gone: nothing leaked, so this is not a failure.
        continue;
      }
      errors += 1;
      logger.warn(
        { err: error, attachmentId: Number(row.id) },
        'failed to remove attachment file',
      );
    }
  }

  return { rows: deleted.length, files, errors };
}

/**
 * Runs one sweep immediately (so a restart does not wait a whole interval),
 * then repeats every `ATTACHMENT_CLEANUP_INTERVAL_MS`. Overlapping sweeps are
 * skipped and the timer is unref'd so it never keeps the process alive.
 */
export function startAttachmentCleanupScheduler(): NodeJS.Timeout {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const result = await runAttachmentCleanup();
      const summary = { ...result, ttlHours: config.attachmentOrphanTtlHours };
      if (result.rows > 0 || result.errors > 0) {
        logger.info(summary, 'attachment cleanup finished');
      } else {
        logger.debug(summary, 'attachment cleanup finished');
      }
    } catch (error) {
      logger.error({ err: error }, 'attachment cleanup failed');
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), config.attachmentCleanupIntervalMs);
  timer.unref();
  return timer;
}
