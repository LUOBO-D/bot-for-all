import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool } from '../src/db';
import { recordAudit } from '../src/services/audit';
import type { AuthUser } from '../src/types';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

function bearer(token: string): string {
  return `Bearer ${token}`;
}

const botPayload = {
  name: 'audit-bot',
  baseUrl: 'http://127.0.0.1:4010',
  apiKey: 'sk-audit-key',
  model: 'fake-ok',
};

async function createBotViaApi(
  admin: AuthUser,
  overrides: Partial<typeof botPayload> = {},
): Promise<{ userId: number; name: string }> {
  const response = await request(app)
    .post('/api/admin/bots')
    .set('Authorization', bearer(tokenFor(admin)))
    .send({ ...botPayload, ...overrides });
  expect(response.status).toBe(201);
  return response.body.bot;
}

function listAudit(token: string, query: Record<string, string | number> = {}) {
  return request(app)
    .get('/api/admin/audit')
    .query(query)
    .set('Authorization', bearer(token));
}

describe('admin audit log', () => {
  it('rejects non-admin access', async () => {
    const user = await createTestUser('audit_plain');

    const response = await listAudit(tokenFor(user));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ADMIN_REQUIRED');
  });

  it('records bot creation and status changes with actor and detail', async () => {
    const admin = await createTestUser('audit_admin', 'admin');
    const target = await createTestUser('audit_target');
    const bot = await createBotViaApi(admin);

    const patch = await request(app)
      .patch(`/api/admin/users/${target.id}/status`)
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ status: 'banned' });
    expect(patch.status).toBe(200);

    const response = await listAudit(tokenFor(admin));

    expect(response.status).toBe(200);
    expect(response.body.limit).toBe(50);
    expect(response.body.offset).toBe(0);
    expect(response.body.total).toBe(2);

    const [statusEntry, createEntry] = response.body.entries;
    expect(statusEntry).toEqual({
      id: expect.any(Number),
      actorId: admin.id,
      actorName: 'audit_admin',
      action: 'user.status',
      targetType: 'user',
      targetId: target.id,
      detail: { from: 'active', to: 'banned' },
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(statusEntry.createdAt))).toBe(false);

    expect(createEntry).toMatchObject({
      actorId: admin.id,
      actorName: 'audit_admin',
      action: 'bot.create',
      targetType: 'bot',
      targetId: bot.userId,
      detail: { name: 'audit-bot', scope: 'global' },
    });
  });

  it('records bot update, mount, unmount and delete', async () => {
    const admin = await createTestUser('audit_lifecycle_admin', 'admin');
    const roomId = await createTestRoom(admin);
    const bot = await createBotViaApi(admin);

    const mount = await request(app)
      .post(`/api/admin/rooms/${roomId}/bots`)
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ botId: bot.userId });
    expect(mount.status).toBe(200);

    const update = await request(app)
      .patch(`/api/admin/bots/${bot.userId}`)
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ model: 'fake-alt' });
    expect(update.status).toBe(200);

    const unmount = await request(app)
      .delete(`/api/admin/rooms/${roomId}/bots/${bot.userId}`)
      .set('Authorization', bearer(tokenFor(admin)));
    expect(unmount.status).toBe(200);

    const remove = await request(app)
      .delete(`/api/admin/bots/${bot.userId}`)
      .set('Authorization', bearer(tokenFor(admin)));
    expect(remove.status).toBe(200);

    const response = await listAudit(tokenFor(admin));

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(5);
    expect(
      response.body.entries.map((entry: { action: string }) => entry.action),
    ).toEqual(['bot.delete', 'bot.unmount', 'bot.update', 'bot.mount', 'bot.create']);

    const [removeEntry, unmountEntry, updateEntry, mountEntry] = response.body.entries;
    expect(removeEntry).toMatchObject({ targetType: 'bot', targetId: bot.userId });
    expect(unmountEntry).toMatchObject({
      targetType: 'room',
      targetId: roomId,
      detail: { botId: bot.userId },
    });
    expect(updateEntry).toMatchObject({
      targetType: 'bot',
      targetId: bot.userId,
      detail: { fields: ['model'] },
    });
    expect(mountEntry).toMatchObject({
      targetType: 'room',
      targetId: roomId,
      detail: { botId: bot.userId },
    });
  });

  it('filters entries by exact action', async () => {
    const admin = await createTestUser('audit_filter_admin', 'admin');
    await createBotViaApi(admin);
    const target = await createTestUser('audit_filter_target');
    await request(app)
      .patch(`/api/admin/users/${target.id}/status`)
      .set('Authorization', bearer(tokenFor(admin)))
      .send({ status: 'banned' });

    const filtered = await listAudit(tokenFor(admin), { action: 'bot.create' });

    expect(filtered.status).toBe(200);
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.entries).toHaveLength(1);
    expect(filtered.body.entries[0].action).toBe('bot.create');

    const none = await listAudit(tokenFor(admin), { action: 'bot.mount' });

    expect(none.status).toBe(200);
    expect(none.body.total).toBe(0);
    expect(none.body.entries).toEqual([]);
  });

  it('paginates newest first', async () => {
    const admin = await createTestUser('audit_page_admin', 'admin');
    for (let index = 0; index < 3; index += 1) {
      await recordAudit({
        actorId: admin.id,
        action: 'bot.update',
        targetType: 'bot',
        targetId: 100 + index,
        detail: { index },
      });
    }

    const page1 = await listAudit(tokenFor(admin), { limit: 2, offset: 0 });
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(3);
    expect(page1.body.limit).toBe(2);
    expect(page1.body.offset).toBe(0);
    expect(
      page1.body.entries.map((entry: { targetId: number }) => entry.targetId),
    ).toEqual([102, 101]);

    const page2 = await listAudit(tokenFor(admin), { limit: 2, offset: 2 });
    expect(page2.status).toBe(200);
    expect(
      page2.body.entries.map((entry: { targetId: number }) => entry.targetId),
    ).toEqual([100]);

    const invalid = await listAudit(tokenFor(admin), { limit: 0 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_INPUT');
  });

  it('survives rows whose detail is not valid JSON', async () => {
    const admin = await createTestUser('audit_json_admin', 'admin');
    await pool.execute(
      `INSERT INTO admin_audit_log (actor_id, action, target_type, target_id, detail)
       VALUES (?, 'bot.update', 'bot', 7, ?)`,
      [admin.id, '{"broken":'],
    );

    const response = await listAudit(tokenFor(admin));

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.entries[0].detail).toBe('{"broken":');
  });
});

function exportAudit(token: string, query: Record<string, string | number> = {}) {
  return request(app)
    .get('/api/admin/audit/export')
    .query(query)
    .set('Authorization', bearer(token));
}

/** CSV rows without a full RFC 4180 reader: these fixtures hold no separators. */
function csvRows(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split(','));
}

/** Writes an audit row at an exact instant; `recordAudit` always uses NOW(). */
async function insertAuditAt(
  actorId: number,
  action: string,
  createdAt: string,
): Promise<void> {
  await pool.execute(
    `INSERT INTO admin_audit_log (actor_id, action, target_type, target_id, created_at)
     VALUES (?, ?, 'user', 1, ?)`,
    [actorId, action, createdAt],
  );
}

async function setDisplayName(userId: number, displayName: string): Promise<void> {
  await pool.execute('UPDATE users SET display_name = ? WHERE id = ?', [
    displayName,
    userId,
  ]);
}

describe('admin audit filters', () => {
  it('matches the actor by username or display name with literal wildcards', async () => {
    const admin = await createTestUser('audit_actor_admin', 'admin');
    const alice = await createTestUser('audit_alice');
    const bob = await createTestUser('audit_bob');
    await setDisplayName(bob.id, 'Alice Cooper');
    const percent = await createTestUser('audit_percent');
    await setDisplayName(percent.id, '100%_off');
    const underscore = await createTestUser('audit_underscore');
    await setDisplayName(underscore.id, 'x_y');
    const letter = await createTestUser('audit_letter');
    await setDisplayName(letter.id, 'xzy');

    for (const actor of [alice, bob, percent, underscore, letter, admin]) {
      await recordAudit({
        actorId: actor.id,
        action: 'user.status',
        targetType: 'user',
        targetId: actor.id,
      });
    }

    const byUsername = await listAudit(tokenFor(admin), { actor: 'audit_alice' });
    expect(byUsername.status).toBe(200);
    expect(byUsername.body.total).toBe(1);
    expect(byUsername.body.entries.map((entry: { actorId: number }) => entry.actorId))
      .toEqual([alice.id]);

    // Display names match too, case-insensitively under the utf8mb4 collation.
    const byDisplay = await listAudit(tokenFor(admin), { actor: 'cooper' });
    expect(byDisplay.body.total).toBe(1);
    expect(byDisplay.body.entries[0].actorId).toBe(bob.id);

    // `%` is a literal, not "match everything".
    const literalPercent = await listAudit(tokenFor(admin), { actor: '%' });
    expect(literalPercent.body.total).toBe(1);
    expect(literalPercent.body.entries[0].actorId).toBe(percent.id);

    // `_` is a literal too: as a wildcard `x_y` would also match `xzy`.
    const literalUnderscore = await listAudit(tokenFor(admin), { actor: 'x_y' });
    expect(literalUnderscore.body.total).toBe(1);
    expect(literalUnderscore.body.entries[0].actorId).toBe(underscore.id);

    // A backslash is literal, not an escape prefix for the following char.
    const backslash = await listAudit(tokenFor(admin), { actor: '\\' });
    expect(backslash.status).toBe(200);
    expect(backslash.body.total).toBe(0);
  });

  it('includes both ends of a date range and excludes the adjacent days', async () => {
    const admin = await createTestUser('audit_date_admin', 'admin');
    await insertAuditAt(admin.id, 'bot.update', '2026-02-28 23:59:59');
    await insertAuditAt(admin.id, 'bot.update', '2026-03-01 00:00:00');
    await insertAuditAt(admin.id, 'bot.update', '2026-03-15 12:00:00');
    await insertAuditAt(admin.id, 'bot.update', '2026-03-31 23:59:59');
    await insertAuditAt(admin.id, 'bot.update', '2026-04-01 00:00:00');

    const range = await listAudit(tokenFor(admin), {
      from: '2026-03-01',
      to: '2026-03-31',
    });
    expect(range.status).toBe(200);
    expect(range.body.total).toBe(3);
    expect(
      range.body.entries.map((entry: { createdAt: string }) => entry.createdAt),
    ).toEqual([
      '2026-03-31T23:59:59.000Z',
      '2026-03-15T12:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
    ]);

    const singleDay = await listAudit(tokenFor(admin), {
      from: '2026-03-01',
      to: '2026-03-01',
    });
    expect(singleDay.body.total).toBe(1);

    const openEnded = await listAudit(tokenFor(admin), { from: '2026-03-01' });
    expect(openEnded.body.total).toBe(4);

    // An upper bound alone keeps every older row, including the day before.
    const upperOnly = await listAudit(tokenFor(admin), { to: '2026-03-01' });
    expect(upperOnly.body.total).toBe(2);
    expect(upperOnly.body.entries[0].createdAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('combines action, actor and date filters with AND', async () => {
    const admin = await createTestUser('audit_combo_admin', 'admin');
    const other = await createTestUser('audit_combo_other');
    await insertAuditAt(admin.id, 'bot.update', '2026-03-10 08:00:00');
    await insertAuditAt(admin.id, 'bot.delete', '2026-03-10 09:00:00');
    await insertAuditAt(admin.id, 'bot.update', '2026-03-20 10:00:00');
    await insertAuditAt(other.id, 'bot.update', '2026-03-10 11:00:00');

    const combined = await listAudit(tokenFor(admin), {
      action: 'bot.update',
      actor: 'combo_admin',
      from: '2026-03-01',
      to: '2026-03-15',
    });
    expect(combined.status).toBe(200);
    expect(combined.body.total).toBe(1);
    expect(combined.body.entries[0]).toMatchObject({
      actorId: admin.id,
      action: 'bot.update',
      createdAt: '2026-03-10T08:00:00.000Z',
    });

    // Dropping the date filter widens the same action+actor pair to two rows.
    const widened = await listAudit(tokenFor(admin), {
      action: 'bot.update',
      actor: 'combo_admin',
    });
    expect(widened.body.total).toBe(2);
  });

  it('rejects inverted and malformed date ranges', async () => {
    const admin = await createTestUser('audit_invalid_admin', 'admin');
    const token = tokenFor(admin);

    const inverted = await listAudit(token, { from: '2026-03-31', to: '2026-03-01' });
    expect(inverted.status).toBe(400);
    expect(inverted.body.error.code).toBe('INVALID_INPUT');

    const invertedExport = await exportAudit(token, {
      from: '2026-03-31',
      to: '2026-03-01',
    });
    expect(invertedExport.status).toBe(400);
    expect(invertedExport.body.error.code).toBe('INVALID_INPUT');

    for (const date of ['2026-02-30', '2026-13-01', '2026-3-1', '03/01/2026', 'today']) {
      const response = await listAudit(token, { from: date });
      expect(response.status, `from=${date}`).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }

    const longActor = await listAudit(token, { actor: 'x'.repeat(65) });
    expect(longActor.status).toBe(400);
    expect(longActor.body.error.code).toBe('INVALID_INPUT');
  });

  it('applies the same filters to the CSV export and keeps the cap', async () => {
    const admin = await createTestUser('audit_export_admin', 'admin');
    const other = await createTestUser('audit_export_other');

    const bulk = Array.from({ length: 5001 }, (_, index) => [
      admin.id,
      'bot.update',
      'bot',
      index + 1,
    ]);
    await pool.query(
      'INSERT INTO admin_audit_log (actor_id, action, target_type, target_id) VALUES ?',
      [bulk],
    );
    await insertAuditAt(other.id, 'user.status', '2026-03-10 08:00:00');
    await insertAuditAt(other.id, 'user.status', '2026-03-11 08:00:00');

    const filtered = await exportAudit(tokenFor(admin), {
      action: 'user.status',
      actor: 'export_other',
      from: '2026-03-10',
      to: '2026-03-10',
    });
    expect(filtered.status).toBe(200);
    expect(filtered.headers['x-audit-truncated']).toBeUndefined();
    const rows = csvRows(filtered.text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([
      'id',
      'createdAt',
      'actorName',
      'action',
      'targetType',
      'targetId',
      'detail',
    ]);
    expect(rows[1].slice(2)).toEqual([
      'audit_export_other',
      'user.status',
      'user',
      '1',
      '',
    ]);

    // The list total matches the exported row count for the same filter.
    const listed = await listAudit(tokenFor(admin), {
      action: 'user.status',
      actor: 'export_other',
      from: '2026-03-10',
      to: '2026-03-10',
    });
    expect(listed.body.total).toBe(rows.length - 1);

    // The 5000-row cap applies after filtering: an actor with no rows exports
    // only the header, while the unfiltered export still reports truncation.
    const empty = await exportAudit(tokenFor(admin), { actor: 'nobody_matches' });
    expect(empty.status).toBe(200);
    expect(empty.headers['x-audit-truncated']).toBeUndefined();
    expect(csvRows(empty.text)).toHaveLength(1);

    const capped = await exportAudit(tokenFor(admin));
    expect(capped.status).toBe(200);
    expect(capped.headers['x-audit-truncated']).toBe('true');
    expect(csvRows(capped.text)).toHaveLength(5001);
  });
});
