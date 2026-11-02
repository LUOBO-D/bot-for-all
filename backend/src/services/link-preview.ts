import type { Server } from 'socket.io';
import { safeFetch } from '../bot/safe-fetch';
import { pool, type ResultSetHeader } from '../db';
import { logger } from '../logger';
import type { MessageDTO, MessagePreview } from '../types';
import { getMessageById } from './message';

/** Wall-clock budget for a single preview request. */
const FETCH_TIMEOUT_MS = 3_000;
/** Hard cap on the bytes read from the response body (256 KiB). */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_TITLE = 255;
const MAX_DESCRIPTION = 300;
const MAX_SITE = 128;
const MAX_URL = 512;

/** Trailing characters that belong to prose rather than to the URL itself. */
const TRAILING_PUNCTUATION = /[.,;:!?'"”’)\]}<>]+$/;

/**
 * First `http(s)` URL in a message body, with sentence punctuation trimmed.
 * Markdown/plain text both work; returns `null` when the text has no link.
 */
export function extractFirstUrl(content: string): string | null {
  const match = /https?:\/\/[^\s<>"'`\u3000]+/i.exec(content);
  if (!match) {
    return null;
  }
  const trimmed = match[0].replace(TRAILING_PUNCTUATION, '');
  if (trimmed.length === 0 || trimmed.length > MAX_URL) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

/** Minimal HTML entity decoding: the five named entities plus numeric refs. */
function decodeEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi,
    (whole, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (decimal !== undefined) {
        return safeCodePoint(Number.parseInt(decimal, 10)) ?? whole;
      }
      if (hex !== undefined) {
        return safeCodePoint(Number.parseInt(hex, 16)) ?? whole;
      }
      switch (named?.toLowerCase()) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        case 'nbsp':
          return ' ';
        default:
          return whole;
      }
    },
  );
}

function safeCodePoint(code: number): string | null {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) {
    return null;
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return null;
  }
}

/** Collapses whitespace and decodes entities, so markup never leaks into a DTO. */
function normalizeText(value: string | undefined): string {
  if (!value) {
    return '';
  }
  return decodeEntities(value).replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const cut = value.slice(0, max);
  // Never leave a dangling high surrogate: utf8mb4 would reject or mangle it.
  const lastCode = cut.charCodeAt(cut.length - 1);
  const safe = lastCode >= 0xd800 && lastCode <= 0xdbff ? cut.slice(0, -1) : cut;
  return safe.trimEnd();
}

const ATTRIBUTE_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function readAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  ATTRIBUTE_RE.lastIndex = 0;
  let match = ATTRIBUTE_RE.exec(tag);
  while (match !== null) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    // First occurrence wins, matching browser behaviour for duplicate attributes.
    attributes[name] ??= value;
    match = ATTRIBUTE_RE.exec(tag);
  }
  return attributes;
}

interface HtmlMeta {
  title: string;
  description: string;
  site: string;
}

/**
 * Pulls the tags a link preview needs. Attribute order and quoting style are
 * irrelevant (attributes are parsed, not pattern-matched), and both `property`
 * and `name` are accepted because sites use either for Open Graph tags.
 */
function parseHtml(html: string): HtmlMeta {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const documentTitle = titleMatch ? normalizeText(titleMatch[1]) : '';
  let ogTitle = '';
  let description = '';
  let site = '';

  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = readAttributes(tag);
    const key = (attributes.property ?? attributes.name ?? '').toLowerCase();
    const content = normalizeText(attributes.content);
    if (!content) {
      continue;
    }
    // First occurrence of each key wins, and Open Graph beats <title>.
    if (key === 'og:title' && !ogTitle) {
      ogTitle = content;
    } else if (key === 'og:description' && !description) {
      description = content;
    } else if (key === 'og:site_name' && !site) {
      site = content;
    }
  }

  return { title: ogTitle || documentTitle, description, site };
}

/** Reads at most `MAX_BODY_BYTES` of the body as UTF-8 text. */
async function readBodyCapped(response: Response): Promise<string> {
  const body = response.body;
  if (!body) {
    return '';
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_BODY_BYTES) {
        break;
      }
    }
  } finally {
    // Stop the transfer even when the cap was hit mid-body.
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(Math.min(total, MAX_BODY_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= merged.length) {
      break;
    }
    const slice = chunk.subarray(0, merged.length - offset);
    merged.set(slice, offset);
    offset += slice.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

/**
 * Fetches Open Graph metadata for `url`.
 *
 * All requests go through `safeFetch`, so the address validation (cloud
 * metadata endpoints always refused, private ranges refused unless explicitly
 * allowed) and the DNS-pinned lookup apply here exactly as they do for bot
 * providers — a message can never make the server probe internal hosts.
 * The response is bounded in both time (3s) and size (256 KiB), only `text/html`
 * is parsed, and every failure yields `null` instead of throwing.
 */
export async function fetchPreview(url: string): Promise<MessagePreview | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  try {
    const response = await safeFetch(parsed, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'bot-for-all-link-preview/1.0',
      },
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/html')) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }

    const html = await readBodyCapped(response);
    const meta = parseHtml(html);
    const hostname = parsed.hostname;
    const title = truncate(meta.title || hostname, MAX_TITLE);
    return {
      url: truncate(parsed.toString(), MAX_URL),
      title,
      description: truncate(meta.description, MAX_DESCRIPTION),
      site: truncate(meta.site || hostname, MAX_SITE),
    };
  } catch (error) {
    logger.debug({ err: error, url }, 'link preview fetch failed');
    return null;
  }
}

/**
 * Fetches and stores the preview of the first URL in `message`, then broadcasts
 * the refreshed DTO as `message:updated`. Never throws: a failed fetch leaves
 * the message untouched and is only logged.
 */
export async function attachLinkPreview(
  io: Server,
  roomId: number,
  message: MessageDTO,
): Promise<void> {
  try {
    if (message.preview || message.deleted || message.status === 'streaming') {
      return;
    }
    const url = extractFirstUrl(message.content);
    if (!url) {
      return;
    }
    const preview = await fetchPreview(url);
    if (!preview) {
      return;
    }

    // `preview_url IS NULL` keeps a concurrent attach from overwriting the first
    // result, and the deleted/edited guards drop results for stale content.
    const [result] = await pool.execute<ResultSetHeader>(
      `UPDATE messages
       SET preview_url = ?, preview_title = ?, preview_description = ?, preview_site = ?
       WHERE id = ? AND deleted_at IS NULL AND preview_url IS NULL`,
      [preview.url, preview.title, preview.description, preview.site, message.id],
    );
    if (result.affectedRows === 0) {
      return;
    }

    const updated = await getMessageById(message.id);
    io.to(`room:${roomId}`).emit('message:updated', { roomId, message: updated });
  } catch (error) {
    logger.warn({ err: error, roomId, messageId: message.id }, 'link preview attach failed');
  }
}
