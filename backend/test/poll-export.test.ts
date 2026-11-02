import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool } from '../src/db';
import { createMessage, deleteMessage } from '../src/services/message';
import { joinRoom } from '../src/services/room';
import type { AuthUser, MessageDTO, PollDTO } from '../src/types';
import { createTestRoom, createTestUser, tokenFor } from './helpers';

const app = createApp();

function auth(user: AuthUser): string {
  return `Bearer ${tokenFor(user)}`;
}

async function createPoll(
  roomId: number,
  actor: AuthUser,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(app)
    .post(`/api/rooms/${roomId}/polls`)
    .set('Authorization', auth(actor))
    .send(body);
}

async function vote(
  roomId: number,
  seq: number,
  actor: AuthUser,
  optionIds: number[],
): Promise<request.Response> {
  return request(app)
    .post(`/api/rooms/${roomId}/messages/${seq}/poll/votes`)
    .set('Authorization', auth(actor))
    .send({ optionIds });
}

function exportPoll(roomId: number, seq: number, actor: AuthUser): request.Test {
  return request(app)
    .get(`/api/rooms/${roomId}/messages/${seq}/poll/export`)
    .set('Authorization', auth(actor));
}

function pollOf(message: MessageDTO): PollDTO {
  if (!message.poll) {
    throw new Error(`message ${message.seq} has no poll`);
  }
  return message.poll;
}

/** RFC 4180 record splitter, so a quoted label may carry commas and newlines. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
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
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else if (char === '\r' && text[index + 1] === '\n') {
      fields.push(field);
      records.push(fields);
      fields = [];
      field = '';
      index += 1;
    } else {
      field += char;
    }
  }
  if (field !== '' || fields.length > 0) {
    fields.push(field);
    records.push(fields);
  }
  return records;
}

describe('poll export', () => {
  it('exports one row per option with voters in vote order', async () => {
    const owner = await createTestUser('poll_export_owner');
    const bob = await createTestUser('poll_export_bob');
    const carol = await createTestUser('poll_export_carol');
    const roomId = await createTestRoom(owner);
    await joinRoom(bob.id, roomId);
    await joinRoom(carol.id, roomId);

    const created = await createPoll(roomId, owner, {
      question: 'Lunch?',
      options: ['Pizza', 'Sushi'],
    });
    expect(created.status).toBe(201);
    const message = created.body.message as MessageDTO;
    const [pizza, sushi] = pollOf(message).options;

    // Votes are cast in ascending user-id order, so a timestamp tie still
    // resolves to this order and the assertion below stays deterministic.
    expect((await vote(roomId, message.seq, bob, [pizza.id])).status).toBe(200);
    expect((await vote(roomId, message.seq, carol, [pizza.id])).status).toBe(200);
    expect((await vote(roomId, message.seq, owner, [sushi.id])).status).toBe(200);

    const response = await exportPoll(roomId, message.seq, bob);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="poll-${message.seq}.csv"`,
    );
    expect(response.text).toBe(
      'option,votes,voters\r\n' +
        `Pizza,2,${bob.displayName}|${carol.displayName}\r\n` +
        `Sushi,1,${owner.displayName}\r\n`,
    );
  });

  it('never writes voters on an anonymous poll', async () => {
    const owner = await createTestUser('poll_export_anon_owner');
    const bob = await createTestUser('poll_export_anon_bob');
    const roomId = await createTestRoom(owner);
    await joinRoom(bob.id, roomId);

    const created = await createPoll(roomId, owner, {
      question: 'Secret ballot',
      options: ['Yes', 'No'],
      anonymous: true,
    });
    expect(created.status).toBe(201);
    const message = created.body.message as MessageDTO;
    const [yes, no] = pollOf(message).options;
    expect((await vote(roomId, message.seq, bob, [yes.id])).status).toBe(200);
    expect((await vote(roomId, message.seq, owner, [no.id])).status).toBe(200);

    const response = await exportPoll(roomId, message.seq, bob);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.text).toBe('option,votes\r\nYes,1\r\nNo,1\r\n');
    // The tallies are exported but neither voter's name may appear anywhere.
    expect(response.text).not.toContain(bob.displayName);
    expect(response.text).not.toContain(owner.displayName);
    for (const record of parseCsv(response.text)) {
      expect(record).toHaveLength(2);
    }
  });

  it('exports options that have no votes with an empty voter list', async () => {
    const owner = await createTestUser('poll_export_empty_owner');
    const roomId = await createTestRoom(owner);
    const created = await createPoll(roomId, owner, {
      question: 'Nobody yet',
      options: ['A', 'B'],
    });
    expect(created.status).toBe(201);
    const message = created.body.message as MessageDTO;

    const response = await exportPoll(roomId, message.seq, owner);
    expect(response.status).toBe(200);
    expect(response.text).toBe('option,votes,voters\r\nA,0,\r\nB,0,\r\n');
  });

  it('escapes labels per RFC 4180 and neutralizes formula injection', async () => {
    const owner = await createTestUser('poll_export_inject_owner');
    const bob = await createTestUser('poll_export_inject_bob');
    const roomId = await createTestRoom(owner);
    await joinRoom(bob.id, roomId);
    // A display name with a comma proves the voter cell is quoted, not split.
    await pool.execute('UPDATE users SET display_name = ? WHERE id = ?', ['Bob, Jr.', bob.id]);

    const created = await createPoll(roomId, owner, {
      question: 'Injection?',
      options: ['=SUM(A1:A2)', '@cmd', '-5', '+1', 'a,"b"', 'line\nbreak'],
    });
    expect(created.status).toBe(201);
    const message = created.body.message as MessageDTO;
    const options = pollOf(message).options;
    expect((await vote(roomId, message.seq, bob, [options[0].id])).status).toBe(200);

    const response = await exportPoll(roomId, message.seq, owner);
    expect(response.status).toBe(200);
    expect(response.text).toContain("'=SUM(A1:A2),1,\"Bob, Jr.\"");
    expect(response.text).toContain("'@cmd,0,");
    expect(response.text).toContain("'-5,0,");
    expect(response.text).toContain("'+1,0,");
    expect(response.text).toContain('"a,""b""",0,');

    const records = parseCsv(response.text);
    expect(records[0]).toEqual(['option', 'votes', 'voters']);
    expect(records).toHaveLength(7);
    for (const record of records) {
      expect(record).toHaveLength(3);
    }
    expect(records.map((record) => record[0])).toEqual([
      'option',
      "'=SUM(A1:A2)",
      "'@cmd",
      "'-5",
      "'+1",
      'a,"b"',
      'line\nbreak',
    ]);
    // No raw label ever reaches the file in an executable form.
    for (const record of records.slice(1)) {
      expect(['=', '+', '-', '@', '\t', '\r'].includes(record[0][0])).toBe(false);
    }
  });

  it('rejects a caller who is not a member of the room', async () => {
    const owner = await createTestUser('poll_export_outsider_owner');
    const outsider = await createTestUser('poll_export_outsider');
    const roomId = await createTestRoom(owner);
    const created = await createPoll(roomId, owner, {
      question: 'Private',
      options: ['A', 'B'],
    });
    const message = created.body.message as MessageDTO;

    const response = await exportPoll(roomId, message.seq, outsider);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_MEMBER');
  });

  it('answers 404 POLL_NOT_FOUND for a missing message', async () => {
    const owner = await createTestUser('poll_export_missing_owner');
    const roomId = await createTestRoom(owner);

    const response = await exportPoll(roomId, 99, owner);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('POLL_NOT_FOUND');
  });

  it('answers 404 POLL_NOT_FOUND for a withdrawn poll', async () => {
    const owner = await createTestUser('poll_export_deleted_owner');
    const roomId = await createTestRoom(owner);
    const created = await createPoll(roomId, owner, {
      question: 'Gone soon',
      options: ['A', 'B'],
    });
    const message = created.body.message as MessageDTO;
    await deleteMessage(roomId, message.seq, owner.id, false);

    const response = await exportPoll(roomId, message.seq, owner);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('POLL_NOT_FOUND');
  });

  it('answers 404 POLL_NOT_FOUND for a non-poll message', async () => {
    const owner = await createTestUser('poll_export_text_owner');
    const roomId = await createTestRoom(owner);
    const message = await createMessage({
      roomId,
      senderId: owner.id,
      senderType: 'user',
      content: 'just text',
      clientMsgId: 'poll-export-text',
    });

    const response = await exportPoll(roomId, message.seq, owner);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('POLL_NOT_FOUND');
  });
});
