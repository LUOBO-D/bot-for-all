import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { pool, type RowDataPacket } from '../src/db';
import { createMessage } from '../src/services/message';
import { createRoom, joinRoom as joinRoomService } from '../src/services/room';
import type { AuthUser } from '../src/types';
import {
  connectClient,
  createTestUser,
  joinRoom,
  startTestServer,
  tokenFor,
  waitForEvent,
  type TestServer,
} from './helpers';

const app = createApp();

// Attachment files are written under a scratch upload dir per run so the
// admin delete paths can be observed without touching backend/uploads.
let uploadRoot: string;
let originalUploadDir: string;

beforeAll(() => {
  originalUploadDir = config.uploadDir;
  uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bfa-admin-rooms-'));
  config.uploadDir = uploadRoot;
});

beforeEach(() => {
  fs.rmSync(uploadRoot, { recursive: true, force: true });
  fs.mkdirSync(uploadRoot, { recursive: true });
});

afterAll(() => {
  config.uploadDir = originalUploadDir;
  fs.rmSync(uploadRoot, { recursive: true, force: true });
});

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function listRooms(token: string, query: Record<string, string | number> = {}) {
  return request(app)
    .get('/api/admin/rooms')
    .query(query)
    .set('Authorization', bearer(token));
}

function deleteRoom(token: string, roomId: number | string) {
  return request(app)
    .delete(`/api/admin/rooms/${roomId}`)
    .set('Authorization', bearer(token));
}

function getRoomDetail(token: string, roomId: number | string) {
  return request(app)
    .get(`/api/admin/rooms/${roomId}`)
    .set('Authorization', bearer(token));
}

function bulkDeleteRooms(token: string, ids: Array<number | string>) {
  return request(app)
    .post('/api/admin/rooms/bulk-delete')
    .set('Authorization', bearer(token))
    .send({ ids });
}

async function createNamedRoom(
  owner: AuthUser,
  name: string,
  isPublic = true,
): Promise<number> {
  const room = await createRoom(owner.id, { name, isPublic });
  return room.id;
}

async function countFor(
  table: 'rooms' | 'messages' | 'room_members',
  roomId: number,
): Promise<number> {
  const column = table === 'rooms' ? 'id' : 'room_id';
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM ${table} WHERE ${column} = ?`,
    [roomId],
  );
  return Number(rows[0]?.total ?? 0);
}

async function countAttachments(roomId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM message_attachments WHERE room_id = ?',
    [roomId],
  );
  return Number(rows[0]?.total ?? 0);
}

interface AttachmentFixture {
  storedName: string;
  absolute: string;
}

/**
 * Inserts a `message_attachments` row and, unless `onDisk` is false, the
 * matching file under the scratch upload dir. The file name is random because
 * `stored_name` is UNIQUE and the table is only truncated between tests.
 */
async function createAttachment(
  roomId: number,
  uploaderId: number,
  options: { messageId?: number | null; onDisk?: boolean } = {},
): Promise<AttachmentFixture> {
  const storedName = randomBytes(12).toString('hex');
  await pool.execute(
    `INSERT INTO message_attachments
       (room_id, uploader_id, message_id, filename, stored_name, mime, size)
     VALUES (?, ?, ?, 'file.txt', ?, 'text/plain', 6)`,
    [roomId, uploaderId, options.messageId ?? null, storedName],
  );
  const absolute = path.join(uploadRoot, storedName);
  if (options.onDisk !== false) {
    await fs.promises.writeFile(absolute, 'attachment');
  }
  return { storedName, absolute };
}

async function fileExists(absolute: string): Promise<boolean> {
  try {
    await fs.promises.access(absolute);
    return true;
  } catch {
    return false;
  }
}

interface AuditRow extends RowDataPacket {
  actor_id: number;
  action: string;
  target_type: string;
  target_id: number;
  detail: unknown;
}

async function roomDeleteAudits(): Promise<
  Array<{ actorId: number; targetType: string; targetId: number; detail: unknown }>
> {
  const [rows] = await pool.query<AuditRow[]>(
    "SELECT actor_id, action, target_type, target_id, detail FROM admin_audit_log WHERE action = 'room.delete'",
  );
  return rows.map((row) => ({
    actorId: Number(row.actor_id),
    targetType: String(row.target_type),
    targetId: Number(row.target_id),
    detail:
      typeof row.detail === 'string' && row.detail.length > 0
        ? (JSON.parse(row.detail) as unknown)
        : row.detail,
  }));
}

describe('admin rooms', () => {
  it('rejects non-admin access to the room list and delete', async () => {
    const admin = await createTestUser('rooms-admin-guard', 'admin');
    const user = await createTestUser('rooms-plain-guard');
    const roomId = await createNamedRoom(admin, 'guarded-room');

    const listed = await listRooms(tokenFor(user));
    expect(listed.status).toBe(403);

    const removed = await deleteRoom(tokenFor(user), roomId);
    expect(removed.status).toBe(403);
    expect(await countFor('rooms', roomId)).toBe(1);
  });

  it('lists rooms newest first with owner, member and message counts', async () => {
    const admin = await createTestUser('rooms-admin-list', 'admin');
    const owner = await createTestUser('rooms-owner-list');
    await pool.execute('UPDATE users SET display_name = ? WHERE id = ?', [
      'Owner Display',
      owner.id,
    ]);
    const member = await createTestUser('rooms-member-list');

    const olderRoom = await createNamedRoom(owner, 'Alpha Room');
    const newerRoom = await createNamedRoom(owner, 'Beta Room', false);
    await joinRoomService(member.id, olderRoom);
    await createMessage({
      roomId: olderRoom,
      senderId: owner.id,
      senderType: 'user',
      content: 'first',
    });
    await createMessage({
      roomId: olderRoom,
      senderId: owner.id,
      senderType: 'user',
      content: 'second',
    });

    const firstPage = await listRooms(tokenFor(admin), { limit: 1, offset: 0 });
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.total).toBe(2);
    expect(firstPage.body.limit).toBe(1);
    expect(firstPage.body.offset).toBe(0);
    expect(firstPage.body.rooms).toHaveLength(1);
    expect(firstPage.body.rooms[0]).toMatchObject({
      id: newerRoom,
      name: 'Beta Room',
      ownerId: owner.id,
      ownerName: 'Owner Display',
      isPublic: false,
      memberCount: 1,
      messageCount: 0,
    });
    expect(typeof firstPage.body.rooms[0].createdAt).toBe('string');

    const secondPage = await listRooms(tokenFor(admin), { limit: 1, offset: 1 });
    expect(secondPage.body.rooms).toHaveLength(1);
    expect(secondPage.body.rooms[0]).toMatchObject({
      id: olderRoom,
      name: 'Alpha Room',
      ownerId: owner.id,
      ownerName: 'Owner Display',
      isPublic: true,
      memberCount: 2,
      messageCount: 2,
    });
    expect(Object.keys(secondPage.body.rooms[0]).sort()).toEqual(
      [
        'createdAt',
        'id',
        'isPublic',
        'memberCount',
        'messageCount',
        'name',
        'ownerId',
        'ownerName',
      ].sort(),
    );
  });

  it('defaults paging and rejects out-of-range values', async () => {
    const admin = await createTestUser('rooms-admin-paging', 'admin');
    await createNamedRoom(admin, 'paging-room');

    const defaults = await listRooms(tokenFor(admin));
    expect(defaults.status).toBe(200);
    expect(defaults.body.limit).toBe(50);
    expect(defaults.body.offset).toBe(0);
    expect(defaults.body.total).toBe(1);

    expect((await listRooms(tokenFor(admin), { limit: 0 })).status).toBe(400);
    expect((await listRooms(tokenFor(admin), { offset: -1 })).status).toBe(400);
  });

  it('searches room names and treats LIKE wildcards as literal characters', async () => {
    const admin = await createTestUser('rooms-admin-search', 'admin');
    const literalRoom = await createNamedRoom(admin, 'a%b_c');
    const wildcardRoom = await createNamedRoom(admin, 'axbxc');
    await createNamedRoom(admin, 'unrelated');

    const literal = await listRooms(tokenFor(admin), { q: 'a%b_c' });
    expect(literal.status).toBe(200);
    expect(literal.body.total).toBe(1);
    expect(literal.body.rooms[0].id).toBe(literalRoom);

    const partial = await listRooms(tokenFor(admin), { q: 'a' });
    expect(partial.body.total).toBe(3);

    const underscore = await listRooms(tokenFor(admin), { q: 'a_b' });
    expect(underscore.body.total).toBe(0);

    const noMatch = await listRooms(tokenFor(admin), { q: 'zzz' });
    expect(noMatch.body).toMatchObject({ rooms: [], total: 0 });
    expect(wildcardRoom).toBeGreaterThan(literalRoom);
  });

  it('returns full room details including topic, announcement and settings', async () => {
    const admin = await createTestUser('rooms-admin-detail', 'admin');
    const owner = await createTestUser('rooms-owner-detail');
    await pool.execute('UPDATE users SET display_name = ? WHERE id = ?', [
      'Detail Owner',
      owner.id,
    ]);
    const member = await createTestUser('rooms-member-detail');
    const roomId = await createNamedRoom(owner, 'detail-room');
    await joinRoomService(member.id, roomId);
    await pool.execute(
      `UPDATE rooms
          SET topic = ?, announcement = ?, retention_days = ?, slow_mode_seconds = ?,
              is_public = 0
        WHERE id = ?`,
      ['weekly sync', 'Read the rules first', 30, 10, roomId],
    );
    await createMessage({
      roomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'hello',
    });
    await createMessage({
      roomId,
      senderId: member.id,
      senderType: 'user',
      content: 'hi',
    });

    const response = await getRoomDetail(tokenFor(admin), roomId);
    expect(response.status).toBe(200);
    expect(response.body.room).toMatchObject({
      id: roomId,
      name: 'detail-room',
      topic: 'weekly sync',
      announcement: 'Read the rules first',
      ownerId: owner.id,
      ownerName: 'Detail Owner',
      isPublic: false,
      memberCount: 2,
      messageCount: 2,
      retentionDays: 30,
      slowModeSeconds: 10,
    });
    expect(typeof response.body.room.createdAt).toBe('string');
    expect(Object.keys(response.body.room).sort()).toEqual(
      [
        'announcement',
        'createdAt',
        'id',
        'isPublic',
        'memberCount',
        'messageCount',
        'name',
        'ownerId',
        'ownerName',
        'retentionDays',
        'slowModeSeconds',
        'topic',
      ].sort(),
    );
  });

  it('rejects non-admin room detail access and returns 404 for unknown rooms', async () => {
    const admin = await createTestUser('rooms-admin-detail-guard', 'admin');
    const user = await createTestUser('rooms-plain-detail-guard');
    const roomId = await createNamedRoom(admin, 'guarded-detail-room');

    expect((await getRoomDetail(tokenFor(user), roomId)).status).toBe(403);

    const missing = await getRoomDetail(tokenFor(admin), 987654321);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: 'ROOM_NOT_FOUND' } });

    const malformed = await getRoomDetail(tokenFor(admin), 'not-an-id');
    expect(malformed.status).toBe(400);
  });

  it('deletes a room, cascades rows and records an audit entry', async () => {
    const admin = await createTestUser('rooms-admin-delete', 'admin');
    const owner = await createTestUser('rooms-owner-delete');
    const member = await createTestUser('rooms-member-delete');
    const roomId = await createNamedRoom(owner, 'doomed-room');
    const otherRoomId = await createNamedRoom(owner, 'survivor-room');
    await joinRoomService(member.id, roomId);
    const message = await createMessage({
      roomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'to be deleted',
    });
    await pool.execute(
      'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)',
      [message.id, member.id, '👍'],
    );

    expect(await countFor('room_members', roomId)).toBe(2);
    expect(await countFor('messages', roomId)).toBe(1);

    const response = await deleteRoom(tokenFor(admin), roomId);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });

    expect(await countFor('rooms', roomId)).toBe(0);
    expect(await countFor('room_members', roomId)).toBe(0);
    expect(await countFor('messages', roomId)).toBe(0);
    const [reactionRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM message_reactions WHERE message_id = ?',
      [message.id],
    );
    expect(Number(reactionRows[0]?.total ?? 0)).toBe(0);

    // Unrelated rooms stay untouched.
    expect(await countFor('rooms', otherRoomId)).toBe(1);

    const audits = await roomDeleteAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: admin.id,
      targetType: 'room',
      targetId: roomId,
      detail: { name: 'doomed-room', ownerId: owner.id },
    });
  });

  it('returns 404 for unknown rooms and writes no audit entry', async () => {
    const admin = await createTestUser('rooms-admin-missing', 'admin');

    const response = await deleteRoom(tokenFor(admin), 987654321);
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'ROOM_NOT_FOUND' } });

    expect(await roomDeleteAudits()).toHaveLength(0);
  });

  it('removes attachment files of a deleted room and ignores missing files', async () => {
    const admin = await createTestUser('rooms-admin-attach', 'admin');
    const owner = await createTestUser('rooms-owner-attach');
    const roomId = await createNamedRoom(owner, 'attachment-room');
    const otherRoomId = await createNamedRoom(owner, 'attachment-survivor');
    const message = await createMessage({
      roomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'with attachment',
    });
    const bound = await createAttachment(roomId, owner.id, { messageId: message.id });
    const unbound = await createAttachment(roomId, owner.id);
    const missing = await createAttachment(roomId, owner.id, { onDisk: false });
    const survivor = await createAttachment(otherRoomId, owner.id);

    expect(await countAttachments(roomId)).toBe(3);

    const response = await deleteRoom(tokenFor(admin), roomId);
    expect(response.status).toBe(200);

    expect(await countAttachments(roomId)).toBe(0);
    expect(await fileExists(bound.absolute)).toBe(false);
    expect(await fileExists(unbound.absolute)).toBe(false);
    // A row whose file was already gone must not fail the delete.
    expect(await fileExists(missing.absolute)).toBe(false);

    // Another room's attachment row and file stay untouched.
    expect(await countAttachments(otherRoomId)).toBe(1);
    expect(await fileExists(survivor.absolute)).toBe(true);
  });

  it('bulk deletes rooms once each, clears files and records bulk audits', async () => {
    const admin = await createTestUser('rooms-admin-bulk', 'admin');
    const owner = await createTestUser('rooms-owner-bulk');
    const firstRoomId = await createNamedRoom(owner, 'bulk-one');
    const secondRoomId = await createNamedRoom(owner, 'bulk-two');
    const survivorRoomId = await createNamedRoom(owner, 'bulk-survivor');
    const firstFile = await createAttachment(firstRoomId, owner.id);
    const message = await createMessage({
      roomId: secondRoomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'bulk message',
    });
    const secondFile = await createAttachment(secondRoomId, owner.id, {
      messageId: message.id,
    });
    const survivorFile = await createAttachment(survivorRoomId, owner.id);

    const response = await bulkDeleteRooms(tokenFor(admin), [
      firstRoomId,
      secondRoomId,
      firstRoomId,
    ]);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: 2 });

    expect(await countFor('rooms', firstRoomId)).toBe(0);
    expect(await countFor('rooms', secondRoomId)).toBe(0);
    expect(await countFor('messages', secondRoomId)).toBe(0);
    expect(await countAttachments(firstRoomId)).toBe(0);
    expect(await countAttachments(secondRoomId)).toBe(0);
    expect(await fileExists(firstFile.absolute)).toBe(false);
    expect(await fileExists(secondFile.absolute)).toBe(false);

    expect(await countFor('rooms', survivorRoomId)).toBe(1);
    expect(await countAttachments(survivorRoomId)).toBe(1);
    expect(await fileExists(survivorFile.absolute)).toBe(true);

    const audits = await roomDeleteAudits();
    expect(audits).toHaveLength(2);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: admin.id,
          targetType: 'room',
          targetId: firstRoomId,
          detail: { name: 'bulk-one', ownerId: owner.id, bulk: true },
        }),
        expect.objectContaining({
          actorId: admin.id,
          targetType: 'room',
          targetId: secondRoomId,
          detail: { name: 'bulk-two', ownerId: owner.id, bulk: true },
        }),
      ]),
    );
  });

  it('rolls back the whole bulk when any room id is missing', async () => {
    const admin = await createTestUser('rooms-admin-bulk-missing', 'admin');
    const owner = await createTestUser('rooms-owner-bulk-missing');
    const roomId = await createNamedRoom(owner, 'bulk-rollback');
    const attachment = await createAttachment(roomId, owner.id);

    const response = await bulkDeleteRooms(tokenFor(admin), [roomId, 987654321]);
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'ROOM_NOT_FOUND' } });

    expect(await countFor('rooms', roomId)).toBe(1);
    expect(await countAttachments(roomId)).toBe(1);
    expect(await fileExists(attachment.absolute)).toBe(true);
    expect(await roomDeleteAudits()).toHaveLength(0);
  });

  it('rejects malformed bulk id lists', async () => {
    const admin = await createTestUser('rooms-admin-bulk-input', 'admin');

    for (const ids of [
      [],
      ['1'],
      Array.from({ length: 101 }, (_value, index) => index + 1),
    ]) {
      const response = await bulkDeleteRooms(tokenFor(admin), ids);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    }

    const noBody = await request(app)
      .post('/api/admin/rooms/bulk-delete')
      .set('Authorization', bearer(tokenFor(admin)))
      .send({});
    expect(noBody.status).toBe(400);
    expect(noBody.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('rejects non-admin access to bulk delete', async () => {
    const admin = await createTestUser('rooms-admin-bulk-guard', 'admin');
    const user = await createTestUser('rooms-plain-bulk-guard');
    const roomId = await createNamedRoom(admin, 'bulk-guarded-room');

    const response = await bulkDeleteRooms(tokenFor(user), [roomId]);
    expect(response.status).toBe(403);
    expect(await countFor('rooms', roomId)).toBe(1);
  });

  describe('socket revocation', () => {
    let server: TestServer;
    const clients: Socket[] = [];

    beforeAll(async () => {
      server = await startTestServer();
    });

    afterAll(async () => {
      await server.close();
    });

    afterEach(() => {
      for (const client of clients) {
        client.close();
      }
      clients.length = 0;
    });

    it('broadcasts room:revoked to the room before deletion', async () => {
      const admin = await createTestUser('rooms-admin-socket', 'admin');
      const owner = await createTestUser('rooms-owner-socket');
      const roomId = await createNamedRoom(owner, 'socket-room');

      const client = await connectClient(server.url, tokenFor(owner));
      clients.push(client);
      await joinRoom(client, roomId);

      const revoked = waitForEvent<{ roomId: number }>(
        client,
        'room:revoked',
        (payload) => payload.roomId === roomId,
      );
      const response = await deleteRoom(tokenFor(admin), roomId);
      expect(response.status).toBe(200);

      await expect(revoked).resolves.toEqual({ roomId });
      expect(await countFor('rooms', roomId)).toBe(0);
    });

    it('broadcasts room:revoked for every room in a bulk delete', async () => {
      const admin = await createTestUser('rooms-admin-bulk-socket', 'admin');
      const firstOwner = await createTestUser('rooms-owner-bulk-socket-a');
      const secondOwner = await createTestUser('rooms-owner-bulk-socket-b');
      const firstRoomId = await createNamedRoom(firstOwner, 'bulk-socket-a');
      const secondRoomId = await createNamedRoom(secondOwner, 'bulk-socket-b');

      const firstClient = await connectClient(server.url, tokenFor(firstOwner));
      const secondClient = await connectClient(server.url, tokenFor(secondOwner));
      clients.push(firstClient, secondClient);
      await joinRoom(firstClient, firstRoomId);
      await joinRoom(secondClient, secondRoomId);

      const firstRevoked = waitForEvent<{ roomId: number }>(
        firstClient,
        'room:revoked',
        (payload) => payload.roomId === firstRoomId,
      );
      const secondRevoked = waitForEvent<{ roomId: number }>(
        secondClient,
        'room:revoked',
        (payload) => payload.roomId === secondRoomId,
      );
      const response = await bulkDeleteRooms(tokenFor(admin), [firstRoomId, secondRoomId]);
      expect(response.status).toBe(200);

      await expect(firstRevoked).resolves.toEqual({ roomId: firstRoomId });
      await expect(secondRevoked).resolves.toEqual({ roomId: secondRoomId });
      expect(await countFor('rooms', firstRoomId)).toBe(0);
      expect(await countFor('rooms', secondRoomId)).toBe(0);
    });
  });
});
