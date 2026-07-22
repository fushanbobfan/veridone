import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const repositoryRoot = import.meta.dirname;

export default defineConfig({
  testDir: './e2e',
  outputDir: './output/playwright-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  ...(process.env.CI ? { workers: 1 } : {}),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'output/playwright-report' }]]
    : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4417',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node scripts/prepare-e2e.mjs && pnpm --filter @veridone/server dev',
      url: 'http://127.0.0.1:4418/api/v1/health',
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        VERIDONE_PORT: '4418',
        VERIDONE_DATA_DIR: path.join(repositoryRoot, 'output', 'e2e-runtime'),
        VERIDONE_ALLOWED_ORIGINS: 'http://127.0.0.1:4417',
      },
    },
    {
      command: 'pnpm --filter @veridone/web dev',
      url: 'http://127.0.0.1:4417',
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        VERIDONE_WEB_PORT: '4417',
        VERIDONE_API_PORT: '4418',
        VERIDONE_STRICT_PORT: '1',
      },
    },
  ],
  projects: [
    {
      name: 'chromium-local',
      testMatch: /local-flow\.spec\.ts/u,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-demo',
      testMatch: /demo\.spec\.ts/u,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      testMatch: /mobile\.spec\.ts/u,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'firefox-demo',
      testMatch: /demo\.spec\.ts/u,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit-demo',
      testMatch: /demo\.spec\.ts/u,
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
