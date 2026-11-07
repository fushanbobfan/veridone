import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect as baseExpect, test, type APIRequestContext, type Page } from '@playwright/test';

import { expectNoWcagViolations } from './accessibility.js';

// What these steps wait for comes with a bootstrap, and on a busy machine one has taken more than the default 10 s.
const expect = baseExpect.configure({ timeout: 25_000 });
const execFileAsync = promisify(execFile);
const fixtureRoot = path.resolve('output/e2e-removal-fixture');
// A root of its own, so that nothing else approved covers what sits under it.
const driveRoot = path.resolve('output/e2e-removal-drive');

interface Bootstrap {
  csrfToken: string;
  roots: Array<{ id: string; path: string }>;
  repositories: Array<{ id: string; name: string }>;
  workItems: Array<{ id: string; title: string; claimHash: string }>;
  removed: { workItems: Array<{ id: string; title: string }> };
}

async function createRepository(parent: string, name: string): Promise<string> {
  const repository = path.join(parent, name);
  await mkdir(repository, { recursive: true });
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
  await execFileAsync('git', ['config', 'user.email', 'e2e@veridone.local'], { cwd: repository });
  await execFileAsync('git', ['config', 'user.name', 'VeriDone E2E'], { cwd: repository });
  await writeFile(path.join(repository, 'README.md'), `# ${name}\n`);
  await execFileAsync('git', ['add', 'README.md'], { cwd: repository });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repository });
  return repository;
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

/** Connects a root, a repository and a receipt, and binds the receipt's work item to the repository. */
async function seedItem(
  api: APIRequestContext,
  options: { parent: string; rootLabel: string; repository: string; title: string },
): Promise<{ workItemId: string; repositoryId: string; repositoryPath: string }> {
  await mkdir(options.parent, { recursive: true });
  await post(api, '/api/v1/roots', { path: options.parent, label: options.rootLabel });
  const repositoryPath = await createRepository(options.parent, options.repository);
  await post(api, '/api/v1/repositories', { path: repositoryPath });
  const receipt = path.join(options.parent, `${options.repository}.json`);
  await writeFile(
    receipt,
    JSON.stringify({
      schema_version: 1,
      run_id: `removal-${options.repository}`,
      source: 'codex',
      title: options.title,
      claim: `${options.title} is complete.`,
      status: 'complete',
      started_at: '2026-11-06T10:00:00.000Z',
    }),
  );
  await post(api, '/api/v1/receipts/import', { path: receipt });
  const seeded = await readBootstrap(api);
  const repositoryId = seeded.repositories.find((entry) => entry.name === options.repository)?.id;
  const workItemId = seeded.workItems.find((entry) => entry.title === options.title)?.id;
  if (!repositoryId || !workItemId) throw new Error(`Fixture ${options.title} was not imported.`);
  await post(api, `/api/v1/work-items/${workItemId}/link`, { repositoryId });
  return { workItemId, repositoryId, repositoryPath };
}

const explorerOf = (page: Page) =>
  page.getByRole('dialog', { name: 'Inspect local review policy' });
const inboxRow = (page: Page, title: string) =>
  page.locator('#inbox').getByRole('button', { name: new RegExp(title, 'u') });

/** Opens a work item's review, once the service has answered; until then the page shows the labeled demo. */
async function openReview(page: Page, workItemId: string, title: string): Promise<void> {
  await page.goto(`/?review=${workItemId}`);
  await expect(page.locator('#review-detail h2').first()).toHaveText(title);
}

function nextBootstrap(page: Page) {
  return page.waitForResponse((response) => response.url().endsWith('/api/v1/bootstrap'), {
    timeout: 25_000,
  });
}

// Each bootstrap reads every repository, and these tests go through many on a workspace that has grown.
test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  await rm(driveRoot, { recursive: true, force: true });
});

test('removes a work item with a reason, keeps its packet, and puts it back', async ({ page }) => {
  const title = 'Removal: added by mistake';
  const { workItemId } = await seedItem(page.request, {
    parent: fixtureRoot,
    rootLabel: 'Removal fixtures',
    repository: 'mistaken',
    title,
  });
  await openReview(page, workItemId, title);

  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.getByLabel('Decision note').fill('This run was never meant for review.');
  await page.getByRole('button', { name: 'Record rejection' }).click();
  await expect(page.getByRole('dialog', { name: 'Reject this work' })).toBeHidden();

  await page.getByRole('button', { name: 'Remove work item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove this work item' });
  await expect(dialog.getByText(/0 evidence records and 1 verdict stay on record/u)).toBeVisible();
  const confirm = dialog.getByRole('button', { name: 'Remove work item' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Why it is removed').fill('Added by mistake.');
  await expectNoWcagViolations(page);
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(inboxRow(page, title)).toHaveCount(0);

  await page.getByRole('button', { name: 'Removed', exact: true }).click();
  const explorer = explorerOf(page);
  await expect(explorer.getByText('Added by mistake.')).toBeVisible();
  await expect(
    explorer.getByText(/1 verdict and 0 evidence records stay on record/u),
  ).toBeVisible();
  await expectNoWcagViolations(page);

  const download = page.waitForEvent('download');
  await explorer.locator('article', { hasText: title }).getByRole('link', { name: 'JSON' }).click();
  const packet = JSON.parse(await readFile(await (await download).path(), 'utf8')) as {
    workItem: { removedReason: string };
    verdicts: unknown[];
  };
  expect(packet.workItem.removedReason).toBe('Added by mistake.');
  expect(packet.verdicts).toHaveLength(1);

  await explorer.getByRole('tab', { name: 'Exports' }).click();
  await expect(explorer.getByText('rejected · work item removed').first()).toBeVisible();
  await explorer.getByRole('tab', { name: 'Removed' }).click();
  await explorer.getByRole('button', { name: `Put back ${title}` }).click();
  await expect(explorer.getByText(`${title} is back.`)).toBeVisible();
  await explorer.getByRole('button', { name: 'Close workspace explorer' }).click();
  await expect(inboxRow(page, title)).toBeVisible();
});

test('says a work item left while its verdict dialog was open', async ({ page }) => {
  const title = 'Removal: left during a decision';
  const { workItemId } = await seedItem(page.request, {
    parent: fixtureRoot,
    rootLabel: 'Removal fixtures',
    repository: 'decided-elsewhere',
    title,
  });
  await openReview(page, workItemId, title);
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Reject this work' });
  await expect(dialog).toBeVisible();

  const { workItems } = await readBootstrap(page.request);
  const claimHash = workItems.find((item) => item.id === workItemId)?.claimHash;
  await post(page.request, `/api/v1/work-items/${workItemId}/remove`, {
    reason: 'Removed from another window.',
    expected: { claimHash },
  });
  await nextBootstrap(page);

  await expect(dialog.getByText(/removed after this dialog opened/u)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Record rejection' })).toBeDisabled();
});

test('a verdict dialog stays and explains when the only work item leaves', async ({ page }) => {
  const title = 'Removal: the only one left';
  const { workItemId } = await seedItem(page.request, {
    parent: fixtureRoot,
    rootLabel: 'Removal fixtures',
    repository: 'the-only-one',
    title,
  });
  const { workItems } = await readBootstrap(page.request);
  for (const item of workItems.filter((entry) => entry.id !== workItemId)) {
    await post(page.request, `/api/v1/work-items/${item.id}/remove`, {
      reason: 'Clearing the inbox.',
      expected: { claimHash: item.claimHash },
    });
  }
  await openReview(page, workItemId, title);
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Reject this work' });
  await expect(dialog).toBeVisible();

  const claimHash = (await readBootstrap(page.request)).workItems[0]?.claimHash;
  await post(page.request, `/api/v1/work-items/${workItemId}/remove`, {
    reason: 'Removed from another window.',
    expected: { claimHash },
  });
  await nextBootstrap(page);
  await expect(dialog.getByText(/removed after this dialog opened/u)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Record rejection' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Nothing to review' })).toBeVisible();

  // Everything goes back for the tests below.
  const removed = (await readBootstrap(page.request)).removed.workItems;
  for (const item of removed) {
    await post(page.request, `/api/v1/work-items/${item.id}/put-back`, {});
  }
});

test('removes a repository, whose work item moves to another one', async ({ page }) => {
  const title = 'Removal: its repository moved';
  const { workItemId, repositoryId } = await seedItem(page.request, {
    parent: fixtureRoot,
    rootLabel: 'Removal fixtures',
    repository: 'moving',
    title,
  });
  const destination = await createRepository(fixtureRoot, 'destination');
  await post(page.request, '/api/v1/repositories', { path: destination });
  await openReview(page, workItemId, title);

  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  const explorer = explorerOf(page);
  await explorer.getByRole('button', { name: 'Remove moving' }).click();
  await expect(explorer.getByText(/1 work item bound to it stays in the inbox/u)).toBeVisible();
  await explorer.getByLabel('Why it is removed').fill('Moved to another folder.');
  await expectNoWcagViolations(page);
  await explorer.getByRole('button', { name: 'Remove this repository' }).click();
  await expect(explorer.getByText(/Removed moving\. It is listed under Removed/u)).toBeVisible();
  await expect(explorer.getByRole('button', { name: 'Remove moving' })).toHaveCount(0);
  await explorer.getByRole('button', { name: 'Close workspace explorer' }).click();

  // The work item stays on the last state, says what to do, and acceptance stays locked.
  await expect(page.locator('.detail-header')).toContainText('was removed');
  await expect(page.locator('.detail-header')).toContainText('Moved to another folder.');
  await expect(page.getByRole('button', { name: 'Accept work' })).toBeDisabled();
  await expectNoWcagViolations(page);

  await page.getByRole('button', { name: 'Link to repository' }).click();
  const link = page.getByRole('dialog', { name: 'Link to a repository' });
  const options = await link
    .getByRole('combobox', { name: 'Repository' })
    .locator('option')
    .allTextContents();
  expect(options.some((option) => option.startsWith('moving'))).toBe(false);
  await link
    .getByRole('combobox', { name: 'Repository' })
    .selectOption({ index: options.findIndex((option) => option.startsWith('destination')) });
  await link.getByRole('button', { name: 'Link current snapshot' }).click();
  await expect(link).toBeHidden();
  await expect(page.locator('.detail-header')).not.toContainText('was removed');

  await page.getByRole('button', { name: 'Removed', exact: true }).click();
  await explorer.getByRole('button', { name: 'Put back moving' }).click();
  await expect(explorer.getByText('moving is back.')).toBeVisible();
  await explorer.getByRole('tab', { name: 'Repositories' }).click();
  await expect(explorer.getByRole('button', { name: 'Remove moving' })).toBeVisible();
  await explorer.getByRole('button', { name: 'Close workspace explorer' }).click();
  expect((await readBootstrap(page.request)).repositories.map((entry) => entry.id)).toContain(
    repositoryId,
  );
});

test('removes a root whose folder is gone, with the repository only it covered', async ({
  page,
}) => {
  const title = 'Removal: on a drive that left';
  const { workItemId } = await seedItem(page.request, {
    parent: driveRoot,
    rootLabel: 'Old drive',
    repository: 'on-the-drive',
    title,
  });
  await rm(driveRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await openReview(page, workItemId, title);
  await expect(page.getByText(/repository source is unavailable/u)).toBeVisible();

  await page.getByRole('button', { name: 'Roots', exact: true }).click();
  const explorer = explorerOf(page);
  await expect(explorer.getByText('Approved · folder missing')).toBeVisible();
  await explorer.getByRole('button', { name: 'Remove Old drive' }).click();
  await expect(explorer.getByRole('checkbox', { name: 'on-the-drive' })).toBeChecked();
  await explorer.getByLabel('Why it is removed').fill('The disk is gone for good.');
  await expectNoWcagViolations(page);
  await explorer.getByRole('button', { name: 'Remove this root' }).click();
  await expect(explorer.getByText(/Removed Old drive\. It is listed under Removed/u)).toBeVisible();

  await explorer.getByRole('tab', { name: 'Removed' }).click();
  await expect(explorer.getByText('Root · removed', { exact: false })).toBeVisible();
  await expect(explorer.getByRole('button', { name: 'Put back on-the-drive' })).toBeVisible();

  // Its folder is gone, so it cannot go back, and the refusal says what to do.
  await explorer.getByRole('button', { name: 'Put back Old drive' }).click();
  await expect(explorer.getByText(/add its new location as a new root/u)).toBeVisible();
  await expect(explorer.getByRole('button', { name: 'Put back Old drive' })).toBeVisible();
  await explorer.getByRole('button', { name: 'Close workspace explorer' }).click();

  // Nothing is left to read, so nothing is reported as unavailable; the work item says where it stands.
  await expect(page.getByText(/repository source is unavailable/u)).toHaveCount(0);
  await expect(page.locator('.detail-header')).toContainText('was removed');
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeEnabled();
});

test('an empty inbox still reaches what was removed', async ({ page }) => {
  const { workItems } = await readBootstrap(page.request);
  const last = workItems.at(-1);
  if (!last) throw new Error('The inbox is empty before this test.');
  for (const item of workItems.slice(0, -1)) {
    await post(page.request, `/api/v1/work-items/${item.id}/remove`, {
      reason: 'Clearing the inbox.',
      expected: { claimHash: item.claimHash },
    });
  }
  await openReview(page, last.id, last.title);
  await page.getByRole('button', { name: 'Remove work item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove this work item' });
  await dialog.getByLabel('Why it is removed').fill('The last one out.');
  await dialog.getByRole('button', { name: 'Remove work item' }).click();
  const empty = page.getByRole('heading', { name: 'Nothing to review' });
  await expect(empty).toBeVisible();
  await expect(empty).toBeFocused();
  await expectNoWcagViolations(page);

  await page.getByRole('button', { name: 'Open workspace explorer' }).click();
  const explorer = explorerOf(page);
  const title = 'Removal: added by mistake';
  await explorer.getByRole('button', { name: `Put back ${title}` }).click();

  // The explorer stays open across the change of view, and says what happened.
  await expect(explorer.getByText(`${title} is back.`)).toBeVisible();
  await explorer.getByRole('button', { name: 'Close workspace explorer' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  // The button that opened the explorer left with the empty page.
  await expect(page.locator('#review-detail')).toBeFocused();
  expect(
    (await readBootstrap(page.request)).removed.workItems.some((item) => item.title === title),
  ).toBe(false);
});
