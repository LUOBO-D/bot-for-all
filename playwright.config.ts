import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter backend migrate && pnpm --filter backend dev',
      url: 'http://127.0.0.1:3000/api/health',
      reuseExistingServer: false,
      env: {
        CAPTCHA_ENABLED: 'false',
        RATE_LIMIT_ENABLED: 'false',
        DATABASE_URL: 'mysql://root:devroot@127.0.0.1:3306/chat_e2e',
      },
    },
    {
      command: 'pnpm --filter frontend dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
    },
    {
      command: 'pnpm --filter backend fake:openai',
      url: 'http://127.0.0.1:4010/health',
      reuseExistingServer: true,
    },
  ],
});
