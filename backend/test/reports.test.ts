import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool, type RowDataPacket } from '../src/db';
import { createMessage, deleteMessage } from '../src/services/message';
import { createRoom, joinRoom } from '../src/services/room';
import type { AuthUser, MessageDTO } from '../src/types';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function fileReport(
  token: string,
  roomId: number | string,
  seq: number | string,
  body: object,
) {
  return request(app)
    .post(`/api/rooms/${roomId}/messages/${seq}/report`)
    .set('Authorization', bearer(token))
    .send(body);
}

function listReports(token: string, query: Record<string, string | number> = {}) {
  return request(app)
    .get('/api/admin/reports')
    .query(query)
    .set('Authorization', bearer(token));
}

function handleReport(token: string, id: number | string, body: object) {
  return request(app)
    .patch(`/api/admin/reports/${id}`)
    .set('Authorization', bearer(token))
    .send(body);
}

function auditEntries(token: string, action: string) {
  return request(app)
    .get('/api/admin/audit')
    .query({ action })
    .set('Authorization', bearer(token));
}

// `message_reports` is not part of the shared TRUNCATE list in test/setup.ts,
// so this file clears it itself: leftover rows would otherwise point at message
// ids that the next test's TRUNCATE hands out again.
beforeEach(async () => {
  await pool.execute('DELETE FROM message_reports');
});

async function seedMessage(
  roomId: number,
  senderId: number,
  content: string,
  clientMsgId: string,
): Promise<MessageDTO> {
  return createMessage({ roomId, senderId, senderType: 'user', content, clientMsgId });
}

interface Fixture {
  admin: AuthUser;
  owner: AuthUser;
  member: AuthUser;
  outsider: AuthUser;
  roomId: number;
}

/** A public room owned by `owner`, with `member` joined and `outsider` not. */
async function seedRoom(): Promise<Fixture> {
  const admin = await createTestUser('rep_admin', 'admin');
  const owner = await createTestUser('rep_owner');
  const member = await createTestUser('rep_member');
  const outsider = await createTestUser('rep_outsider');
  const room = await createRoom(owner.id, { name: 'report-room', isPublic: true });
  await joinRoom(member.id, room.id);
  return { admin, owner, member, outsider, roomId: room.id };
}

async function reportCount(): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM message_reports',
  );
  return Number(rows[0]?.total ?? 0);
}

describe('message reports', () => {
  it('files a report on another member\'s message', async () => {
    const { owner, member, roomId } = await seedRoom();
    const message = await seedMessage(roomId, owner.id, '被举报的内容', 'rep-c1');

    const response = await fileReport(tokenFor(member), roomId, message.seq, {
      reason: '  垃圾广告  ',
    });

    expect(response.status).toBe(201);
    expect(response.body.report).toEqual({
      id: expect.any(Number),
      messageId: message.id,
      messageSeq: message.seq,
      messageContent: '被举报的内容',
      messageDeleted: false,
      roomId,
      roomName: 'report-room',
      reporterId: member.id,
      reporterName: 'rep_member',
      senderId: owner.id,
      senderName: 'rep_owner',
      reason: '垃圾广告',
      status: 'open',
      createdAt: expect.any(String),
      resolvedBy: null,
      resolvedByName: null,
      resolvedAt: null,
    });
    expect(Number.isNaN(Date.parse(response.body.report.createdAt))).toBe(false);
    expect(await reportCount()).toBe(1);
  });

  it('rejects a second report of the same message by the same member', async () => {
    const { owner, member, roomId } = await seedRoom();
    const message = await seedMessage(roomId, owner.id, '重复举报', 'rep-c2');
    const token = tokenFor(member);

    expect((await fileReport(token, roomId, message.seq, { reason: '第一次' })).status).toBe(201);

    const duplicate = await fileReport(token, roomId, message.seq, { reason: '第二次' });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('REPORT_EXISTS');
    expect(await reportCount()).toBe(1);
  });

  it('lets two different members report the same message', async () => {
    const { owner, member, outsider, roomId } = await seedRoom();
    const message = await seedMessage(roomId, owner.id, '两个人都不满', 'rep-c3');
    await joinRoom(outsider.id, roomId);

    expect((await fileReport(tokenFor(member), roomId, message.seq, { reason: '甲' })).status)
      .toBe(201);
    expect((await fileReport(tokenFor(outsider), roomId, message.seq, { reason: '乙' })).status)
      .toBe(201);
    expect(await reportCount()).toBe(2);
  });

  it('rejects reporting your own message', async () => {
    const { owner, roomId } = await seedRoom();
    const message = await seedMessage(roomId, owner.id, '自己的话', 'rep-c4');

    const response = await fileReport(tokenFor(owner), roomId, message.seq, { reason: '举报自己' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CANNOT_REPORT_OWN');
    expect(await reportCount()).toBe(0);
  });

  it('rejects reporting a withdrawn message', async () => {
    const { owner, member, roomId } = await seedRoom();
    const message = await seedMessage(roomId, owner.id, '马上就撤回', 'rep-c5');
    await deleteMessage(roomId, message.seq, owner.id, true);

    const response = await fileReport(tokenFor(member), roomId, message.seq, { reason: '太晚了' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MESSAGE_DELETED');
    expect(await reportCount()).toBe(0);
  });

  it('rejects non-members, unknown messages and malformed identifiers', async () => {
    const { owner, member, outsider, roomId } = await seedRoom();
    const message = await seedMessage(roomId, owner.id, '正常内容', 'rep-c6');

    const stranger = await fileReport(tokenFor(outsider), roomId, message.seq, { reason: '路过' });
    expect(stranger.status).toBe(403);
    expect(stranger.body.error.code).toBe('NOT_MEMBER');

    const missing = await fileReport(tokenFor(member), roomId, 9_999, { reason: '不存在' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('MESSAGE_NOT_FOUND');

    const badSeq = await fileReport(tokenFor(member), roomId, 'abc', { reason: '坏 seq' });
    expect(badSeq.status).toBe(400);
    expect(badSeq.body.error.code).toBe('INVALID_SEQ');

    const badRoom = await fileReport(tokenFor(member), 'abc', message.seq, { reason: '坏房间' });
    expect(badRoom.status).toBe(400);
    expect(badRoom.body.error.code).toBe('INVALID_ROOM_ID');

    const anonymous = await request(app)
      .post(`/api/rooms/${roomId}/messages/${message.seq}/report`)
      .send({ reason: '匿名' });
    expect(anonymous.status).toBe(401);
    expect(await reportCount()).toBe(0);
  });

  it('requires a 1-500 character reason', async () => {
    const { owner, member, roomId } = await seedRoom();
    const message = await seedMessage(roomId, owner.id, '内容', 'rep-c7');
    const token = tokenFor(member);

    for (const reason of ['', '   ', undefined, null, 42]) {
      const response = await fileReport(token, roomId, message.seq, { reason });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }

    const tooLong = await fileReport(token, roomId, message.seq, { reason: 'x'.repeat(501) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('INVALID_INPUT');

    const exact = await fileReport(token, roomId, message.seq, { reason: 'y'.repeat(500) });
    expect(exact.status).toBe(201);
    expect(exact.body.report.reason).toHaveLength(500);
  });

  it('lists the queue newest first with message, room, reporter and sender', async () => {
    const { admin, owner, member, roomId } = await seedRoom();
    const first = await seedMessage(roomId, owner.id, '第一条被举报', 'rep-c8a');
    const second = await seedMessage(roomId, member.id, '第二条被举报', 'rep-c8b');

    const firstReport = await fileReport(tokenFor(member), roomId, first.seq, {
      reason: '第一条原因',
    });
    const secondReport = await fileReport(tokenFor(owner), roomId, second.seq, {
      reason: '第二条原因',
    });

    const response = await listReports(tokenFor(admin));

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(response.body.limit).toBe(50);
    expect(response.body.offset).toBe(0);
    expect(response.body.reports.map((report: { id: number }) => report.id)).toEqual([
      secondReport.body.report.id,
      firstReport.body.report.id,
    ]);
    expect(response.body.reports[0]).toEqual({
      id: secondReport.body.report.id,
      messageId: second.id,
      messageSeq: second.seq,
      messageContent: '第二条被举报',
      messageDeleted: false,
      roomId,
      roomName: 'report-room',
      reporterId: owner.id,
      reporterName: 'rep_owner',
      senderId: member.id,
      senderName: 'rep_member',
      reason: '第二条原因',
      status: 'open',
      createdAt: expect.any(String),
      resolvedBy: null,
      resolvedByName: null,
      resolvedAt: null,
    });
  });

  it('pages the queue with limit and offset', async () => {
    const { admin, owner, member, roomId } = await seedRoom();
    const seqs: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const message = await seedMessage(roomId, owner.id, `分页 ${index}`, `rep-page-${index}`);
      seqs.push(message.seq);
      await fileReport(tokenFor(member), roomId, message.seq, { reason: `原因 ${index}` });
    }

    const page = await listReports(tokenFor(admin), { limit: 1, offset: 1 });

    expect(page.status).toBe(200);
    expect(page.body.total).toBe(3);
    expect(page.body.limit).toBe(1);
    expect(page.body.offset).toBe(1);
    expect(page.body.reports).toHaveLength(1);
    expect(page.body.reports[0].messageSeq).toBe(seqs[1]);
  });

  it('handles a report as resolved and hides it from the open queue', async () => {
    const { admin, owner, member, roomId } = await seedRoom();
    const message = await seedMessage(roomId, owner.id, '需要处理', 'rep-c9');
    const created = await fileReport(tokenFor(member), roomId, message.seq, { reason: '违规' });
    const reportId = created.body.report.id;

    const resolved = await handleReport(tokenFor(admin), reportId, { status: 'resolved' });

    expect(resolved.status).toBe(200);
    expect(resolved.body.report.status).toBe('resolved');
    expect(resolved.body.report.resolvedBy).toBe(admin.id);
    expect(resolved.body.report.resolvedByName).toBe('rep_admin');
    expect(Number.isNaN(Date.parse(resolved.body.report.resolvedAt))).toBe(false);
    // Everything else is untouched by handling.
    expect(resolved.body.report.reason).toBe('违规');
    expect(resolved.body.report.reporterId).toBe(member.id);

    const open = await listReports(tokenFor(admin));
    expect(open.body.total).toBe(0);
    expect(open.body.reports).toEqual([]);

    const all = await listReports(tokenFor(admin), { status: 'all' });
    expect(all.body.total).toBe(1);
    expect(all.body.reports[0].status).toBe('resolved');
  });

  it('dismisses a report and keeps the open queue filtered by status', async () => {
    const { admin, owner, member, roomId } = await seedRoom();
    const kept = await seedMessage(roomId, owner.id, '还开着', 'rep-c10a');
    const dropped = await seedMessage(roomId, owner.id, '将被忽略', 'rep-c10b');
    await fileReport(tokenFor(member), roomId, kept.seq, { reason: '留着' });
    const dismissedReport = await fileReport(tokenFor(member), roomId, dropped.seq, {
      reason: '忽略它',
    });

    const dismissed = await handleReport(tokenFor(admin), dismissedReport.body.report.id, {
      status: 'dismissed',
    });

    expect(dismissed.status).toBe(200);
    expect(dismissed.body.report.status).toBe('dismissed');

    const open = await listReports(tokenFor(admin), { status: 'open' });
    expect(open.body.total).toBe(1);
    expect(open.body.reports[0].messageSeq).toBe(kept.seq);
    expect(open.body.reports[0].status).toBe('open');

    const all = await listReports(tokenFor(admin), { status: 'all' });
    expect(all.body.reports.map((report: { status: string }) => report.status)).toEqual([
      'dismissed',
      'open',
    ]);

    const invalid = await listReports(tokenFor(admin), { status: 'pending' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_INPUT');
  });

  it('allows re-classifying an already handled report', async () => {
    const { admin, owner, member, roomId } = await seedRoom();
    const message = await seedMessage(roomId, owner.id, '改判', 'rep-c11');
    const created = await fileReport(tokenFor(member), roomId, message.seq, { reason: '先判违规' });
    const reportId = created.body.report.id;

    expect((await handleReport(tokenFor(admin), reportId, { status: 'resolved' })).status)
      .toBe(200);
    const again = await handleReport(tokenFor(admin), reportId, { status: 'dismissed' });

    expect(again.status).toBe(200);
    expect(again.body.report.status).toBe('dismissed');
    expect(again.body.report.resolvedBy).toBe(admin.id);

    const entries = await auditEntries(tokenFor(admin), 'report.resolve');
    expect(entries.body.entries).toHaveLength(2);
    expect(entries.body.entries.map((entry: { detail: unknown }) => entry.detail)).toEqual([
      { status: 'dismissed' },
      { status: 'resolved' },
    ]);
  });

  it('answers 404 for an unknown report and 400 for a bad id or status', async () => {
    const { admin } = await seedRoom();
    const token = tokenFor(admin);

    const missing = await handleReport(token, 999_999, { status: 'resolved' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('REPORT_NOT_FOUND');

    const malformed = await handleReport(token, 'abc', { status: 'resolved' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_ID');

    const badStatus = await handleReport(token, 1, { status: 'open' });
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.error.code).toBe('INVALID_INPUT');
  });

  it('rejects the admin endpoints for non-admins', async () => {
    const { owner, member, roomId } = await seedRoom();
    const message = await seedMessage(roomId, owner.id, '只有管理员能看', 'rep-c12');
    const created = await fileReport(tokenFor(member), roomId, message.seq, { reason: '越权测试' });
    const token = tokenFor(member);

    const list = await listReports(token);
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('ADMIN_REQUIRED');

    const handle = await handleReport(token, created.body.report.id, { status: 'resolved' });
    expect(handle.status).toBe(403);
    expect(handle.body.error.code).toBe('ADMIN_REQUIRED');

    const stillOpen = await listReports(tokenFor(await createTestUser('rep_admin2', 'admin')));
    expect(stillOpen.body.reports[0].status).toBe('open');
  });

  it('records the handling admin in the audit log', async () => {
    const { admin, owner, member, roomId } = await seedRoom();
    const message = await seedMessage(roomId, owner.id, '审计用', 'rep-c13');
    const created = await fileReport(tokenFor(member), roomId, message.seq, { reason: '审计' });
    const reportId = created.body.report.id;

    expect((await handleReport(tokenFor(admin), reportId, { status: 'resolved' })).status)
      .toBe(200);

    const entries = await auditEntries(tokenFor(admin), 'report.resolve');

    expect(entries.status).toBe(200);
    expect(entries.body.entries).toEqual([
      {
        id: expect.any(Number),
        actorId: admin.id,
        actorName: 'rep_admin',
        action: 'report.resolve',
        targetType: 'report',
        targetId: reportId,
        detail: { status: 'resolved' },
        createdAt: expect.any(String),
      },
    ]);
  });
});
