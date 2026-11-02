import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { extractFirstUrl, fetchPreview } from '../src/services/link-preview';
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
  close: () => Promise<void>;
}

async function startPreviewServer(): Promise<PreviewServer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
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
