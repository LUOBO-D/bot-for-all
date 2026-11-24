import { config } from '../config';
import { logger } from '../logger';
import { checkRate } from '../middleware/ratelimit';
import type { ToolFunctionSpec } from './provider';
import { safeFetch } from './safe-fetch';
import { assertSafeBotUrl } from './url';

/** One result link, collected for the deterministic 来源 footer. */
export interface ToolSource {
  title: string;
  url: string;
}

/** What one executed tool call hands back to the gateway. */
export interface ToolExecution {
  /** The tool-role message body the model receives. */
  content: string;
  /** Sources the call actually retrieved; empty when it failed. */
  sources: ToolSource[];
}

/** A model-emitted call, detached from the assistant message it rode in on. */
export interface BotToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * The two web tools attached to every enabled bot's main-chain request once
 * the platform switch is on. The descriptions ask for inline citations; the
 * gateway additionally appends the source list deterministically, so linking
 * never depends on the model's goodwill alone. bot-test (completeOnce) never
 * sends tools.
 */
export const BOT_TOOL_SPECS: ToolFunctionSpec[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '联网搜索最新资料（新闻、事实、价格、人物等），返回若干条标题、URL 和摘要。回答时必须把用到的来源以 markdown 链接写在正文中。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        '抓取一个 http(s) 网页并返回正文纯文本（超长会截断），用于搜索后深入阅读。回答时必须把用到的来源以 markdown 链接写在正文中。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的 http(s) 链接' },
        },
        required: ['url'],
      },
    },
  },
];

/** Identifies the tool egress so operators can recognize the traffic. */
const TOOL_USER_AGENT = 'bot-for-all-web-tools/0.1';
const TOOL_ACCEPT = 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5';
/** GET has no body to preserve, so every redirect status may become a GET. */
const FOLLOWABLE_REDIRECTS = [301, 302, 303, 307, 308];
const MAX_REDIRECT_HOPS = 3;
const TEXT_CONTENT_TYPES =
  /^(text\/|application\/(json|xml|xhtml|rss|atom|ld\+json|javascript|graphql|yaml|toml))/i;

function toolFailure(message: string): ToolExecution {
  return { content: message, sources: [] };
}


/**
 * One tool HTTP request. Every egress validates through `assertSafeBotUrl`
 * plus the address-validating dispatcher inside `safeFetch`; a private
 * network is unreachable no matter which tool asked.
 */
async function toolFetch(
  url: string,
  init: RequestInit,
  baseSignal: AbortSignal,
): Promise<Response> {
  await assertSafeBotUrl(url);
  return safeFetch(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.any([baseSignal, AbortSignal.timeout(config.webToolsTimeoutMs)]),
  });
}

interface ToolResponse {
  response: Response;
  /** The URL the response actually came from, after redirects. */
  url: string;
}

/**
 * Follows GET redirects by hand so every hop is re-validated — never lets
 * undici follow a target the URL checks have not seen.
 */
async function fetchWithRedirects(
  rawUrl: string,
  init: RequestInit,
  baseSignal: AbortSignal,
): Promise<ToolResponse> {
  let url = rawUrl;
  for (let hop = 0; ; hop += 1) {
    const response = await toolFetch(url, init, baseSignal);
    if (!FOLLOWABLE_REDIRECTS.includes(response.status)) {
      return { response, url };
    }
    const location = response.headers.get('location');
    if (!location) {
      return { response, url };
    }
    if (hop >= MAX_REDIRECT_HOPS) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('too many redirects while fetching the page');
    }
    const next = new URL(location, url).toString();
    await assertSafeBotUrl(next);
    await response.body?.cancel().catch(() => undefined);
    url = next;
  }
}

function decodeBody(chunks: Uint8Array[], kept: number, contentType: string): string {
  const buffer = Buffer.concat(chunks, kept);
  const declared = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(declared || 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/**
 * Reads at most WEB_FETCH_MAX_BYTES and releases the socket. Unlike the
 * provider's response cap the limit truncates instead of failing: long pages
 * are normal, only the model's context is bounded.
 */
async function readToolBody(
  response: Response,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { text: '', truncated: false };
  }
  const limit = config.webFetchMaxBytes;
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (kept + value.byteLength > limit) {
        chunks.push(value.subarray(0, limit - kept));
        kept = limit;
        truncated = true;
        break;
      }
      chunks.push(value);
      kept += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (truncated) {
    await reader.cancel().catch(() => undefined);
  }
  return { text: decodeBody(chunks, kept, response.headers.get('content-type') ?? ''), truncated };
}

function safeCodePoint(code: number): string {
  if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff) {
    return '';
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Decodes the handful of entities search pages actually emit. */
function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(markup: string): string {
  return markup.replace(/<[^>]*>/g, ' ');
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t\r\f]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * HTML → plain text: script/style/comment removal, block ends as line breaks,
 * other tags stripped, entities decoded afterwards so escaped markup dies
 * with the real tags. `isHtml` comes from the response content type; the
 * doctype sniff catches servers that label HTML as plain text.
 */
export function htmlToText(input: string, isHtml: boolean): string {
  let text = input;
  if (isHtml || /<html[\s>]|<!doctype\s+html/i.test(input.slice(0, 2000))) {
    text = text
      .replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(
        /<\/(?:p|div|li|ul|ol|dd|dt|tr|h[1-6]|blockquote|pre|table|section|article|header|footer|nav|aside)\s*>/gi,
        '\n',
      )
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<(script|style)\b[\s\S]*$/i, ' ');
    text = stripTags(text);
  }
  return collapseWhitespace(decodeEntities(text));
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Reads one attribute out of a tag's attribute list. */
function attrValue(attrs: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  if (!match) {
    return '';
  }
  return match[1] ?? match[2] ?? match[3] ?? '';
}

/**
 * Resolves a lite href to its target: results point at the redirector
 * `//duckduckgo.com/l/?uddg=<percent-encoded target>`; `searchParams.get`
 * already decodes once, so no second decode happens here.
 */
function unwrapDdgUrl(href: string): string {
  const candidate = href.startsWith('//') ? `https:${href}` : href;
  try {
    const uddg = new URL(candidate).searchParams.get('uddg');
    return uddg ?? candidate;
  } catch {
    return candidate;
  }
}

/**
 * stripTags left a gap wherever a tag was; between CJK characters that gap
 * is a false word boundary, so rejoin it (ASCII wording keeps its spaces).
 */
function joinCjk(text: string): string {
  const cjkBoundary = /(?<=[\u2e80-\u9fff\uff00-\uffef])\s+(?=[\u2e80-\u9fff\uff00-\uffef])/g;
  return text.replace(cjkBoundary, '');
}

/**
 * Extracts the result rows of a DuckDuckGo lite results page. Pure and
 * exported so the parser is tested against a recorded fixture; the live page
 * moves its markers occasionally, and a miss must surface as an empty array
 * (a structured "no results" for the model), never a crash.
 */
export function parseDuckDuckGoLite(html: string, max: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const anchor = /<a\s+([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null) {
    const attrs = match[1];
    // Title links carry rel="nofollow" (or class="result-link"); the page's
    // own navigation links never do.
    if (
      !/rel\s*=\s*["'][^"']*nofollow/i.test(attrs) &&
      !/class\s*=\s*["'][^"']*result-link/i.test(attrs)
    ) {
      continue;
    }
    const url = unwrapDdgUrl(attrValue(attrs, 'href'));
    if (!/^https?:\/\//i.test(url)) {
      continue;
    }
    const content = url.replace(/\/+$/, '');
    if (seen.has(content)) {
      continue;
    }
    // The lite table puts the snippet in a sibling row right after the title.
    const window = html.slice(anchor.lastIndex, anchor.lastIndex + 4096);
    const snippet = /<td[^>]*class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td\s*>/i.exec(window);
    const title = joinCjk(collapseWhitespace(decodeEntities(stripTags(match[2]))));
    seen.add(content);
    hits.push({
      title: title || content,
      url: content,
      snippet: snippet ? joinCjk(collapseWhitespace(decodeEntities(stripTags(snippet[1])))) : '',
    });
    if (hits.length >= max) {
      break;
    }
  }
  return hits;
}

function formatSearchHits(hits: SearchHit[]): ToolExecution {
  const lines = hits.map(
    (hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet || '（无摘要）'}`,
  );
  return {
    content: `搜索结果：\n${lines.join('\n')}`,
    sources: hits.map((hit) => ({ title: hit.title, url: hit.url })),
  };
}

function searchFailure(provider: string, detail: string): ToolExecution {
  return toolFailure(`${provider} 搜索失败（${detail}）；请换个关键词或稍后重试。`);
}

async function duckSearch(query: string, baseSignal: AbortSignal): Promise<ToolExecution> {
  const response = await toolFetch(
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    { headers: { 'User-Agent': TOOL_USER_AGENT, Accept: 'text/html' } },
    baseSignal,
  );
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return searchFailure('DuckDuckGo', `HTTP ${response.status}`);
  }
  const { text } = await readToolBody(response);
  const hits = parseDuckDuckGoLite(text, config.webSearchMaxResults);
  if (hits.length === 0) {
    return searchFailure('DuckDuckGo', '结果页解析为空');
  }
  return formatSearchHits(hits);
}

async function braveSearch(query: string, baseSignal: AbortSignal): Promise<ToolExecution> {
  const response = await toolFetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${config.webSearchMaxResults}`,
    {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': config.webSearchApiKey ?? '',
        'User-Agent': TOOL_USER_AGENT,
      },
    },
    baseSignal,
  );
  const { text } = await readToolBody(response);
  if (response.status !== 200) {
    return searchFailure('Brave', `HTTP ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return searchFailure('Brave', '响应不是合法 JSON');
  }
  const hits: SearchHit[] = [];
  if (typeof parsed === 'object' && parsed !== null && 'web' in parsed) {
    const web = parsed.web;
    if (typeof web === 'object' && web !== null && 'results' in web && Array.isArray(web.results)) {
      for (const raw of web.results) {
        if (typeof raw !== 'object' || raw === null || !('title' in raw) || !('url' in raw)) {
          continue;
        }
        if (typeof raw.title !== 'string' || typeof raw.url !== 'string') {
          continue;
        }
        // Descriptions carry <strong> highlights.
        const description =
          'description' in raw && typeof raw.description === 'string' ? raw.description : '';
        hits.push({
          title: raw.title,
          url: raw.url,
          snippet: collapseWhitespace(decodeEntities(stripTags(description))),
        });
        if (hits.length >= config.webSearchMaxResults) {
          break;
        }
      }
    }
  }
  if (hits.length === 0) {
    return searchFailure('Brave', '没有可用结果');
  }
  return formatSearchHits(hits);
}

async function tavilySearch(query: string, baseSignal: AbortSignal): Promise<ToolExecution> {
  const response = await toolFetch(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.webSearchApiKey ?? ''}`,
      },
      body: JSON.stringify({ query, max_results: config.webSearchMaxResults }),
    },
    baseSignal,
  );
  const { text } = await readToolBody(response);
  if (response.status !== 200) {
    return searchFailure('Tavily', `HTTP ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return searchFailure('Tavily', '响应不是合法 JSON');
  }
  const hits: SearchHit[] = [];
  if (typeof parsed === 'object' && parsed !== null && 'results' in parsed && Array.isArray(parsed.results)) {
    for (const raw of parsed.results) {
      if (typeof raw !== 'object' || raw === null || !('title' in raw) || !('url' in raw)) {
        continue;
      }
      if (typeof raw.title !== 'string' || typeof raw.url !== 'string') {
        continue;
      }
      const content = 'content' in raw && typeof raw.content === 'string' ? raw.content : '';
      hits.push({ title: raw.title, url: raw.url, snippet: content.slice(0, 300) });
      if (hits.length >= config.webSearchMaxResults) {
        break;
      }
    }
  }
  if (hits.length === 0) {
    return searchFailure('Tavily', '没有可用结果');
  }
  return formatSearchHits(hits);
}

function webSearch(query: string, baseSignal: AbortSignal): Promise<ToolExecution> {
  switch (config.webSearchProvider) {
    case 'duckduckgo':
      return duckSearch(query, baseSignal);
    case 'brave':
      return braveSearch(query, baseSignal);
    case 'tavily':
      return tavilySearch(query, baseSignal);
    default:
      return Promise.resolve(toolFailure('搜索源未启用或未配置；请直接回答。'));
  }
}

async function webFetch(rawUrl: string, baseSignal: AbortSignal): Promise<ToolExecution> {
  const { response, url } = await fetchWithRedirects(rawUrl, {
    headers: { 'User-Agent': TOOL_USER_AGENT, Accept: TOOL_ACCEPT },
  }, baseSignal);
  const contentType = response.headers.get('content-type') ?? '';
  // A missing content type is read as text; a declared binary type is not.
  if (contentType && !TEXT_CONTENT_TYPES.test(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    return toolFailure(`web_fetch 仅支持文本内容（收到 ${contentType}）。`);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return toolFailure(`抓取失败：HTTP ${response.status}。`);
  }
  const { text, truncated } = await readToolBody(response);
  const isHtml = /html/i.test(contentType);
  const source = {
    title:
      (isHtml
        ? collapseWhitespace(decodeEntities(stripTags(/<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(text)?.[1] ?? '')))
        : '') || url,
    url,
  };
  const marker = truncated ? `（正文超过 ${config.webFetchMaxBytes} 字节上限，已截断）\n` : '';
  return {
    content: `网页正文（${url}）：\n${htmlToText(text, isHtml)}\n${marker}`.trimEnd(),
    sources: [source],
  };
}

export function parseToolArgs(raw: string): Record<string, unknown> | null {
  if (raw === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    record[key] = value;
  }
  return record;
}

/**
 * Executes one tool call for one bot. Failures come back as tool-message text
 * (the model can rephrase or retry) instead of ending the turn; the only
 * rethrow is an abort, because a stop or the whole-turn budget must settle
 * the generation rather than politely continue.
 */
export async function executeBotTool(
  botUserId: number,
  call: BotToolCall,
  baseSignal: AbortSignal,
): Promise<ToolExecution> {
  if (!(await checkRate(`bot-tool:${botUserId}`, config.botToolRatePerMin, 60_000))) {
    return toolFailure('工具调用已达每分钟上限；请基于已有信息直接回答或提示用户稍后再试。');
  }

  try {
    const args = parseToolArgs(call.arguments);
    if (args === null) {
      return toolFailure('工具参数不是合法 JSON 对象；请修正后重新调用。');
    }
    if (call.name === 'web_search') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      return query
        ? await webSearch(query, baseSignal)
        : toolFailure('缺少搜索关键词（query）。');
    }
    if (call.name === 'web_fetch') {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      return url
        ? await webFetch(url, baseSignal)
        : toolFailure('缺少要抓取的链接（url）。');
    }
    return toolFailure(`未知工具：${call.name}；可用工具只有 web_search 和 web_fetch。`);
  } catch (error) {
    if (baseSignal.aborted) {
      throw error;
    }
    logger.warn({ err: error, tool: call.name }, 'bot tool call failed');
    // The model only needs a usable reason; whole provider stack traces are
    // context bloat, so the first 160 chars suffice.
    const brief = (error instanceof Error ? error.message : String(error)).slice(0, 160);
    return toolFailure(`工具调用失败（${call.name}）：${brief}。请基于已有信息回答或稍后重试。`);
  }
}
