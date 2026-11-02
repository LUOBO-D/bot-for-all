import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config, envSchema } from '../src/config';
import { pool, type RowDataPacket } from '../src/db';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

const DEFAULT_AUDIT_EXPORT_ALL_MAX = config.auditExportAllMax;

afterEach(() => {
  config.rateLimitEnabled = false;
  config.auditExportAllMax = DEFAULT_AUDIT_EXPORT_ALL_MAX;
});

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function exportAll(token: string, query: Record<string, string | number> = {}) {
  return request(app)
    .get('/api/admin/audit/export-all')
    .query(query)
    .set('Authorization', bearer(token));
}

function exportCapped(token: string, query: Record<string, string | number> = {}) {
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

interface AuditFixture {
  actorId: number;
  action: string;
  targetType?: string;
  targetId?: number | null;
  detail?: string | null;
  createdAt?: string;
}

async function insertAuditRows(fixtures: AuditFixture[]): Promise<void> {
  if (fixtures.length === 0) {
    return;
  }
  await pool.query(
    `INSERT INTO admin_audit_log
       (actor_id, action, target_type, target_id, detail, created_at)
     VALUES ?`,
    [
      fixtures.map((fixture) => [
        fixture.actorId,
        fixture.action,
        fixture.targetType ?? 'user',
        fixture.targetId ?? null,
        fixture.detail ?? null,
        fixture.createdAt ?? '2026-03-10 08:00:00',
      ]),
    ],
  );
}

async function setDisplayName(userId: number, displayName: string): Promise<void> {
  await pool.execute('UPDATE users SET display_name = ? WHERE id = ?', [
    displayName,
    userId,
  ]);
}

function bulkFixtures(actorId: number, count: number, action = 'bot.update'): AuditFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    actorId,
    action,
    targetType: 'bot',
    targetId: index + 1,
  }));
}

describe('AUDIT_EXPORT_ALL_MAX configuration', () => {
  it('defaults to 100000 and accepts only 1..1000000', () => {
    expect(config.auditExportAllMax).toBe(100_000);

    const base = {
      DATABASE_URL: 'mysql://root:devroot@127.0.0.1:3306/chat_test',
      JWT_SECRET: 'x'.repeat(32),
      BOT_KEY_SECRET: '0123456789abcdef'.repeat(4),
      ADMIN_PASSWORD: 'test-admin-password',
    };

    const parsed = envSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.AUDIT_EXPORT_ALL_MAX).toBe(100_000);
    }

    for (const value of ['0', '-1', '1000001']) {
      expect(envSchema.safeParse({ ...base, AUDIT_EXPORT_ALL_MAX: value }).success, value)
        .toBe(false);
    }
    for (const value of ['1', '1000000']) {
      expect(envSchema.safeParse({ ...base, AUDIT_EXPORT_ALL_MAX: value }).success, value)
        .toBe(true);
    }
  });
});

describe('GET /api/admin/audit/export-all', () => {
  it('streams every row while the capped export still stops at 5000', async () => {
    const admin = await createTestUser('export_all_admin', 'admin');
    await insertAuditRows(bulkFixtures(admin.id, 5001));

    const full = await exportAll(tokenFor(admin));

    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(full.headers['content-disposition']).toBe(
      'attachment; filename="audit-export-all.csv"',
    );
    // No Content-Length: the body is chunked as batches are written.
    expect(full.headers['transfer-encoding']).toBe('chunked');
    expect(full.headers['x-audit-truncated']).toBeUndefined();

    const rows = parseCsv(full.text);
    expect(rows[0]).toEqual(CSV_HEADER);
    expect(rows).toHaveLength(5002);

    const ids = rows.slice(1).map((row) => Number(row[0]));
    expect(new Set(ids).size).toBe(5001);
    expect(ids).toEqual([...ids].sort((left, right) => right - left));

    const capped = await exportCapped(tokenFor(admin));
    expect(capped.status).toBe(200);
    expect(capped.headers['x-audit-truncated']).toBe('true');
    const cappedRows = parseCsv(capped.text);
    expect(cappedRows).toHaveLength(5001);
    // The capped export is the newest slice of the full one.
    expect(cappedRows.slice(1).map((row) => Number(row[0]))).toEqual(ids.slice(0, 5000));
  });

  it('applies the same action/actor/from/to filters as the capped export', async () => {
    const admin = await createTestUser('export_all_filter_admin', 'admin');
    const alice = await createTestUser('export_all_filter_alice');
    await setDisplayName(alice.id, 'Alice Export');

    await insertAuditRows([
      {
        actorId: alice.id,
        action: 'user.status',
        createdAt: '2026-03-10 08:00:00',
      },
      {
        actorId: alice.id,
        action: 'user.status',
        createdAt: '2026-03-11 08:00:00',
      },
      {
        actorId: alice.id,
        action: 'user.role',
        createdAt: '2026-03-10 09:00:00',
      },
      {
        actorId: admin.id,
        action: 'user.status',
        createdAt: '2026-03-10 10:00:00',
      },
    ]);

    const filtered = await exportAll(tokenFor(admin), {
      action: 'user.status',
      actor: 'alice export',
      from: '2026-03-10',
      to: '2026-03-10',
    });

    expect(filtered.status).toBe(200);
    const rows = parseCsv(filtered.text);
    expect(rows).toHaveLength(2);
    expect(rows[1].slice(1)).toEqual([
      expect.any(String),
      'Alice Export',
      'user.status',
      'user',
      '',
      '',
    ]);
    expect(Number.isNaN(Date.parse(rows[1][1]))).toBe(false);

    const byActor = await exportAll(tokenFor(admin), { actor: 'filter_admin' });
    expect(byActor.status).toBe(200);
    expect(parseCsv(byActor.text)).toHaveLength(2);

    const empty = await exportAll(tokenFor(admin), { actor: 'nobody_matches' });
    expect(empty.status).toBe(200);
    expect(empty.headers['x-audit-truncated']).toBeUndefined();
    expect(parseCsv(empty.text)).toHaveLength(1);

    const inverted = await exportAll(tokenFor(admin), {
      from: '2026-03-31',
      to: '2026-03-01',
    });
    expect(inverted.status).toBe(400);
    expect(inverted.body.error.code).toBe('INVALID_INPUT');
  });

  it('neutralizes spreadsheet formulas in user-controlled cells', async () => {
    const admin = await createTestUser('export_all_formula_admin', 'admin');
    const actor = await createTestUser('export_all_formula_actor');
    await setDisplayName(actor.id, '=2+2');

    await insertAuditRows([
      {
        actorId: actor.id,
        action: '-cmd',
        targetType: '@SUM(A1)',
        targetId: 7,
        detail: '+HYPERLINK("http://evil")',
      },
      {
        actorId: admin.id,
        action: 'safe.action',
        detail: '{"note":"ok"}',
      },
    ]);

    const response = await exportAll(tokenFor(admin), { action: '-cmd' });
    expect(response.status).toBe(200);
    const rows = parseCsv(response.text);
    expect(rows).toHaveLength(2);
    expect(rows[1][2]).toBe("'=2+2");
    expect(rows[1][3]).toBe("'-cmd");
    expect(rows[1][4]).toBe("'@SUM(A1)");
    expect(rows[1][6]).toBe(`'+HYPERLINK("http://evil")`);

    const safe = await exportAll(tokenFor(admin), { action: 'safe.action' });
    const safeRow = parseCsv(safe.text)[1];
    expect(safeRow[3]).toBe('safe.action');
    expect(safeRow[6]).toBe('{"note":"ok"}');
  });

  it('rejects non-admin access', async () => {
    const user = await createTestUser('export_all_plain');

    const response = await exportAll(tokenFor(user));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ADMIN_REQUIRED');
  });

  it('allows one full export per admin per five minutes', async () => {
    config.rateLimitEnabled = true;
    const admin = await createTestUser('export_all_rate_admin', 'admin');
    await insertAuditRows(bulkFixtures(admin.id, 1));

    const first = await exportAll(tokenFor(admin));
    expect(first.status).toBe(200);

    const second = await exportAll(tokenFor(admin));
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('RATE_LIMITED');

    // The bucket is per admin, so a second admin is not affected.
    const other = await createTestUser('export_all_rate_other', 'admin');
    const otherResponse = await exportAll(tokenFor(other));
    expect(otherResponse.status).toBe(200);
  });

  it('honors the configured cap and only flags truncation when more rows exist', async () => {
    const admin = await createTestUser('export_all_cap_admin', 'admin');

    config.auditExportAllMax = 1;
    await insertAuditRows(bulkFixtures(admin.id, 2, 'cap.one'));
    const single = await exportAll(tokenFor(admin), { action: 'cap.one' });
    expect(single.status).toBe(200);
    expect(single.headers['x-audit-truncated']).toBe('true');
    const singleRows = parseCsv(single.text);
    expect(singleRows).toHaveLength(2);
    // Newest first: the second inserted row wins the single slot.
    const [newest] = await pool.query<RowDataPacket[]>(
      "SELECT MAX(id) AS id FROM admin_audit_log WHERE action = 'cap.one'",
    );
    expect(Number(singleRows[1][0])).toBe(Number(newest[0]?.id));

    config.auditExportAllMax = 5;
    await insertAuditRows(bulkFixtures(admin.id, 6, 'cap.over'));
    const over = await exportAll(tokenFor(admin), { action: 'cap.over' });
    expect(over.status).toBe(200);
    expect(over.headers['x-audit-truncated']).toBe('true');
    expect(parseCsv(over.text)).toHaveLength(6);

    await insertAuditRows(bulkFixtures(admin.id, 5, 'cap.exact'));
    const exact = await exportAll(tokenFor(admin), { action: 'cap.exact' });
    expect(exact.status).toBe(200);
    expect(exact.headers['x-audit-truncated']).toBeUndefined();
    expect(parseCsv(exact.text)).toHaveLength(6);
  });

  it('keeps serving after a client disconnects mid-stream', async () => {
    const admin = await createTestUser('export_all_disconnect', 'admin');
    await insertAuditRows(bulkFixtures(admin.id, 5001));

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => {
      server.once('listening', resolve);
    });
    const port = (server.address() as AddressInfo).port;

    try {
      await new Promise<void>((resolve) => {
        const req = http.get(
          {
            host: '127.0.0.1',
            port,
            path: '/api/admin/audit/export-all',
            headers: { Authorization: bearer(tokenFor(admin)) },
          },
          (response) => {
            response.once('data', () => {
              // Abort after the first chunk, while later batches are pending.
              response.destroy();
              resolve();
            });
            response.on('error', () => resolve());
          },
        );
        req.on('error', () => resolve());
      });

      // The follow-up is itself a round trip: if the aborted write had taken
      // the process down, or the handler had thrown after the headers went
      // out, this request would fail.
      const after = await exportAll(tokenFor(admin));
      expect(after.status).toBe(200);
      expect(parseCsv(after.text)).toHaveLength(5002);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
