import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  webServer: {
    // Launch Vite directly so Playwright owns the server process. On Windows,
    // launching it through npm leaves the Vite child alive after the tests and
    // prevents an otherwise successful release gate from terminating.
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4179',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4179',
    browserName: 'chromium',
    // Local Windows runs use the installed Chrome. CI installs the exact
    // Playwright Chromium revision declared by the lockfile.
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    colorScheme: 'light',
    trace: 'retain-on-failure',
  },
});
