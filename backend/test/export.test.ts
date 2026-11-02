import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app';
import { pool } from '../src/db';
import {
  closePoll,
  createMessage,
  createPoll,
  deleteMessage,
  editMessage,
  forwardMessage,
  toggleReaction,
  votePoll,
} from '../src/services/message';
import { joinRoom, updateRoom } from '../src/services/room';
import type { MessageDTO, PollDTO } from '../src/types';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

const exportMessageSchema = z.object({
  id: z.number(),
  seq: z.number(),
  roomId: z.number(),
  senderId: z.number(),
  senderName: z.string(),
  content: z.string(),
  createdAt: z.string(),
  deleted: z.boolean(),
  reactions: z.array(z.unknown()),
});

const exportResponseSchema = z.object({
  room: z.object({
    id: z.number(),
    name: z.string(),
    topic: z.string(),
    announcement: z.string(),
  }),
  messages: z.array(exportMessageSchema),
});

function auth(token: string): string {
  return `Bearer ${token}`;
}

function pollOf(message: MessageDTO): PollDTO {
  if (!message.poll) {
    throw new Error(`message ${message.seq} has no poll`);
  }
  return message.poll;
}

describe('room export', () => {
  it('exports json for a member in seq order with room metadata', async () => {
    const alice = await createTestUser('alice');
    const roomId = await createTestRoom(alice);
    await updateRoom(roomId, alice.id, alice.role, {
      name: 'Export Room',
      topic: 'weekly sync',
      announcement: 'be nice',
    });

    for (const content of ['first', 'second', 'third']) {
      await createMessage({
        roomId,
        senderId: alice.id,
        senderType: 'user',
        content,
        clientMsgId: `client-${content}`,
      });
    }

    const response = await request(app)
      .get(`/api/rooms/${roomId}/export`)
      .query({ format: 'json' })
      .set('Authorization', auth(tokenFor(alice)));

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="room-${roomId}.json"`,
    );

    const body = exportResponseSchema.parse(JSON.parse(response.text));
    expect(body.room).toEqual({
      id: roomId,
      name: 'Export Room',
      topic: 'weekly sync',
      announcement: 'be nice',
    });
    expect(body.messages.map((message) => message.seq)).toEqual([1, 2, 3]);
    expect(body.messages.map((message) => message.content)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(body.messages[0].senderName).toBe('alice');
  });

  it('exports markdown with header, senders, contents and a deletion marker', async () => {
    const alice = await createTestUser('alice');
    const roomId = await createTestRoom(alice);
    await updateRoom(roomId, alice.id, alice.role, {
      name: 'Markdown Room',
      topic: 'topic line',
      announcement: 'announcement line',
    });

    await createMessage({
      roomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'hello world',
      clientMsgId: 'client-1',
    });
    const doomed = await createMessage({
      roomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'regrettable',
      clientMsgId: 'client-2',
    });
    await deleteMessage(roomId, doomed.seq, alice.id, false);

    const response = await request(app)
      .get(`/api/rooms/${roomId}/export`)
      .query({ format: 'markdown' })
      .set('Authorization', auth(tokenFor(alice)));

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="room-${roomId}.md"`,
    );

    const text = response.text;
    expect(text).toContain('# Markdown Room');
    expect(text).toContain('topic line');
    expect(text).toContain('announcement line');
    expect(text).toContain('alice: hello world');
    expect(text).toContain('[消息已撤回]');
    expect(text).not.toContain('regrettable');
  });

  it('renders forward, edit, attachment, poll and reaction metadata in message order', async () => {
    const alice = await createTestUser('alice');
    const bob = await createTestUser('bob');
    const roomId = await createTestRoom(alice);
    await joinRoom(bob.id, roomId);
    await updateRoom(roomId, alice.id, alice.role, {
      name: 'Combo Room',
      topic: 'combo topic',
      announcement: 'combo announcement',
    });

    // A forward snapshots the source room name and sender at copy time.
    const sourceRoomId = await createTestRoom(alice);
    await joinRoom(bob.id, sourceRoomId);
    await updateRoom(sourceRoomId, alice.id, alice.role, { name: 'Source Room' });
    const source = await createMessage({
      roomId: sourceRoomId,
      senderId: bob.id,
      senderType: 'user',
      content: 'original words',
      clientMsgId: 'combo-source',
    });
    const forwarded = await forwardMessage({
      sourceRoomId,
      sourceSeq: source.seq,
      targetRoomId: roomId,
      userId: alice.id,
    });

    const withFile = await createMessage({
      roomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'see attached',
      clientMsgId: 'combo-file',
      copiedAttachments: [
        {
          filename: 'report.pdf',
          storedName: 'combo-report',
          mime: 'application/pdf',
          size: 1536,
        },
      ],
    });

    const openPoll = await createPoll({
      roomId,
      senderId: alice.id,
      question: 'Lunch?',
      options: ['Pizza', 'Sushi'],
      multiple: true,
      closesAt: new Date(Date.now() + 3_600_000),
    });
    const [pizza, sushi] = pollOf(openPoll).options;
    await votePoll({
      roomId,
      seq: openPoll.seq,
      userId: alice.id,
      optionIds: [pizza.id, sushi.id],
    });
    await votePoll({ roomId, seq: openPoll.seq, userId: bob.id, optionIds: [pizza.id] });

    const secretPoll = await createPoll({
      roomId,
      senderId: alice.id,
      question: 'Secret?',
      options: ['Yes', 'No'],
      anonymous: true,
    });
    const [yes] = pollOf(secretPoll).options;
    await votePoll({ roomId, seq: secretPoll.seq, userId: bob.id, optionIds: [yes.id] });
    await closePoll({ roomId, seq: secretPoll.seq, userId: alice.id, moderator: false });

    const edited = await createMessage({
      roomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'typo',
      clientMsgId: 'combo-edit',
    });
    await editMessage(roomId, edited.seq, alice.id, 'fixed text');

    const reacted = await createMessage({
      roomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'nice one',
      clientMsgId: 'combo-react',
    });
    await toggleReaction(roomId, reacted.seq, alice.id, '👍');
    await toggleReaction(roomId, reacted.seq, bob.id, '👍');
    await toggleReaction(roomId, reacted.seq, bob.id, '🎉');
    // attachReactions orders by first use; pin the timestamps so two inserts in
    // the same millisecond cannot make the expected order flaky.
    await pool.execute(
      "UPDATE message_reactions SET created_at = '2026-01-01 00:00:00.000' WHERE message_id = ? AND emoji = '👍'",
      [reacted.id],
    );
    await pool.execute(
      "UPDATE message_reactions SET created_at = '2026-01-01 00:00:01.000' WHERE message_id = ? AND emoji = '🎉'",
      [reacted.id],
    );

    const doomed = await createMessage({
      roomId,
      senderId: alice.id,
      senderType: 'user',
      content: 'secret draft',
      clientMsgId: 'combo-doomed',
      copiedAttachments: [
        {
          filename: 'secret.txt',
          storedName: 'combo-secret',
          mime: 'text/plain',
          size: 12,
        },
      ],
    });
    await toggleReaction(roomId, doomed.seq, bob.id, '💀');
    await deleteMessage(roomId, doomed.seq, alice.id, false);

    const response = await request(app)
      .get(`/api/rooms/${roomId}/export`)
      .query({ format: 'markdown' })
      .set('Authorization', auth(tokenFor(alice)));

    expect(response.status).toBe(200);
    const expected = [
      '# Combo Room',
      '',
      '**话题**: combo topic',
      '**公告**: combo announcement',
      '',
      `[${forwarded.createdAt}] alice: original words`,
      '> 转发自 Source Room · bob',
      `[${withFile.createdAt}] alice: see attached`,
      '- 附件: report.pdf (application/pdf, 1.5 KB)',
      `[${openPoll.createdAt}] alice: Lunch?`,
      `投票: 多选 · 截止 ${pollOf(openPoll).closesAt}`,
      '- Pizza: 2 票',
      '- Sushi: 1 票',
      `[${secretPoll.createdAt}] alice: Secret?`,
      '投票: 单选 · 匿名 · 已截止',
      '- Yes: 1 票',
      '- No: 0 票',
      `[${edited.createdAt}] alice: fixed text（已编辑）`,
      `[${reacted.createdAt}] alice: nice one`,
      '反应: 👍 2, 🎉 1',
      `[${doomed.createdAt}] alice: [消息已撤回]`,
      '',
    ].join('\n');
    expect(response.text).toBe(expected);
    // Withdrawn metadata and the replaced revision never reach the transcript.
    expect(response.text).not.toContain('secret.txt');
    expect(response.text).not.toContain('secret draft');
    expect(response.text).not.toContain('💀');
    expect(response.text).not.toContain('typo');
    // No poll exports voter identities, so the secret ballot stays secret.
    expect(response.text).not.toContain('投票人');
  });

  it('rejects a non-member with 403', async () => {
    const alice = await createTestUser('alice');
    const bob = await createTestUser('bob');
    const roomId = await createTestRoom(alice);

    const response = await request(app)
      .get(`/api/rooms/${roomId}/export`)
      .query({ format: 'json' })
      .set('Authorization', auth(tokenFor(bob)));

    expect(response.status).toBe(403);
  });

  it('rejects an unsupported format with 400', async () => {
    const alice = await createTestUser('alice');
    const roomId = await createTestRoom(alice);

    const response = await request(app)
      .get(`/api/rooms/${roomId}/export`)
      .query({ format: 'xml' })
      .set('Authorization', auth(tokenFor(alice)));

    expect(response.status).toBe(400);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const alice = await createTestUser('alice');
    const roomId = await createTestRoom(alice);

    const response = await request(app)
      .get(`/api/rooms/${roomId}/export`)
      .query({ format: 'json' });

    expect(response.status).toBe(401);
  });

  it('exports an empty room without messages', async () => {
    const alice = await createTestUser('alice');
    const roomId = await createTestRoom(alice);

    const jsonResponse = await request(app)
      .get(`/api/rooms/${roomId}/export`)
      .query({ format: 'json' })
      .set('Authorization', auth(tokenFor(alice)));
    expect(jsonResponse.status).toBe(200);
    expect(exportResponseSchema.parse(JSON.parse(jsonResponse.text)).messages).toEqual([]);

    const mdResponse = await request(app)
      .get(`/api/rooms/${roomId}/export`)
      .query({ format: 'markdown' })
      .set('Authorization', auth(tokenFor(alice)));
    expect(mdResponse.status).toBe(200);
    expect(mdResponse.text.startsWith('# ')).toBe(true);
    expect(mdResponse.text).not.toContain('undefined');
  });
});
