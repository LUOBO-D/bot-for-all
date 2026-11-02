import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, type RowDataPacket } from '../src/db';
import { createMessage, deleteMessage } from '../src/services/message';
import { createRoom, joinRoom } from '../src/services/room';
import type { AuthUser, MessageDTO } from '../src/types';
import { createTestUser, startTestServer, tokenFor, type TestServer } from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

// test/setup.ts truncates the core tables but not saved_messages, so clear the
// bookmarks here: leftover rows would otherwise point at recycled user and
// message ids in the next test.
beforeEach(async () => {
  await pool.execute('DELETE FROM saved_messages');
});

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

function save(roomId: number, seq: number, actor: AuthUser): Promise<request.Response> {
  return request(server.url)
    .post(`/api/rooms/${roomId}/messages/${seq}/save`)
    .set('Authorization', auth(actor));
}

function unsave(roomId: number, seq: number, actor: AuthUser): Promise<request.Response> {
  return request(server.url)
    .delete(`/api/rooms/${roomId}/messages/${seq}/save`)
    .set('Authorization', auth(actor));
}

function listSaved(actor: AuthUser, query = ''): Promise<request.Response> {
  return request(server.url).get(`/api/me/saved${query}`).set('Authorization', auth(actor));
}

async function savedCount(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM saved_messages WHERE user_id = ?',
    [userId],
  );
  return Number(rows[0].total);
}

async function backdateSave(userId: number, messageId: number, createdAt: string): Promise<void> {
  await pool.execute(
    'UPDATE saved_messages SET created_at = ? WHERE user_id = ? AND message_id = ?',
    [createdAt, userId, messageId],
  );
}

describe('saved messages', () => {
  it('saves a message and stays idempotent on a repeated save', async () => {
    const owner = await createTestUser('save_owner');
    const member = await createTestUser('save_member');
    const room = await createRoom(owner.id, { name: 'save-room', isPublic: true });
    await joinRoom(member.id, room.id);
    // Saving somebody else's message is allowed for any member.
    const message = await createMessage({
      roomId: room.id,
      senderId: member.id,
      senderType: 'user',
      content: 'remember this',
    });

    const first = await save(room.id, message.seq, owner);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ saved: true });
    expect(await savedCount(owner.id)).toBe(1);

    const second = await save(room.id, message.seq, owner);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ saved: true });
    expect(await savedCount(owner.id)).toBe(1);

    // The sender's own bookmark set is untouched by the other member.
    expect(await savedCount(member.id)).toBe(0);
  });

  it('removes a bookmark and stays idempotent when repeated', async () => {
    const owner = await createTestUser('unsave_owner');
    const room = await createRoom(owner.id, { name: 'unsave-room', isPublic: true });
    const message = await createMessage({
      roomId: room.id,
      senderId: owner.id,
      senderType: 'user',
      content: 'bookmarked then dropped',
    });
    await save(room.id, message.seq, owner);
    expect(await savedCount(owner.id)).toBe(1);

    const first = await unsave(room.id, message.seq, owner);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ saved: false });
    expect(await savedCount(owner.id)).toBe(0);

    const second = await unsave(room.id, message.seq, owner);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ saved: false });
    expect(await savedCount(owner.id)).toBe(0);
  });

  it('rejects a non-member with 403 NOT_MEMBER', async () => {
    const owner = await createTestUser('save_nm_owner');
    const outsider = await createTestUser('save_nm_outsider');
    const room = await createRoom(owner.id, { name: 'save-nm', isPublic: true });
    const message = await createMessage({
      roomId: room.id,
      senderId: owner.id,
      senderType: 'user',
      content: 'members only',
    });

    const response = await save(room.id, message.seq, outsider);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
    expect(await savedCount(outsider.id)).toBe(0);

    const removal = await unsave(room.id, message.seq, outsider);
    expect(removal.status).toBe(403);
    expect(removal.body.error.code).toBe('NOT_MEMBER');
  });

  it('rejects a withdrawn message with 400 MESSAGE_DELETED', async () => {
    const owner = await createTestUser('save_del_owner');
    const room = await createRoom(owner.id, { name: 'save-del', isPublic: true });
    const message = await createMessage({
      roomId: room.id,
      senderId: owner.id,
      senderType: 'user',
      content: 'gone soon',
    });
    await deleteMessage(room.id, message.seq, owner.id, false);

    const response = await save(room.id, message.seq, owner);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MESSAGE_DELETED');
    expect(await savedCount(owner.id)).toBe(0);
  });

  it('returns 404 for a message that does not exist', async () => {
    const owner = await createTestUser('save_404_owner');
    const room = await createRoom(owner.id, { name: 'save-404', isPublic: true });

    const response = await save(room.id, 999, owner);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('MESSAGE_NOT_FOUND');
    expect(await savedCount(owner.id)).toBe(0);

    // Unsaving something that was never saved is still a no-op, not an error.
    const removal = await unsave(room.id, 999, owner);
    expect(removal.status).toBe(200);
    expect(removal.body).toEqual({ saved: false });
  });

  it('lists bookmarks newest-first with room, sender and saved time', async () => {
    const owner = await createTestUser('list_owner');
    const member = await createTestUser('list_member');
    const firstRoom = await createRoom(owner.id, { name: 'list-one', isPublic: true });
    const secondRoom = await createRoom(owner.id, { name: 'list-two', isPublic: true });
    await joinRoom(member.id, firstRoom.id);
    await joinRoom(member.id, secondRoom.id);

    const older = await createMessage({
      roomId: firstRoom.id,
      senderId: owner.id,
      senderType: 'user',
      content: 'older message',
    });
    const newest = await createMessage({
      roomId: firstRoom.id,
      senderId: owner.id,
      senderType: 'user',
      content: 'newest message',
    });
    const middle = await createMessage({
      roomId: secondRoom.id,
      senderId: member.id,
      senderType: 'user',
      content: 'from the other room',
    });

    // Saved out of order on purpose; the saved_at timestamps decide the order.
    await save(firstRoom.id, older.seq, owner);
    await save(secondRoom.id, middle.seq, owner);
    await save(firstRoom.id, newest.seq, owner);
    await backdateSave(owner.id, older.id, '2024-01-01 00:00:00.000');
    await backdateSave(owner.id, middle.id, '2024-02-01 00:00:00.000');
    await backdateSave(owner.id, newest.id, '2024-03-01 00:00:00.000');

    const response = await listSaved(owner);
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(3);
    expect(response.body.limit).toBe(50);
    expect(response.body.offset).toBe(0);

    const items = response.body.items as { message: MessageDTO; roomName: string; savedAt: string }[];
    expect(items.map((item) => item.message.seq)).toEqual([
      newest.seq,
      middle.seq,
      older.seq,
    ]);

    const [first] = items;
    expect(first.message.id).toBe(newest.id);
    expect(first.message.roomId).toBe(firstRoom.id);
    expect(first.message.senderId).toBe(owner.id);
    expect(first.message.senderName).toBe('list_owner');
    expect(first.message.content).toBe('newest message');
    expect(first.message.status).toBe('done');
    expect(first.message.deleted).toBe(false);
    expect(first.message.reactions).toEqual([]);
    expect(first.message.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.roomName).toBe('list-one');
    expect(first.savedAt).toBe('2024-03-01T00:00:00.000Z');

    const other = items[1];
    expect(other.roomName).toBe('list-two');
    expect(other.message.senderName).toBe('list_member');
    expect(other.message.content).toBe('from the other room');
  });

  it('pages with limit and offset and keeps the total', async () => {
    const owner = await createTestUser('page_owner');
    const room = await createRoom(owner.id, { name: 'page-room', isPublic: true });
    const messages: { id: number; seq: number }[] = [];
    for (const content of ['one', 'two', 'three']) {
      messages.push(
        await createMessage({
          roomId: room.id,
          senderId: owner.id,
          senderType: 'user',
          content,
        }),
      );
    }
    for (const [index, message] of messages.entries()) {
      await save(room.id, message.seq, owner);
      await backdateSave(owner.id, message.id, `2024-0${index + 1}-01 00:00:00.000`);
    }

    const firstPage = await listSaved(owner, '?limit=2');
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.total).toBe(3);
    expect(firstPage.body.limit).toBe(2);
    expect(firstPage.body.offset).toBe(0);
    expect(
      (firstPage.body.items as { message: MessageDTO }[]).map((item) => item.message.content),
    ).toEqual(['three', 'two']);

    const secondPage = await listSaved(owner, '?limit=2&offset=2');
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.total).toBe(3);
    expect(secondPage.body.limit).toBe(2);
    expect(secondPage.body.offset).toBe(2);
    expect(
      (secondPage.body.items as { message: MessageDTO }[]).map((item) => item.message.content),
    ).toEqual(['one']);

    for (const query of ['?limit=0', '?limit=101', '?offset=-1', '?limit=abc']) {
      const bad = await listSaved(owner, query);
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('INVALID_INPUT');
    }
  });

  it('filters bookmarks by literal content, ignoring case', async () => {
    const owner = await createTestUser('search_owner');
    const room = await createRoom(owner.id, { name: 'search-room', isPublic: true });
    const drafts = ['Deploy Alpha done', 'alpha beta', 'unrelated'];
    const saved: { id: number; seq: number; content: string }[] = [];
    for (const content of drafts) {
      const message = await createMessage({
        roomId: room.id,
        senderId: owner.id,
        senderType: 'user',
        content,
      });
      await save(room.id, message.seq, owner);
      saved.push({ id: message.id, seq: message.seq, content });
    }
    for (const [index, message] of saved.entries()) {
      await backdateSave(owner.id, message.id, `2024-0${index + 1}-01 00:00:00.000`);
    }

    const matched = await listSaved(owner, '?q=ALPHA');
    expect(matched.status).toBe(200);
    expect(matched.body.total).toBe(2);
    expect(
      (matched.body.items as { message: MessageDTO }[]).map((item) => item.message.content),
    ).toEqual(['alpha beta', 'Deploy Alpha done']);

    const missing = await listSaved(owner, '?q=nowhere');
    expect(missing.status).toBe(200);
    expect(missing.body.total).toBe(0);
    expect(missing.body.items).toEqual([]);

    // Clearing the box removes the filter entirely.
    const cleared = await listSaved(owner, '?q=');
    expect(cleared.status).toBe(200);
    expect(cleared.body.total).toBe(3);
  });

  it('treats LIKE metacharacters in q as literal text', async () => {
    const owner = await createTestUser('search_escape_owner');
    const room = await createRoom(owner.id, { name: 'search-escape', isPublic: true });
    const contents = [
      'discount 100% today',
      '1000 items',
      'snake_case name',
      'snakeXcase name',
      'C:\\temp\\saved',
    ];
    for (const content of contents) {
      const message = await createMessage({
        roomId: room.id,
        senderId: owner.id,
        senderType: 'user',
        content,
      });
      await save(room.id, message.seq, owner);
    }

    const percent = await listSaved(owner, `?q=${encodeURIComponent('100%')}`);
    expect(percent.status).toBe(200);
    expect(percent.body.total).toBe(1);
    expect(percent.body.items[0].message.content).toBe('discount 100% today');

    const underscore = await listSaved(owner, '?q=snake_case');
    expect(underscore.status).toBe(200);
    expect(underscore.body.total).toBe(1);
    expect(underscore.body.items[0].message.content).toBe('snake_case name');

    // A bare `_` must not degenerate into the single-character wildcard, which
    // would match every non-empty content in the list.
    const bareUnderscore = await listSaved(owner, '?q=_');
    expect(bareUnderscore.status).toBe(200);
    expect(bareUnderscore.body.total).toBe(1);
    expect(bareUnderscore.body.items[0].message.content).toBe('snake_case name');

    const backslash = await listSaved(owner, `?q=${encodeURIComponent('\\')}`);
    expect(backslash.status).toBe(200);
    expect(backslash.body.total).toBe(1);
    expect(backslash.body.items[0].message.content).toBe('C:\\temp\\saved');
  });

  it('keeps the filtered total while paging with q', async () => {
    const owner = await createTestUser('search_page_owner');
    const room = await createRoom(owner.id, { name: 'search-page', isPublic: true });
    const contents = ['apple one', 'apple two', 'apple three', 'banana'];
    const saved: { id: number; seq: number }[] = [];
    for (const content of contents) {
      const message = await createMessage({
        roomId: room.id,
        senderId: owner.id,
        senderType: 'user',
        content,
      });
      await save(room.id, message.seq, owner);
      saved.push(message);
    }
    for (const [index, message] of saved.entries()) {
      await backdateSave(owner.id, message.id, `2024-0${index + 1}-01 00:00:00.000`);
    }

    const firstPage = await listSaved(owner, '?q=apple&limit=2');
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.total).toBe(3);
    expect(firstPage.body.limit).toBe(2);
    expect(firstPage.body.offset).toBe(0);
    expect(
      (firstPage.body.items as { message: MessageDTO }[]).map((item) => item.message.content),
    ).toEqual(['apple three', 'apple two']);

    const secondPage = await listSaved(owner, '?q=apple&limit=2&offset=2');
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.total).toBe(3);
    expect(secondPage.body.limit).toBe(2);
    expect(secondPage.body.offset).toBe(2);
    expect(
      (secondPage.body.items as { message: MessageDTO }[]).map((item) => item.message.content),
    ).toEqual(['apple one']);

    const tooLong = await listSaved(owner, `?q=${'a'.repeat(101)}`);
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('INVALID_INPUT');
  });

  it('hides matching bookmarks from a user who is no longer a member', async () => {
    const owner = await createTestUser('search_leave_owner');
    const room = await createRoom(owner.id, { name: 'search-leave', isPublic: true });
    const message = await createMessage({
      roomId: room.id,
      senderId: owner.id,
      senderType: 'user',
      content: 'apple pie recipe',
    });
    await save(room.id, message.seq, owner);

    const before = await listSaved(owner, '?q=apple');
    expect(before.body.total).toBe(1);

    await pool.execute('DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [
      room.id,
      owner.id,
    ]);

    // Both the items and the count are scoped to current membership.
    const after = await listSaved(owner, '?q=apple');
    expect(after.status).toBe(200);
    expect(after.body.total).toBe(0);
    expect(after.body.items).toEqual([]);
  });

  it('keeps withdrawn messages in the list as empty deleted entries', async () => {
    const owner = await createTestUser('deleted_owner');
    const room = await createRoom(owner.id, { name: 'deleted-room', isPublic: true });
    const kept = await createMessage({
      roomId: room.id,
      senderId: owner.id,
      senderType: 'user',
      content: 'still here',
    });
    const withdrawn = await createMessage({
      roomId: room.id,
      senderId: owner.id,
      senderType: 'user',
      content: 'will be withdrawn',
    });
    await save(room.id, kept.seq, owner);
    await save(room.id, withdrawn.seq, owner);
    await deleteMessage(room.id, withdrawn.seq, owner.id, false);

    const response = await listSaved(owner);
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);

    const items = response.body.items as { message: MessageDTO }[];
    const entry = items.find((item) => item.message.id === withdrawn.id);
    expect(entry).toBeDefined();
    expect(entry?.message.deleted).toBe(true);
    expect(entry?.message.content).toBe('');
    // The bookmark survives the withdrawal; the row is still listed.
    expect(await savedCount(owner.id)).toBe(2);
  });

  it("never shows one member the other member's bookmarks", async () => {
    const owner = await createTestUser('iso_owner');
    const member = await createTestUser('iso_member');
    const room = await createRoom(owner.id, { name: 'iso-room', isPublic: true });
    await joinRoom(member.id, room.id);
    const message = await createMessage({
      roomId: room.id,
      senderId: owner.id,
      senderType: 'user',
      content: 'shared message',
    });
    await save(room.id, message.seq, owner);

    const mine = await listSaved(owner);
    expect(mine.body.total).toBe(1);

    const theirs = await listSaved(member);
    expect(theirs.status).toBe(200);
    expect(theirs.body.total).toBe(0);
    expect(theirs.body.items).toEqual([]);
  });

  it('requires authentication for both the bookmark and the list', async () => {
    const owner = await createTestUser('auth_owner');
    const room = await createRoom(owner.id, { name: 'auth-room', isPublic: true });
    const message = await createMessage({
      roomId: room.id,
      senderId: owner.id,
      senderType: 'user',
      content: 'private',
    });

    const list = await request(server.url).get('/api/me/saved');
    expect(list.status).toBe(401);

    const bookmark = await request(server.url).post(
      `/api/rooms/${room.id}/messages/${message.seq}/save`,
    );
    expect(bookmark.status).toBe(401);
  });
});
