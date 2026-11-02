import fs from 'node:fs';
import { config } from '../config';
import { withTransaction, type RowDataPacket } from '../db';
import { logger } from '../logger';
import { resolveAttachmentPath } from './attachment-cleanup';

/** Messages one sweep deletes at most; larger backlogs wait for the next tick. */
export const ROOM_RETENTION_BATCH_SIZE = 500;

export interface RoomRetentionOptions {
  /** Batch size; defaults to and never exceeds `ROOM_RETENTION_BATCH_SIZE`. */
  batchSize?: number;
}

export interface RoomRetentionResult {
  /** Messages deleted in this sweep. */
  rows: number;
  /** Attachment files removed from disk. */
  files: number;
  /** Attachment rows whose file was refused or could not be removed. */
  errors: number;
}

/**
 * Deletes one batch of messages that outlived their room's retention policy.
 *
 * Only rooms with `retention_days > 0` are considered, and pinned messages are
 * always kept. The cutoff is evaluated per room with the column itself, so a
 * mixed table never applies one room's policy to another. Candidate rows are
 * locked with `FOR UPDATE SKIP LOCKED`, which lets several backend instances
 * sweep concurrently without claiming the same message twice.
 *
 * The DELETE is a single statement: every child table (`message_reactions`,
 * `message_edits`, `message_reports`, `saved_messages`, `polls`/options/votes,
 * `message_attachments`, `notifications`) cascades from `messages`, so one
 * statement clears the whole message graph atomically. Attachment files are
 * unlinked only after the transaction commits: a rollback must not leave a
 * live row pointing at a removed file. A missing file is not an error; an
 * unsafe `stored_name` or a failed unlink is only counted and logged, because
 * the row is already gone and retrying forever would keep it alive.
 */
export async function runRoomRetention(
  options: RoomRetentionOptions = {},
): Promise<RoomRetentionResult> {
  const batchSize = Math.min(
    ROOM_RETENTION_BATCH_SIZE,
    Math.max(1, Math.trunc(options.batchSize ?? ROOM_RETENTION_BATCH_SIZE)),
  );

  const claimed = await withTransaction(async (conn) => {
    const [selected] = await conn.query<RowDataPacket[]>(
      `SELECT m.id
         FROM messages m
         JOIN rooms r ON r.id = m.room_id
        WHERE r.retention_days > 0
          AND m.pinned_at IS NULL
          AND m.created_at < TIMESTAMPADD(DAY, -r.retention_days, NOW(3))
        ORDER BY m.id
        LIMIT ?
        FOR UPDATE OF m SKIP LOCKED`,
      [batchSize],
    );
    if (selected.length === 0) {
      return { rows: 0, attachments: [] as RowDataPacket[] };
    }

    const ids = selected.map((row) => Number(row.id));
    // Read the file names before the cascade removes the rows. A concurrent
    // upload binding to one of these messages blocks on the locked parent row,
    // so the set cannot grow between this SELECT and the DELETE.
    const [attachments] = await conn.query<RowDataPacket[]>(
      'SELECT stored_name FROM message_attachments WHERE message_id IN (?)',
      [ids],
    );
    await conn.query('DELETE FROM messages WHERE id IN (?)', [ids]);
    return { rows: ids.length, attachments };
  });

  let files = 0;
  let errors = 0;
  for (const row of claimed.attachments) {
    const storedName = String(row.stored_name);
    const absolute = resolveAttachmentPath(storedName);
    if (!absolute) {
      errors += 1;
      logger.warn({ storedName }, 'refusing unsafe attachment path during room retention');
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
      logger.warn({ err: error, storedName }, 'failed to remove attachment file during retention');
    }
  }

  return { rows: claimed.rows, files, errors };
}

/**
 * Runs one sweep immediately (a restart should not wait a whole interval),
 * then repeats every `ROOM_RETENTION_SWEEP_MS`. Overlapping sweeps are skipped
 * and the timer is unref'd so it never keeps the process alive.
 */
export function startRoomRetentionScheduler(): NodeJS.Timeout {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const result = await runRoomRetention();
      if (result.rows > 0 || result.errors > 0) {
        logger.info(result, 'room retention sweep finished');
      } else {
        logger.debug(result, 'room retention sweep finished');
      }
    } catch (error) {
      logger.error({ err: error }, 'room retention sweep failed');
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), config.roomRetentionSweepMs);
  timer.unref();
  return timer;
}
