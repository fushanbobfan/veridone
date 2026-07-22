import { expect, test } from '@playwright/test';

import { expectNoWcagViolations } from './accessibility.js';

test('mobile review keeps every required action reachable', async ({ page }) => {
  await page.route('**/api/v1/bootstrap', (route) => route.abort('connectionrefused'));
  await page.goto('/');
  await page.getByRole('button', { name: /harden workspace export bundles/i }).click();

  await expect(page.getByRole('button', { name: 'Review inbox' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request changes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept work' })).toBeDisabled();
  await expectNoWcagViolations(page);
});
