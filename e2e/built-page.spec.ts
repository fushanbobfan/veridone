import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    cspReports: string[];
  }
}

// The content security policy forbids eval, and a browser reports a blocked eval even when the code catches the error.
// zod probes for eval when it builds its first object schema, so the web app keeps zod out of the page by importing
// `@veridone/core/scope`, which leaves out the schemas of the package's main entry. A page that does need zod has to
// call `z.config({ jitless: true })` before it builds an object schema.
test('the built page loads without a content security policy report', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    // Chromium logs the refused bootstrap request below as an error.
    if (message.type() === 'error' && !message.location().url.endsWith('/api/v1/bootstrap')) {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.addInitScript(() => {
    window.cspReports = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.cspReports.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  await page.route('**/api/v1/bootstrap', (route) => route.abort('connectionrefused'));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Review inbox' })).toBeVisible();

  const reports = () => page.evaluate(() => window.cspReports);
  expect({ reports: await reports(), consoleErrors }).toEqual({ reports: [], consoleErrors: [] });

  // A blocked eval here has to reach the list, or the empty list above says nothing about this browser. It runs on a
  // timer because browsers exempt Playwright's own call from the policy.
  await page.evaluate(() => {
    window.setTimeout(() => {
      try {
        new Function('');
      } catch {
        // The policy blocks it.
      }
    });
  });
  await expect.poll(reports).toEqual(['script-src eval']);
});

test('a local build without its service says so and keeps asking', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/v1/bootstrap', (route) => {
    requests += 1;
    return route.abort('connectionrefused');
  });

  await page.clock.install();
  await page.goto('/');
  await expect(page.getByText('Local service unavailable · synthetic demo')).toBeVisible();

  const requestsAtLoad = requests;
  await page.clock.fastForward(15_000);
  await expect.poll(() => requests).toBeGreaterThan(requestsAtLoad);
});
