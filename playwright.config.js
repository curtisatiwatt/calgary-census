import { defineConfig, devices } from '@playwright/test';

// End-to-end smoke tests against the production build (vite preview).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173/',
    locale: 'en-CA',
    trace: 'retain-on-failure',
  },
  webServer: {
    // CI builds once in its own step and tests exactly the files it then publishes;
    // locally the tests build first so they never run against a stale dist/.
    command: `${process.env.CI ? '' : 'npm run build && '}npx vite preview --host 127.0.0.1 --port 4173 --strictPort`,
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
