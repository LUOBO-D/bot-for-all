import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'socket.io';
import type { Socket } from 'socket.io-client';
import { config } from '../src/config';
import { attachLinkPreview, extractFirstUrl, fetchPreview } from '../src/services/link-preview';
import type { MessageDTO } from '../src/types';
import {
  connectClient,
  createTestRoom,
  createTestUser,
  delay,
  joinRoom,
  sendMessage,
  startTestServer,
  tokenFor,
  waitForEvent,
  type TestServer,
} from './helpers';

interface UpdatedPayload {
  roomId: number;
  message: MessageDTO;
}

/** Attributes are deliberately reordered, mixed-quoted and upper-cased. */
const OG_HTML = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<TITLE>  Document &amp; Title  </TITLE>
<META content="Fake &amp; Preview Title" PROPERTY="og:title">
<meta name='og:description' content='Line one
  of the description &quot;quoted&quot;.'>
<meta property=og:site_name content="Fake Provider">
</head><body><p>hello</p></body></html>`;

interface PreviewServer {
  origin: string;
  requests: string[];
  maxActive: () => number;
  close: () => Promise<void>;
}

async function startPreviewServer(): Promise<PreviewServer> {
  const requests: string[] = [];
  let active = 0;
  let maxActive = 0;
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    if ((req.url ?? '').startsWith('/slow')) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active -= 1;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>slow page</title></head></html>');
      }, 150);
      return;
    }
    if (req.url === '/og') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(OG_HTML);
      return;
    }
    if (req.url === '/bare') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><p>no metadata at all</p></body></html>');
      return;
    }
    if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"title":"not html"}');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<title>missing</title>');
  });
  const { promise: listening, resolve: onListening } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', onListening);
  await listening;
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    maxActive: () => maxActive,
    close: async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
    },
  };
}

let previewServer: PreviewServer;
let server: TestServer;
const clients: Socket[] = [];

async function openClient(token: string): Promise<Socket> {
  const socket = await connectClient(server.url, token);
  clients.push(socket);
  return socket;
}

beforeAll(async () => {
  previewServer = await startPreviewServer();
  server = await startTestServer();
});

afterEach(() => {
  for (const socket of clients.splice(0)) {
    socket.disconnect();
  }
});

afterAll(async () => {
  await server.close();
  await previewServer.close();
});

describe('extractFirstUrl', () => {
  it('returns the first http(s) URL with trailing punctuation trimmed', () => {
    expect(extractFirstUrl('see https://example.com/a?b=1, and more')).toBe(
      'https://example.com/a?b=1',
    );
    expect(extractFirstUrl('(http://example.com/x)')).toBe('http://example.com/x');
    expect(extractFirstUrl('one http://a.test first, two https://b.test second')).toBe(
      'http://a.test',
    );
  });

  it('returns null when the message has no link', () => {
    expect(extractFirstUrl('just text, no link here')).toBeNull();
    expect(extractFirstUrl('ftp://example.com/file')).toBeNull();
  });
});

describe('fetchPreview', () => {
  it('parses Open Graph metadata from an HTML page', async () => {
    const preview = await fetchPreview(`${previewServer.origin}/og`);
    expect(preview).toEqual({
      url: `${previewServer.origin}/og`,
      title: 'Fake & Preview Title',
      description: 'Line one of the description "quoted".',
      site: 'Fake Provider',
    });
  });

  it('falls back to the hostname when the page has no metadata', async () => {
    expect(await fetchPreview(`${previewServer.origin}/bare`)).toEqual({
      url: `${previewServer.origin}/bare`,
      title: '127.0.0.1',
      description: '',
      site: '127.0.0.1',
    });
  });

  it('returns null for non-2xx responses', async () => {
    expect(await fetchPreview(`${previewServer.origin}/missing`)).toBeNull();
  });

  it('ignores responses that are not HTML', async () => {
    expect(await fetchPreview(`${previewServer.origin}/json`)).toBeNull();
  });

  it('refuses cloud metadata addresses', async () => {
    expect(await fetchPreview('http://169.254.169.254/latest/meta-data/')).toBeNull();
  });
});

const silentIo = {
  to: () => ({ emit: () => undefined }),
} as unknown as Server;

function previewMessage(messageId: number, senderId: number, content: string): MessageDTO {
  return {
    id: messageId,
    seq: messageId,
    roomId: 1,
    senderId,
    senderType: 'user',
    senderName: 'preview-test',
    senderAvatar: null,
    content,
    kind: 'text',
    poll: null,
    attachments: [],
    status: 'done',
    replyToId: null,
    createdAt: new Date().toISOString(),
    editedAt: null,
    deleted: false,
    pinned: false,
    pinnedBy: null,
    forwardedFrom: null,
    preview: null,
    reactions: [],
  };
}

describe('preview limits', () => {
  it('drops fetches above the global concurrency cap and frees slots', async () => {
    const user = await createTestUser(`lp-cap-${Date.now().toString(36)}`);
    const before = previewServer.requests.length;

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        attachLinkPreview(
          silentIo,
          1,
          previewMessage(
            800_000 + index,
            user.id,
            `${previewServer.origin}/slow?i=${index}`,
          ),
        ),
      ),
    );

    // Eight slots are all in use at once; the other four never reach the page.
    expect(previewServer.maxActive()).toBe(8);
    expect(previewServer.requests.length - before).toBe(8);

    // The finally block released the slots after the slow responses finished.
    await attachLinkPreview(
      silentIo,
      1,
      previewMessage(800_099, user.id, `${previewServer.origin}/slow?after=1`),
    );
    expect(previewServer.requests.length - before).toBe(9);
  });

  it('skips a sender after 20 preview attempts per minute', async () => {
    const previous = config.rateLimitEnabled;
    config.rateLimitEnabled = true;
    try {
      const user = await createTestUser(`lp-rate-${Date.now().toString(36)}`);
      const other = await createTestUser(`lp-rate-other-${Date.now().toString(36)}`);
      const before = previewServer.requests.length;

      for (let index = 0; index < 21; index += 1) {
        await attachLinkPreview(
          silentIo,
          1,
          previewMessage(810_000 + index, user.id, `${previewServer.origin}/og`),
        );
      }

      // The 21st attempt is dropped silently, before any fetch.
      expect(previewServer.requests.length - before).toBe(20);

      // Another sender keeps its own budget.
      await attachLinkPreview(
        silentIo,
        1,
        previewMessage(810_099, other.id, `${previewServer.origin}/og`),
      );
      expect(previewServer.requests.length - before).toBe(21);
    } finally {
      config.rateLimitEnabled = previous;
    }
  });
});

describe('link preview over socket', () => {
  it('broadcasts message:updated with the preview once the page is fetched', async () => {
    const user = await createTestUser(`lp-${Date.now().toString(36)}`);
    const roomId = await createTestRoom(user);
    const socket = await openClient(tokenFor(user));
    await joinRoom(socket, roomId);

    const pending = waitForEvent<UpdatedPayload>(
      socket,
      'message:updated',
      (payload) => payload.roomId === roomId && payload.message.preview !== null,
    );

    const sent = await sendMessage(socket, roomId, `look ${previewServer.origin}/og`);
    expect(sent.ok).toBe(true);

    const updated = await pending;
    expect(updated.message.seq).toBe(sent.message?.seq);
    expect(updated.message.preview).toEqual({
      url: `${previewServer.origin}/og`,
      title: 'Fake & Preview Title',
      description: 'Line one of the description "quoted".',
      site: 'Fake Provider',
    });
  });

  it('does not fetch or broadcast for messages without a URL', async () => {
    const user = await createTestUser(`lp-none-${Date.now().toString(36)}`);
    const roomId = await createTestRoom(user);
    const socket = await openClient(tokenFor(user));
    await joinRoom(socket, roomId);

    const before = previewServer.requests.length;
    let updates = 0;
    socket.on('message:updated', () => {
      updates += 1;
    });

    const sent = await sendMessage(socket, roomId, 'no link in this one');
    expect(sent.ok).toBe(true);

    await delay(500);
    expect(updates).toBe(0);
    expect(previewServer.requests.length).toBe(before);
  });
});
