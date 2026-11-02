import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool } from '../src/db';
import { recordAudit } from '../src/services/audit';
import { createMessage } from '../src/services/message';
import { createReport, resolveReport } from '../src/services/reports';
import { createRoom } from '../src/services/room';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

function bearer(token: string): string {
  return `Bearer ${token}`;
}

// `message_reports` is not part of the shared TRUNCATE list in test/setup.ts,
// so this file clears it itself; leftover rows would skew the stats snapshot.
beforeEach(async () => {
  await pool.execute('DELETE FROM message_reports');
});

describe('admin stats: reports', () => {
  it('counts reports by status and in total', async () => {
    const admin = await createTestUser('stats_admin', 'admin');
    const owner = await createTestUser('stats_owner');
    const reporter = await createTestUser('stats_reporter');
    const room = await createRoom(owner.id, { name: 'stats-room', isPublic: true });

    const ids: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const message = await createMessage({
        roomId: room.id,
        senderId: owner.id,
        senderType: 'user',
        content: `report me ${index}`,
        clientMsgId: `stats-report-${index}`,
      });
      const report = await createReport({
        roomId: room.id,
        seq: message.seq,
        reporterId: reporter.id,
        reason: 'spam',
      });
      ids.push(report.id);
    }
    await resolveReport(ids[0], 'resolved', admin.id);
    await resolveReport(ids[1], 'dismissed', admin.id);

    const response = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', bearer(tokenFor(admin)));

    expect(response.status).toBe(200);
    expect(response.body.reports).toEqual({
      open: 1,
      resolved: 1,
      dismissed: 1,
      total: 3,
    });
    // The snapshot keeps the other groups untouched.
    expect(response.body.users.total).toBe(3);
    expect(response.body.rooms.total).toBe(1);
  });

  it('reports zeroed counters on an empty database', async () => {
    const admin = await createTestUser('stats_empty_admin', 'admin');

    const response = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', bearer(tokenFor(admin)));

    expect(response.status).toBe(200);
    expect(response.body.reports).toEqual({
      open: 0,
      resolved: 0,
      dismissed: 0,
      total: 0,
    });
  });

  it('rejects non-admin access', async () => {
    const user = await createTestUser('stats_plain');

    const response = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', bearer(tokenFor(user)));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ADMIN_REQUIRED');
  });
});

interface CsvResult {
  status: number;
  text: string;
  headers: Record<string, string>;
}

function exportCsv(token: string, query: Record<string, string | number> = {}) {
  return request(app)
    .get('/api/admin/audit/export')
    .query(query)
    .set('Authorization', bearer(token));
}

const CSV_HEADER = [
  'id',
  'createdAt',
  'actorName',
  'action',
  'targetType',
  'targetId',
  'detail',
];

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, `\n` row breaks. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function exportResponse(token: string, query: Record<string, string | number> = {}) {
  const response = await exportCsv(token, query);
  return {
    status: response.status,
    text: response.text,
    headers: response.headers as Record<string, string>,
  } satisfies CsvResult;
}

describe('admin audit CSV export', () => {
  it('streams newest-first rows with the contract columns and headers', async () => {
    const admin = await createTestUser('export_admin', 'admin');

    await recordAudit({
      actorId: admin.id,
      action: 'user.status',
      targetType: 'user',
      targetId: 42,
      detail: { from: 'active', to: 'banned', note: 'a,b"c' },
    });
    await recordAudit({
      actorId: admin.id,
      action: 'user.role',
      targetType: 'weird,type',
      targetId: null,
      detail: null,
    });
    await recordAudit({
      actorId: admin.id,
      action: 'bot.create',
      targetType: 'line\nbreak',
      targetId: 7,
      detail: { name: 'bot' },
    });

    const { status, text, headers } = await exportResponse(tokenFor(admin));

    expect(status).toBe(200);
    expect(headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(headers['content-disposition']).toBe(
      'attachment; filename="audit-export.csv"',
    );

    const rows = parseCsv(text);
    expect(rows[0]).toEqual(CSV_HEADER);
    expect(rows).toHaveLength(4);

    const [newest, middle, oldest] = rows.slice(1);

    expect(newest).toEqual([
      expect.stringMatching(/^\d+$/),
      expect.any(String),
      'export_admin',
      'bot.create',
      'line\nbreak',
      '7',
      '{"name":"bot"}',
    ]);
    expect(Number.isNaN(Date.parse(newest[1]))).toBe(false);

    expect(middle).toEqual([
      expect.stringMatching(/^\d+$/),
      expect.any(String),
      'export_admin',
      'user.role',
      'weird,type',
      '',
      '',
    ]);

    expect(oldest[3]).toBe('user.status');
    expect(oldest[4]).toBe('user');
    expect(oldest[5]).toBe('42');
    expect(oldest[6]).toBe('{"from":"active","to":"banned","note":"a,b\\"c"}');

    // Newest first: ids strictly descend.
    const ids = rows.slice(1).map((row) => Number(row[0]));
    expect(ids).toEqual([...ids].sort((left, right) => right - left));
  });

  it('filters by exact action', async () => {
    const admin = await createTestUser('export_filter_admin', 'admin');

    for (const action of ['user.status', 'user.status', 'user.status2', 'user.role']) {
      await recordAudit({
        actorId: admin.id,
        action,
        targetType: 'user',
        targetId: 1,
      });
    }

    const { status, text } = await exportResponse(tokenFor(admin), {
      action: 'user.status',
    });

    expect(status).toBe(200);
    const rows = parseCsv(text);
    expect(rows[0]).toEqual(CSV_HEADER);
    expect(rows).toHaveLength(3);
    expect(rows.slice(1).every((row) => row[3] === 'user.status')).toBe(true);
  });

  it('neutralizes spreadsheet formulas in actor names and legacy detail', async () => {
    const admin = await createTestUser('export_formula_admin', 'admin');
    const actor = await createTestUser('export_formula_actor');
    await pool.execute('UPDATE users SET display_name = ? WHERE id = ?', [
      '=HYPERLINK("http://evil.example")',
      actor.id,
    ]);
    await recordAudit({
      actorId: actor.id,
      action: 'user.status',
      targetType: 'user',
      targetId: 1,
    });
    await pool.execute(
      `INSERT INTO admin_audit_log (actor_id, action, target_type, detail)
       VALUES (?, 'legacy.export', 'user', '=1+1')`,
      [admin.id],
    );

    const { status, text } = await exportResponse(tokenFor(admin));
    expect(status).toBe(200);

    const rows = parseCsv(text);
    const actorRow = rows.find((row) => row[3] === 'user.status');
    expect(actorRow?.[2]).toBe('\'=HYPERLINK("http://evil.example")');
    const legacyRow = rows.find((row) => row[3] === 'legacy.export');
    expect(legacyRow?.[6]).toBe("'=1+1");
  });

  it('caps the export at 5000 rows', async () => {
    const admin = await createTestUser('export_cap_admin', 'admin');

    const values = Array.from({ length: 5001 }, (_, index) => [
      admin.id,
      'user.status',
      'user',
      index + 1,
    ]);
    await pool.query(
      'INSERT INTO admin_audit_log (actor_id, action, target_type, target_id) VALUES ?',
      [values],
    );

    const { status, text, headers } = await exportResponse(tokenFor(admin));

    expect(status).toBe(200);
    expect(headers['x-audit-truncated']).toBe('true');
    const rows = parseCsv(text);
    expect(rows).toHaveLength(5001); // header + 5000 rows
    expect(rows[1][0]).toBe('5001');
    expect(rows[5000][0]).toBe('2');
  });

  it('rejects an over-long action filter', async () => {
    const admin = await createTestUser('export_invalid_admin', 'admin');

    const response = await exportCsv(tokenFor(admin), { action: 'x'.repeat(65) });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_INPUT');
  });

  it('rejects non-admin access', async () => {
    const user = await createTestUser('export_plain');

    const response = await exportCsv(tokenFor(user));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ADMIN_REQUIRED');
  });
});
