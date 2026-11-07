import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export async function expectNoWcagViolations(page: Page): Promise<void> {
  // An element that is still fading in measures below its resting contrast, so scan a settled page. A review's fade-out
  // and fade-in leave a moment with nothing running, so a violation counts once it is still there on a later scan.
  await expect(async () => {
    await page.waitForFunction(() =>
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.playState !== 'running' ||
            animation.effect?.getComputedTiming().endTime === Infinity,
        ),
    );
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations,
      results.violations
        .map(
          (violation) =>
            `${violation.id}: ${violation.help}\n${violation.nodes.map((node) => `  ${node.target.join(' ')}`).join('\n')}`,
        )
        .join('\n'),
    ).toEqual([]);
  }).toPass({ timeout: 10_000 });
}
