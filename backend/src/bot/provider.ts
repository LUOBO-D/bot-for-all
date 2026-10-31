import { config } from '../config';
import { SseParser } from './sse';
import { assertSafeBotUrl } from './url';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  extraBody?: Record<string, unknown> | null;
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
  return {
    ...(options.extraBody ?? {}),
    model: options.model,
    messages: options.messages,
    stream,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
  };
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

async function request(
  options: StreamOptions,
  stream: boolean,
  signal: AbortSignal,
): Promise<Response> {
  await assertSafeBotUrl(options.baseUrl);
  try {
    return await fetch(endpointFor(options.baseUrl), requestInit(options, stream, signal));
  } catch (error) {
    throw normalizeFetchError(error);
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

async function readNonStream(options: StreamOptions, signal: AbortSignal): Promise<string> {
  const response = await request(options, false, signal);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ProviderAuthError(`Provider auth failed (${response.status})`, response.status);
    }
    if (response.status === 429) {
      throw new ProviderRateError('Provider rate limited', response.status);
    }
    throw new ProviderError(`Provider error ${response.status}`, response.status);
  }
  const json: unknown = await response.json();
  return extractNonStreamContent(json);
}

export async function completeOnce(options: StreamOptions): Promise<string> {
  const signal = AbortSignal.timeout(config.botTimeoutMs);
  return readNonStream(options, signal);
}

export async function* streamChat(options: StreamOptions): AsyncGenerator<string> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(config.botTimeoutMs)])
    : AbortSignal.timeout(config.botTimeoutMs);

  const response = await request(options, true, signal);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      throw new ProviderAuthError(`Provider auth failed (${response.status})`, response.status);
    }
    if (response.status === 429) {
      throw new ProviderRateError('Provider rate limited', response.status);
    }
    if ([400, 404, 405, 415, 422].includes(response.status)) {
      yield await readNonStream(options, signal);
      return;
    }
    throw new ProviderError(
      `Provider error ${response.status}: ${text.slice(0, 200)}`,
      response.status,
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    const json: unknown = await response.json();
    yield extractNonStreamContent(json);
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new ProviderError('Provider returned no body');
  }

  const decoder = new TextDecoder('utf-8');
  const parser = new SseParser();

  const emit = (payload: string): string | null => {
    if (payload === '[DONE]') {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
    return extractDeltaContent(parsed);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = decoder.decode(value, { stream: true });
    for (const payload of parser.feed(chunk)) {
      if (payload === '[DONE]') {
        return;
      }
      const text = emit(payload);
      if (text) {
        yield text;
      }
    }
  }

  const tail = decoder.decode();
  if (tail) {
    for (const payload of parser.feed(tail)) {
      if (payload === '[DONE]') {
        return;
      }
      const text = emit(payload);
      if (text) {
        yield text;
      }
    }
  }
}
