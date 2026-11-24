import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { executeBotTool, htmlToText, parseDuckDuckGoLite } from '../src/bot/tools';

/**
 * Tool-layer tests: the DuckDuckGo lite parser against a fixture page (no
 * network), web_fetch byte truncation against a local server, and the guard
 * rails the platform promises — private addresses refused, rate limits
 * answered as model-facing text.
 *
 * Fixture servers run on 127.0.0.1, allowed by the test env's
 * ALLOW_PRIVATE_BOT_URLS=true; the SSRF case flips that switch back to
 * production's semantics.
 */

const servers: http.Server[] = [];
const restoreOverrides: Array<() => void> = [];

/** Test-only config mutation, undone in `afterEach` no matter the outcome. */
function overrideConfig(values: Partial<typeof config>): void {
  const saved = Object.keys(values).map((key) => ({
    key,
    value: (config as unknown as Record<string, unknown>)[key],
  }));
  for (const [key, value] of Object.entries(values)) {
    (config as unknown as Record<string, unknown>)[key] = value;
  }
  restoreOverrides.push(() => {
    for (const entry of [...saved].reverse()) {
      (config as unknown as Record<string, unknown>)[entry.key] = entry.value;
    }
  });
}

async function startFixtureServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  const { promise: listening, resolve: onListening } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', onListening);
  await listening;
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

afterEach(() => {
  for (const restore of restoreOverrides.splice(0)) {
    restore();
  }
});

afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    await promise;
  }
});

/** A compacted DuckDuckGo lite results page: three title results, nav noise. */
const DDG_FIXTURE = `<!DOCTYPE html>
<html><body>
<table>
<tr><td><input type="text" name="q"></td></tr>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fweather&amp;rut=abc123" class="result-link">天气 &amp; 预报 &#x2013; Example</a></td></tr>
<tr><td class="result-snippet">今日<b>天气</b>晴，气温 12&#186;C。</td></tr>
<tr><td class="result-separator"></td></tr>
<tr><td><a href="/about">关于我们</a></td></tr>
<tr><td class="result-snippet">nav noise snippet</td></tr>
<tr><td><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example.org%2Fstory%3Fid%3D1&amp;rut=def456" class="result-link">新闻：今日&#39;头条</a></td></tr>
<tr><td class="result-snippet">头条内容与<b>天气</b>报道。</td></tr>
<tr><td><a rel="nofollow" href="//example.com/dup/" class="result-link">重复 Example 条目</a></td></tr>
<tr><td><a rel="nofollow" href="//example.com/dup" class="result-link">重复 Example 条目（仅差斜杠）</a></td></tr>
<tr><td class="result-snippet">与首条仅差一个斜杠，第二条应被去重。</td></tr>
</table>
</body></html>`;

describe('parseDuckDuckGoLite', () => {
  it('extracts title links, unwraps the redirector, decodes entities, dedupes', () => {
    const hits = parseDuckDuckGoLite(DDG_FIXTURE, 5);
    // The nav anchor (no rel/class markers) never shows up; the trailing-slash
    // duplicate URL collapses into its earlier twin.
    expect(hits).toEqual([
      {
        title: '天气 & 预报 – Example',
        url: 'https://example.com/weather',
        snippet: '今日天气晴，气温 12ºC。',
      },
      {
        title: "新闻：今日'头条",
        url: 'https://news.example.org/story?id=1',
        snippet: '头条内容与天气报道。',
      },
      {
        title: '重复 Example 条目',
        url: 'https://example.com/dup',
        snippet: '与首条仅差一个斜杠，第二条应被去重。',
      },
    ]);
  });

  it('skips malformed redirect hrefs and clamps to max', () => {
    const sparse = '<a rel="nofollow" href="/l/?uddg=%zz-bad">解析失败链接</a>'
      + '<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fok.example%2Fpage" class="result-link">有效条目</a>';
    const hits = parseDuckDuckGoLite(sparse, 5);
    expect(hits).toEqual([
      { title: '有效条目', url: 'https://ok.example/page', snippet: '' },
    ]);
    // max is respected whenever more results exist than the cap allows.
    expect(parseDuckDuckGoLite(sparse, 1)).toHaveLength(1);
  });

  it('returns an empty list for a page without result markers', () => {
    // The gateway turns this into the structured "unparseable results" tool
    // message; the parser contract is just: no throws, no hits.
    expect(parseDuckDuckGoLite('<html><body><p>maintenance</p></body></html>', 5)).toEqual([]);
    expect(parseDuckDuckGoLite('', 5)).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('strips script/style, turns block ends into breaks, decodes entities', () => {
    const page = `<!doctype html><html><head><title>t</title><style>.x{color:red}</style>
<script>var s = "<p>not text</p>";</script></head><body>
<div><p>第一段 &amp; more</p><p>第二段</p></div>
<ul><li>项一</li><li>项二</li></ul><script>evil()</script>
</body></html>`;
    const text = htmlToText(page, true);
    expect(text).not.toContain('not text');
    expect(text).not.toContain('evil()');
    expect(text).toContain('第一段 & more');
    expect(text).toContain('第二段');
    expect(text).toContain('项一');
    expect(text).toContain('项二');
  });

  it('leaves plain text alone when nothing looks like a document', () => {
    expect(htmlToText('plain & simple < 3', false)).toBe('plain & simple < 3');
  });
});

describe('web_fetch execution', () => {
  it('truncates oversized bodies at the byte cap with a truncation marker', async () => {
    overrideConfig({ webFetchMaxBytes: 2048 });
    const served = 'x'.repeat(8192);
    const base = await startFixtureServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><head><title>页标题</title></head><body><p>${served}</p></body></html>`);
    });
    const result = await executeBotTool(
      1,
      { id: 'call_1', name: 'web_fetch', arguments: JSON.stringify({ url: `${base}/page` }) },
      new AbortController().signal,
    );
    expect(result.content).toContain('网页正文');
    expect(result.content).toContain('页标题');
    expect(result.content).toContain(`超过 ${config.webFetchMaxBytes} 字节上限`);
    expect(result.content.length).toBeLessThan(served.length);
    expect(result.sources).toEqual([{ title: '页标题', url: `${base}/page` }]);
  });

  it('rejects declared binary content types as a structured tool failure', async () => {
    const base = await startFixtureServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    const result = await executeBotTool(
      1,
      { id: 'call_2', name: 'web_fetch', arguments: JSON.stringify({ url: `${base}/logo.png` }) },
      new AbortController().signal,
    );
    expect(result.sources).toEqual([]);
    expect(result.content).toContain('仅支持文本内容');
  });

  it('refuses private addresses while ALLOW_PRIVATE_BOT_URLS is off', async () => {
    overrideConfig({ allowPrivateBotUrls: false });
    const result = await executeBotTool(
      1,
      {
        id: 'call_3',
        name: 'web_fetch',
        arguments: JSON.stringify({ url: 'http://127.0.0.1:9555/admin' }),
      },
      new AbortController().signal,
    );
    expect(result.sources).toEqual([]);
    expect(result.content).toContain('工具调用失败（web_fetch）');
    expect(result.content).toMatch(/UNSAFE_BOT_URL|private or reserved/);
  });

  it('answers with the rate-limit text instead of throwing when the per-minute cap is hit', async () => {
    // max=0 denies every attempt; the generation must survive this as a tool
    // message the model can answer around.
    overrideConfig({ rateLimitEnabled: true, botToolRatePerMin: 0 });
    const result = await executeBotTool(
      1,
      { id: 'call_4', name: 'web_search', arguments: JSON.stringify({ query: 'anything' }) },
      new AbortController().signal,
    );
    expect(result.sources).toEqual([]);
    expect(result.content).toContain('每分钟上限');
  });

  it('reports malformed arguments as a tool failure', async () => {
    const result = await executeBotTool(
      1,
      { id: 'call_5', name: 'web_search', arguments: '{not json' },
      new AbortController().signal,
    );
    expect(result.content).toContain('不是合法 JSON');
    const missing = await executeBotTool(
      1,
      { id: 'call_6', name: 'web_fetch', arguments: '{}' },
      new AbortController().signal,
    );
    expect(missing.content).toContain('缺少要抓取的链接');
  });
});
