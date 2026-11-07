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

test('the contract fits a phone screen with no service behind the page', async ({ page }) => {
  await page.route('**/api/v1/bootstrap', (route) => route.abort('connectionrefused'));
  await page.goto('/');
  await page.getByRole('button', { name: /harden workspace export bundles/i }).click();

  await page.getByRole('button', { name: 'View contract' }).click();
  const dialog = page.getByRole('dialog', { name: 'Acceptance contract' });
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByText('Every approved check has fresh passing evidence')).toBeVisible();
  await expectNoWcagViolations(page);
  await dialog.getByRole('button', { name: 'Close contract' }).click();
  await expect(dialog).toHaveCount(0);
});
