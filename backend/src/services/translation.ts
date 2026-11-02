import { config } from '../config';
import { ApiError } from '../errors';
import { logger } from '../logger';

/** Maximum source characters accepted by the translate endpoint. */
export const TRANSLATE_CONTENT_MAX = 4000;
/** Maximum `targetLang` length accepted from the client. */
export const TRANSLATE_TARGET_LANG_MAX = 20;
/** Language used when the request omits `targetLang`. */
export const TRANSLATE_DEFAULT_TARGET_LANG = 'zh-CN';
/** Per-user translation attempts allowed in one rolling minute. */
export const TRANSLATE_RATE_MAX = 20;
export const TRANSLATE_RATE_WINDOW_MS = 60_000;
/**
 * Hard cap on bytes read from the provider response. Enforced on the bytes
 * actually handed over by the reader, never on `Content-Length`, which a
 * provider can omit or lie about. Crossing it cancels the connection.
 */
export const TRANSLATE_MAX_RESPONSE_BYTES = 64 * 1024;

const SYSTEM_PROMPT =
  'You are a translation engine. Translate the user text into the requested target language. ' +
  'Output only the translation, with no explanations, quotes, labels, or extra text. ' +
  'Preserve the original formatting and line breaks.';

/**
 * Process-local LRU of successful translations. A `Map` iterates in insertion
 * order, so a hit re-inserts the entry to mark it most recently used and the
 * cap evicts the first key. Only translated text is stored, never the source.
 */
const translationCache = new Map<string, { text: string; expiresAt: number }>();

function readCachedTranslation(key: string): string | undefined {
  if (config.translateCacheTtlMs <= 0 || config.translateCacheMax <= 0) {
    return undefined;
  }
  const entry = translationCache.get(key);
  if (entry === undefined) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    translationCache.delete(key);
    return undefined;
  }
  // Re-insert so this key becomes the newest entry in iteration order.
  translationCache.delete(key);
  translationCache.set(key, entry);
  return entry.text;
}

function writeCachedTranslation(key: string, text: string): void {
  if (config.translateCacheTtlMs <= 0 || config.translateCacheMax <= 0) {
    return;
  }
  const now = Date.now();
  // Sweep expired entries first; otherwise a backlog of dead keys would
  // evict live ones at the cap.
  for (const [existingKey, entry] of translationCache) {
    if (entry.expiresAt <= now) {
      translationCache.delete(existingKey);
    }
  }
  translationCache.delete(key);
  translationCache.set(key, { text, expiresAt: now + config.translateCacheTtlMs });
  while (translationCache.size > config.translateCacheMax) {
    const oldest = translationCache.keys().next();
    if (oldest.done === true) {
      break;
    }
    translationCache.delete(oldest.value);
  }
}

/** Drops every cached translation; tests use it to isolate cases. */
export function clearTranslationCache(): void {
  translationCache.clear();
}

/** Translation is enabled only when all three provider settings are present. */
export function isTranslationEnabled(): boolean {
  return Boolean(config.translateBaseUrl && config.translateApiKey && config.translateModel);
}

/** Throws the contract's 503 when the provider is not fully configured. */
export function assertTranslationEnabled(): void {
  if (!isTranslationEnabled()) {
    throw new ApiError(
      503,
      'TRANSLATION_DISABLED',
      'Message translation is not configured on this server',
    );
  }
}

/** The shared 502 for every provider-side failure; details stay in the log. */
function translationFailed(): ApiError {
  return new ApiError(502, 'TRANSLATION_FAILED', 'Translation provider failed');
}

/** Reads at most {@link TRANSLATE_MAX_RESPONSE_BYTES} and fails past the cap. */
async function readCappedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw translationFailed();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > TRANSLATE_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw translationFailed();
      }
      chunks.push(value);
    }
  } catch (error) {
    // Aborts, malformed reads and the size cap all release the connection.
    await reader.cancel().catch(() => undefined);
    if (error instanceof ApiError) {
      throw error;
    }
    throw translationFailed();
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks, total));
}

/** First `choices[0].message.content` string, or `null` for any other shape. */
function extractTranslation(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('choices' in payload)) {
    return null;
  }
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null || !('message' in first)) {
    return null;
  }
  const message = first.message;
  if (typeof message !== 'object' || message === null || !('content' in message)) {
    return null;
  }
  return typeof message.content === 'string' ? message.content : null;
}

export interface TranslateInput {
  /** Message row id; with `editedAt` it identifies the cached translation. */
  messageId: number;
  /** ISO timestamp of the last edit, `null` until the first edit. */
  editedAt: string | null;
  text: string;
  targetLang: string;
}

/**
 * Returns a translation, serving the in-process cache when the same message
 * revision and target language were already translated successfully. Only
 * successes are cached: failures propagate and are retried by the next call.
 */
export async function translateText(input: TranslateInput): Promise<string> {
  assertTranslationEnabled();
  // `messageId:editedAt:targetLang`; an edit changes `editedAt` and misses
  // every language cached for the previous revision.
  const key = `${input.messageId}:${input.editedAt ?? ''}:${input.targetLang}`;
  const cached = readCachedTranslation(key);
  if (cached !== undefined) {
    return cached;
  }
  const text = await requestTranslation(input);
  writeCachedTranslation(key, text);
  return text;
}

/**
 * Calls the configured OpenAI-compatible endpoint and returns the translated
 * text. The source text is never logged; failures collapse into the contract's
 * 502 `TRANSLATION_FAILED`, whether they come from the timeout, a non-2xx
 * status, an oversized body, invalid JSON, or a response without choices.
 */
async function requestTranslation(input: TranslateInput): Promise<string> {
  const baseUrl = config.translateBaseUrl as string;
  const apiKey = config.translateApiKey as string;
  const model = config.translateModel as string;

  const signal = AbortSignal.timeout(config.translateTimeoutMs);
  let response: Response;
  try {
    // `${baseUrl}/chat/completions`; the configured base URL may include a
    // version prefix (`/v1`) and may end with a slash.
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Target language: ${input.targetLang}\n\n${input.text}` },
        ],
      }),
      signal,
      // The URL comes from server configuration, never from a request, but a
      // provider redirect is still not part of the contract.
      redirect: 'error',
    });
  } catch (error) {
    logger.warn({ err: error, targetLang: input.targetLang }, 'translation provider request failed');
    throw translationFailed();
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    logger.warn(
      { status: response.status, targetLang: input.targetLang },
      'translation provider returned an error status',
    );
    throw translationFailed();
  }

  let payloadText: string;
  try {
    payloadText = await readCappedText(response);
  } catch (error) {
    logger.warn(
      { err: error, targetLang: input.targetLang },
      'translation provider response could not be read',
    );
    throw translationFailed();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    logger.warn({ targetLang: input.targetLang }, 'translation provider returned invalid JSON');
    throw translationFailed();
  }

  const text = extractTranslation(payload);
  if (text === null || text.trim() === '') {
    logger.warn({ targetLang: input.targetLang }, 'translation provider returned no translation');
    throw translationFailed();
  }
  return text.trim();
}
