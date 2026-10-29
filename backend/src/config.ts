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
  ALLOW_PRIVATE_BOT_URLS: z.string().default('false').transform((v) => v === 'true'),
  TRUST_PROXY: z.string().optional().transform(parseTrustProxy),
  BOT_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  BOT_CONTEXT_MESSAGES: z.coerce.number().int().positive().default(20),
  BOT_CONTEXT_MAX_CHARS: z.coerce.number().int().positive().default(6000),
  BOT_RATE_PER_MIN: z.coerce.number().int().positive().default(20),
  BOT_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(2000),
  BOT_THROTTLE_MS: z.coerce.number().int().positive().default(80),
  CORS_ORIGIN: z.string().optional(),
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
  allowPrivateBotUrls: env.ALLOW_PRIVATE_BOT_URLS,
  trustProxy: env.TRUST_PROXY,
  botTimeoutMs: env.BOT_TIMEOUT_MS,
  botContextMessages: env.BOT_CONTEXT_MESSAGES,
  botContextMaxChars: env.BOT_CONTEXT_MAX_CHARS,
  botRatePerMin: env.BOT_RATE_PER_MIN,
  botDebounceMs: env.BOT_DEBOUNCE_MS,
  botThrottleMs: env.BOT_THROTTLE_MS,
  corsOrigin: env.CORS_ORIGIN,
};
