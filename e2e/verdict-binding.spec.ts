import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { expectNoWcagViolations } from './accessibility.js';

const execFileAsync = promisify(execFile);
const fixtureRoot = path.resolve('output/e2e-verdict-fixture');

interface Bootstrap {
  csrfToken: string;
  repositories: Array<{ id: string; name: string }>;
  workItems: Array<{ id: string; title: string }>;
  verdicts: Array<{
    workItemId: string;
    decision: string;
    note: string;
    overrideReason: string | null;
  }>;
}

async function createRepository(name: string): Promise<string> {
  const repository = path.join(fixtureRoot, name);
  await mkdir(repository, { recursive: true });
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
  await execFileAsync('git', ['config', 'user.email', 'e2e@veridone.local'], { cwd: repository });
  await execFileAsync('git', ['config', 'user.name', 'VeriDone E2E'], { cwd: repository });
  await writeFile(path.join(repository, 'README.md'), `# ${name}\n`);
  await execFileAsync('git', ['add', 'README.md'], { cwd: repository });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repository });
  return repository;
}

async function writeReceipt(runId: string, title: string, completedAt: string): Promise<string> {
  const receiptPath = path.join(fixtureRoot, `${runId}.json`);
  await writeFile(
    receiptPath,
    JSON.stringify({
      schema_version: 1,
      run_id: runId,
      source: 'codex',
      title,
      claim: `${title} is complete.`,
      status: 'complete',
      started_at: '2026-07-21T10:00:00.000Z',
      completed_at: completedAt,
    }),
  );
  return receiptPath;
}

async function readBootstrap(api: APIRequestContext): Promise<Bootstrap> {
  return (await (await api.get('/api/v1/bootstrap')).json()) as Bootstrap;
}

let csrfToken: string | undefined;

async function post(api: APIRequestContext, url: string, data: unknown): Promise<unknown> {
  csrfToken ??= (await readBootstrap(api)).csrfToken;
  const response = await api.post(url, { data, headers: { 'X-VeriDone-CSRF': csrfToken } });
  expect(response.status(), `${url}: ${await response.text()}`).toBeLessThan(300);
  return response.json();
}

/** Connects each repository and receipt and links them in order, so the last item is the newest. */
async function seedLinkedItems(
  api: APIRequestContext,
  items: Array<{ repository: string; runId: string; title: string }>,
): Promise<Record<string, string>> {
  await post(api, '/api/v1/roots', { path: fixtureRoot, label: 'Verdict fixtures' });
  for (const [index, item] of items.entries()) {
    const repositoryPath = await createRepository(item.repository);
    await post(api, '/api/v1/repositories', { path: repositoryPath });
    const receiptPath = await writeReceipt(
      item.runId,
      item.title,
      `2026-07-21T1${index}:00:00.000Z`,
    );
    await post(api, '/api/v1/receipts/import', { path: receiptPath });
  }
  const seeded = await readBootstrap(api);
  const ids: Record<string, string> = {};
  for (const item of items) {
    const repositoryId = seeded.repositories.find((entry) => entry.name === item.repository)?.id;
    const workItemId = seeded.workItems.find((entry) => entry.title === item.title)?.id;
    if (!repositoryId || !workItemId) throw new Error(`Fixture ${item.title} was not imported.`);
    await post(api, `/api/v1/work-items/${workItemId}/link`, { repositoryId });
    ids[item.title] = workItemId;
  }
  return ids;
}

function nextBootstrap(page: Page) {
  return page.waitForResponse((response) => response.url().endsWith('/api/v1/bootstrap'), {
    timeout: 25_000,
  });
}

test.beforeAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });
});

test('a verdict stays on the work item the reviewer opened, across background refreshes', async ({
  page,
}) => {
  const ids = await seedLinkedItems(page.request, [
    { repository: 'binding-b', runId: 'binding-b', title: 'Binding item B' },
    { repository: 'binding-a', runId: 'binding-a', title: 'Binding item A' },
  ]);
  const itemB = ids['Binding item B'];
  const detailHeading = page.locator('#review-detail h2').first();

  // REV-02: a deep link survives the first local refresh.
  const firstLoad = nextBootstrap(page);
  await page.goto(`/?review=${itemB}`);
  await firstLoad;
  await expect(detailHeading).toHaveText('Binding item B');

  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Verdict subject')).toContainText('Binding item B');
  await dialog.getByLabel('Decision note').fill('Rejecting item B after review.');

  // Writing a note takes longer than one refresh interval.
  await nextBootstrap(page);
  await expect(detailHeading).toHaveText('Binding item B');
  await expect(dialog.getByLabel('Verdict subject')).toContainText('Binding item B');
  await dialog.getByRole('button', { name: 'Record rejection' }).click();
  await expect(dialog).toBeHidden();

  const after = await readBootstrap(page.request);
  const titleOf = (id: string) => after.workItems.find((item) => item.id === id)?.title;
  expect(
    after.verdicts
      .filter((verdict) => verdict.note === 'Rejecting item B after review.')
      .map((verdict) => ({ title: titleOf(verdict.workItemId), decision: verdict.decision })),
  ).toEqual([{ title: 'Binding item B', decision: 'rejected' }]);
});

test('a reviewer can accept normally after requesting changes on an earlier state', async ({
  page,
}) => {
  const ids = await seedLinkedItems(page.request, [
    { repository: 'revision-c', runId: 'revision-c', title: 'Revision item C' },
  ]);
  const itemC = ids['Revision item C'];
  const repositoryPath = path.join(fixtureRoot, 'revision-c');
  const bootstrap = await readBootstrap(page.request);
  const repositoryId = bootstrap.repositories.find((entry) => entry.name === 'revision-c')?.id;
  await post(page.request, '/api/v1/checks', {
    repositoryId,
    label: 'Deterministic revision check',
    kind: 'test',
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("verified")'],
    cwdRelative: '.',
    timeoutMs: 10_000,
    maxOutputBytes: 10_000,
  });

  await page.goto(`/?review=${itemC}`);
  await expect(page.locator('#review-detail h2').first()).toHaveText('Revision item C');
  await page.getByRole('button', { name: 'Request changes' }).click();
  await page.getByLabel('Decision note').fill('Add the missing regression test.');
  await page.getByRole('button', { name: 'Record request' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  // The agent revises the work; the earlier verdict now describes an older state.
  await writeFile(path.join(repositoryPath, 'regression.test.txt'), 'added after review\n');
  await page.goto(`/?review=${itemC}`);
  await expect(page.getByText(/superseded/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Rebind to current state' }).click();
  await page.getByRole('button', { name: 'Run approved checks' }).click();
  await expect(page.getByText('All required evidence is current')).toBeVisible();

  const accept = page.getByRole('button', { name: 'Accept work' });
  await expect(accept).toBeEnabled();
  await accept.click();
  await page.getByLabel('Decision note').fill('Regression test added and the check passes.');
  await page.getByRole('button', { name: 'Record acceptance' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expectNoWcagViolations(page);

  const after = await readBootstrap(page.request);
  expect(
    after.verdicts
      .filter((verdict) => verdict.workItemId === itemC)
      .map(({ decision, overrideReason }) => ({ decision, overrideReason })),
  ).toEqual([
    { decision: 'accepted', overrideReason: null },
    { decision: 'changes-requested', overrideReason: null },
  ]);
});
