import { expect, test, type Page } from '@playwright/test';

import type {
  BootstrapDto,
  CheckDto,
  EvidenceDto,
  ReadinessDto,
  RepositoryDto,
  WorkItemDto,
} from '../apps/web/src/api.js';

declare global {
  interface Window {
    layoutFrames: Array<{ ms: number; title: string; sideways: number; barOffset: number }>;
    layoutFramesDone: boolean;
  }
}

// UX-01: the review and the workspace explorer fit their boxes on phones, tablets and desktops. The review pane's width
// does not follow the window's: the navigation and the inbox take a share of the window that changes at each layout
// step, so the desktop widths below sit on both sides of each step. The workspace holds long values on purpose.

const stamp = '2026-11-01T00:00:00.000Z';

const repository = (id: string, branch: string, statusEntries: string[]): RepositoryDto => ({
  id,
  path: `D:/projects/a-rather-long-folder-name/${id}`,
  name: `${id}-with-a-long-name`,
  snapshot: {
    repositoryId: id,
    head: 'c0ffee1234567890c0ffee1234567890c0ffee12',
    branch,
    statusEntries,
    worktreeHash: 'b'.repeat(64),
    diffStats: {
      changedFiles: 14,
      additions: 1482,
      deletions: 367,
      binaryFiles: 0,
      untrackedFiles: 0,
    },
    fingerprint: `${id}-state`,
    contractVersion: 'default-v1',
    checkDefinitionVersion: 'stand-in',
    capturedAt: stamp,
  },
  updatedAt: stamp,
  removedAt: null,
  removedReason: null,
});

const workItem = (id: string, title: string, repositoryId: string): WorkItemDto => ({
  id,
  repositoryId,
  sourceType: 'manual',
  sourceRef: `manual:${id}`,
  title,
  claim: 'The task is complete, and every test that goes with it passes on a clean checkout.',
  sourceLabel: 'Example agent',
  updatedAt: stamp,
  snapshotFingerprint: `${repositoryId}-state`,
  humanVerdict: null,
  claimHash: 'stand-in',
  removedAt: null,
  removedReason: null,
});

const check = (id: string, repositoryId: string, label: string, kind: string): CheckDto => ({
  id,
  repositoryId,
  label,
  kind,
  executable: 'pnpm',
  args: ['exec', 'vitest', 'run', '--reporter=verbose', 'apps/server/src/a-long-test-file.test.ts'],
  versionArgs: ['--version'],
  scopePaths: [],
  cwdRelative: 'packages/some-package-with-a-long-name/tests/integration',
  timeoutMs: 60_000,
  maxOutputBytes: 1_000_000,
  resolvedExecutable:
    'C:/Users/somebody/AppData/Local/Programs/a-tool-with-a-long-name/bin/tool.exe',
  executableSha256: 'a'.repeat(64),
  definitionHash: 'stand-in',
  approvedAt: stamp,
  setupArgs: [],
  setupTimeoutMs: 60_000,
  retiredAt: null,
  retiredReason: null,
});

const evidence = (id: string, checkId: string, result: string): EvidenceDto => ({
  id,
  workItemId: 'first',
  checkId,
  kind: 'test',
  label: checkId,
  result,
  repositoryId: 'first-repository',
  snapshotFingerprint: 'first-repository-state',
  head: 'c0ffee1234567890c0ffee1234567890c0ffee12',
  contractVersion: 'default-v1',
  checkDefinitionVersion: 'stand-in',
  completedAt: stamp,
  durationMs: 12_345,
  toolVersion: '1.2.3',
  exitCode: result === 'passed' ? 0 : 1,
  invalidReason: null,
  isolation: 'clean-checkout',
  toolPath: 'C:/tools/tool.exe',
  toolSha256: 'd'.repeat(64),
  origin: 'local',
});

const readiness = (fields: Partial<ReadinessDto>): ReadinessDto => ({
  ready: false,
  repositoryIssue: null,
  bound: true,
  bindingFresh: true,
  degraded: false,
  checkCount: 0,
  passingCount: 0,
  evidenceIds: [],
  scopeDeclared: false,
  scopeDriftPaths: [],
  checks: [],
  ...fields,
});

const workspace: BootstrapDto = {
  mode: 'local',
  csrfToken: 'stand-in',
  sourceIssues: [],
  roots: [
    {
      id: 'root',
      path: 'D:/projects/a-rather-long-folder-name/with/several/levels/of/nesting/inside/it',
      label: 'Projects',
      createdAt: stamp,
      status: 'pending',
      missing: true,
      removedAt: null,
      removedReason: null,
    },
  ],
  repositories: [
    repository('first-repository', 'feature/a-branch-name-long-enough-to-be-cut-short', [
      ' M apps/server/src/packet.ts',
      ' M apps/server/src/workspace.ts',
    ]),
    repository('second-repository', 'main', []),
  ],
  receipts: [],
  workItems: [
    workItem('first', 'First work item', 'first-repository'),
    workItem('second', 'Second work item', 'second-repository'),
  ],
  removed: { roots: [], repositories: [], workItems: [] },
  contracts: [
    {
      id: 'default-v1',
      version: 'default-v1',
      title: 'Default acceptance contract',
      criteria: [
        { id: 'provenance', title: 'Source parses with preserved provenance', required: true },
        { id: 'scope', title: 'Changed files remain inside declared scope', required: false },
      ],
      createdAt: stamp,
    },
  ],
  checks: [
    check('unit', 'first-repository', 'Unit tests of the server, every one of them', 'test'),
    check('secrets', 'first-repository', 'Secret scan', 'security'),
    check('types', 'first-repository', 'Type check', 'static-analysis'),
    check('second-unit', 'second-repository', 'Unit tests', 'test'),
  ],
  evidence: [evidence('unit-run', 'unit', 'failed'), evidence('secrets-run', 'secrets', 'passed')],
  verdicts: [
    {
      id: 'verdict',
      workItemId: 'second',
      decision: 'accepted',
      note: 'Looks right.',
      decidedAt: stamp,
      snapshotFingerprint: 'an-earlier-state',
      overrideReason: null,
      sequence: 1,
      previousVerdictId: null,
      claimHash: null,
    },
  ],
  signingKey: { keyId: 'stand-in' },
  readiness: {
    first: readiness({
      checkCount: 3,
      passingCount: 1,
      evidenceIds: ['unit-run', 'secrets-run'],
      scopeDeclared: true,
      scopeDriftPaths: ['apps/server/src/packet.ts', 'apps/server/src/workspace.ts'],
      checks: [
        { checkId: 'unit', state: 'failed', evidenceId: 'unit-run' },
        { checkId: 'secrets', state: 'passed', evidenceId: 'secrets-run' },
        { checkId: 'types', state: 'missing', evidenceId: null },
      ],
    }),
    second: readiness({
      ready: true,
      checkCount: 1,
      passingCount: 1,
      checks: [{ checkId: 'second-unit', state: 'passed', evidenceId: null }],
    }),
  },
};

async function openWorkspace(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.route('**/api/v1/bootstrap', (route) => route.fulfill({ json: workspace }));
  await page.goto('/');
  await page.getByRole('button', { name: /First work item/u }).click();
  await expect(page.getByRole('heading', { name: 'First work item' })).toBeVisible();
}

/** What runs past the review's column, which ends where the review's padding begins, or past the window for the bar. */
function measureReview() {
  const pane = document.querySelector<HTMLElement>('.review-detail');
  const inner = document.querySelector<HTMLElement>('.detail-inner');
  const bar = document.querySelector<HTMLElement>('.decision-dock');
  const scroller = document.scrollingElement;
  if (!pane || !inner || !bar || !scroller) return 'no review on the page';
  // The window less a classic scrollbar, which `innerWidth` counts.
  const windowEdge = document.documentElement.clientWidth;
  const edge = Math.min(
    pane.getBoundingClientRect().left + pane.clientWidth,
    windowEdge,
    inner.getBoundingClientRect().right - parseFloat(getComputedStyle(inner).paddingRight),
  );
  const name = (node: Element) =>
    `${node.tagName.toLowerCase()}.${String(node.getAttribute('class') ?? '').replace(/ +/gu, '.')}`;
  const past = (nodes: Element[], limit: number) =>
    nodes
      .filter((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.right > limit + 0.5;
      })
      .map(name)
      .slice(0, 5);
  const inFlow = [...inner.querySelectorAll('*')].filter((node) => !bar.contains(node));
  return {
    paneSideways: pane.scrollWidth - pane.clientWidth,
    pageSideways: scroller.scrollWidth - scroller.clientWidth,
    pastColumn: past(inFlow, edge),
    barPastWindow: past([...bar.querySelectorAll('*')], windowEdge),
  };
}

const fits = { paneSideways: 0, pageSideways: 0, pastColumn: [], barPastWindow: [] };

/** Records, every frame, how far the pane or the page scrolls sideways and how far the decision bar is off its place. */
function recordFrames() {
  window.layoutFrames = [];
  window.layoutFramesDone = false;
  const start = performance.now();
  const frame = () => {
    const pane = document.querySelector<HTMLElement>('.review-detail');
    const bar = document.querySelector<HTMLElement>('.decision-dock');
    const scroller = document.scrollingElement;
    // While the inbox covers a phone's screen the review has no box, and between two reviews there is a frame with none.
    if (pane && bar && scroller && bar.getBoundingClientRect().height > 0) {
      window.layoutFrames.push({
        ms: performance.now() - start,
        title: pane.querySelector('h2')?.textContent ?? '',
        sideways: Math.max(
          pane.scrollWidth - pane.clientWidth,
          scroller.scrollWidth - scroller.clientWidth,
        ),
        barOffset: Math.round(Math.abs(window.innerHeight - bar.getBoundingClientRect().bottom)),
      });
    }
    if (!window.layoutFramesDone && performance.now() - start < 30_000)
      requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const settled = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(() => {
        const inner = document.querySelector('.detail-inner');
        return inner ? getComputedStyle(inner).opacity : 'none';
      }),
    )
    .toBe('1');

for (const width of [360, 768, 1024, 1100, 1240, 1280, 1366, 1440, 1450, 1536, 1920]) {
  test(`the review fits its pane at ${width} px, at rest and while it changes`, async ({
    page,
  }) => {
    await openWorkspace(page, width, 800);
    await settled(page);
    expect(await page.evaluate(measureReview)).toEqual(fits);

    // A change of work item animates the review; nothing may leave its place meanwhile, the decision bar included.
    await page.evaluate(recordFrames);
    if (width <= 860) await page.getByRole('button', { name: 'Review inbox' }).click();
    await page.getByRole('button', { name: /Second work item/u }).click();
    await expect(page.getByRole('heading', { name: 'Second work item' })).toBeVisible();
    // The recording spans the change: it starts on the first review and runs until the second has been on screen for
    // longer than its 220 ms fade.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const shown = window.layoutFrames.filter((frame) => frame.title === 'Second work item');
          return (shown.at(-1)?.ms ?? 0) - (shown[0]?.ms ?? 0);
        }),
      )
      .toBeGreaterThan(400);
    const frames = await page.evaluate(() => {
      window.layoutFramesDone = true;
      return window.layoutFrames;
    });
    expect(frames[0]?.title).toBe('First work item');
    expect({
      widest: Math.max(...frames.map((frame) => frame.sideways)),
      barMoved: Math.max(...frames.map((frame) => frame.barOffset)),
    }).toEqual({ widest: 0, barMoved: 0 });
    expect(await page.evaluate(measureReview)).toEqual(fits);
  });
}

/** Opens the workspace explorer and visits each of its tabs: each is drawn where it can be clicked, and none scrolls. */
async function everyExplorerTab(page: Page) {
  await page.getByRole('button', { name: 'View contract' }).click();
  const dialog = page.getByRole('dialog', { name: 'Inspect local review policy' });
  await expect(dialog).toBeVisible();

  const names = (await dialog.getByRole('tab').allTextContents()).map((text) => text.trim());
  expect(names).toEqual(
    expect.arrayContaining(['Roots', 'Repositories', 'Checks', 'Contracts', 'Exports', 'Removed']),
  );
  for (const name of names) {
    const tab = dialog.getByRole('tab', { name, exact: true });
    // A click scrolls its target into view first, so whether the tab shows where it is drawn is read before.
    expect(
      await tab.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const bar = node.parentElement?.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          insideBar: Boolean(bar && box.left >= bar.left - 0.5 && box.right <= bar.right + 0.5),
          insideWindow: box.left >= 0 && box.right <= document.documentElement.clientWidth,
          onTop: Boolean(top && node.contains(top)),
        };
      }),
      name,
    ).toEqual({ insideBar: true, insideWindow: true, onTop: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(
      await page.evaluate(() => {
        const box = document.querySelector('.explorer-dialog');
        const panel = document.querySelector('.explorer-panel');
        const scroller = document.scrollingElement;
        if (!box || !panel || !scroller) return 'no explorer on the page';
        return {
          dialogSideways: box.scrollWidth - box.clientWidth,
          panelSideways: panel.scrollWidth - panel.clientWidth,
          pageSideways: scroller.scrollWidth - scroller.clientWidth,
        };
      }),
      name,
    ).toEqual({ dialogSideways: 0, panelSideways: 0, pageSideways: 0 });
  }
}

for (const width of [320, 360, 768]) {
  test(`the workspace explorer fits ${width} px, every tab reachable where it is drawn`, async ({
    page,
  }) => {
    await openWorkspace(page, width, 740);
    await everyExplorerTab(page);
  });
}

// A page whose service stops answering keeps its last data under a banner above the shell, and the review, its decision
// bar and the explorer say how old that data is in longer lines. The first refresh after the service stops shows it.
async function stopService(page: Page) {
  await page.route('**/api/v1/bootstrap', (route) => route.abort('connectionrefused'));
  await page.clock.fastForward(15_000);
  await expect(
    page.getByRole('status').filter({ hasText: 'Local service unavailable' }),
  ).toBeVisible();
}

/** How far the banner scrolls sideways, and what of it ends past the window less a classic scrollbar. */
function measureBanner() {
  const banner = document.querySelector<HTMLElement>('.service-banner');
  if (!banner) return 'no banner on the page';
  const windowEdge = document.documentElement.clientWidth;
  return {
    bannerSideways: banner.scrollWidth - banner.clientWidth,
    bannerPastWindow: [banner, ...banner.querySelectorAll('*')]
      .filter((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.right > windowEdge + 0.5;
      })
      .map((node) => node.tagName.toLowerCase()),
  };
}

for (const width of [360, 768, 1024, 1100, 1240, 1450, 1920]) {
  test(`the review and the banner fit ${width} px while the service is not answering`, async ({
    page,
  }) => {
    await page.clock.install();
    await openWorkspace(page, width, 800);
    await settled(page);
    await stopService(page);
    await expect(page.getByText('Decisions wait for the local service')).toBeVisible();
    expect(await page.evaluate(measureReview)).toEqual(fits);
    expect(await page.evaluate(measureBanner)).toEqual({ bannerSideways: 0, bannerPastWindow: [] });
  });
}

for (const width of [320, 360]) {
  test(`the workspace explorer fits ${width} px while the service is not answering`, async ({
    page,
  }) => {
    await page.clock.install();
    await openWorkspace(page, width, 740);
    await stopService(page);
    await everyExplorerTab(page);
    await expect(page.getByText('Changes wait until the service answers.')).toBeVisible();
  });
}
