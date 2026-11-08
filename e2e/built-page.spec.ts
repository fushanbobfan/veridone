import { expect, test, type Page, type Route } from '@playwright/test';

import { expectNoWcagViolations } from './accessibility.js';
import { look, lookAwayAndOn } from './pointer.js';
import {
  answers,
  movedOn,
  proxyError,
  refused,
  standInService,
  workspace,
} from './stand-in-service.js';

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

const serviceStopped = (page: Page) =>
  page.getByRole('status').filter({ hasText: 'Local service unavailable' });

test('a page says when its service stops answering, and goes back when it answers', async ({
  page,
}) => {
  const service = await standInService(page);
  await page.clock.install({ time: new Date('2026-11-07T10:32:05') });
  await page.goto('/');

  await expect(page.getByText('Live local evidence')).toBeVisible();
  await expect(page.getByText('Updated now')).toBeVisible();
  await expect(serviceStopped(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Accept work' })).toBeEnabled();

  // The time the page reports comes from its last answer, so one more answer has to move it.
  const laterItem = {
    ...workspace.workItems[0],
    title: 'Stand-in work item, later answer',
    updatedAt: new Date('2026-11-07T10:46:05').toISOString(),
  };
  service.answer = answers({ ...workspace, workItems: [laterItem] });
  await page.clock.fastForward(14 * 60_000);
  const lastItem = page.getByRole('heading', { name: 'Stand-in work item, later answer' });
  await expect(lastItem).toBeVisible();

  // The first failure falls in a later minute than the last answer, so the two cannot pass for each other.
  service.answer = refused;
  await page.clock.fastForward(2 * 60_000);
  await expect(serviceStopped(page)).toContainText('Nov 7, 10:46 AM');
  const inbox = page.getByRole('region', { name: 'Review inbox' });
  await expect(inbox.getByText('Last data received', { exact: true })).toBeVisible();
  await expect(inbox.getByText('Nov 7, 10:46 AM', { exact: true })).toBeVisible();
  await expect(page.getByText('Live local evidence')).toHaveCount(0);
  await expect(page.getByText('Updated now')).toHaveCount(0);
  await expect(page.getByText('Not answering', { exact: true })).toBeVisible();

  // The last data stays, the readiness line carries its time, and the dock says decisions wait.
  await expect(lastItem).toBeVisible();
  await expect(page.getByText(/gates are current/u)).toContainText('as of Nov 7, 10:46 AM');
  await expect(page.getByText('Evidence is current', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Accept work' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Export packet' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Remove work item' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add source' })).toHaveCount(0);
  await expect(page.getByText('Workspace backup needs the local service')).toHaveCount(1);
  await expectNoWcagViolations(page);

  // The inspector still opens on the last data, says what it is, and offers no change.
  await page.getByRole('button', { name: 'Roots' }).click();
  const explorer = page.getByRole('dialog');
  await expect(explorer.getByRole('status')).toContainText('Nov 7, 10:46 AM');
  await expect(explorer.getByText('Stand-in root')).toBeVisible();
  await expect(explorer.getByRole('button', { name: 'Approve Stand-in root' })).toHaveCount(0);
  await expect(explorer.getByRole('button', { name: 'Remove Stand-in root' })).toHaveCount(0);
  await expectNoWcagViolations(page);

  // Time passing without an answer leaves the time alone. A proxy in front of the stopped service answers differently.
  const requests = service.requests;
  service.answer = proxyError;
  await page.clock.fastForward(20 * 60_000);
  await expect.poll(() => service.requests).toBeGreaterThan(requests);
  await page.waitForTimeout(500);
  await expect(explorer.getByRole('status')).toContainText('Nov 7, 10:46 AM');
  await expect(inbox.getByText(/^2[2-4] min ago$/u).first()).toBeVisible();

  service.answer = answers(workspace);
  await page.clock.fastForward(15_000);
  await expect(page.getByText('Live local evidence')).toHaveCount(1);
  await expect(serviceStopped(page)).toHaveCount(0);
  await expect(explorer.getByRole('status')).toHaveText('');
  await expect(explorer.getByRole('button', { name: 'Approve Stand-in root' })).toBeVisible();
  await expect(explorer.getByRole('button', { name: 'Remove Stand-in root' })).toBeVisible();
  await explorer.getByRole('button', { name: 'Close workspace explorer' }).click();
  await expect(page.getByText('Updated now')).toBeVisible();
  await expect(page.getByText('Evidence is current', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept work' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Remove work item' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Add source' })).toBeVisible();
});

test('a service that hangs counts as stopped once its silence outlasts its slowest answer', async ({
  page,
}) => {
  const service = await standInService(page);
  await page.clock.install();
  await page.goto('/');
  const live = page.getByText('Live local evidence');
  await expect(live).toBeVisible();

  const hang = async (rounds: number, requests: number) => {
    const held = new Promise<Route>((resolve) => {
      service.answer = async (route) => resolve(route);
    });
    await page.clock.fastForward(15_000);
    const unanswered = await held;

    // Every round but the last leaves the page live, and it has a moment to show otherwise.
    for (let round = 1; round < rounds; round += 1) {
      await page.clock.fastForward(15_000);
    }
    await page.waitForTimeout(500);
    await expect(live).toBeVisible();

    await page.clock.fastForward(15_000);
    await expect(serviceStopped(page)).toBeVisible();
    await expect(live).toHaveCount(0);
    expect(service.requests, 'the page keeps one request open at a time').toBe(requests);

    await unanswered.fulfill({ json: workspace });
    await expect(live).toBeVisible();
    await expect(serviceStopped(page)).toHaveCount(0);
  };

  // Answers have been quick, so two rounds of silence count. That late answer took two rounds, so the next hang has
  // to reach four, and a workspace that always answers in two rounds never reads as stopped.
  await hang(2, 2);
  await hang(4, 3);

  // The rounds go on from there.
  service.answer = answers(workspace);
  await page.clock.fastForward(15_000);
  await expect.poll(() => service.requests).toBe(4);
});

test('a first request that gets no answer says so, and the late answer still counts', async ({
  page,
}) => {
  const service = await standInService(page);
  const held = new Promise<Route>((resolve) => {
    service.answer = async (route) => resolve(route);
  });
  await page.clock.install();
  await page.goto('/');
  const unanswered = await held;
  const loading = page.getByText('Refreshing repository fingerprints and local evidence');
  await expect(loading).toBeVisible();

  await page.clock.fastForward(15_000);
  await page.waitForTimeout(500);
  await expect(loading).toBeVisible();

  await page.clock.fastForward(15_000);
  await expect(page.getByText('The local service has not answered yet.')).toBeVisible();

  await unanswered.fulfill({ json: workspace });
  await expect(page.getByText('Live local evidence')).toBeVisible();
  await expect(serviceStopped(page)).toHaveCount(0);
});

test('a verdict being written keeps its note through a stop, and records once the service is back', async ({
  page,
}) => {
  const service = await standInService(page);
  let recordVerdict = refused;
  await page.route('**/api/v1/work-items/*/verdicts', (route) => recordVerdict(route));
  await page.clock.install();
  await page.goto('/');

  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const note = dialog.getByLabel('Decision note');
  await note.fill('Written before the service stopped.');
  const record = dialog.getByRole('button', { name: 'Record rejection' });

  service.answer = proxyError;
  await page.clock.fastForward(15_000);
  await expect(serviceStopped(page)).toBeVisible();

  // The two ways a request fails once the service has stopped read the same.
  await record.click();
  await expect(dialog.getByText('The local service did not answer.')).toBeVisible();
  recordVerdict = proxyError;
  await record.click();
  await expect(record).toBeEnabled();
  await expect(dialog.getByText('The local service did not answer.')).toBeVisible();
  await expect(note).toHaveValue('Written before the service stopped.');

  // A recorded verdict brings the page back with no wait for the next round.
  service.answer = answers(workspace);
  recordVerdict = answers({});
  await record.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Live local evidence')).toBeVisible();
  await expect(serviceStopped(page)).toHaveCount(0);
});

test('an action the stopped service never answered reads plainly, and that message clears when it is back', async ({
  page,
}) => {
  const service = await standInService(page, movedOn);
  let bind = refused;
  await page.route('**/api/v1/work-items/*/link', (route) => bind(route));
  await page.clock.install();
  await page.goto('/');
  const rebind = page.getByRole('button', { name: 'Rebind to current state' });
  const toast = page.getByRole('alert');
  await expect(rebind).toBeVisible();

  // The moment before the next round, when the page has not noticed yet.
  service.answer = proxyError;
  await rebind.click();
  await expect(toast).toContainText('The local service did not answer.');
  await expect(serviceStopped(page)).toHaveCount(0);

  await page.clock.fastForward(15_000);
  await expect(serviceStopped(page)).toBeVisible();
  await expect(rebind).toBeDisabled();

  service.answer = answers(movedOn);
  await page.clock.fastForward(15_000);
  await expect(serviceStopped(page)).toHaveCount(0);
  await expect(toast).toHaveCount(0);
  await expect(rebind).toBeEnabled();

  // A refusal the service did give stays until it is read, whatever the rounds bring.
  bind = (route) => route.fulfill({ status: 409, json: { message: 'Refused for a reason.' } });
  await rebind.click();
  await expect(toast).toContainText('Refused for a reason.');
  const requests = service.requests;
  await page.clock.fastForward(15_000);
  await expect.poll(() => service.requests).toBeGreaterThan(requests);
  await page.waitForTimeout(500);
  await expect(toast).toContainText('Refused for a reason.');
});

test('a backup dialog open when the service stops takes back its downloads', async ({ page }) => {
  const service = await standInService(page);
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Open workspace backup and restore' }).click();
  const dialog = page.getByRole('dialog');
  const backup = dialog.getByRole('link', { name: /Export verified JSON/u });
  const signingKey = dialog.getByRole('link', { name: /Download the packet signing key/u });
  await expect(backup).toBeVisible();
  await expect(signingKey).toBeVisible();

  service.answer = proxyError;
  await page.clock.fastForward(15_000);
  await expect(dialog.getByRole('status')).toContainText('Local service unavailable');
  await expect(backup).toHaveCount(0);
  await expect(signingKey).toHaveCount(0);

  service.answer = answers(workspace);
  await page.clock.fastForward(15_000);
  await expect(backup).toBeVisible();
  await expect(signingKey).toBeVisible();
  await expect(dialog.getByRole('status')).toHaveText('');
});

// The banner's live region sits in front of the empty view, and the dialogs both views share must keep their place
// when the first work item arrives, or the restore's message is lost with the dialog that held it.
test('a restore that brings in the first work item keeps its message', async ({ page }) => {
  const service = await standInService(page, {
    ...workspace,
    roots: [],
    repositories: [],
    workItems: [],
    readiness: {},
  });
  const restored = {
    imported: { workItems: 1 },
    unchanged: {},
    added: {
      roots: [],
      repositories: [],
      checks: [],
      workItems: [{ title: 'Stand-in work item' }],
      removed: [],
    },
  };
  await page.route('**/api/v1/workspace/preview', (route) => route.fulfill({ json: restored }));
  await page.route('**/api/v1/workspace/import', (route) => {
    service.answer = answers(workspace);
    return route.fulfill({ status: 201, json: restored });
  });
  await page.goto('/');

  await page.getByRole('button', { name: 'Restore a backup' }).click();
  await page.getByLabel('Choose a VeriDone workspace JSON backup').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"schemaVersion":2}'),
  });
  await page.getByRole('button', { name: 'Restore these records' }).click();
  await expect(page.getByRole('heading', { name: 'Stand-in work item' })).toBeVisible();
  await expect(page.getByText(/approve restored roots under Roots/u)).toBeVisible();
});

test('an empty workspace says when its service stops too', async ({ page }) => {
  const service = await standInService(page, {
    ...workspace,
    roots: [],
    repositories: [],
    workItems: [],
    readiness: {},
  });
  await page.clock.install();
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'No evidence sources yet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add first source' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Restore a backup' })).toBeEnabled();

  const running = service.answer;
  service.answer = refused;
  await page.clock.fastForward(15_000);
  await expect(serviceStopped(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add first source' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Restore a backup' })).toBeDisabled();
  await expectNoWcagViolations(page);

  service.answer = running;
  await page.clock.fastForward(15_000);
  await expect(page.getByRole('button', { name: 'Add first source' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Restore a backup' })).toBeEnabled();
  await expect(serviceStopped(page)).toHaveCount(0);
});

test('the buttons a stopped service turns off stay still under the pointer', async ({ page }) => {
  // A work item that is not ready, so the dock offers "Override lock" as well.
  const service = await standInService(page, {
    ...workspace,
    readiness: { 'work-item': { ...workspace.readiness['work-item'], ready: false } },
  });
  await page.clock.install();
  await page.goto('/');
  const reject = page.getByRole('button', { name: 'Reject', exact: true });
  await expect(page.getByRole('button', { name: 'Override lock' })).toBeVisible();

  // While the service answers, Reject lights up under the pointer, so this browser applies the hover style.
  const answering = await look(reject);
  await reject.hover();
  await expect.poll(() => look(reject)).not.toBe(answering);
  await page.mouse.move(0, 0);

  service.answer = refused;
  await page.clock.fastForward(15_000);
  await expect(serviceStopped(page)).toBeVisible();
  const turnedOff = page.locator('button:disabled:visible');
  const names = (await turnedOff.allInnerTexts()).map((text) => text.trim());
  expect(names).toEqual(
    expect.arrayContaining([
      'Approve a check',
      'Export packet',
      'Remove work item',
      'Override lock',
      'Reject',
      'Request changes',
      'Accept work',
    ]),
  );

  for (const [index, button] of (await turnedOff.all()).entries()) {
    const { away, on } = await lookAwayAndOn(button);
    expect(on, names[index]).toBe(away);
  }
});
