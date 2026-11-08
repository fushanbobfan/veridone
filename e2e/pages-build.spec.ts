import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectNoWcagViolations } from './accessibility.js';

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

test('the contract opens on the public demo and closes back to its button', async ({ page }) => {
  await page.goto('./');
  const trigger = page.getByRole('button', { name: 'View contract' });

  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Acceptance contract' });
  await expect(dialog.getByText('Every approved check has fresh passing evidence')).toBeVisible();
  await expectNoWcagViolations(page);
  await dialog.getByRole('button', { name: 'Close contract' }).click();
  await expect(dialog).toHaveCount(0);

  // WebKit gives a clicked button no focus, so the way back to the button is tested from the keyboard.
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Close contract' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

/** In the viewport, with nothing such as the decision bar drawn over its middle. */
async function expectSeen(locator: Locator) {
  await expect(locator).toBeInViewport({ ratio: 1 });
  const onTop = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit !== null && (hit === element || element.contains(hit));
  });
  expect(onTop).toBe(true);
}

async function openReview(page: Page, review: string, title: string) {
  await page.goto(`./?review=${review}`);
  // Below 1002 px the inbox comes first, and a review opens from its row.
  await page.getByRole('button', { name: new RegExp(title, 'iu') }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

// A decision on the demo opens no dialog. The end of the evidence rail, which also shows it, is off screen or under the
// decision bar at these sizes.
for (const size of [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1100x800', width: 1100, height: 800 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: 'Pixel 7', width: 412, height: 839 },
  { name: '360x640', width: 360, height: 640 },
]) {
  test(`the decision bar says the decision at ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const result = (text: string) => page.getByRole('status').filter({ hasText: text });

    await openReview(page, 'export-hardening', 'Harden workspace export bundles');
    await page.getByRole('button', { name: 'Reject' }).click();
    await expectSeen(result('Rejected by you'));
    await page.getByRole('button', { name: 'Request changes' }).click();
    await expectSeen(result('Changes requested by you'));

    await openReview(page, 'receipt-import', 'Import harness run receipts');
    await expect(result('Evidence is current')).toBeVisible();
    await page.getByRole('button', { name: 'Accept work' }).click();
    await expectSeen(result('Accepted by you'));
  });
}

test('"Show all reviews" clears the search as well as the filter', async ({ page }) => {
  await page.goto('./');
  const search = page.getByRole('searchbox', { name: 'Search reviews' });
  const rows = page.locator('.review-row');
  await expect(rows.first()).toBeVisible();
  const total = await rows.count();

  await search.fill('zzzz');
  await expect(rows).toHaveCount(0);
  await page.getByRole('button', { name: 'Show all reviews' }).click();
  await expect(search).toHaveValue('');
  await expect(rows).toHaveCount(total);

  // A search that matches, with a filter that hides the match.
  await search.fill('receipt');
  await page.getByRole('button', { name: /^Stale/u }).click();
  await expect(rows).toHaveCount(0);
  await page.getByRole('button', { name: 'Show all reviews' }).click();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('button', { name: /^All/u })).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(total);
  await expect(page).not.toHaveURL(/[?&](q|filter)=/u);
});

test('the backup button looks as unavailable as it is', async ({ page }) => {
  await page.goto('./');
  const backup = page.getByRole('button', { name: /^Workspace backup/u });
  const theme = page.getByRole('button', { name: /^Switch to (light|dark) theme$/u });
  const look = (button: Locator) =>
    button.evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.color} on ${style.backgroundColor}`;
    });

  await expect(backup).toBeDisabled();
  await expect(backup).toHaveAttribute('title', 'Workspace backup needs the local service');
  await expect(backup).toHaveCSS('cursor', 'not-allowed');
  await expect
    .poll(() => backup.evaluate((element) => Number(getComputedStyle(element).opacity)))
    .toBeLessThan(1);
  const backupAtRest = await look(backup);
  await backup.hover({ force: true });
  expect(await look(backup)).toBe(backupAtRest);

  // The working button beside it does light up, so this browser applies the hover style.
  const themeAtRest = await look(theme);
  await theme.hover();
  await expect.poll(() => look(theme)).not.toBe(themeAtRest);
});

for (const [device, other] of [
  ['dark', 'light'],
  ['light', 'dark'],
] as const) {
  test.describe(`on a device set to ${device}`, () => {
    test.use({ colorScheme: device });

    test('every press of the theme button changes the theme', async ({ page }) => {
      await page.goto('./');
      const root = page.locator('html');
      const toggle = page.getByRole('button', { name: /^Switch to (light|dark) theme$/u });
      await expect(root).toHaveAttribute('data-theme', device);

      for (const theme of [other, device, other, device]) {
        await toggle.click();
        await expect(root).toHaveAttribute('data-theme', theme);
      }
      // Back on the device's theme, the page follows the device again.
      await page.emulateMedia({ colorScheme: other });
      await expect(root).toHaveAttribute('data-theme', other);
    });
  });
}
