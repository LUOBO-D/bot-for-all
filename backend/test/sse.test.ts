import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/bot/sse';

function decodeChunks(chunks: Buffer[]): string[] {
  const decoder = new TextDecoder('utf-8');
  const parser = new SseParser();
  const events: string[] = [];
  for (const chunk of chunks) {
    events.push(...parser.feed(decoder.decode(chunk, { stream: true })));
  }
  events.push(...parser.feed(decoder.decode()));
  return events;
}

describe('SseParser', () => {
  it('decodes UTF-8 split inside a multi-byte character', () => {
    const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`;
    const buffer = Buffer.from(payload, 'utf8');
    const index = buffer.indexOf(Buffer.from('你', 'utf8')) + 1;
    const events = decodeChunks([buffer.subarray(0, index), buffer.subarray(index)]);
    expect(events).toHaveLength(1);
    const parsed: unknown = JSON.parse(events[0]);
    expect(parsed).toMatchObject({ choices: [{ delta: { content: '你好' } }] });
  });

  it('joins multi-line data and ignores comments', () => {
    const parser = new SseParser();
    const events = parser.feed(': keep-alive\ndata: {"a":1,\ndata: "b":2}\n\n');
    expect(events).toEqual(['{"a":1,\n"b":2}']);
  });

  it('returns [DONE] as a payload', () => {
    const parser = new SseParser();
    expect(parser.feed('data: [DONE]\n\n')).toEqual(['[DONE]']);
  });

  it('handles CRLF boundaries split across chunks', () => {
    const parser = new SseParser();
    const first = parser.feed('data: {"a":1}\r');
    const second = parser.feed('\n\r\n');
    expect(first).toEqual([]);
    expect(second).toEqual(['{"a":1}']);
  });
});
