import { expect, test } from '@playwright/test';

import { expectNoWcagViolations } from './accessibility.js';
import { refused, standInService } from './stand-in-service.js';

test('a phone on the review page sees when the service stops, wherever it has scrolled', async ({
  page,
}) => {
  const service = await standInService(page);
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: /stand-in work item/i }).click();
  await expect(page.getByRole('button', { name: 'Review inbox' })).toBeVisible();

  const running = service.answer;
  service.answer = refused;
  await page.clock.fastForward(15_000);
  const stopped = page.getByRole('status').filter({ hasText: 'Local service unavailable' });
  await expect(stopped).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(stopped).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeDisabled();
  await expectNoWcagViolations(page);

  service.answer = running;
  await page.clock.fastForward(15_000);
  await expect(stopped).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeEnabled();
});

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
