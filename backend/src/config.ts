import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const envCandidates = [
  path.resolve(process.cwd(), '../.env'),
  path.resolve(process.cwd(), '.env'),
];

for (const candidate of envCandidates) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

/**
 * `TRUST_PROXY` accepts `true`/`false`, a hop count (`1`, `2`, ...) or an Express
 * trust-list string (`loopback`, `uniquelocal`, `127.0.0.1,10.0.0.0/8`).
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = raw?.trim();
  if (!value || value === 'false') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters (openssl rand -hex 32)'),
  BOT_KEY_SECRET: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'BOT_KEY_SECRET must be 64 lowercase hex characters')
    .refine(
      (value) => new Set(value).size > 1,
      'BOT_KEY_SECRET must not repeat a single character (generate it with openssl rand -hex 32)',
    ),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z
    .string()
    .min(1, 'ADMIN_PASSWORD is required (generate it with openssl rand -hex 16)'),
  CAPTCHA_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  RATE_LIMIT_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  /**
   * Optional Redis for shared rate-limit counters. Unset (or empty) keeps the
   * per-process in-memory buckets, which is all a single instance needs.
   */
  REDIS_URL: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined))
    .refine(
      (value) => value === undefined || /^rediss?:\/\/\S+$/.test(value),
      'REDIS_URL must start with redis:// or rediss://',
    ),
  ALLOW_PRIVATE_BOT_URLS: z.string().default('false').transform((v) => v === 'true'),
  TRUST_PROXY: z.string().optional().transform(parseTrustProxy),
  BOT_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  BOT_CONTEXT_MESSAGES: z.coerce.number().int().positive().default(20),
  BOT_CONTEXT_MAX_CHARS: z.coerce.number().int().positive().default(6000),
  BOT_RATE_PER_MIN: z.coerce.number().int().positive().default(20),
  BOT_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(2000),
  BOT_THROTTLE_MS: z.coerce.number().int().positive().default(80),
  /**
   * Defence in depth against a single room fanning out to an unbounded number
   * of model calls. The creation quota counts every room-scoped bot row in the
   * room (disabled rows included); the read path truncates to the same number
   * so pre-existing excess, however it got there, cannot amplify one message.
   */
  BOT_MAX_PER_ROOM: z.coerce.number().int().min(1).max(50).default(10),
  /** Maximum bot rows one user may own across global bots and every room. */
  BOT_MAX_PER_OWNER: z.coerce.number().int().min(1).max(100).default(20),
  /**
   * Hard cap on bytes read from a provider response (JSON, text, an error
   * body, or the sum of an SSE stream). Reading stops and the connection is
   * cancelled at the limit; `Content-Length` is never trusted.
   */
  BOT_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1024)
    .max(16 * 1024 * 1024)
    .default(1024 * 1024),
  /**
   * Maximum bytes buffered for a single SSE event (including an incomplete
   * event still waiting for its blank-line terminator).
   */
  BOT_MAX_SSE_EVENT_BYTES: z.coerce
    .number()
    .int()
    .min(16 * 1024)
    .max(1024 * 1024)
    .default(256 * 1024),
  /** How often the scheduled-message worker looks for due rows. */
  SCHEDULED_TICK_MS: z.coerce.number().int().min(1000).default(15000),
  CORS_ORIGIN: z.string().optional(),
  /**
   * Directory holding uploaded room attachments. Relative paths resolve
   * against the process cwd; unset keeps `backend/uploads` next to the source
   * tree, so dev (`src/config.ts`) and build (`dist/config.js`) agree.
   */
  UPLOAD_DIR: z.string().trim().optional(),
  /**
   * Per-user disk budget for room attachments, in bytes. Uploads count against
   * it whether or not they are bound to a message, because they already occupy
   * disk. `0` disables the check.
   */
  ATTACHMENT_USER_QUOTA_BYTES: z.coerce.number().int().nonnegative().default(209715200),
  /**
   * Hard cap on the number of attachment rows one user may own. It is the row
   * counterpart to the byte quota: a flood of tiny files exhausts inodes and
   * per-row bookkeeping long before it fills 200 MiB, and a bulk forward
   * copies every source file under the forwarder's account.
   */
  ATTACHMENT_USER_MAX_FILES: z.coerce.number().int().min(1).max(100000).default(1000),
  /**
   * How long an attachment may sit unbound (uploaded but never sent) or bound
   * to a withdrawn message before the cleanup sweep deletes it. Attachments of
   * live messages are never removed.
   */
  ATTACHMENT_ORPHAN_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(24),
  /** How often the orphaned-attachment sweep runs. */
  ATTACHMENT_CLEANUP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(21_600_000),
  /**
   * Row cap for the streaming audit export. The export pages through the log
   * with keyset batches, so this bounds one download without buffering rows;
   * when the log holds more matches the response carries
   * `X-Audit-Truncated: true`.
   */
  AUDIT_EXPORT_ALL_MAX: z.coerce.number().int().min(1).max(1_000_000).default(100_000),
  /** How often rooms with a retention policy drop expired messages. */
  ROOM_RETENTION_SWEEP_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(21_600_000),
  /**
   * Optional OpenAI-compatible translation provider. Translation is enabled
   * only when all three of base URL, API key and model are set; a partially
   * configured provider leaves the endpoint disabled (503) instead of failing
   * at request time. Empty values count as unset.
   */
  TRANSLATE_BASE_URL: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined))
    .refine(
      (value) => value === undefined || /^https?:\/\/\S+$/.test(value),
      'TRANSLATE_BASE_URL must start with http:// or https://',
    ),
  TRANSLATE_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined)),
  TRANSLATE_MODEL: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined)),
  /** Wall-clock budget for one translation request, including body read. */
  TRANSLATE_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  /**
   * In-process cache of successful translations. `0` disables it; entries
   * expire after this many milliseconds. Only translated text is kept, never
   * the source, and the key changes whenever a message is edited.
   */
  TRANSLATE_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(3_600_000),
  /** Maximum cached translations; the least recently used entry is evicted. */
  TRANSLATE_CACHE_MAX: z.coerce.number().int().min(1).max(5000).default(500),
});

export type Env = z.infer<typeof envSchema>;

/** Parses and validates environment variables, throwing on any invalid value. */
export function validateEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

const env = ((): Env => {
  try {
    return validateEnv(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
})();

export const config = {
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  jwtSecret: env.JWT_SECRET,
  botKeySecret: env.BOT_KEY_SECRET,
  adminUsername: env.ADMIN_USERNAME,
  adminPassword: env.ADMIN_PASSWORD,
  captchaEnabled: env.CAPTCHA_ENABLED,
  rateLimitEnabled: env.RATE_LIMIT_ENABLED,
  redisUrl: env.REDIS_URL,
  allowPrivateBotUrls: env.ALLOW_PRIVATE_BOT_URLS,
  trustProxy: env.TRUST_PROXY,
  botTimeoutMs: env.BOT_TIMEOUT_MS,
  botContextMessages: env.BOT_CONTEXT_MESSAGES,
  botContextMaxChars: env.BOT_CONTEXT_MAX_CHARS,
  botRatePerMin: env.BOT_RATE_PER_MIN,
  botDebounceMs: env.BOT_DEBOUNCE_MS,
  botThrottleMs: env.BOT_THROTTLE_MS,
  botMaxPerRoom: env.BOT_MAX_PER_ROOM,
  botMaxPerOwner: env.BOT_MAX_PER_OWNER,
  botMaxResponseBytes: env.BOT_MAX_RESPONSE_BYTES,
  botMaxSseEventBytes: env.BOT_MAX_SSE_EVENT_BYTES,
  scheduledTickMs: env.SCHEDULED_TICK_MS,
  corsOrigin: env.CORS_ORIGIN,
  uploadDir: env.UPLOAD_DIR
    ? path.resolve(process.cwd(), env.UPLOAD_DIR)
    : path.resolve(__dirname, '..', 'uploads'),
  attachmentUserQuotaBytes: env.ATTACHMENT_USER_QUOTA_BYTES,
  attachmentUserMaxFiles: env.ATTACHMENT_USER_MAX_FILES,
  attachmentOrphanTtlHours: env.ATTACHMENT_ORPHAN_TTL_HOURS,
  attachmentCleanupIntervalMs: env.ATTACHMENT_CLEANUP_INTERVAL_MS,
  auditExportAllMax: env.AUDIT_EXPORT_ALL_MAX,
  roomRetentionSweepMs: env.ROOM_RETENTION_SWEEP_MS,
  translateBaseUrl: env.TRANSLATE_BASE_URL,
  translateApiKey: env.TRANSLATE_API_KEY,
  translateModel: env.TRANSLATE_MODEL,
  translateTimeoutMs: env.TRANSLATE_TIMEOUT_MS,
  translateCacheTtlMs: env.TRANSLATE_CACHE_TTL_MS,
  translateCacheMax: env.TRANSLATE_CACHE_MAX,
};

// Attachments are written straight to disk, so the destination must exist
// before the first upload; a missing directory would surface as a 500.
fs.mkdirSync(config.uploadDir, { recursive: true });
