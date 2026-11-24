import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import {
  streamChat,
  type StreamEvent,
  type StreamOptions,
  type ToolFunctionSpec,
} from '../src/bot/provider';

/**
 * Provider-level tool_calls tests. The server scripts raw SSE bytes, so the
 * argument reassembly is exercised through the same SseParser feed path
 * production takes, including events split mid-payload across write calls.
 */

const SPECS: ToolFunctionSpec[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'search the web',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
];

interface ScriptedProvider {
  url: string;
  /** Parsed chat-completion request bodies, in arrival order. */
  bodies: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function delta(content: string): string {
  return sse({ choices: [{ delta: { content } }] });
}

function toolCallOpen(index: number, id: string, name: string): string {
  return sse({
    choices: [
      {
        delta: {
          tool_calls: [
            { index, id, type: 'function', function: { name, arguments: '' } },
          ],
        },
      },
    ],
  });
}

function toolCallArgs(index: number, fragment: string): string {
  return sse({
    choices: [{ delta: { tool_calls: [{ index, function: { arguments: fragment } }] } }],
  });
}

/** Starts a provider that answers one scripted SSE script per request. */
async function startScriptedProvider(
  scripts: (requestIndex: number, body: Record<string, unknown>) => string[],
): Promise<ScriptedProvider> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, response) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      bodies.push(body);
      const index = bodies.length - 1;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      const lines = scripts(index, body);
      for (const line of lines) {
        response.write(line);
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  const { promise: listening, resolve: onListening } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', onListening);
  await listening;
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: async () => {
      server.closeAllConnections();
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
    },
  };
}

function options(url: string, tools?: ToolFunctionSpec[]): StreamOptions {
  return {
    baseUrl: url,
    apiKey: 'test-key',
    model: 'fake',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0,
    maxTokens: 64,
    tools: tools ?? null,
  };
}

async function collect(generator: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

const providers: ScriptedProvider[] = [];

async function withProvider(
  scripts: (requestIndex: number, body: Record<string, unknown>) => string[],
): Promise<ScriptedProvider> {
  const provider = await startScriptedProvider(scripts);
  providers.push(provider);
  return provider;
}

afterAll(async () => {
  for (const provider of providers) {
    await provider.close();
  }
});

describe('streamChat tool_calls', () => {
  it('reassembles argument fragments split across SSE writes, by call index', async () => {
    // Both calls interleave across events; call B's opening event is also
    // split mid-payload across two raw write chunks, so the parser has to
    // hold the unfinished event until its payload completes.
    const split = toolCallOpen(1, 'call_b', 'web_fetch');
    const cut = Math.floor(split.length / 2);
    const provider = await withProvider(() => [
      delta('正在检索'),
      toolCallOpen(0, 'call_a', 'web_search'),
      toolCallArgs(0, '{"qu'),
      split.slice(0, cut),
      split.slice(cut),
      toolCallArgs(0, 'ery":"天气"}'),
      toolCallArgs(1, '{"url": '),
      toolCallArgs(1, '"http://example.com"}'),
    ]);
    const events = await collect(streamChat(options(provider.url, SPECS)));
    const callEvents = events.filter((event) => event.type === 'tool_calls');
    const deltaEvents = events.filter((event) => event.type === 'delta');
    expect(deltaEvents.map((event) => (event.type === 'delta' ? event.text : ''))).toEqual([
      '正在检索',
    ]);
    expect(callEvents).toHaveLength(1);
    if (callEvents[0]?.type !== 'tool_calls') {
      throw new Error('expected tool_calls event');
    }
    expect(callEvents[0].calls).toEqual([
      {
        id: 'call_a',
        type: 'function',
        function: { name: 'web_search', arguments: '{"query":"天气"}' },
      },
      {
        id: 'call_b',
        type: 'function',
        function: { name: 'web_fetch', arguments: '{"url": "http://example.com"}' },
      },
    ]);
  });

  it('synthesizes stable ids when the provider omits them, and names arrive split', async () => {
    const provider = await withProvider(() => [
      sse({
        choices: [
          { delta: { tool_calls: [{ index: 2, function: { name: 'web_', arguments: '' } }] } },
        ],
      }),
      toolCallArgs(2, '{"query":"x"}'),
    ]);
    const events = await collect(streamChat(options(provider.url, SPECS)));
    const last = events[events.length - 1];
    if (last?.type !== 'tool_calls') {
      throw new Error('expected tool_calls event');
    }
    expect(last.calls).toEqual([
      {
        id: 'call_2',
        type: 'function',
        function: { name: 'web_', arguments: '{"query":"x"}' },
      },
    ]);
  });

  it('attaches tools and tool_choice only when the option is set', async () => {
    const provider = await withProvider(() => [delta('回答')]);
    await collect(streamChat(options(provider.url, SPECS)));
    await collect(streamChat(options(provider.url)));
    expect((provider.bodies[0] as Record<string, unknown>).tools).toEqual(SPECS);
    expect((provider.bodies[0] as Record<string, unknown>).tool_choice).toBe('auto');
    const off = provider.bodies[1] as Record<string, unknown>;
    expect('tools' in off).toBe(false);
    expect('tool_choice' in off).toBe(false);
  });

  it('drops unnamed fragments and keeps content flowing alongside calls', async () => {
    const provider = await withProvider(() => [
      delta('想想'),
      // A fragment with an empty name and no later name fragment is noise.
      sse({ choices: [{ delta: { tool_calls: [{ index: 5 }] } }] }),
      toolCallOpen(0, 'call_z', 'web_search'),
      toolCallArgs(0, '{}'),
      delta('还是想了想'),
    ]);
    const events = await collect(streamChat(options(provider.url, SPECS)));
    expect(events.filter((event) => event.type === 'delta').map((e) => (e.type === 'delta' ? e.text : ''))).toEqual([
      '想想',
      '还是想了想',
    ]);
    const last = events[events.length - 1];
    expect(last?.type).toBe('tool_calls');
    if (last.type !== 'tool_calls') {
      throw new Error('unreachable');
    }
    expect(last.calls).toEqual([
      { id: 'call_z', type: 'function', function: { name: 'web_search', arguments: '{}' } },
    ]);
  });
});
