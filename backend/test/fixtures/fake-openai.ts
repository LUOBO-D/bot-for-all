import express, { type Request, type Response } from 'express';

interface FakeStats {
  calls: number;
  lastBody: unknown;
}

const stats: FakeStats = { calls: 0, lastBody: null };

export function resetFakeStats(): void {
  stats.calls = 0;
  stats.lastBody = null;
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

async function handleChat(req: Request, res: Response): Promise<void> {
  stats.calls += 1;
  stats.lastBody = req.body;
  const model = typeof req.body?.model === 'string' ? req.body.model : 'fake-ok';
  const stream = req.body?.stream === true;

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

  if (!stream) {
    res.json({ choices: [{ message: { content: '整段回复' } }] });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

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
