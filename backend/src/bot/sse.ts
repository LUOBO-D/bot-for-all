import { config } from '../config';
import { ApiError } from '../errors';

export interface SseParserOptions {
  /** Bytes allowed in the unfinished-event buffer. Defaults to config.botMaxSseEventBytes. */
  maxBufferBytes?: number;
  /** Bytes allowed in one complete event. Defaults to {@link maxBufferBytes}. */
  maxEventBytes?: number;
}

/** The shared 502 thrown whenever a provider response crosses a byte cap. */
export function responseTooLargeError(message?: string): ApiError {
  return new ApiError(
    502,
    'BOT_RESPONSE_TOO_LARGE',
    message ?? 'Bot provider response exceeds the configured size limit',
  );
}

/**
 * Incremental SSE parser.
 *
 * A hostile provider could stream an event without ever emitting the blank
 * line that terminates it, so both the unfinished buffer and every complete
 * event are capped in bytes and fail fast instead of growing without bound.
 * Scanning remembers its last position and the buffer is compacted once per
 * `feed`, keeping total work linear in the bytes received.
 */
export class SseParser {
  private buffer = '';

  private bufferBytes = 0;

  private scanFrom = 0;

  private pendingCR = false;

  private readonly maxBufferBytes: number;

  private readonly maxEventBytes: number;

  constructor(options: number | SseParserOptions = {}) {
    const normalized = typeof options === 'number' ? { maxBufferBytes: options } : options;
    this.maxBufferBytes = normalized.maxBufferBytes ?? config.botMaxSseEventBytes;
    this.maxEventBytes = normalized.maxEventBytes ?? this.maxBufferBytes;
  }

  feed(chunk: string): string[] {
    const text = this.normalizeLineEndings(chunk);
    this.buffer += text;
    this.bufferBytes += Buffer.byteLength(text);

    const events: string[] = [];
    let start = 0;
    let boundary = this.buffer.indexOf('\n\n', this.scanFrom);
    while (boundary >= 0) {
      const rawEvent = this.buffer.slice(start, boundary);
      if (Buffer.byteLength(rawEvent) > this.maxEventBytes) {
        this.reset();
        throw responseTooLargeError('Bot provider SSE event exceeds the configured size limit');
      }
      const dataLines: string[] = [];
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (dataLines.length > 0) {
        events.push(dataLines.join('\n'));
      }
      start = boundary + 2;
      boundary = this.buffer.indexOf('\n\n', start);
    }

    if (start > 0) {
      this.bufferBytes -= Buffer.byteLength(this.buffer.slice(0, start));
      this.buffer = this.buffer.slice(start);
    }
    // A boundary can straddle the old end and the new chunk, so rescan one
    // character before the end instead of searching the whole buffer again.
    this.scanFrom = Math.max(0, this.buffer.length - 1);

    if (this.bufferBytes > this.maxBufferBytes) {
      this.reset();
      throw responseTooLargeError('Bot provider SSE buffer exceeds the configured size limit');
    }
    return events;
  }

  /**
   * Normalizes CRLF/CR line endings one chunk at a time. A trailing CR is held
   * back so a CRLF split across two chunks still becomes a single newline.
   */
  private normalizeLineEndings(chunk: string): string {
    let prefix = '';
    let rest = chunk;
    if (this.pendingCR) {
      this.pendingCR = false;
      if (rest.startsWith('\n')) {
        prefix = '\n';
        rest = rest.slice(1);
      } else {
        prefix = '\n';
      }
    }
    if (rest.endsWith('\r')) {
      this.pendingCR = true;
      rest = rest.slice(0, -1);
    }
    if (rest.length === 0) {
      return prefix;
    }
    return prefix + rest.replace(/\r\n?/g, '\n');
  }

  private reset(): void {
    this.buffer = '';
    this.bufferBytes = 0;
    this.scanFrom = 0;
    this.pendingCR = false;
  }
}
