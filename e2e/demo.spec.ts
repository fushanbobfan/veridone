import { expect, test } from '@playwright/test';

import { expectNoWcagViolations } from './accessibility.js';

test('a page waiting for its first answer stays on the loading screen', async ({ page }) => {
  await page.route('**/api/v1/bootstrap', () => undefined);
  await page.goto('/');

  const loading = page.getByText('Refreshing repository fingerprints and local evidence');
  await expect(loading).toBeVisible();
  await page.waitForTimeout(500);
  await expect(loading).toBeVisible();
  await expect(page.getByText(/synthetic demo/iu)).toHaveCount(0);
});

test('hosted demo remains honest, navigable, and accessible', async ({ page }) => {
  await page.route('**/api/v1/bootstrap', (route) => route.abort('connectionrefused'));
  await page.goto('/');

  await expect(page.getByText(/synthetic demo/i).first()).toBeVisible();
  await expect(page.getByText('Updated now')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Review inbox' })).toBeVisible();
  await page.getByRole('button', { name: /import harness run receipts/i }).click();
  await expect(page.getByRole('heading', { name: 'Import harness run receipts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept work' })).toBeEnabled();
  await expectNoWcagViolations(page);
});
