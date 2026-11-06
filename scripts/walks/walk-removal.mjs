// Removal walk: a real browser takes the built app through removing a root, a repository and a work item on a workspace
// the real v1.2.0 build made, through putting each one back, and through backups in both directions.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  check,
  client,
  cloneUnderTest,
  fresh,
  git,
  launchChromium,
  preparedClone,
  reservePort,
  runWalk,
  startApi,
  startService,
  verifyPacket,
  waitForFreePorts,
  walkOptions,
} from './walk-lib.mjs';

// The last release without removal. Its workspace and its backup are what an operator upgrades with.
const releaseBefore = 'v1.2.0';
// In a path of every fixture, so a packet that lets one through shows.
const pathMarker = 'walk-removal-private';
const rawError = /ENOENT|EACCES|UNIQUE constraint|FOREIGN KEY|SQLITE|invalid_request|ZodError/u;
const refusal = (response) =>
  String(response.json?.message ?? response.json?.error ?? response.text);

async function makeRepository(directory) {
  await mkdir(directory, { recursive: true });
  const run = (...args) =>
    git(directory, '-c', 'user.name=Walk', '-c', 'user.email=walk@example.invalid', ...args);
  await run('init', '-q', '-b', 'main');
  await writeFile(path.join(directory, 'README.md'), `# ${path.basename(directory)}\n`);
  await run('add', '-A');
  await run('commit', '-q', '-m', 'Initial commit');
  return directory;
}

async function writeClaim(file, runId, title) {
  await writeFile(
    file,
    JSON.stringify({
      schema_version: 1,
      run_id: runId,
      source: 'codex',
      title,
      claim: `${title}. Written at ${path.dirname(file)}.`,
      status: 'complete',
      started_at: '2026-11-05T09:00:00-08:00',
    }),
  );
}

/** Every row of the two append-only tables as they stand, read from the database file beside the running service. */
function historyRows(clone, dataDir) {
  const Database = createRequire(path.join(clone, 'apps', 'server', 'package.json'))(
    'better-sqlite3',
  );
  const database = new Database(path.join(dataDir, 'veridone.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const rows = {};
    for (const table of ['verdicts', 'evidence']) {
      for (const row of database.prepare(`SELECT * FROM ${table}`).all()) {
        rows[`${table}:${row.id}`] = JSON.stringify(row);
      }
    }
    return rows;
  } finally {
    database.close();
  }
}

const digest = (rows) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        Object.keys(rows)
          .sort()
          .map((key) => [key, rows[key]]),
      ),
    )
    .digest('hex');

async function waitUntilUp(url, service) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && service.running()) {
    try {
      if ((await fetch(`${url}/api/v1/bootstrap`)).ok) return true;
    } catch {
      // Both processes may not be listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

await runWalk('REMOVAL WALK', async () => {
  const { root, ref } = await walkOptions();
  const browser = await launchChromium();
  try {
    const clone = await cloneUnderTest(root, ref);
    const before = await preparedClone(root, releaseBefore);
    const work = path.join(root, 'walk-removal');
    await fresh(work);
    const kept = path.join(work, pathMarker, 'kept');
    const drive = path.join(work, pathMarker, 'drive');
    const appPath = await makeRepository(path.join(kept, 'app'));
    const movingPath = await makeRepository(path.join(kept, 'moving'));
    const destinationPath = await makeRepository(path.join(kept, 'destination'));
    const oldPath = await makeRepository(path.join(drive, 'old'));
    const tempDir = path.join(work, 'tmp');
    await mkdir(tempDir, { recursive: true });
    const dataDir = path.join(work, 'data');
    const oldBackupFile = path.join(work, 'backup-v1.2.0.json');

    // A workspace of the real previous build: one accepted, one rejected, one unbound, one on a folder that will go.
    const titles = {
      accepted: 'Accepted before the upgrade',
      moving: 'On a repository that moves',
      mistake: 'Added by mistake',
      drive: 'On a drive that leaves',
      follows: 'Follows its repository',
    };
    const seeded = await startApi(before, dataDir);
    check(`the ${releaseBefore} build starts`, seeded.health?.status === 'ok', seeded.output());
    const old = client(seeded.base);
    await old.boot();
    await old.post('/api/v1/roots', { path: kept, label: 'Kept' });
    await old.post('/api/v1/roots', { path: drive, label: 'Old drive' });
    const addRepository = async (repositoryPath) =>
      (await old.post('/api/v1/repositories', { path: repositoryPath })).json.repository.id;
    const appId = await addRepository(appPath);
    const movingId = await addRepository(movingPath);
    const oldId = await addRepository(oldPath);
    await addRepository(destinationPath);
    const importClaim = async (folder, runId, title) => {
      const file = path.join(folder, `${runId}.json`);
      await writeClaim(file, runId, title);
      await old.post('/api/v1/receipts/import', { path: file });
      const boot = await old.boot();
      return boot.workItems.find((item) => item.title === title);
    };
    const decide = async (item, decision, note) => {
      const boot = await old.boot();
      const current = boot.workItems.find((entry) => entry.id === item.id);
      const repository = boot.repositories.find((entry) => entry.id === current.repositoryId);
      const verdicts = boot.verdicts.filter((entry) => entry.workItemId === item.id);
      return old.post(`/api/v1/work-items/${item.id}/verdicts`, {
        decision,
        note,
        expected: {
          fingerprint: repository?.snapshot.fingerprint ?? null,
          verdictId: verdicts.at(-1)?.id ?? null,
          claimHash: current.claimHash,
        },
      });
    };
    const acceptedItem = await importClaim(kept, 'walk-accepted', titles.accepted);
    const movingItem = await importClaim(kept, 'walk-moving', titles.moving);
    const mistakeItem = await importClaim(kept, 'walk-mistake', titles.mistake);
    const driveItem = await importClaim(drive, 'walk-drive', titles.drive);
    const followsItem = await importClaim(kept, 'walk-follows', titles.follows);
    const definition = {
      repositoryId: appId,
      label: 'Walk check',
      kind: 'test',
      executable: process.execPath,
      args: ['-e', "process.stdout.write('verified')"],
      cwdRelative: '.',
      timeoutMs: 60_000,
      maxOutputBytes: 100_000,
    };
    const { check: walkCheck } = (await old.post('/api/v1/checks', definition)).json;
    await old.post(`/api/v1/work-items/${acceptedItem.id}/link`, { repositoryId: appId });
    await old.post(`/api/v1/work-items/${movingItem.id}/link`, { repositoryId: movingId });
    await old.post(`/api/v1/work-items/${driveItem.id}/link`, { repositoryId: oldId });
    await old.post(`/api/v1/work-items/${followsItem.id}/link`, { repositoryId: movingId });
    const ran = await old.post(`/api/v1/checks/${walkCheck.id}/run`, {
      workItemId: acceptedItem.id,
    });
    check(
      `${releaseBefore} records passing evidence`,
      ran.json?.evidence?.result === 'passed' && ran.json?.readiness?.ready === true,
      refusal(ran),
    );
    const acceptedOld = await decide(acceptedItem, 'accepted', 'Reviewed before the upgrade.');
    const rejectedOld = await decide(movingItem, 'rejected', 'Rejected before the upgrade.');
    check(
      `${releaseBefore} records the verdicts`,
      acceptedOld.status === 201 && rejectedOld.status === 201,
    );
    await writeFile(oldBackupFile, (await old.get('/api/v1/workspace/export')).text);
    await seeded.stop();

    // The new build, as an operator starts it, on that workspace.
    const webPort = await reservePort();
    const apiPort = await reservePort();
    const url = `http://127.0.0.1:${webPort}`;
    const launch = (data) =>
      startService([process.env.npm_execpath, 'start'], {
        cwd: clone,
        tree: true,
        env: {
          TEMP: tempDir,
          TMP: tempDir,
          TMPDIR: tempDir,
          VERIDONE_ALLOWED_ORIGINS: url,
          VERIDONE_API_PORT: String(apiPort),
          VERIDONE_DATA_DIR: data,
          VERIDONE_PORT: String(apiPort),
          VERIDONE_STRICT_PORT: '1',
          VERIDONE_WEB_PORT: String(webPort),
        },
      });
    const restart = async (service, data) => {
      await service.stop();
      await waitForFreePorts([webPort, apiPort]);
      const next = launch(data);
      if (!(await waitUntilUp(url, next))) throw new Error(`not up: ${next.output().slice(-300)}`);
      return next;
    };
    let server = launch(dataDir);
    if (
      !check(
        'the built app opens the v1.2.0 workspace and migrates it',
        await waitUntilUp(url, server),
        server.output().slice(-300),
      )
    ) {
      throw new Error('not up');
    }
    const api = client(url);
    let boot = await api.boot();
    check(
      'every record of the old workspace is there and none is removed',
      boot.workItems.length === 5 &&
        boot.repositories.length === 4 &&
        boot.roots.length === 2 &&
        boot.verdicts.length === 2 &&
        boot.removed?.workItems.length === 0 &&
        boot.removed?.repositories.length === 0 &&
        boot.removed?.roots.length === 0,
    );
    const historyBefore = historyRows(clone, dataDir);

    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1360, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const problems = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      // A refused request logs a line in the browser, and these requests are part of the walk.
      if (message.type() === 'error' && !/status of 4\d\d/u.test(message.text())) {
        problems.push(`console: ${message.text().slice(0, 200)}`);
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 500) problems.push(`${response.status()} ${response.url()}`);
    });
    const shot = (target, name) =>
      target.screenshot({ path: path.join(work, `${name}.png`), fullPage: true });
    const explorer = page.getByRole('dialog', { name: 'Inspect local review policy' });
    const closeExplorer = () =>
      explorer.getByRole('button', { name: 'Close workspace explorer' }).click();
    const inboxRow = (title) => page.locator('#inbox').getByRole('button', { name: title });

    // A work item added by mistake.
    await page.goto(`${url}/?review=${mistakeItem.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Remove work item' }).click();
    const removeDialog = page.getByRole('dialog', { name: 'Remove this work item' });
    check(
      'removing a work item waits for a reason',
      await removeDialog.getByRole('button', { name: 'Remove work item' }).isDisabled(),
    );
    await removeDialog.getByLabel('Why it is removed').fill('Added by mistake.');
    await shot(page, '1-remove-work-item');
    await removeDialog.getByRole('button', { name: 'Remove work item' }).click();
    await removeDialog.waitFor({ state: 'hidden' });
    check('the work item leaves the inbox', (await inboxRow(titles.mistake).count()) === 0);

    boot = await api.boot();
    check(
      'the workspace lists it as removed, with its reason, and computes no gate for it',
      boot.removed.workItems[0]?.removedReason === 'Added by mistake.' &&
        boot.readiness[mistakeItem.id] === undefined,
    );
    const refusedVerdict = await api.post(`/api/v1/work-items/${mistakeItem.id}/verdicts`, {
      decision: 'rejected',
      note: 'No.',
      expected: {
        fingerprint: null,
        verdictId: null,
        claimHash: boot.removed.workItems[0]?.claimHash,
      },
    });
    check(
      'a removed work item refuses a verdict and names the way back',
      refusedVerdict.status === 409 && /put it back/iu.test(refusal(refusedVerdict)),
      refusal(refusedVerdict).slice(0, 200),
    );

    // Its run imported again leaves it where it is, and the dialog says so.
    await page.getByRole('button', { name: 'Add source' }).click();
    await page.getByText('Agent receipt', { exact: true }).click();
    await page.getByLabel('Absolute local path').fill(path.join(kept, 'walk-mistake.json'));
    await page.getByRole('button', { name: 'Preview import' }).click();
    await page.getByText(/removed earlier/u).waitFor();
    await page.getByRole('button', { name: 'Import 1' }).click();
    await page.getByText(/Put it back under Removed/u).waitFor();
    check(
      'importing its run again leaves it removed, and the dialog says so',
      (await inboxRow(titles.mistake).count()) === 0,
    );
    await page
      .getByRole('dialog', { name: 'Connect evidence' })
      .getByRole('button', { name: 'Close', exact: true })
      .click();

    // A root whose folder went away, and the repository only it covered.
    await rm(drive, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText(/repository source is unavailable/u).waitFor();
    check('a folder that went away is reported', true);
    await page.getByRole('button', { name: 'Roots', exact: true }).click();
    await explorer.getByText('Approved · folder missing').waitFor();
    await explorer.getByRole('button', { name: 'Remove Old drive' }).click();
    check(
      'the form names the repository only this root covers, ticked',
      await explorer.getByRole('checkbox', { name: 'old', exact: true }).isChecked(),
    );
    check(
      'it leaves out the repositories another root covers',
      (await explorer.getByRole('checkbox').count()) === 1,
    );
    await explorer.getByLabel('Why it is removed').fill(`The disk at ${drive} is gone for good.`);
    await shot(page, '2-remove-root');
    await explorer.getByRole('button', { name: 'Remove this root' }).click();
    await explorer.getByText(/Removed Old drive/u).waitFor();
    await closeExplorer();
    check(
      'nothing is reported as unavailable any more',
      (await page.getByText(/repository source is unavailable/u).count()) === 0,
    );
    boot = await api.boot();
    check(
      'the root and its repository are removed, with the same reason',
      boot.removed.roots[0]?.label === 'Old drive' &&
        boot.removed.repositories[0]?.id === oldId &&
        boot.removed.repositories[0]?.removedReason === boot.removed.roots[0]?.removedReason,
    );

    // Its work item stays, on the last state captured, with the gate closed and a way forward.
    await inboxRow(titles.drive).click();
    const header = page.locator('.detail-header');
    await header.getByText('was removed').waitFor();
    check(
      'its work item says the repository was removed and what to do next',
      /Link this work item/u.test(await header.innerText()),
    );
    check(
      'acceptance stays locked',
      await page.getByRole('button', { name: 'Accept work' }).isDisabled(),
    );
    await shot(page, '3-repository-removed');
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await page.getByLabel('Decision note').fill('The work went away with the disk.');
    await page.getByRole('button', { name: 'Record rejection' }).click();
    await page.getByRole('dialog', { name: 'Reject this work' }).waitFor({ state: 'hidden' });
    boot = await api.boot();
    const driveVerdict = boot.verdicts.find((verdict) => verdict.workItemId === driveItem.id);
    check(
      'a rejection records against the last state captured',
      driveVerdict?.decision === 'rejected' &&
        driveVerdict?.snapshotFingerprint ===
          boot.removed.repositories.find((entry) => entry.id === oldId)?.snapshot.fingerprint,
    );

    // A repository that moved, with a decided work item.
    await page.getByRole('button', { name: 'Repositories', exact: true }).click();
    await explorer.getByRole('button', { name: 'Remove moving' }).click();
    await explorer.getByText(/2 work items bound to it stay in the inbox/u).waitFor();
    await explorer.getByLabel('Why it is removed').fill('Moved to another disk.');
    await shot(page, '4-remove-repository');
    await explorer.getByRole('button', { name: 'Remove this repository' }).click();
    await explorer.getByText(/Removed moving/u).waitFor();
    await explorer.getByRole('tab', { name: 'Checks' }).click();
    await explorer.getByRole('tab', { name: 'Removed' }).click();
    await shot(page, '5-removed-list');
    check(
      'the Removed list shows all three kinds, each with a way back',
      (await explorer.getByRole('button', { name: /^Put back/u }).count()) === 4,
    );
    await closeExplorer();
    const decidedMark = (title) =>
      page
        .locator('.detail-header')
        .filter({ hasText: title })
        .getByText('Decided', { exact: true })
        .waitFor()
        .then(() => true)
        .catch(() => false);
    await inboxRow(titles.moving).click();
    check('a work item decided on the last state stays decided', await decidedMark(titles.moving));
    await inboxRow(titles.accepted).click();
    check('an unrelated accepted work item stays decided', await decidedMark(titles.accepted));

    // A work item moves to where its repository went, and takes no evidence with it.
    await inboxRow(titles.follows).click();
    await page.locator('.detail-header').getByText('was removed').waitFor();
    await page.getByRole('button', { name: 'Link to repository' }).click();
    const linkDialog = page.getByRole('dialog', { name: 'Link to a repository' });
    const linkOptions = await linkDialog
      .getByRole('combobox', { name: 'Repository' })
      .locator('option')
      .allTextContents();
    check(
      'a removed repository is not offered for linking',
      linkOptions.some((option) => option.startsWith('destination')) &&
        !linkOptions.some((option) => option.startsWith('moving')),
      linkOptions.join(' | '),
    );
    await linkDialog
      .getByRole('combobox', { name: 'Repository' })
      .selectOption({ index: linkOptions.findIndex((option) => option.startsWith('destination')) });
    await linkDialog.getByRole('button', { name: 'Link current snapshot' }).click();
    await linkDialog.waitFor({ state: 'hidden' });
    await page.locator('.detail-header').getByText('was removed').waitFor({ state: 'hidden' });
    boot = await api.boot();
    check(
      'the work item binds to the other repository, with nothing passing there yet',
      boot.readiness[followsItem.id]?.repositoryIssue === null &&
        boot.readiness[followsItem.id]?.bindingFresh === true &&
        boot.readiness[followsItem.id]?.ready === false,
    );

    // The recorded history did not move.
    const historyNow = historyRows(clone, dataDir);
    const changedRows = Object.keys(historyBefore).filter(
      (key) => historyBefore[key] !== historyNow[key],
    );
    const addedRows = Object.keys(historyNow).filter((key) => !(key in historyBefore));
    check(
      'no verdict or evidence row changed through the removals',
      changedRows.length === 0 && addedRows.length === 1 && addedRows[0]?.startsWith('verdicts:'),
      `changed ${changedRows.length}, added ${addedRows.join(', ')}; sha256 ${digest(historyNow).slice(0, 16)}`,
    );

    // Packets of what left, read by this build's verifier and by the previous release's.
    const keyFile = path.join(work, 'signing-key.pem');
    await writeFile(keyFile, (await api.get('/api/v1/workspace/signing-key')).text);
    const packets = {};
    for (const [name, id] of [
      ['removed-work-item', mistakeItem.id],
      ['removed-repository', driveItem.id],
      ['moved-repository', movingItem.id],
      ['untouched', acceptedItem.id],
    ]) {
      const route = `/api/v1/work-items/${id}/packet`;
      const jsonFile = path.join(work, `packet-${name}.json`);
      const text = (await api.get(`${route}/json`)).text;
      await writeFile(jsonFile, text);
      packets[name] = {
        jsonFile,
        json: JSON.parse(text),
        md: (await api.get(`${route}/md`)).text,
        html: (await api.get(`${route}/html`)).text,
        text,
      };
      for (const [verifier, tree] of [
        ['this build', clone],
        [releaseBefore, before],
      ]) {
        const verified = await verifyPacket(tree, jsonFile, keyFile);
        check(
          `${name}: ${verifier} verifies the packet against the workspace key`,
          verified.code === 0,
          verified.output.split('\n').at(-1),
        );
      }
    }
    check(
      'the packet of a removed work item states the removal in every format',
      packets['removed-work-item'].json.workItem.removedReason === 'Added by mistake.' &&
        packets['removed-work-item'].md.includes('Removed from review') &&
        packets['removed-work-item'].html.includes('Removed from review'),
    );
    check(
      'the packet of a removed repository keeps its last state and states the removal',
      packets['moved-repository'].json.repository?.name === 'moving' &&
        packets['moved-repository'].json.repository?.head?.length === 40 &&
        packets['moved-repository'].json.repository?.removedReason === 'Moved to another disk.' &&
        packets['moved-repository'].md.includes('Repository removed') &&
        packets['moved-repository'].html.includes('Repository removed'),
    );
    check(
      'a packet with nothing removed says nothing of removal',
      packets.untouched.json.workItem.removedAt === null &&
        packets.untouched.json.repository?.removedAt === null &&
        !packets.untouched.md.includes('removed'),
    );
    const leaks = Object.entries(packets).flatMap(([name, packet]) =>
      [packet.text, packet.md, packet.html].some((text) =>
        text.replaceAll('\\\\', '/').toLowerCase().includes(pathMarker),
      )
        ? [name]
        : [],
    );
    check(
      'no packet holds a local path, those of removed records and the reason included',
      leaks.length === 0,
      leaks.join(', '),
    );

    // Refusals say what to do, in plain words.
    const refusals = [
      await api.post(`/api/v1/repositories/${oldId}/refresh`, {}),
      await api.post(`/api/v1/work-items/${acceptedItem.id}/link`, { repositoryId: oldId }),
      await api.post('/api/v1/checks', { ...definition, repositoryId: oldId }),
      await api.post(`/api/v1/repositories/discover`, { rootId: boot.removed.roots[0]?.id }),
    ];
    check(
      'what needs a removed record refuses it, names the way back, and shows no raw error',
      refusals.every(
        (response) =>
          response.status === 409 &&
          /put it back/iu.test(refusal(response)) &&
          !rawError.test(response.text),
      ),
      refusals.map(refusal).join(' | ').slice(0, 400),
    );

    // Putting back: a root whose folder is gone refuses and says why; with the folder back it goes back.
    await page.getByRole('button', { name: 'Removed', exact: true }).click();
    await explorer.getByRole('button', { name: 'Put back Old drive' }).click();
    await explorer.getByText(/add its new location as a new root/u).waitFor();
    check('a root whose folder is gone stays removed and says what to do', true);
    await mkdir(drive, { recursive: true });
    await explorer.getByRole('button', { name: 'Put back Old drive' }).click();
    await explorer.getByText('Old drive is back.').waitFor();
    await explorer.getByRole('button', { name: 'Put back moving' }).click();
    await explorer.getByText('moving is back.').waitFor();
    await explorer.getByRole('button', { name: `Put back ${titles.mistake}` }).click();
    await explorer.getByText(`${titles.mistake} is back.`).waitFor();
    await closeExplorer();
    const historyAfterPutBack = historyRows(clone, dataDir);
    check(
      'no verdict or evidence row changed through the put backs',
      digest(historyAfterPutBack) === digest(historyNow),
      `sha256 ${digest(historyAfterPutBack).slice(0, 16)}`,
    );
    boot = await api.boot();
    check(
      'each record goes back, with its bindings and verdicts',
      boot.roots.some((entry) => entry.label === 'Old drive' && entry.status === 'approved') &&
        boot.repositories.some((entry) => entry.id === movingId) &&
        boot.workItems.some((entry) => entry.id === mistakeItem.id) &&
        boot.workItems.find((entry) => entry.id === movingItem.id)?.repositoryId === movingId &&
        boot.verdicts.filter((entry) => entry.workItemId === movingItem.id).length === 1,
    );

    // Removing again for the backups below: what left stays apart from what stayed.
    const removeAgainItem = boot.workItems.find((entry) => entry.id === mistakeItem.id);
    await api.post(`/api/v1/work-items/${mistakeItem.id}/remove`, {
      reason: 'Added by mistake, again.',
      expected: { claimHash: removeAgainItem.claimHash },
    });
    await api.post(`/api/v1/repositories/${movingId}/remove`, { reason: 'Moved for good.' });
    const backupFile = path.join(work, 'backup-new.json');
    await writeFile(backupFile, (await api.get('/api/v1/workspace/export')).text);
    const backup = JSON.parse(await readFile(backupFile, 'utf8'));
    check(
      'a backup carries removed records and their reasons',
      backup.schemaVersion === 2 &&
        backup.data.workItems.some((item) => item.removedReason === 'Added by mistake, again.') &&
        backup.data.repositories.some((item) => item.removedReason === 'Moved for good.'),
    );

    // The old backup on this workspace undoes nothing.
    const oldBackup = JSON.parse(await readFile(oldBackupFile, 'utf8'));
    const overHere = await api.post('/api/v1/workspace/import', oldBackup);
    boot = await api.boot();
    check(
      'the v1.2.0 backup restores onto this workspace, and a local removal stands',
      overHere.status === 201 &&
        overHere.json.imported.evidence === 0 &&
        boot.removed.workItems.some((item) => item.id === mistakeItem.id) &&
        boot.removed.repositories.some((item) => item.id === movingId),
      refusal(overHere).slice(0, 200),
    );
    await context.close();

    // The real v1.2.0 backup into an empty workspace, through the dialog.
    const restoredDir = path.join(work, 'data-from-v1.2.0');
    server = await restart(server, restoredDir);
    const restoring = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const restorePage = await restoring.newPage();
    restorePage.setDefaultTimeout(30_000);
    await restorePage.goto(url, { waitUntil: 'networkidle' });
    await restorePage.getByRole('heading', { name: 'No evidence sources yet' }).waitFor();
    await restorePage.getByRole('button', { name: 'Restore a backup' }).click();
    await restorePage
      .getByLabel('Choose a VeriDone workspace JSON backup')
      .setInputFiles(oldBackupFile);
    const preview = restorePage.getByLabel('Restore preview');
    await preview.getByText(titles.accepted).waitFor();
    check(
      'the preview of an old backup lists no removed records',
      (await preview.getByText('Removed records').count()) === 0,
    );
    await restorePage.getByRole('button', { name: 'Restore these records' }).click();
    await restorePage.getByText(/approve restored roots under Roots/u).waitFor();
    const restoredApi = client(url);
    boot = await restoredApi.boot();
    check(
      'the v1.2.0 backup restores into an empty workspace, nothing removed',
      boot.workItems.length === 5 &&
        boot.verdicts.length === 2 &&
        boot.removed.workItems.length === 0 &&
        boot.removed.repositories.length === 0 &&
        boot.removed.roots.length === 0,
    );

    // A backup that holds removals changes nothing the workspace holds.
    const overRecords = await restoredApi.post(
      '/api/v1/workspace/import',
      JSON.parse(await readFile(backupFile, 'utf8')),
    );
    boot = await restoredApi.boot();
    check(
      'a backup that holds a removal does not remove a record this workspace holds',
      overRecords.status === 201 &&
        boot.workItems.some((item) => item.id === mistakeItem.id) &&
        boot.repositories.some((item) => item.id === movingId) &&
        boot.removed.workItems.length === 0 &&
        boot.removed.repositories.length === 0,
      refusal(overRecords).slice(0, 200),
    );

    // A root the backup brought from another machine can go, without approving it first.
    await restorePage.getByRole('button', { name: 'Done' }).click();
    await restorePage.getByRole('button', { name: 'Roots', exact: true }).click();
    const restoredExplorer = restorePage.getByRole('dialog', {
      name: 'Inspect local review policy',
    });
    await restoredExplorer.getByRole('button', { name: 'Remove Old drive' }).click();
    check(
      'a restored root can be removed, with the repositories only it covers',
      await restoredExplorer.getByRole('checkbox', { name: 'old', exact: true }).isChecked(),
    );
    await restoredExplorer.getByLabel('Why it is removed').fill('From another machine.');
    await restoredExplorer.getByRole('button', { name: 'Remove this root' }).click();
    await restoredExplorer.getByText(/Removed Old drive/u).waitFor();
    boot = await restoredApi.boot();
    check(
      'it leaves as a removed root that was never approved here',
      boot.removed.roots.some((root) => root.label === 'Old drive' && root.status === 'pending') &&
        boot.removed.repositories.some((repository) => repository.id === oldId),
    );
    await restoring.close();

    // The new backup into an empty workspace: removed records stay removed, and the preview lists them apart.
    const newDir = path.join(work, 'data-from-new');
    server = await restart(server, newDir);
    const second = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const secondPage = await second.newPage();
    secondPage.setDefaultTimeout(30_000);
    await secondPage.goto(url, { waitUntil: 'networkidle' });
    await secondPage.getByRole('button', { name: 'Restore a backup' }).click();
    await secondPage
      .getByLabel('Choose a VeriDone workspace JSON backup')
      .setInputFiles(backupFile);
    await secondPage.getByLabel('Restore preview').getByText('Removed records').waitFor();
    await shot(secondPage, '6-restore-preview');
    await secondPage.getByRole('button', { name: 'Restore these records' }).click();
    await secondPage.getByText(/approve restored roots under Roots/u).waitFor();
    const newApi = client(url);
    boot = await newApi.boot();
    check(
      'removed records stay removed in a workspace restored from a new backup',
      boot.removed.workItems.some((item) => item.id === mistakeItem.id) &&
        boot.removed.repositories.some((item) => item.id === movingId) &&
        !boot.workItems.some((item) => item.id === mistakeItem.id),
    );
    await second.close();

    // The last work item leaving must not strand the operator.
    const emptying = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const emptyPage = await emptying.newPage();
    emptyPage.setDefaultTimeout(30_000);
    boot = await newApi.boot();
    for (const item of boot.workItems) {
      await newApi.post(`/api/v1/work-items/${item.id}/remove`, {
        reason: 'Clearing the inbox.',
        expected: { claimHash: item.claimHash },
      });
    }
    await emptyPage.goto(url, { waitUntil: 'networkidle' });
    await emptyPage.getByRole('heading', { name: 'Nothing to review' }).waitFor();
    await shot(emptyPage, '7-empty-inbox');
    await emptyPage.getByRole('button', { name: 'Open workspace explorer' }).click();
    const emptyExplorer = emptyPage.getByRole('dialog', { name: 'Inspect local review policy' });
    await emptyExplorer.getByRole('button', { name: `Put back ${titles.accepted}` }).click();
    await emptyExplorer.getByText(`${titles.accepted} is back.`).waitFor();
    await emptyExplorer.getByRole('button', { name: 'Close workspace explorer' }).click();
    await emptyPage.getByRole('heading', { name: titles.accepted }).waitFor();
    check('an empty inbox reaches what was removed, and a work item comes back', true);
    await emptying.close();

    // A phone: the forms stay usable, with no sideways scroll.
    const phone = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const phonePage = await phone.newPage();
    phonePage.setDefaultTimeout(30_000);
    await phonePage.goto(`${url}/?review=${acceptedItem.id}`, { waitUntil: 'networkidle' });
    await phonePage.getByRole('button', { name: new RegExp(titles.accepted, 'u') }).click();
    await phonePage.getByRole('button', { name: 'Remove work item' }).click();
    await phonePage.getByRole('dialog', { name: 'Remove this work item' }).waitFor();
    const overflow = await phonePage.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check('the removal form fits a phone', overflow <= 0, `${overflow}px wider`);
    await shot(phonePage, '8-phone-remove');
    await phonePage.getByRole('button', { name: 'Keep it' }).click();
    await phonePage.getByRole('button', { name: 'Manage checks' }).click();
    const phoneExplorer = phonePage.getByRole('dialog', { name: 'Inspect local review policy' });
    await phoneExplorer.getByRole('tab', { name: 'Removed' }).click();
    await phoneExplorer
      .getByRole('button', { name: /^Put back/u })
      .first()
      .waitFor();
    check(
      'the Removed list opens on a phone, and the dialog stays in place',
      await phoneExplorer.evaluate(
        (dialog) => dialog.scrollLeft === 0 && dialog.scrollWidth <= dialog.clientWidth,
      ),
    );
    await shot(phonePage, '9-phone-removed');
    await phone.close();

    check(
      'no page error, console error or server error along the way',
      problems.length === 0,
      problems.slice(0, 5).join(' || ').slice(0, 600),
    );

    // Going back a release: the old build opens the workspace, and the new one still knows what was removed.
    await server.stop();
    await waitForFreePorts([webPort, apiPort]);
    const rolledBack = await startApi(before, dataDir);
    const rollback = client(rolledBack.base);
    const rolledBackBoot = rolledBack.health ? await rollback.boot() : null;
    check(
      `${releaseBefore} still opens the migrated workspace and shows every record`,
      rolledBackBoot?.workItems.some((item) => item.id === mistakeItem.id) === true &&
        rolledBackBoot?.repositories.some((item) => item.id === movingId) === true,
      rolledBack.output().slice(-200),
    );
    await rolledBack.stop();
    server = launch(dataDir);
    await waitUntilUp(url, server);
    boot = await client(url).boot();
    check(
      'back on this build, the removals stand',
      boot.removed.workItems.some((item) => item.id === mistakeItem.id) &&
        boot.removed.repositories.some((item) => item.id === movingId),
    );

    check(
      'the fixtures are untouched',
      (await git(appPath, 'status', '--porcelain')) === '' &&
        (await git(movingPath, 'status', '--porcelain')) === '',
    );
  } finally {
    await browser.close();
  }
});
