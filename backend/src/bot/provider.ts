import { config } from '../config';
import { safeFetch } from './safe-fetch';
import { responseTooLargeError, SseParser } from './sse';
import { assertSafeBotUrl } from './url';

/** A function-call schema in the OpenAI wire format. */
export interface ToolFunctionSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** A function call emitted by a tool-capable model, in wire format. */
export interface ToolCallPayload {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant-role only: the calls a tool-capable round emitted. */
  tool_calls?: ToolCallPayload[];
  /** Tool-role only: the id of the assistant tool_call this message answers. */
  tool_call_id?: string;
  /** Tool-role only: the function name, for providers that display it. */
  name?: string;
}

export interface StreamOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  extraBody?: Record<string, unknown> | null;
  /** When set, `tools` + `tool_choice: "auto"` join the request body. */
  tools?: ToolFunctionSpec[] | null;
  signal?: AbortSignal;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'ProviderAuthError';
  }
}

export class ProviderRateError extends ProviderError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'ProviderRateError';
  }
}

function endpointFor(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith('/v1')
    ? `${normalized}/chat/completions`
    : `${normalized}/v1/chat/completions`;
}

function requestBody(options: StreamOptions, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...(options.extraBody ?? {}),
    model: options.model,
    messages: options.messages,
    stream,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
  };
  // Tool declarations follow the platform switch in BOTH directions: on →
  // the built-in tools (overriding a stale `tools` in extraBody), off →
  // none survive an extraBody override.
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = 'auto';
  } else {
    delete body.tools;
    delete body.tool_choice;
  }
  return body;
}

function requestInit(options: StreamOptions, stream: boolean, signal: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(requestBody(options, stream)),
    signal,
    // Never let undici follow redirects on its own: a validated base URL
    // could 302 to a metadata/internal address. Hops are re-validated below.
    redirect: 'manual',
  };
}

function extractNonStreamContent(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('choices' in value)) {
    return '';
  }
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return '';
  }
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null || !('message' in first)) {
    return '';
  }
  const message = first.message;
  if (typeof message !== 'object' || message === null || !('content' in message)) {
    return '';
  }
  return typeof message.content === 'string' ? message.content : '';
}

function extractDeltaContent(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('choices' in value)) {
    return null;
  }
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null || !('delta' in first)) {
    return null;
  }
  const delta = first.delta;
  if (typeof delta !== 'object' || delta === null || !('content' in delta)) {
    return null;
  }
  return typeof delta.content === 'string' ? delta.content : null;
}

const MAX_REDIRECT_HOPS = 3;

async function request(
  options: StreamOptions,
  stream: boolean,
  signal: AbortSignal,
): Promise<Response> {
  await assertSafeBotUrl(options.baseUrl);
  let url = endpointFor(options.baseUrl);
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      // `safeFetch` validates every resolved address at connect time, so a
      // rebinding host cannot swap in an internal address after the URL check.
      response = await safeFetch(url, requestInit(options, stream, signal));
    } catch (error) {
      throw normalizeFetchError(error);
    }
    const location = response.headers.get('location');
    if (!location) {
      return response;
    }
    // Only 307/308 preserve POST + body; anything else is refused rather
    // than silently downgraded to GET.
    if (response.status !== 307 && response.status !== 308) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError(`Bot provider returned unsupported redirect (${response.status})`);
    }
    if (hop >= MAX_REDIRECT_HOPS) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError('Bot provider redirected too many times');
    }
    const next = new URL(location, url).toString();
    try {
      await assertSafeBotUrl(next);
    } catch {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError(`Bot redirect target rejected: ${next}`);
    }
    await response.body?.cancel().catch(() => undefined);
    url = next;
  }
}

function normalizeFetchError(error: unknown): Error {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return error;
    }
    return new ProviderError(`Provider request failed: ${error.message}`);
  }
  return new ProviderError(String(error));
}

/**
 * Reads at most `limit` bytes from a response body. The cap is enforced on the
 * bytes actually handed over by the reader, never on `Content-Length` (which a
 * hostile provider can lie about or omit). Crossing the cap cancels the reader
 * so the socket is torn down instead of draining the rest.
 */
async function readCappedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
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
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLargeError(`Bot provider response exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    // Aborts, malformed reads and the cap itself all release the connection.
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks, total));
}

/**
 * Turns a successful non-stream body into reply text. JSON is the normal
 * shape, but a plain-text body is accepted as-is; an invalid JSON content type
 * is a provider error rather than silently empty content.
 */
async function readSuccessBody(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await readCappedText(response, config.botMaxResponseBytes);
  if (text.trim() === '') {
    return '';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (
      contentType.includes('json') ||
      text.trimStart().startsWith('{') ||
      text.trimStart().startsWith('[')
    ) {
      throw new ProviderError('Provider returned invalid JSON');
    }
    return text;
  }
  return extractNonStreamContent(parsed);
}

/**
 * Reads an error body under the same cap, returning a short excerpt for the
 * callers that report it. A body that crosses the cap is itself a response-size
 * failure, so the caller never buffers it.
 */
async function readErrorBody(response: Response): Promise<string> {
  const text = await readCappedText(response, config.botMaxResponseBytes);
  return text.slice(0, 200);
}

async function readNonStream(options: StreamOptions, signal: AbortSignal): Promise<string> {
  const response = await request(options, false, signal);
  if (!response.ok) {
    // Read (and therefore cap) the error body before classifying the status.
    await readErrorBody(response);
    if (response.status === 401 || response.status === 403) {
      throw new ProviderAuthError(`Provider auth failed (${response.status})`, response.status);
    }
    if (response.status === 429) {
      throw new ProviderRateError('Provider rate limited', response.status);
    }
    throw new ProviderError(`Provider error ${response.status}`, response.status);
  }
  return readSuccessBody(response);
}

export async function completeOnce(options: StreamOptions): Promise<string> {
  const signal = AbortSignal.timeout(config.botTimeoutMs);
  return readNonStream(options, signal);
}

/** What one streaming turn yields: text pieces, then the model's tool calls. */
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_calls'; calls: ToolCallPayload[] };

/** One fragment of `choices[0].delta.tool_calls`, in whatever shape arrived. */
interface ToolCallFragment {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/**
 * Pulls the tool-call fragments out of one SSE payload. OpenAI streams open a
 * call on its first fragment (`index`, `id`, `function.name`) and continue it
 * with `function.arguments` pieces; payloads without tool calls return null.
 */
function extractDeltaToolCalls(value: unknown): ToolCallFragment[] | null {
  if (typeof value !== 'object' || value === null || !('choices' in value)) {
    return null;
  }
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null || !('delta' in first)) {
    return null;
  }
  const delta = first.delta;
  if (typeof delta !== 'object' || delta === null || !('tool_calls' in delta)) {
    return null;
  }
  const rawCalls = delta.tool_calls;
  if (!Array.isArray(rawCalls)) {
    return null;
  }
  const fragments: ToolCallFragment[] = [];
  for (const raw of rawCalls) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    // `function` carries the name on the opening fragment only; argument
    // pieces arrive without it.
    const fn =
      'function' in raw &&
      typeof raw.function === 'object' &&
      raw.function !== null
        ? raw.function
        : null;
    fragments.push({
      index: 'index' in raw && typeof raw.index === 'number' ? raw.index : 0,
      id: 'id' in raw && typeof raw.id === 'string' ? raw.id : '',
      name: fn !== null && 'name' in fn && typeof fn.name === 'string' ? fn.name : '',
      arguments:
        fn !== null && 'arguments' in fn && typeof fn.arguments === 'string'
          ? fn.arguments
          : '',
    });
  }
  return fragments;
}

interface ToolCallDraft {
  id: string;
  name: string;
  arguments: string;
}

/** Accumulates streamed fragments into whole function calls, keyed by index. */
class ToolCallCollector {
  private readonly drafts = new Map<number, ToolCallDraft>();

  absorb(value: unknown): void {
    const fragments = extractDeltaToolCalls(value);
    if (fragments === null) {
      return;
    }
    for (const fragment of fragments) {
      const draft = this.drafts.get(fragment.index) ?? { id: '', name: '', arguments: '' };
      if (fragment.id) {
        draft.id = fragment.id;
      }
      if (fragment.name) {
        draft.name = fragment.name;
      }
      draft.arguments += fragment.arguments;
      this.drafts.set(fragment.index, draft);
    }
  }

  /** Whole calls in index order; providers that omit `id` get a stable one. */
  finish(): ToolCallPayload[] {
    return [...this.drafts.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, draft]) => draft.name !== '')
      .map(([index, draft]) => ({
        id: draft.id || `call_${index}`,
        type: 'function' as const,
        function: { name: draft.name, arguments: draft.arguments },
      }));
  }
}

/** Parses one SSE payload into delta events, harvesting tool-call fragments. */
function* processPayload(toolCalls: ToolCallCollector, payload: string): Generator<StreamEvent> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  toolCalls.absorb(parsed);
  const text = extractDeltaContent(parsed);
  if (text) {
    yield { type: 'delta', text };
  }
}

export async function* streamChat(options: StreamOptions): AsyncGenerator<StreamEvent> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(config.botTimeoutMs)])
    : AbortSignal.timeout(config.botTimeoutMs);

  const response = await request(options, true, signal);

  if (!response.ok) {
    const text = await readErrorBody(response);
    if (response.status === 401 || response.status === 403) {
      throw new ProviderAuthError(`Provider auth failed (${response.status})`, response.status);
    }
    if (response.status === 429) {
      throw new ProviderRateError('Provider rate limited', response.status);
    }
    if ([400, 404, 405, 415, 422].includes(response.status)) {
      yield { type: 'delta', text: await readNonStream(options, signal) };
      return;
    }
    throw new ProviderError(`Provider error ${response.status}: ${text}`, response.status);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    yield { type: 'delta', text: await readSuccessBody(response) };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new ProviderError('Provider returned no body');
  }

  const decoder = new TextDecoder('utf-8');
  const parser = new SseParser({
    maxBufferBytes: config.botMaxSseEventBytes,
    maxEventBytes: config.botMaxSseEventBytes,
  });
  // The content path through `extractDeltaContent` is untouched; tool-call
  // fragments reassemble on the side and surface once, after the stream ends.
  const toolCalls = new ToolCallCollector();

  // Counted on raw bytes actually read from the socket, so SSE framing,
  // comments and ignored events all consume the same budget.
  let totalBytes = 0;
  try {
    let sawDone = false;
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > config.botMaxResponseBytes) {
        throw responseTooLargeError(
          `Bot provider response exceeds ${config.botMaxResponseBytes} bytes`,
        );
      }
      const chunk = decoder.decode(value, { stream: true });
      for (const payload of parser.feed(chunk)) {
        if (payload === '[DONE]') {
          sawDone = true;
          break outer;
        }
        yield* processPayload(toolCalls, payload);
      }
    }

    if (!sawDone) {
      const tail = decoder.decode();
      if (tail) {
        for (const payload of parser.feed(tail)) {
          if (payload === '[DONE]') {
            sawDone = true;
            break;
          }
          yield* processPayload(toolCalls, payload);
        }
      }
    }

    const calls = toolCalls.finish();
    if (calls.length > 0) {
      yield { type: 'tool_calls', calls };
    }
  } finally {
    // Also runs on [DONE]/consumer return, releasing the socket promptly
    // instead of waiting for the provider to close an idle stream.
    await reader.cancel().catch(() => undefined);
  }
}
