import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const repositoryRoot = import.meta.dirname;
const builtPageUrl = 'http://127.0.0.1:4419';
const pagesBuildUrl = 'http://127.0.0.1:4420/veridone/';

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
    {
      // The production bundle, which `pnpm start` and the public demo serve and the development server does not.
      command: 'pnpm --filter @veridone/web build && pnpm --filter @veridone/web preview',
      url: builtPageUrl,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        VERIDONE_WEB_PORT: '4419',
        VERIDONE_STRICT_PORT: '1',
      },
    },
    {
      // The public demo as `.github/workflows/pages.yml` builds it, in a folder apart from the bundle above.
      command:
        'pnpm --filter @veridone/web build --outDir ../../output/pages-build --emptyOutDir && pnpm --filter @veridone/web preview --outDir ../../output/pages-build',
      url: pagesBuildUrl,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        VITE_BASE_PATH: '/veridone/',
        VITE_PUBLIC_DEMO: '1',
        VERIDONE_WEB_PORT: '4420',
        VERIDONE_STRICT_PORT: '1',
      },
    },
  ],
  projects: [
    {
      // The local projects write to one service's workspace, which a retry inherits, so a retry cannot pass.
      name: 'chromium-local',
      testMatch: /local-flow\.spec\.ts/u,
      retries: 0,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Shares the local service with chromium-local, so it starts after that empty-workspace flow.
      name: 'chromium-verdicts',
      testMatch: /verdict-binding\.spec\.ts/u,
      dependencies: ['chromium-local'],
      retries: 0,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Shares the local service too, and ends by clearing its inbox, so it runs last of the three.
      name: 'chromium-removal',
      testMatch: /removal\.spec\.ts/u,
      dependencies: ['chromium-verdicts'],
      retries: 0,
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
    {
      name: 'chromium-built',
      testMatch: /(built-page|layout)\.spec\.ts/u,
      use: { ...devices['Desktop Chrome'], baseURL: builtPageUrl },
    },
    {
      name: 'firefox-built',
      testMatch: /(built-page|layout)\.spec\.ts/u,
      use: { ...devices['Desktop Firefox'], baseURL: builtPageUrl },
    },
    {
      name: 'webkit-built',
      testMatch: /(built-page|layout)\.spec\.ts/u,
      use: { ...devices['Desktop Safari'], baseURL: builtPageUrl },
    },
    {
      name: 'chromium-pages',
      testMatch: /pages-build\.spec\.ts/u,
      use: { ...devices['Desktop Chrome'], baseURL: pagesBuildUrl },
    },
    {
      name: 'firefox-pages',
      testMatch: /pages-build\.spec\.ts/u,
      use: { ...devices['Desktop Firefox'], baseURL: pagesBuildUrl },
    },
    {
      name: 'webkit-pages',
      testMatch: /pages-build\.spec\.ts/u,
      use: { ...devices['Desktop Safari'], baseURL: pagesBuildUrl },
    },
  ],
});
