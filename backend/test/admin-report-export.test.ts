import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { pool, type RowDataPacket } from '../src/db';
import { createMessage } from '../src/services/message';
import { createReport, resolveReport } from '../src/services/reports';
import { createRoom } from '../src/services/room';
import type { AuthUser } from '../src/types';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

afterEach(() => {
  config.rateLimitEnabled = false;
});

const CSV_HEADER = [
  'id',
  'createdAt',
  'roomName',
  'senderName',
  'messageContent',
  'reporterName',
  'reason',
  'status',
  'resolvedBy',
  'resolvedAt',
];

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function exportReports(token: string, status?: string) {
  const call = request(app)
    .get('/api/admin/reports/export')
    .set('Authorization', bearer(token));
  return status === undefined ? call : call.query({ status });
}

/**
 * Minimal RFC 4180 reader: quoted cells (including embedded commas, quotes and
 * newlines), doubled quotes, and both CRLF and LF record terminators.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    // A trailing terminator must not produce a phantom record.
    if (row.length > 1 || row[0] !== '') {
      rows.push(row);
    }
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      endField();
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      endRow();
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    endRow();
  }
  return rows;
}

function toObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  expect(rows[0]).toEqual(CSV_HEADER);
  return rows.slice(1).map((cells) => {
    expect(cells).toHaveLength(CSV_HEADER.length);
    return Object.fromEntries(CSV_HEADER.map((name, index) => [name, cells[index]]));
  });
}

interface Fixture {
  admin: AuthUser;
  owner: AuthUser;
  reporter: AuthUser;
  roomId: number;
}

async function seedFixture(prefix: string): Promise<Fixture> {
  const admin = await createTestUser(`${prefix}_admin`, 'admin');
  const owner = await createTestUser(`${prefix}_owner`);
  const reporter = await createTestUser(`${prefix}_reporter`);
  const room = await createRoom(owner.id, { name: `${prefix}-room`, isPublic: true });
  return { admin, owner, reporter, roomId: room.id };
}

let clientSeq = 0;

/** Creates one message by `owner` and one report on it by `reporter`. */
async function seedReport(
  fixture: Fixture,
  content: string,
  reason: string,
): Promise<{ reportId: number; messageId: number }> {
  clientSeq += 1;
  const message = await createMessage({
    roomId: fixture.roomId,
    senderId: fixture.owner.id,
    senderType: 'user',
    content,
    clientMsgId: `export-${clientSeq}-${Date.now()}`,
  });
  const report = await createReport({
    roomId: fixture.roomId,
    seq: message.seq,
    reporterId: fixture.reporter.id,
    reason,
  });
  return { reportId: report.id, messageId: message.id };
}

/** Bulk-seeds `count` open reports on fresh messages via one INSERT SELECT. */
async function seedManyReports(
  fixture: Fixture,
  count: number,
): Promise<{ minId: number; maxId: number }> {
  const batchSize = 500;
  for (let start = 0; start < count; start += batchSize) {
    const size = Math.min(batchSize, count - start);
    const values: unknown[][] = [];
    for (let offset = 0; offset < size; offset += 1) {
      const seq = start + offset + 1;
      values.push([
        fixture.roomId,
        seq,
        fixture.owner.id,
        'user',
        `bulk message ${seq}`,
        'done',
      ]);
    }
    await pool.query(
      `INSERT INTO messages (room_id, seq, sender_id, sender_type, content, status)
       VALUES ?`,
      [values],
    );
  }
  await pool.query(
    `INSERT INTO message_reports (message_id, room_id, reporter_id, reason)
     SELECT id, ?, ?, 'bulk spam'
       FROM messages
      WHERE room_id = ?
      ORDER BY id`,
    [fixture.roomId, fixture.reporter.id, fixture.roomId],
  );
  // Direct inserts bypass the service's max_seq allocation, so advance the
  // room counter; otherwise a later createMessage would reuse seq 1.
  await pool.execute('UPDATE rooms SET max_seq = ? WHERE id = ?', [
    count,
    fixture.roomId,
  ]);
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM message_reports WHERE room_id = ?',
    [fixture.roomId],
  );
  return {
    minId: Number(rows[0]?.min_id ?? 0),
    maxId: Number(rows[0]?.max_id ?? 0),
  };
}

describe('admin report CSV export', () => {
  it('rejects non-admin access', async () => {
    const plain = await createTestUser('report_export_plain');

    const response = await exportReports(tokenFor(plain));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ADMIN_REQUIRED');
  });

  it('exports the open queue by default with the documented columns', async () => {
    const fixture = await seedFixture('report_export_open');
    const open = await seedReport(fixture, 'open message', 'spam');
    const resolvedTarget = await seedReport(fixture, 'resolved message', 'abuse');

    // The default export only carries the queue, so handle the second row
    // before the first download.
    const resolvedId = resolvedTarget.reportId;
    const handled = await resolveReport(resolvedId, 'resolved', fixture.admin.id);
    expect(handled).not.toBeNull();

    const response = await exportReports(tokenFor(fixture.admin));

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="reports-open.csv"',
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-report-truncated']).toBeUndefined();

    const rows = toObjects(response.text);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(String(open.reportId));
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(row.roomName).toBe('report_export_open-room');
    expect(row.senderName).toBe('report_export_open_owner');
    expect(row.messageContent).toBe('open message');
    expect(row.reporterName).toBe('report_export_open_reporter');
    expect(row.reason).toBe('spam');
    expect(row.status).toBe('open');
    expect(row.resolvedBy).toBe('');
    expect(row.resolvedAt).toBe('');

    // The default export must not leak handled rows; `all` includes them with
    // the resolver id and timestamp.
    const allResponse = await exportReports(tokenFor(fixture.admin), 'all');
    expect(allResponse.status).toBe(200);
    expect(allResponse.headers['content-disposition']).toBe(
      'attachment; filename="reports-all.csv"',
    );
    const allRows = toObjects(allResponse.text);
    expect(allRows).toHaveLength(2);
    // Newest id first.
    expect(Number(allRows[0].id)).toBeGreaterThan(Number(allRows[1].id));
    const handledRow = allRows.find((entry) => entry.id === String(resolvedId));
    expect(handledRow?.status).toBe('resolved');
    expect(handledRow?.resolvedBy).toBe(String(fixture.admin.id));
    expect(handledRow?.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

    // The same filter still returns only the queue row.
    const queueAfterResolve = await exportReports(tokenFor(fixture.admin), 'open');
    expect(toObjects(queueAfterResolve.text)).toHaveLength(1);
  });

  it('quotes RFC 4180 cells and neutralizes spreadsheet formulas', async () => {
    const fixture = await seedFixture('report_export_escape');
    const { reportId, messageId } = await seedReport(fixture, 'placeholder', 'placeholder');

    const content = 'line1\nline2, "quoted"';
    const reason = '-cmd|calc';
    await pool.execute('UPDATE messages SET content = ? WHERE id = ?', [content, messageId]);
    await pool.execute('UPDATE message_reports SET reason = ? WHERE id = ?', [
      reason,
      reportId,
    ]);
    await pool.execute('UPDATE rooms SET name = ? WHERE id = ?', [
      '=export, "room"',
      fixture.roomId,
    ]);
    await pool.execute('UPDATE users SET display_name = ? WHERE id = ?', [
      '=2+2',
      fixture.owner.id,
    ]);
    await pool.execute('UPDATE users SET display_name = ? WHERE id = ?', [
      '@reporter',
      fixture.reporter.id,
    ]);

    const response = await exportReports(tokenFor(fixture.admin));
    expect(response.status).toBe(200);

    const rows = toObjects(response.text);
    expect(rows).toHaveLength(1);
    // Quoted cells round-trip exactly; leading formula triggers get an
    // apostrophe so Excel/Sheets show the text instead of evaluating it.
    expect(rows[0].roomName).toBe(`'=export, "room"`);
    expect(rows[0].senderName).toBe(`'=2+2`);
    expect(rows[0].messageContent).toBe(content);
    expect(rows[0].reporterName).toBe(`'@reporter`);
    expect(rows[0].reason).toBe(`'${reason}`);

    // Raw bytes carry the same guard and RFC 4180 quoting.
    expect(response.text).toContain(`"'=export, ""room"""`);
    expect(response.text).toContain(`'=2+2`);
    expect(response.text).toContain(`"line1\nline2, ""quoted"""`);
    expect(response.text).toContain(`'${reason}`);
  });

  it('returns just the header when the queue is empty', async () => {
    const admin = await createTestUser('report_export_empty_admin', 'admin');

    const response = await exportReports(tokenFor(admin));

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="reports-open.csv"',
    );
    expect(response.headers['x-report-truncated']).toBeUndefined();
    expect(response.text).toBe(`${CSV_HEADER.join(',')}\r\n`);
    expect(parseCsv(response.text)).toEqual([CSV_HEADER]);
  });

  it('rejects an unknown status filter', async () => {
    const admin = await createTestUser('report_export_status_admin', 'admin');

    for (const status of ['resolved', 'dismissed', 'OPEN', '']) {
      const response = await exportReports(tokenFor(admin), status);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }
  });

  it('caps the CSV at 5000 rows and flags truncation only when more exist', async () => {
    const fixture = await seedFixture('report_export_cap');
    const seeded = await seedManyReports(fixture, 5000);

    const exact = await exportReports(tokenFor(fixture.admin));
    expect(exact.status).toBe(200);
    expect(exact.headers['x-report-truncated']).toBeUndefined();
    const exactRows = toObjects(exact.text);
    expect(exactRows).toHaveLength(5000);
    expect(exactRows[0].id).toBe(String(seeded.maxId));
    expect(exactRows[4999].id).toBe(String(seeded.minId));
    expect(exactRows[0].messageContent).toBe('bulk message 5000');

    // One more row pushes the set past the cap: the newest 5000 survive and
    // the header tells the client that older rows were dropped.
    const extra = await seedReport(fixture, 'extra open report', 'spam');
    const capped = await exportReports(tokenFor(fixture.admin));
    expect(capped.status).toBe(200);
    expect(capped.headers['x-report-truncated']).toBe('true');
    const cappedRows = toObjects(capped.text);
    expect(cappedRows).toHaveLength(5000);
    expect(cappedRows[0].id).toBe(String(extra.reportId));
    expect(cappedRows.map((row) => row.id)).not.toContain(String(seeded.minId));
    // Still sorted newest first across the cut.
    const ids = cappedRows.map((row) => Number(row.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it('allows ten exports per minute per admin', async () => {
    config.rateLimitEnabled = true;
    const admin = await createTestUser('report_export_rate_admin', 'admin');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await exportReports(tokenFor(admin));
      expect(response.status).toBe(200);
    }

    const limited = await exportReports(tokenFor(admin));
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');

    // The bucket is per admin, so a second admin is unaffected.
    const other = await createTestUser('report_export_rate_other', 'admin');
    const otherResponse = await exportReports(tokenFor(other));
    expect(otherResponse.status).toBe(200);
  });
});
