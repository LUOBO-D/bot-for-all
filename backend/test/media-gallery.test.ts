import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool, type ResultSetHeader } from '../src/db';
import { joinRoom } from '../src/services/room';
import type { RoomAttachmentDTO } from '../src/services/message';
import type { AuthUser } from '../src/types';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

let owner: AuthUser;
let member: AuthUser;
let outsider: AuthUser;
let roomId: number;
let otherRoomId: number;

beforeEach(async () => {
  owner = await createTestUser(`gallery_owner_${randomBytes(3).toString('hex')}`);
  member = await createTestUser(`gallery_member_${randomBytes(3).toString('hex')}`);
  outsider = await createTestUser(`gallery_outsider_${randomBytes(3).toString('hex')}`);
  roomId = await createTestRoom(owner);
  otherRoomId = await createTestRoom(owner);
  // `member` only belongs to roomId; `outsider` belongs to neither room.
  await joinRoom(member.id, roomId);
});

function gallery(
  actor: AuthUser | null,
  room: number = roomId,
  query: Record<string, string | number> = {},
): request.Test {
  const req = request(app).get(`/api/rooms/${room}/attachments`).query(query);
  if (actor) {
    req.set('Authorization', `Bearer ${tokenFor(actor)}`);
  }
  return req;
}

/** Posts a message row directly; `seq` is explicit so jumps stay predictable. */
async function insertMessage(
  room: number,
  sender: AuthUser,
  seq: number,
  options: { deleted?: boolean; createdAt?: string } = {},
): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO messages
       (room_id, seq, sender_id, sender_type, content, status, deleted_at, created_at)
     VALUES (?, ?, ?, 'user', ?, 'done', ?, ?)`,
    [
      room,
      seq,
      sender.id,
      `message-${seq}`,
      options.deleted ? new Date() : null,
      options.createdAt ?? new Date(),
    ],
  );
  return result.insertId;
}

interface AttachmentFixture {
  room?: number;
  uploader?: AuthUser;
  messageId: number | null;
  filename: string;
  mime: string;
  size?: number;
  createdAt?: Date;
}

/** Rows are enough for the listing: it never touches the bytes on disk. */
async function insertAttachment(fixture: AttachmentFixture): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO message_attachments
       (room_id, uploader_id, message_id, filename, stored_name, mime, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixture.room ?? roomId,
      (fixture.uploader ?? owner).id,
      fixture.messageId,
      fixture.filename,
      randomBytes(24).toString('hex'),
      fixture.mime,
      fixture.size ?? 1024,
      fixture.createdAt ?? new Date(),
    ],
  );
  return result.insertId;
}

/** Uploads one file per message and returns the attachment ids in order. */
async function seedFiles(
  files: Array<{ filename: string; mime: string; sender?: AuthUser }>,
  room: number = roomId,
): Promise<number[]> {
  const ids: number[] = [];
  for (const [index, file] of files.entries()) {
    const sender = file.sender ?? owner;
    const messageId = await insertMessage(room, sender, index + 1);
    ids.push(
      await insertAttachment({
        room,
        uploader: sender,
        messageId,
        filename: file.filename,
        mime: file.mime,
      }),
    );
  }
  return ids;
}

function ids(attachments: RoomAttachmentDTO[]): number[] {
  return attachments.map((attachment) => attachment.id);
}

/** One backdated message carrying one attachment, so day windows stay fixed. */
async function seedDated(
  seq: number,
  sender: AuthUser,
  createdAt: string,
  file: { filename: string; mime: string },
  options: { deleted?: boolean } = {},
): Promise<number> {
  const messageId = await insertMessage(roomId, sender, seq, {
    createdAt,
    deleted: options.deleted,
  });
  return insertAttachment({
    messageId,
    uploader: sender,
    filename: file.filename,
    mime: file.mime,
  });
}

describe('room media gallery', () => {
  it('lists images newest-first with sender, message seq and url', async () => {
    const firstMessage = await insertMessage(roomId, owner, 1);
    const first = await insertAttachment({
      messageId: firstMessage,
      filename: 'first.png',
      mime: 'image/png',
      size: 2048,
    });
    const secondMessage = await insertMessage(roomId, member, 2);
    const second = await insertAttachment({
      messageId: secondMessage,
      uploader: member,
      filename: 'second.jpg',
      mime: 'image/jpeg',
    });

    const response = await gallery(member, roomId, { type: 'image' });

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    const attachments = response.body.attachments as RoomAttachmentDTO[];
    expect(ids(attachments)).toEqual([second, first]);

    const newest = attachments[0];
    expect(newest).toMatchObject({
      id: second,
      filename: 'second.jpg',
      mime: 'image/jpeg',
      size: 1024,
      messageSeq: 2,
      senderName: member.displayName,
      url: `/api/rooms/${roomId}/attachments/${second}`,
    });
    // MySQL DATETIME(3) surfaces as an ISO 8601 string for the client.
    expect(newest.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(attachments[1]).toMatchObject({
      id: first,
      filename: 'first.png',
      size: 2048,
      messageSeq: 1,
      senderName: owner.displayName,
    });
  });

  it('buckets video, audio and everything else into separate filters', async () => {
    const [imageId, audioId, videoId, pdfId, textId] = await seedFiles([
      { filename: 'photo.png', mime: 'image/png' },
      { filename: 'clip.mp3', mime: 'audio/mpeg' },
      { filename: 'clip.mp4', mime: 'video/mp4' },
      { filename: 'report.pdf', mime: 'application/pdf' },
      { filename: 'notes.txt', mime: 'text/plain' },
    ]);

    const audio = await gallery(member, roomId, { type: 'audio' });
    expect(audio.status).toBe(200);
    expect(audio.body.total).toBe(1);
    expect(ids(audio.body.attachments)).toEqual([audioId]);

    const video = await gallery(member, roomId, { type: 'video' });
    expect(video.status).toBe(200);
    expect(video.body.total).toBe(1);
    expect(ids(video.body.attachments)).toEqual([videoId]);

    const files = await gallery(member, roomId, { type: 'file' });
    expect(files.status).toBe(200);
    expect(files.body.total).toBe(2);
    // Newest first, and no image/audio/video leaks in.
    expect(ids(files.body.attachments)).toEqual([textId, pdfId]);
    expect(
      (files.body.attachments as RoomAttachmentDTO[]).every(
        (attachment) => !attachment.mime.startsWith('image/'),
      ),
    ).toBe(true);
    expect(
      (files.body.attachments as RoomAttachmentDTO[]).every(
        (attachment) =>
          !attachment.mime.startsWith('audio/') &&
          !attachment.mime.startsWith('video/'),
      ),
    ).toBe(true);

    const all = await gallery(member, roomId, { type: 'all' });
    expect(all.body.total).toBe(5);
    expect(ids(all.body.attachments)).toEqual([textId, pdfId, videoId, audioId, imageId]);

    // The default is `all`, and an omitted `type` matches it exactly.
    const defaults = await gallery(member);
    expect(defaults.body.total).toBe(5);
    expect(ids(defaults.body.attachments)).toEqual([textId, pdfId, videoId, audioId, imageId]);
  });

  it('excludes unbound uploads and attachments of withdrawn messages', async () => {
    const liveMessage = await insertMessage(roomId, owner, 1);
    const live = await insertAttachment({
      messageId: liveMessage,
      filename: 'live.png',
      mime: 'image/png',
    });
    const withdrawnMessage = await insertMessage(roomId, owner, 2, { deleted: true });
    await insertAttachment({
      messageId: withdrawnMessage,
      filename: 'withdrawn.png',
      mime: 'image/png',
    });
    // Uploaded but never sent: private to its uploader, so the library hides it.
    await insertAttachment({
      messageId: null,
      filename: 'draft.png',
      mime: 'image/png',
    });

    const response = await gallery(owner, roomId, { type: 'image' });

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(ids(response.body.attachments)).toEqual([live]);

    // Every bucket agrees: the excluded rows are not counted anywhere.
    const all = await gallery(owner, roomId, { type: 'all' });
    expect(all.body.total).toBe(1);
    expect(ids(all.body.attachments)).toEqual([live]);
    for (const type of ['file', 'audio', 'video']) {
      const bucket = await gallery(owner, roomId, { type });
      expect(bucket.body.total).toBe(0);
      expect(bucket.body.attachments).toEqual([]);
    }
  });

  it('narrows by sender and ANDs it with the type bucket', async () => {
    const ownerImage = await seedDated(1, owner, '2024-06-15 12:00:00.000', {
      filename: 'owner.png',
      mime: 'image/png',
    });
    const memberImage = await seedDated(2, member, '2024-06-15 13:00:00.000', {
      filename: 'member.png',
      mime: 'image/png',
    });
    const memberPdf = await seedDated(3, member, '2024-06-15 14:00:00.000', {
      filename: 'member.pdf',
      mime: 'application/pdf',
    });

    const fromMember = await gallery(member, roomId, { senderId: member.id });
    expect(fromMember.status).toBe(200);
    expect(fromMember.body.total).toBe(2);
    expect(ids(fromMember.body.attachments)).toEqual([memberPdf, memberImage]);

    const memberImages = await gallery(member, roomId, { senderId: member.id, type: 'image' });
    expect(memberImages.body.total).toBe(1);
    expect(ids(memberImages.body.attachments)).toEqual([memberImage]);

    const fromOwner = await gallery(member, roomId, { senderId: owner.id });
    expect(fromOwner.body.total).toBe(1);
    expect(ids(fromOwner.body.attachments)).toEqual([ownerImage]);

    // `senderId` is a value filter, not a membership gate: a member who never
    // posted and a user outside the room both simply match nothing.
    const quiet = await createTestUser(`gallery_quiet_${randomBytes(3).toString('hex')}`);
    await joinRoom(quiet.id, roomId);
    const noPosts = await gallery(member, roomId, { senderId: quiet.id });
    expect(noPosts.status).toBe(200);
    expect(noPosts.body.total).toBe(0);
    expect(noPosts.body.attachments).toEqual([]);

    const nonMember = await gallery(member, roomId, { senderId: outsider.id });
    expect(nonMember.status).toBe(200);
    expect(nonMember.body.total).toBe(0);
    expect(nonMember.body.attachments).toEqual([]);
  });

  it('matches file names as literal substrings and escapes LIKE metacharacters', async () => {
    const [percent, plainHundred, underscore, plainX, backslash, plainSlash, upper] =
      await seedFiles([
        { filename: '100% done.png', mime: 'image/png' },
        { filename: '100x done.png', mime: 'image/png' },
        { filename: 'a_b.txt', mime: 'text/plain' },
        { filename: 'axb.txt', mime: 'text/plain' },
        { filename: 'back\\slash.txt', mime: 'text/plain' },
        { filename: 'backslash.txt', mime: 'text/plain' },
        { filename: 'Holiday.PNG', mime: 'image/png' },
      ]);

    // `%` is an escaped literal, so it must not act as a wildcard.
    const percentMatch = await gallery(member, roomId, { q: '100%' });
    expect(percentMatch.status).toBe(200);
    expect(percentMatch.body.total).toBe(1);
    expect(ids(percentMatch.body.attachments)).toEqual([percent]);
    expect(ids(percentMatch.body.attachments)).not.toContain(plainHundred);

    // `_` matches the underscore itself, not any one character.
    const underscoreMatch = await gallery(member, roomId, { q: 'a_b' });
    expect(underscoreMatch.body.total).toBe(1);
    expect(ids(underscoreMatch.body.attachments)).toEqual([underscore]);
    expect(ids(underscoreMatch.body.attachments)).not.toContain(plainX);

    // A backslash is escaped too; it cannot swallow the next character.
    const backslashMatch = await gallery(member, roomId, { q: 'back\\slash' });
    expect(backslashMatch.body.total).toBe(1);
    expect(ids(backslashMatch.body.attachments)).toEqual([backslash]);
    expect(ids(backslashMatch.body.attachments)).not.toContain(plainSlash);

    // The match is a substring, and the schema's collation makes it case-blind.
    const holiday = await gallery(member, roomId, { q: 'holiDAY' });
    expect(holiday.body.total).toBe(1);
    expect(ids(holiday.body.attachments)).toEqual([upper]);
  });

  it('ANDs the name filter with sender, day and type while total counts the filtered set', async () => {
    const oldest = await seedDated(1, member, '2024-06-15 12:00:00.000', {
      filename: 'report-final.pdf',
      mime: 'application/pdf',
    });
    const middle = await seedDated(2, member, '2024-06-15 13:00:00.000', {
      filename: 'report-draft.pdf',
      mime: 'application/pdf',
    });
    const newest = await seedDated(3, member, '2024-06-15 14:00:00.000', {
      filename: 'report-scan.pdf',
      mime: 'application/pdf',
    });
    await seedDated(4, owner, '2024-06-15 12:00:00.000', {
      filename: 'report-other.pdf',
      mime: 'application/pdf',
    });
    await seedDated(5, member, '2024-06-15 12:00:00.000', {
      filename: 'report.png',
      mime: 'image/png',
    });
    await seedDated(6, member, '2024-01-01 12:00:00.000', {
      filename: 'report-old.pdf',
      mime: 'application/pdf',
    });
    await seedDated(
      7,
      member,
      '2024-06-15 12:00:00.000',
      { filename: 'report-hidden.pdf', mime: 'application/pdf' },
      { deleted: true },
    );
    // Unbound upload: no message, so no sender, day or live row.
    await insertAttachment({
      messageId: null,
      uploader: member,
      filename: 'report-draft.pdf',
      mime: 'application/pdf',
    });

    const query = {
      q: 'report',
      senderId: member.id,
      from: '2024-06-01',
      to: '2024-06-30',
      type: 'file',
    };
    const combined = await gallery(member, roomId, query);
    expect(combined.status).toBe(200);
    expect(combined.body.total).toBe(3);
    // Newest-first by attachment id, which follows insertion order.
    expect(ids(combined.body.attachments)).toEqual([newest, middle, oldest]);

    // Pagination walks the same filtered set; `total` never leaks the decoys.
    const secondPage = await gallery(member, roomId, {
      ...query,
      limit: 1,
      offset: 1,
    });
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.total).toBe(3);
    expect(ids(secondPage.body.attachments)).toEqual([middle]);

    const none = await gallery(member, roomId, { ...query, q: 'no-such-name' });
    expect(none.status).toBe(200);
    expect(none.body.total).toBe(0);
    expect(none.body.attachments).toEqual([]);
  });

  it('includes the whole UTC day at both ends of the message window', async () => {
    const before = await seedDated(1, owner, '2024-06-14 23:59:59.999', {
      filename: 'before.png',
      mime: 'image/png',
    });
    const start = await seedDated(2, owner, '2024-06-15 00:00:00.000', {
      filename: 'start.png',
      mime: 'image/png',
    });
    const end = await seedDated(3, owner, '2024-06-15 23:59:59.999', {
      filename: 'end.png',
      mime: 'image/png',
    });
    const after = await seedDated(4, owner, '2024-06-16 00:00:00.000', {
      filename: 'after.png',
      mime: 'image/png',
    });

    const day = await gallery(member, roomId, { from: '2024-06-15', to: '2024-06-15' });
    expect(day.status).toBe(200);
    expect(day.body.total).toBe(2);
    expect(ids(day.body.attachments)).toEqual([end, start]);

    // Each bound alone is inclusive too, and `total` follows the same WHERE.
    const fromOnly = await gallery(member, roomId, { from: '2024-06-15' });
    expect(fromOnly.body.total).toBe(3);
    expect(ids(fromOnly.body.attachments)).toEqual([after, end, start]);

    const toOnly = await gallery(member, roomId, { to: '2024-06-15' });
    expect(toOnly.body.total).toBe(3);
    expect(ids(toOnly.body.attachments)).toEqual([end, start, before]);
  });

  it('ANDs sender, day and type while keeping the usual exclusions', async () => {
    const target = await seedDated(1, member, '2024-06-15 12:00:00.000', {
      filename: 'target.png',
      mime: 'image/png',
    });
    await seedDated(2, member, '2024-01-01 12:00:00.000', {
      filename: 'too-old.png',
      mime: 'image/png',
    });
    await seedDated(3, owner, '2024-06-15 12:00:00.000', {
      filename: 'wrong-sender.png',
      mime: 'image/png',
    });
    await seedDated(4, member, '2024-06-15 13:00:00.000', {
      filename: 'wrong-type.pdf',
      mime: 'application/pdf',
    });
    await seedDated(
      5,
      member,
      '2024-06-15 14:00:00.000',
      { filename: 'withdrawn.png', mime: 'image/png' },
      { deleted: true },
    );
    // Unbound upload: no message means no sender and no day, so it never joins.
    await insertAttachment({
      messageId: null,
      uploader: member,
      filename: 'draft.png',
      mime: 'image/png',
    });

    const combined = await gallery(member, roomId, {
      senderId: member.id,
      from: '2024-06-01',
      to: '2024-06-30',
      type: 'image',
    });
    expect(combined.status).toBe(200);
    expect(combined.body.total).toBe(1);
    expect(ids(combined.body.attachments)).toEqual([target]);

    // Pagination walks the filtered set, and `total` stays the filtered count.
    const memberRows = await gallery(member, roomId, { senderId: member.id, limit: 1, offset: 1 });
    expect(memberRows.status).toBe(200);
    expect(memberRows.body.total).toBe(3);
    expect(memberRows.body.attachments).toHaveLength(1);
  });

  it('rejects an inverted day range without leaking rows', async () => {
    await seedFiles([{ filename: 'visible.png', mime: 'image/png' }]);

    const response = await gallery(member, roomId, { from: '2024-06-16', to: '2024-06-15' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_INPUT');
    expect(response.body.error.message).toBe('from must not be after to');
    expect(response.body.attachments).toBeUndefined();
  });

  it('paginates with limit and offset while total counts the whole set', async () => {
    const seeded = await seedFiles(
      Array.from({ length: 5 }, (_, index) => ({
        filename: `image-${index + 1}.png`,
        mime: 'image/png',
      })),
    );

    const firstPage = await gallery(member, roomId, { type: 'image', limit: 2, offset: 0 });
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.total).toBe(5);
    expect(ids(firstPage.body.attachments)).toEqual([seeded[4], seeded[3]]);

    const secondPage = await gallery(member, roomId, { type: 'image', limit: 2, offset: 2 });
    expect(secondPage.body.total).toBe(5);
    expect(ids(secondPage.body.attachments)).toEqual([seeded[2], seeded[1]]);

    const tail = await gallery(member, roomId, { type: 'image', limit: 2, offset: 4 });
    expect(ids(tail.body.attachments)).toEqual([seeded[0]]);

    const past = await gallery(member, roomId, { type: 'image', limit: 2, offset: 5 });
    expect(past.body.total).toBe(5);
    expect(past.body.attachments).toEqual([]);
  });

  it('defaults to 20 rows per page and accepts the maximum of 50', async () => {
    const seeded = await seedFiles(
      Array.from({ length: 21 }, (_, index) => ({
        filename: `scan-${index + 1}.pdf`,
        mime: 'application/pdf',
      })),
    );

    const defaults = await gallery(member, roomId);
    expect(defaults.status).toBe(200);
    expect(defaults.body.total).toBe(21);
    expect(defaults.body.attachments).toHaveLength(20);
    expect(ids(defaults.body.attachments)).toEqual(seeded.slice(1).reverse());

    const capped = await gallery(member, roomId, { limit: 50 });
    expect(capped.status).toBe(200);
    expect(capped.body.attachments).toHaveLength(21);
  });

  it('only lists attachments of the requested room', async () => {
    const here = await seedFiles([{ filename: 'here.png', mime: 'image/png' }]);
    const elsewhere = await seedFiles(
      [{ filename: 'elsewhere.png', mime: 'image/png' }],
      otherRoomId,
    );

    const response = await gallery(owner, roomId);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(ids(response.body.attachments)).toEqual(here);
    expect(ids(response.body.attachments)).not.toContain(elsewhere[0]);
  });

  it('rejects non-members with 403', async () => {
    await seedFiles([{ filename: 'secret.png', mime: 'image/png' }]);

    const response = await gallery(outsider);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
  });

  it('requires authentication', async () => {
    const response = await gallery(null);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects malformed query parameters with 400', async () => {
    const cases: Array<Record<string, string | number>> = [
      { type: 'document' },
      { type: 'IMAGE' },
      { q: '' },
      { q: '   ' },
      { q: 'x'.repeat(101) },
      { limit: 0 },
      { limit: 51 },
      { limit: 'abc' },
      { limit: 1.5 },
      { offset: -1 },
      { offset: 'abc' },
      { senderId: 'abc' },
      { senderId: 0 },
      { senderId: -3 },
      { senderId: 1.5 },
      { from: 'nope' },
      { from: '2024-02-30' },
      { from: '2024-13-01' },
      { from: '2024-1-1' },
      { from: '2024-06-15T00:00:00.000Z' },
      { to: 'yesterday' },
      { to: '2024-06-31' },
    ];

    for (const query of cases) {
      const response = await gallery(member, roomId, query);
      expect(response.status, JSON.stringify(query)).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }

    // The message names the offending field instead of the whole filter list.
    const wrongSender = await gallery(member, roomId, { senderId: 'abc' });
    expect(wrongSender.body.error.message).toBe('senderId must be a positive integer');
    const impossibleDay = await gallery(member, roomId, { to: '2024-06-31' });
    expect(impossibleDay.body.error.message).toBe('to must be a valid YYYY-MM-DD date');
    const blankQuery = await gallery(member, roomId, { q: '   ' });
    expect(blankQuery.body.error.message).toBe('q must be 1-100 characters');
  });
});
