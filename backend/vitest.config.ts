import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'mysql://root:devroot@127.0.0.1:3306/chat_test',
      JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123',
      BOT_KEY_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'test-admin-password',
      CAPTCHA_ENABLED: 'false',
      RATE_LIMIT_ENABLED: 'false',
      ALLOW_PRIVATE_BOT_URLS: 'true',
      TRUST_PROXY: 'false',
      BOT_TIMEOUT_MS: '1500',
      BOT_DEBOUNCE_MS: '200',
      BOT_THROTTLE_MS: '10',
    },
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
