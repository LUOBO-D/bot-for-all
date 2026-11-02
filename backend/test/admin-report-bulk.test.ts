import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool, type RowDataPacket } from '../src/db';
import { createMessage } from '../src/services/message';
import { createReport, resolveReport } from '../src/services/reports';
import { createRoom } from '../src/services/room';
import type { AuthUser } from '../src/types';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function bulkResolve(actor: AuthUser, body: unknown) {
  return request(app)
    .patch('/api/admin/reports/bulk')
    .set('Authorization', bearer(tokenFor(actor)))
    .send(body as object);
}

function auditEntries(token: string, action = 'report.resolve') {
  return request(app)
    .get('/api/admin/audit')
    .query({ action })
    .set('Authorization', bearer(token));
}

// `message_reports` is not part of the shared TRUNCATE list in test/setup.ts,
// so this file clears it itself: stale rows would otherwise wedge the counts.
beforeEach(async () => {
  await pool.execute('DELETE FROM message_reports');
});

interface Fixture {
  admin: AuthUser;
  owner: AuthUser;
  reporter: AuthUser;
  roomId: number;
}

async function seedRoom(): Promise<Fixture> {
  const admin = await createTestUser('rb_admin', 'admin');
  const owner = await createTestUser('rb_owner');
  const reporter = await createTestUser('rb_reporter');
  const room = await createRoom(owner.id, { name: 'bulk-report-room', isPublic: true });
  return { admin, owner, reporter, roomId: room.id };
}

/** Files `count` reports on fresh messages and returns their ids in order. */
async function seedReports(
  fixture: Fixture,
  count: number,
  prefix: string,
): Promise<number[]> {
  const ids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const message = await createMessage({
      roomId: fixture.roomId,
      senderId: fixture.owner.id,
      senderType: 'user',
      content: `${prefix} message ${index}`,
      clientMsgId: `${prefix}-${index}`,
    });
    const report = await createReport({
      roomId: fixture.roomId,
      seq: message.seq,
      reporterId: fixture.reporter.id,
      reason: 'spam',
    });
    ids.push(report.id);
  }
  return ids;
}

interface ReportState {
  status: string;
  resolvedBy: number | null;
  resolvedAt: Date | null;
}

async function stateOf(ids: number[]): Promise<ReportState[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, status, resolved_by, resolved_at
       FROM message_reports
      WHERE id IN (${ids.map(() => '?').join(',')})
      ORDER BY id`,
    ids,
  );
  return rows.map((row) => ({
    status: String(row.status),
    resolvedBy: row.resolved_by == null ? null : Number(row.resolved_by),
    resolvedAt: row.resolved_at == null ? null : new Date(row.resolved_at as string),
  }));
}

describe('admin bulk report handling', () => {
  it('resolves every selected report and audits each one', async () => {
    const fixture = await seedRoom();
    const ids = await seedReports(fixture, 3, 'rb-success');

    const response = await bulkResolve(fixture.admin, {
      ids,
      status: 'resolved',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: 3 });
    for (const state of await stateOf(ids)) {
      expect(state.status).toBe('resolved');
      expect(state.resolvedBy).toBe(fixture.admin.id);
      expect(state.resolvedAt).not.toBeNull();
    }

    const audit = await auditEntries(tokenFor(fixture.admin));
    expect(audit.status).toBe(200);
    expect(audit.body.total).toBe(3);
    expect(audit.body.entries.map((entry: { targetId: number }) => entry.targetId).sort())
      .toEqual([...ids].sort());
    for (const entry of audit.body.entries) {
      expect(entry).toMatchObject({
        actorId: fixture.admin.id,
        action: 'report.resolve',
        targetType: 'report',
        detail: { status: 'resolved', bulk: true },
      });
    }
  });

  it('overwrites an already handled report and refreshes its resolver', async () => {
    const fixture = await seedRoom();
    const ids = await seedReports(fixture, 2, 'rb-overwrite');
    const other = await createTestUser('rb_other_admin', 'admin');

    expect(await resolveReport(ids[0], 'resolved', other.id)).not.toBeNull();
    // Backdate the resolver timestamp so the batch refresh is observable
    // without waiting on the wall clock.
    await pool.execute(
      "UPDATE message_reports SET resolved_at = '2020-01-01 00:00:00.000' WHERE id = ?",
      [ids[0]],
    );
    const [before] = await stateOf([ids[0]]);
    expect(before.status).toBe('resolved');

    const response = await bulkResolve(fixture.admin, {
      ids,
      status: 'dismissed',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: 2 });
    const states = await stateOf(ids);
    for (const state of states) {
      expect(state.status).toBe('dismissed');
      expect(state.resolvedBy).toBe(fixture.admin.id);
    }
    expect(states[0].resolvedAt).not.toBeNull();
    if (before.resolvedAt) {
      expect(states[0].resolvedAt!.getTime()).toBeGreaterThan(before.resolvedAt.getTime());
    }

    const audit = await auditEntries(tokenFor(fixture.admin));
    expect(audit.body.total).toBe(2);
    for (const entry of audit.body.entries) {
      expect(entry.detail).toEqual({ status: 'dismissed', bulk: true });
    }
  });

  it('deduplicates repeated ids before updating and auditing', async () => {
    const fixture = await seedRoom();
    const [first, second] = await seedReports(fixture, 2, 'rb-dedup');

    const response = await bulkResolve(fixture.admin, {
      ids: [first, first, second, first],
      status: 'resolved',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: 2 });
    expect((await stateOf([first, second])).map((state) => state.status))
      .toEqual(['resolved', 'resolved']);

    const audit = await auditEntries(tokenFor(fixture.admin));
    expect(audit.body.total).toBe(2);
    expect(audit.body.entries.map((entry: { targetId: number }) => entry.targetId).sort())
      .toEqual([first, second].sort());
  });

  it('rolls the whole batch back when one id does not exist', async () => {
    const fixture = await seedRoom();
    const ids = await seedReports(fixture, 2, 'rb-missing');

    const response = await bulkResolve(fixture.admin, {
      ids: [ids[0], 999_999, ids[1]],
      status: 'resolved',
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('REPORT_NOT_FOUND');
    expect((await stateOf(ids)).map((state) => state.status)).toEqual(['open', 'open']);
    expect((await auditEntries(tokenFor(fixture.admin))).body.total).toBe(0);
  });

  it('rejects non-admin callers without touching the reports', async () => {
    const fixture = await seedRoom();
    const plain = await createTestUser('rb_plain');
    const ids = await seedReports(fixture, 1, 'rb-forbidden');

    const response = await bulkResolve(plain, { ids, status: 'resolved' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ADMIN_REQUIRED');
    expect((await stateOf(ids)).map((state) => state.status)).toEqual(['open']);
    expect((await auditEntries(tokenFor(fixture.admin))).body.total).toBe(0);
  });

  it('rejects an empty selection and other malformed payloads', async () => {
    const fixture = await seedRoom();
    const ids = await seedReports(fixture, 1, 'rb-payload');

    const bodies: unknown[] = [
      {},
      { ids: [], status: 'resolved' },
      { ids },
      { ids, status: 'open' },
      { ids: [0], status: 'resolved' },
      { ids: [-1], status: 'resolved' },
      { ids: [1.5], status: 'resolved' },
      { ids: ['1'], status: 'resolved' },
      { ids: [null], status: 'resolved' },
      {
        ids: Array.from({ length: 201 }, (_, index) => index + 1),
        status: 'resolved',
      },
    ];

    for (const body of bodies) {
      const response = await bulkResolve(fixture.admin, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }
    expect((await stateOf(ids)).map((state) => state.status)).toEqual(['open']);
  });
});
