import { expect, test } from '@playwright/test';

import { expectNoWcagViolations } from './accessibility.js';

test('hosted demo remains honest, navigable, and accessible', async ({ page }) => {
  await page.route('**/api/v1/bootstrap', (route) => route.abort('connectionrefused'));
  await page.goto('/');

  await expect(page.getByText(/synthetic demo/i).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review inbox' })).toBeVisible();
  await page.getByRole('button', { name: /import harness run receipts/i }).click();
  await expect(page.getByRole('heading', { name: 'Import harness run receipts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept work' })).toBeEnabled();
  await expectNoWcagViolations(page);
});
