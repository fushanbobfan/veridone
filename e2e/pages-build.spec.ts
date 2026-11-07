import { expect, test } from '@playwright/test';

// The public demo is a static site with no service behind it, so an open page has nothing to ask for and nothing to log.
test('the public demo makes no data request and logs no console error', async ({ page }) => {
  const dataRequests: string[] = [];
  const consoleErrors: string[] = [];
  page.on('request', (request) => {
    if (['fetch', 'xhr'].includes(request.resourceType())) {
      const { pathname, search } = new URL(request.url());
      dataRequests.push(pathname + search);
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.clock.install();
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Review inbox' })).toBeVisible();
  await expect(page.getByText('Synthetic demo data')).toBeVisible();
  // A file that fails to load logs its error when the answer comes, so the load has to settle before the read below.
  await page.waitForLoadState('networkidle');
  // A build with a service asks it again every 15 seconds.
  await page.clock.fastForward(20_000);

  // A request and an error from a page timer have to reach the lists, or empty lists say nothing about this browser and
  // this clock. They come last, so what the page did above has reached the lists by then, and the query keeps this
  // request apart from any the page made itself.
  await page.evaluate(() => {
    window.setTimeout(() => {
      console.error('control');
      void fetch('favicon.svg?control');
    }, 15_000);
  });
  await page.clock.fastForward(20_000);
  await expect
    .poll(() => ({ dataRequests, consoleErrors }))
    .toEqual({ dataRequests: ['/veridone/favicon.svg?control'], consoleErrors: ['control'] });
});
