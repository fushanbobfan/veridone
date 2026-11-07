// First-workspace walk (ACCEPTANCE REL-01): a real browser takes the built app through a real public repository, from an
// empty workspace to a packet that verifies. Its workspaces, packets and screenshots stay in one folder under the walk
// root.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  check,
  checkArgs,
  clonePublicRepository,
  cloneUnderTest,
  findPython,
  fresh,
  git,
  launchChromium,
  reservePort,
  runWalk,
  startService,
  verifyPacket,
  waitForFreePorts,
  walkOptions,
  writeReceipt,
} from './walk-lib.mjs';

// The approved root's folder name. No redaction may leave it in a packet, on any machine.
const rootMarker = 'walk-approved-root';

/** Every way a packet could write this run's local paths, in lower case. */
function localPathForms(localPaths) {
  const words = [rootMarker];
  // The home folder's name alone counts too, unless packets use the word: CI's user is `runner`, and they have a
  // `runner` field.
  const user = path.basename(os.homedir()).toLowerCase();
  if (user.length >= 5 && user !== 'runner') words.push(user);
  const forms = new Set();
  for (const localPath of localPaths) {
    const parts = localPath
      .toLowerCase()
      .split(/[\\/]+/u)
      .filter(Boolean);
    const drive = /^[a-z]:$/u.test(parts[0] ?? '') ? parts.shift()[0] : null;
    if (drive) words.push(`${drive}%3a`);
    for (const separator of ['/', '\\', '\\\\', '%2f', '%5c']) {
      // Each tail of two folders or more: a redaction that stops partway shows, whatever it leaves in front.
      for (let start = 0; start < parts.length - 1; start += 1) {
        forms.add(parts.slice(start).join(separator));
      }
      // Each ancestor from its start: a path beside this one shows too, as C:\x, /c/x, /mnt/c/x, or /home/me/x.
      for (let end = drive ? 1 : 2; end < parts.length; end += 1) {
        const ancestor = parts.slice(0, end).join(separator);
        if (drive) forms.add(`${drive}:${separator}${ancestor}`);
        forms.add(`${separator}${drive ? `${drive}${separator}` : ''}${ancestor}`);
      }
    }
  }
  // A shorter path could turn up by chance in a signature's base64.
  return [...words, ...[...forms].filter((form) => form.length >= 6)];
}

async function waitUntilUp(url, service) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && service.running()) {
    try {
      const response = await fetch(`${url}/api/v1/bootstrap`);
      if (response.ok) return true;
    } catch {
      // Both processes may not be listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

await runWalk('FIRST WORKSPACE WALK', async () => {
  const { root, ref } = await walkOptions();
  const pythonPath = await findPython();
  const browser = await launchChromium();
  try {
    const clone = await cloneUnderTest(root, ref);
    const work = path.join(root, 'walk-first-workspace');
    const repoRoot = path.join(work, rootMarker);
    const dataDir = path.join(work, 'data');
    const tempDir = path.join(work, 'tmp');
    const receipt = path.join(repoRoot, 'receipt.json');
    await fresh(work);
    await mkdir(repoRoot, { recursive: true });
    await mkdir(tempDir, { recursive: true });
    const repository = await clonePublicRepository(repoRoot, 'ai-eval-micro-lab');
    const decoy = await clonePublicRepository(repoRoot, 'useful-automation-lab');
    await writeReceipt(receipt, 'release-walk-first-workspace');
    const head = await git(repository, 'rev-parse', 'HEAD');

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
    let server = launch(dataDir);
    const shot = (page, name) =>
      page.screenshot({ path: path.join(work, `${name}.png`), fullPage: true });

    const up = await waitUntilUp(url, server);
    if (!check('the built app starts on the documented command', up, server.output().slice(-300))) {
      throw new Error('not up');
    }
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1360, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const problems = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        problems.push(
          `console: ${message.text().replace(/base64,[A-Za-z0-9+/=]+/gu, 'base64,...')}`,
        );
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 500) problems.push(`${response.status()} ${response.url()}`);
    });

    const connectSource = async (kind, sourcePath) => {
      await page.getByRole('button', { name: /add (first )?source/i }).click();
      await page.getByText(kind, { exact: true }).click();
      if (kind === 'Git repository') {
        await page.getByRole('button', { name: 'Discover repositories' }).click();
        await page.getByLabel('Discovered repository').selectOption(sourcePath);
      } else {
        await page.getByLabel('Absolute local path').fill(sourcePath);
      }
      if (kind === 'Approved root') await page.getByLabel(/label/i).fill('Walk repositories');
      if (kind === 'Agent receipt') {
        await page.getByRole('button', { name: 'Preview import' }).click();
        await page
          .getByLabel('Validated receipt preview')
          .getByText('1 receipt validated')
          .waitFor();
        await page.getByRole('button', { name: 'Import 1' }).click();
      } else {
        await page.getByRole('button', { name: 'Connect source' }).click();
      }
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
    };

    await page.goto(url);
    await page.getByRole('heading', { name: 'No evidence sources yet' }).waitFor();
    check('an empty workspace opens on its first page', true);
    await connectSource('Approved root', repoRoot);
    await connectSource('Git repository', repository);
    await connectSource('Git repository', decoy);
    await connectSource('Agent receipt', receipt);
    check('a root, two repositories and a receipt connect', true);

    await page.getByRole('heading', { name: /implementation · release-walk/i }).waitFor();
    await page.getByRole('button', { name: 'Link to repository' }).click();
    await page.getByRole('heading', { name: 'Link to a repository' }).waitFor();
    check(
      'linking starts with no repository chosen',
      await page.getByRole('button', { name: 'Link current snapshot' }).isDisabled(),
    );
    await page
      .getByRole('combobox', { name: 'Repository' })
      .selectOption({ label: `ai-eval-micro-lab — main @ ${head.slice(0, 12)}` });
    const snapshot = await page.getByLabel('Selected repository snapshot').innerText();
    check('the dialog shows the commit it will bind', snapshot.includes(head));
    await page.getByRole('button', { name: 'Link current snapshot' }).click();

    await page.getByRole('button', { name: 'Approve a check' }).click();
    await page.getByLabel('Label').fill('AI Eval Micro Lab test suite');
    await page.getByLabel('Executable').fill(pythonPath);
    await page.getByLabel('Literal argument array').fill(JSON.stringify(checkArgs));
    await page.getByRole('button', { name: 'Approve definition' }).click();

    await page.getByRole('button', { name: 'Checks', exact: true }).click();
    const explorer = page.getByRole('dialog', { name: 'Inspect local review policy' });
    await explorer.getByText('AI Eval Micro Lab test suite').waitFor();
    await explorer.getByText('Pinned tool').waitFor();
    check('approval pins the tool', (await explorer.getByText(/not pinned/u).count()) === 0);
    await shot(page, '1-checks');
    await explorer.getByRole('button', { name: 'Close workspace explorer' }).click();

    await page.getByRole('button', { name: 'Run approved checks' }).click();
    await page.getByText('All required evidence is current').waitFor({ timeout: 180_000 });
    check(
      'the check runs and the gate opens',
      await page.getByRole('button', { name: 'Accept work' }).isEnabled(),
    );
    await shot(page, '2-evidence');

    await page.getByRole('button', { name: 'Accept work' }).click();
    // A note can name local paths, and these give the packet scan below something to catch if redaction stops working.
    const homeNotes = path.join(os.homedir(), 'walk-notes.txt');
    await page
      .getByLabel('Decision note')
      .fill(`Reviewed ${repository} with ${pythonPath}. Notes are in ${homeNotes}.`);
    await shot(page, '3-verdict-dialog');
    await page.getByRole('button', { name: 'Record acceptance' }).click();
    await page
      .getByText(/^accepted$/i)
      .first()
      .waitFor();
    check('the verdict records', true);
    await shot(page, '4-accepted');

    const htmlDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export packet' }).click();
    const htmlFile = path.join(work, 'packet.html');
    await (await htmlDownload).saveAs(htmlFile);

    await page.getByRole('button', { name: 'Open workspace backup and restore' }).click();
    const keyDownload = page.waitForEvent('download');
    await page.getByRole('link', { name: /packet signing key/i }).click();
    const keyFile = path.join(work, 'signing-key.pem');
    await (await keyDownload).saveAs(keyFile);
    const backupDownload = page.waitForEvent('download');
    await page.getByRole('link', { name: /export verified json/i }).click();
    const backupFile = path.join(work, 'backup.json');
    await (await backupDownload).saveAs(backupFile);
    check('the packet, the signing key and a backup download', true);

    const bootstrap = await (await page.request.get(`${url}/api/v1/bootstrap`)).json();
    const workItem = bootstrap.workItems[0];
    const jsonFile = path.join(work, 'packet.json');
    const mdFile = path.join(work, 'packet.md');
    const packetRoute = `${url}/api/v1/work-items/${workItem.id}/packet`;
    const packetText = await (await page.request.get(`${packetRoute}/json`)).text();
    await writeFile(jsonFile, packetText);
    await writeFile(mdFile, await (await page.request.get(`${packetRoute}/md`)).text());
    const packet = JSON.parse(packetText);

    const verified = await verifyPacket(clone, jsonFile, keyFile);
    check(
      'the packet verifies against the workspace key',
      verified.code === 0 && /trusted key/u.test(verified.output),
      verified.output.split('\n').at(-1),
    );
    const tampered = structuredClone(packet);
    tampered.workItem.claim = `${tampered.workItem.claim} `;
    const tamperedFile = path.join(work, 'tampered.json');
    await writeFile(tamperedFile, JSON.stringify(tampered));
    const refused = await verifyPacket(clone, tamperedFile, keyFile);
    check(
      'a changed packet fails verification',
      refused.code !== 0,
      refused.output.split('\n').at(-1),
    );

    const evidence = packet.evidence.at(-1);
    check(
      'the packet names the check and its tool hash',
      packet.checks?.length === 1 &&
        /^[0-9a-f]+$/iu.test(
          String(packet.checks[0].toolSha256 ?? packet.checks[0].executableSha256 ?? 'x'),
        ),
      JSON.stringify(packet.checks?.[0]).slice(0, 320),
    );
    check(
      'the packet gives the test counts pytest printed',
      Boolean(evidence.testCounts?.passed),
      JSON.stringify(evidence.testCounts),
    );
    check(
      'the evidence came from a clean checkout',
      evidence.isolation === 'clean-checkout',
      String(evidence.isolation),
    );
    check('the packet carries the commit it binds', evidence.head === head);

    const forms = localPathForms([
      root,
      clone,
      repository,
      pythonPath,
      path.dirname(pythonPath),
      os.homedir(),
      os.tmpdir(),
    ]);
    for (const [name, file] of [
      ['JSON', jsonFile],
      ['Markdown', mdFile],
      ['HTML', htmlFile],
    ]) {
      const text = (await readFile(file, 'utf8')).toLowerCase();
      const hits = forms.filter((form) => text.includes(form));
      check(`the ${name} packet holds no local path`, hits.length === 0, hits.join(' | '));
    }

    check(
      'no page error, console error or server error along the way',
      problems.length === 0,
      problems.slice(0, 5).join(' || ').slice(0, 600),
    );
    check(
      'the repository is untouched',
      (await git(repository, 'status', '--porcelain')) === '' &&
        (await git(repository, 'rev-parse', 'HEAD')) === head,
    );
    // veridone-git-* is the running process's own empty Git home, removed when it exits.
    const leftovers = (await readdir(tempDir)).filter((name) =>
      name.startsWith('veridone-checkout-'),
    );
    check(
      'no checkout is left in the temporary directory',
      leftovers.length === 0,
      leftovers.join(', '),
    );

    await page.goto(pathToFileURL(htmlFile).href);
    await shot(page, '5-packet');
    await context.close();

    // A restart reads the same workspace.
    await server.stop();
    await waitForFreePorts([webPort, apiPort]);
    server = launch(dataDir);
    check('the app starts again on the same workspace', await waitUntilUp(url, server));
    const after = await (await fetch(`${url}/api/v1/bootstrap`)).json();
    check(
      'the verdict and the evidence survive a restart',
      after.verdicts.length === 1 &&
        after.evidence.length === 1 &&
        after.readiness[workItem.id].ready === true,
    );

    // That backup restores into an empty workspace from its first screen, and the dialog says what comes next.
    await server.stop();
    await waitForFreePorts([webPort, apiPort]);
    server = launch(path.join(work, 'data-restored'));
    check('a new workspace starts', await waitUntilUp(url, server));
    const restoreContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const restorePage = await restoreContext.newPage();
    restorePage.setDefaultTimeout(30_000);
    const restoreProblems = [];
    restorePage.on('pageerror', (error) => restoreProblems.push(`pageerror: ${error.message}`));
    restorePage.on('console', (message) => {
      if (message.type() === 'error') {
        restoreProblems.push(`console: ${message.text().slice(0, 200)}`);
      }
    });
    await restorePage.goto(url, { waitUntil: 'networkidle' });
    await restorePage.getByRole('button', { name: 'Restore a backup' }).click();
    await restorePage
      .getByLabel('Choose a VeriDone workspace JSON backup')
      .setInputFiles(backupFile);
    await restorePage.getByRole('button', { name: 'Restore these records' }).click();
    const told = await restorePage
      .getByText(/approve restored roots under Roots/u)
      .waitFor()
      .then(() => true)
      .catch(() => false);
    check(
      'a backup restores into an empty workspace from its first screen, and says what comes next',
      told,
    );
    await shot(restorePage, '6-restored');
    const restoredState = await (await fetch(`${url}/api/v1/bootstrap`)).json();
    check(
      'the restored workspace holds the work item and its verdict',
      restoredState.workItems.length === 1 && restoredState.verdicts.length === 1,
    );
    check(
      'no error along the restore',
      restoreProblems.length === 0,
      restoreProblems.slice(0, 3).join(' || '),
    );
    await restoreContext.close();
  } finally {
    await browser.close();
  }
});
