import express, { type Request, type Response } from 'express';

interface FakeStats {
  calls: number;
  lastBody: unknown;
  lastAuth: string | null;
  /** Responses the client cancelled before the fake finished writing. */
  aborted: number;
}

const stats: FakeStats = { calls: 0, lastBody: null, lastAuth: null, aborted: 0 };

export function resetFakeStats(): void {
  stats.calls = 0;
  stats.lastBody = null;
  stats.lastAuth = null;
  stats.aborted = 0;
}

export function getFakeStats(): FakeStats {
  return stats;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function ssePayload(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function reasoningPayload(reasoning: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { reasoning } }] })}\n\n`;
}

async function writeSplit(res: Response, text: string, delayMs = 5): Promise<void> {
  const buffer = Buffer.from(text, 'utf8');
  const cut = Math.max(1, Math.floor(buffer.length / 2));
  const { promise, resolve } = Promise.withResolvers<void>();
  res.write(buffer.subarray(0, cut));
  setTimeout(() => {
    res.write(buffer.subarray(cut));
    resolve();
  }, delayMs);
  await promise;
}

/**
 * Reports whether the client tore the connection down before the fixture
 * finished writing, which is how the provider's cancel-on-cap path is observed.
 */
function trackAbort(res: Response): () => boolean {
  let aborted = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      stats.aborted += 1;
    }
  });
  return () => aborted;
}

async function handleChat(req: Request, res: Response): Promise<void> {
  stats.calls += 1;
  stats.lastBody = req.body;
  stats.lastAuth = req.headers.authorization ?? null;
  const model = typeof req.body?.model === 'string' ? req.body.model : 'fake-ok';
  const stream = req.body?.stream === true;

  // Translation endpoint fixtures: the service always requests a non-streaming
  // completion, so these branches ignore `stream`.
  if (model === 'fake-translate') {
    res.json({ choices: [{ message: { content: '翻译结果' } }] });
    return;
  }
  if (model === 'fake-translate-no-choices') {
    res.json({ choices: [] });
    return;
  }
  if (model === 'fake-translate-bad-json') {
    res.type('application/json').send('{"choices": [');
    return;
  }
  if (model === 'fake-translate-slow') {
    await delay(1000);
    res.json({ choices: [{ message: { content: '慢翻译' } }] });
    return;
  }

  if (req.query.redirected === '1' && !stream) {
    res.json({ choices: [{ message: { content: '重定向后回复' } }] });
    return;
  }
  if (model === 'fake-redirect') {
    res.redirect(307, '/v1/chat/completions?redirected=1');
    return;
  }
  if (model === 'fake-redirect-loop') {
    const n = Number(req.query.n ?? 0);
    res.redirect(307, `/v1/chat/completions?n=${n + 1}`);
    return;
  }
  if (model === 'fake-redirect-evil') {
    res.redirect(307, 'http://metadata.google.internal/v1/chat/completions');
    return;
  }
  if (model === 'fake-401') {
    res.status(401).json({ error: { message: 'unauthorized' } });
    return;
  }
  if (model === 'fake-error') {
    res.status(500).json({ error: { message: 'boom' } });
    return;
  }
  if (model === 'fake-nostream') {
    if (stream) {
      res.status(400).json({ error: { message: 'stream not supported' } });
      return;
    }
    res.json({ choices: [{ message: { content: '非流式回复' } }] });
    return;
  }

  // Oversized bodies for the provider byte caps. These stay far above the
  // test-configured limits (64 KiB response / 16 KiB event) but well below
  // anything that would make the fixture itself slow.
  if (model === 'fake-big-json') {
    res.json({ choices: [{ message: { content: 'j'.repeat(200_000) } }] });
    return;
  }
  if (model === 'fake-big-text') {
    res.type('text/plain').send('t'.repeat(200_000));
    return;
  }
  if (model === 'fake-big-error') {
    res.status(500).type('text/plain').send('e'.repeat(200_000));
    return;
  }

  if (!stream) {
    res.json({ choices: [{ message: { content: '整段回复' } }] });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const aborted = trackAbort(res);

  if (model === 'fake-big-sse-event') {
    // One complete event above BOT_MAX_SSE_EVENT_BYTES but below the total
    // stream cap, so the parser cap is what trips.
    res.write(ssePayload('s'.repeat(50_000)));
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  if (model === 'fake-big-sse-total') {
    // Many individually valid events whose sum crosses the total cap. The
    // stream runs long enough that the client's cancel lands mid-flight,
    // which is how the fixture observes the torn-down connection.
    for (let index = 0; index < 30 && !aborted() && !res.destroyed; index += 1) {
      res.write(ssePayload('T'.repeat(10_000)));
      await delay(10);
    }
    if (!aborted() && !res.destroyed) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }

  if (model === 'fake-slow') {
    await delay(3000);
    res.write(ssePayload('慢回复'));
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  if (model === 'fake-reasoning') {
    res.write(reasoningPayload('Thinking process should be ignored'));
    await delay(5);
    await writeSplit(res, ssePayload('真实回答'));
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  for (const part of ['你', '好', '，', '世界']) {
    await writeSplit(res, ssePayload(part));
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

export function createFakeProviderApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/__stats', (_req, res) => {
    res.json(stats);
  });
  app.post('/__reset', (_req, res) => {
    resetFakeStats();
    res.json({ ok: true });
  });
  // Link-preview target for e2e: a page carrying Open Graph metadata.
  app.get('/preview', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(
      `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Fake Preview Page</title>
<meta property="og:title" content="Fake &amp; Preview">
<meta property="og:description" content="Open Graph description served by the fake provider.">
<meta property="og:site_name" content="Fake Provider">
</head><body><h1>preview</h1></body></html>`,
    );
  });
  app.post('/v1/chat/completions', (req, res) => {
    void handleChat(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.status(500).json({ error: { message: String(error) } });
      } else {
        res.end();
      }
    });
  });

  return app;
}
