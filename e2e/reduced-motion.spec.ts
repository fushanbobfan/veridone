import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    motionRecord: {
      lastFrame: number;
      caught: { element: string; state: string }[];
      unsettled: { element: string; state: string }[];
    };
  }
}

// Runs before the page's own scripts and looks at every frame the page draws. An element is caught when it can be seen
// between two resting states: a review pane, a criterion row or an inbox row part-faded or off its place, or a
// readiness bar whose width changes after it first shows. Each frame also lists the elements away from their final
// look, seen or not, so a test can tell an element that appears in place from one that never appears.
function recordMotion() {
  const record: Window['motionRecord'] = { lastFrame: 0, caught: [], unsettled: [] };
  window.motionRecord = record;
  const watched = {
    '.detail-inner': 'review pane',
    '.criterion-row': 'criterion row',
    '.review-row': 'inbox row',
  };
  const barWidths = new Map<Element, number>();
  const look = (time: number) => {
    record.lastFrame = time;
    const unsettled: Window['motionRecord']['unsettled'] = [];
    for (const [selector, element] of Object.entries(watched)) {
      for (const node of document.querySelectorAll(selector)) {
        const { opacity, transform } = getComputedStyle(node);
        const atRest =
          Number(opacity) > 0.999 &&
          (transform === 'none' || new DOMMatrixReadOnly(transform).isIdentity);
        if (atRest) continue;
        const state = `opacity ${opacity}, ${transform}`;
        unsettled.push({ element, state });
        if (Number(opacity) > 0.001) record.caught.push({ element, state });
      }
    }
    for (const bar of document.querySelectorAll('.progress-track > span')) {
      const width = bar.getBoundingClientRect().width;
      // At rest a bar fills the share of gates its progress bar reports, which the pane rounds to a whole percent.
      const track = bar.parentElement as HTMLElement;
      const share =
        Number(track.getAttribute('aria-valuenow')) / Number(track.getAttribute('aria-valuemax'));
      const trackWidth = track.getBoundingClientRect().width;
      if (Math.abs(width - trackWidth * share) > trackWidth / 200 + 0.5) {
        unsettled.push({ element: 'readiness bar', state: `${width} px of ${trackWidth} px` });
      }
      const before = barWidths.get(bar);
      if (before !== undefined && before > 0.5 && Math.abs(width - before) > 0.5) {
        record.caught.push({ element: 'readiness bar', state: `${before} px to ${width} px` });
      }
      barWidths.set(bar, width);
    }
    record.unsettled = unsettled;
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

/** Waits for a frame drawn `ms` after now. A page reports a media change and moves its animations on as it draws. */
async function waitForFrameAfter(page: Page, ms: number) {
  const now = await page.evaluate(() => performance.now());
  await expect
    .poll(() => page.evaluate(() => window.motionRecord.lastFrame))
    .toBeGreaterThan(now + ms);
}

/**
 * Opens each demo review in turn, then shows only ready reviews and all of them again, so two inbox rows enter once more
 * on a page that has finished loading: on Linux WebKit the recorder once saw no frame of the entrance at load. Then
 * watches for a second, longer than any animation in the app, and checks that everything ended at its final look.
 */
async function useTheInbox(page: Page) {
  for (const title of [
    'Import harness run receipts',
    'Restore keyboard-only review flow',
    'Harden workspace export bundles',
  ]) {
    await page.getByRole('button', { name: new RegExp(title, 'iu') }).click();
    await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
  }
  const filters = page.locator('.filter-strip');
  await filters.getByRole('button', { name: /^Ready/u }).click();
  await expect(page.locator('.review-row')).toHaveCount(1);
  await filters.getByRole('button', { name: /^All/u }).click();
  await expect(page.locator('.review-row')).toHaveCount(3);
  await waitForFrameAfter(page, 1_000);
  // The caught frames leave out what cannot be seen, so an element left transparent would pass them.
  expect(await page.evaluate(() => window.motionRecord.unsettled)).toEqual([]);
}

/** How many frames caught each kind of element. */
async function caught(page: Page) {
  const frames = await page.evaluate(() => window.motionRecord.caught);
  const counts: Record<string, number> = {};
  for (const { element } of frames) counts[element] = (counts[element] ?? 0) + 1;
  return counts;
}

// Each animated element has to be caught here, or the empty records below say nothing about this browser.
test('with motion allowed, the inbox and each review fade and move in', async ({ page }) => {
  await page.addInitScript(recordMotion);
  await page.goto('./');
  await useTheInbox(page);
  expect(Object.keys(await caught(page)).sort()).toEqual([
    'criterion row',
    'inbox row',
    'readiness bar',
    'review pane',
  ]);
});

test.describe('on a device that asks for reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the inbox and each review appear in place', async ({ page }) => {
    await page.addInitScript(recordMotion);
    await page.goto('./');
    await useTheInbox(page);
    expect(await caught(page)).toEqual({});
  });
});

test('reduced motion turned on in an open page stops later changes moving', async ({ page }) => {
  await page.addInitScript(recordMotion);
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Review inbox' })).toBeVisible();
  // The inbox rows' entrance ends first, so the record below starts from a page at rest.
  await waitForFrameAfter(page, 1_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await waitForFrameAfter(page, 0);
  await page.evaluate(() => {
    window.motionRecord.caught = [];
  });

  await useTheInbox(page);
  expect(await caught(page)).toEqual({});
});
