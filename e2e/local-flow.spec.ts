import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import { expectNoWcagViolations } from './accessibility.js';

const execFileAsync = promisify(execFile);
const fixtureRoot = path.resolve('output/e2e-fixture');
const repositoryPath = path.join(fixtureRoot, 'repository');
const decoyRepositoryPath = path.join(fixtureRoot, 'unrelated-repository');
const receiptPath = path.join(fixtureRoot, 'receipt.json');
let repositoryHead = '';

test.beforeAll(async () => {
  const createRepository = async (repository: string, heading: string) => {
    await mkdir(repository, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await execFileAsync('git', ['config', 'user.email', 'e2e@veridone.local'], {
      cwd: repository,
    });
    await execFileAsync('git', ['config', 'user.name', 'VeriDone E2E'], { cwd: repository });
    await writeFile(path.join(repository, 'README.md'), `# ${heading}\n`);
    await execFileAsync('git', ['add', 'README.md'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repository });
  };

  await createRepository(repositoryPath, 'E2E fixture');
  await createRepository(decoyRepositoryPath, 'Unrelated fixture');
  repositoryHead = (
    await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryPath })
  ).stdout.trim();
  await writeFile(
    receiptPath,
    JSON.stringify({
      schema_version: 1,
      run_id: 'playwright-local-flow',
      started_at: '2026-07-21T13:00:00.1234567-07:00',
      completed_at: '2026-07-21T13:00:03.7654321-07:00',
      status: 'complete',
      task: { type: 'implementation' },
      stages: [{ name: 'build', status: 'completed', output: 'untrusted output stays inert' }],
    }),
  );
});

async function connectSource(
  page: import('@playwright/test').Page,
  kind: 'Approved root' | 'Git repository' | 'Agent receipt',
  sourcePath: string,
): Promise<void> {
  const openButton = page.getByRole('button', { name: /add (first )?source/i });
  await openButton.click();
  await page.getByText(kind, { exact: true }).click();
  await expect(page.getByRole('radio', { name: new RegExp(kind, 'i') })).toBeChecked();
  if (kind === 'Git repository') {
    await page.getByRole('button', { name: 'Discover repositories' }).click();
    await page.getByLabel('Discovered repository').selectOption(sourcePath);
    await expect(page.getByLabel('Absolute local path')).toHaveValue(sourcePath);
  } else {
    await page.getByLabel('Absolute local path').fill(sourcePath);
  }
  if (kind === 'Approved root') await page.getByLabel(/label/i).fill('Playwright fixtures');
  if (kind === 'Agent receipt') {
    await page.getByRole('button', { name: 'Preview import' }).click();
    await expect(page.getByLabel('Validated receipt preview')).toContainText('1 receipt validated');
    await page.getByRole('button', { name: 'Import 1' }).click();
  } else {
    await page.getByRole('button', { name: 'Connect source' }).click();
  }
  await expect(page.getByRole('dialog')).toBeHidden();
}

test('onboards, verifies, decides, and exports without trusting the claim', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'No evidence sources yet' })).toBeVisible();

  await connectSource(page, 'Approved root', fixtureRoot);
  await connectSource(page, 'Git repository', repositoryPath);
  await connectSource(page, 'Git repository', decoyRepositoryPath);
  await connectSource(page, 'Agent receipt', receiptPath);

  await expect(page.getByRole('heading', { name: /implementation · playwright/i })).toBeVisible();
  await page.getByRole('button', { name: 'Link to repository' }).click();
  await expect(page.getByRole('heading', { name: 'Link to a repository' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Link current snapshot' })).toBeDisabled();
  await page
    .getByRole('combobox', { name: 'Repository' })
    .selectOption({ label: `repository — main @ ${repositoryHead.slice(0, 12)}` });
  await expect(page.getByLabel('Selected repository snapshot')).toContainText(repositoryHead);
  await page.getByRole('button', { name: 'Link current snapshot' }).click();
  await page.getByRole('button', { name: 'Approve a check' }).click();
  await page.getByLabel('Label').fill('Deterministic browser smoke check');
  await page.getByLabel('Executable').fill(process.execPath);
  await page
    .getByLabel('Literal argument array')
    .fill('["-e", "process.stdout.write(\\"verified\\")"]');
  await page.getByRole('button', { name: 'Approve definition' }).click();

  // Approval pins the tool file; the workspace explorer shows which one.
  await page.getByRole('button', { name: 'Checks', exact: true }).click();
  const explorer = page.getByRole('dialog', { name: 'Inspect local review policy' });
  await expect(explorer.getByText('Deterministic browser smoke check')).toBeVisible();
  await expect(explorer.getByText('Pinned tool')).toBeVisible();
  await expect(explorer.getByText(/not pinned/u)).toHaveCount(0);
  await expectNoWcagViolations(page);
  await explorer.getByRole('button', { name: 'Close workspace explorer' }).click();

  await page.getByRole('button', { name: 'Run approved checks' }).click();

  await expect(page.getByText('All required evidence is current')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept work' })).toBeEnabled();
  await expectNoWcagViolations(page);

  await page.getByRole('button', { name: 'Accept work' }).click();
  await page
    .getByLabel('Decision note')
    .fill('Reviewed the current fingerprint and fresh smoke check.');
  await page.getByRole('button', { name: 'Record acceptance' }).click();
  await expect(page.getByText(/^accepted$/i)).toBeVisible();

  const packetDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export packet' }).click();
  const packet = await packetDownload;
  expect(packet.suggestedFilename()).toMatch(/^veridone-.+\.html$/u);

  await page.getByRole('button', { name: 'Open workspace backup and restore' }).click();
  const backupDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: /export verified json/i }).click();
  const backup = await backupDownload;
  expect(backup.suggestedFilename()).toMatch(/^veridone-workspace-\d{4}-\d{2}-\d{2}\.json$/u);
  await expectNoWcagViolations(page);
});
