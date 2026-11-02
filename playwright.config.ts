import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
    // Voice-message e2e records through Chromium's fake audio device.
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  webServer: [
    {
      command:
        'pnpm --filter backend e2e:reset && pnpm --filter backend migrate && pnpm --filter backend seed:admin && pnpm --filter backend dev',
      url: 'http://127.0.0.1:3000/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        CAPTCHA_ENABLED: 'false',
        RATE_LIMIT_ENABLED: 'false',
        SCHEDULED_TICK_MS: '1000',
        DATABASE_URL: 'mysql://root:devroot@127.0.0.1:3306/chat_e2e',
        ADMIN_USERNAME: 'admin',
        ADMIN_PASSWORD: 'e2e-admin-pass',
        TRANSLATE_BASE_URL: 'http://127.0.0.1:4010/v1',
        TRANSLATE_MODEL: 'fake-translate',
        TRANSLATE_API_KEY: 'test-translate-key',
      },
    },
    {
      command: 'pnpm --filter frontend exec vite --port 5174 --strictPort',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter backend fake:openai',
      url: 'http://127.0.0.1:4010/health',
      reuseExistingServer: false,
    },
  ],
});
