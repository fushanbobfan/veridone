// Dead-end walk: the stuck states v1.2.0 removed are walked to a recorded decision or a working workspace, through the API.
// A workspace from the real v1.1.0 build is used wherever the state comes from an upgrade.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  check,
  client,
  cloneUnderTest,
  execFileAsync,
  fresh,
  preparedClone,
  previousRelease,
  runWalk,
  startApi,
  stopServices,
  verifyPacket,
  walkOptions,
  writeReceipt,
} from './walk-lib.mjs';

const windows = process.platform === 'win32';
const rawError = /ENOENT|EACCES|UNIQUE constraint|SQLITE|invalid_request|ZodError|realpath/u;
const message = (response) =>
  String(response.json?.message ?? response.json?.error ?? response.text).slice(0, 200);
const plain = (response) => !rawError.test(response.text);
const nextStep = (response, pattern) => pattern.test(message(response));

async function git(cwd, ...args) {
  return execFileAsync(
    'git',
    ['-c', 'user.name=Walk', '-c', 'user.email=walk@example.invalid', ...args],
    { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
}
async function makeRepo(directory, files) {
  await mkdir(directory, { recursive: true });
  await git(directory, 'init', '-q', '-b', 'main');
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await git(directory, 'add', '-A');
  await git(directory, 'commit', '-q', '-m', 'Initial commit');
}
const plainTest = {
  'package.json': '{"name":"walk","private":true}\n',
  'test/a.test.js': "require('node:test')('plain', () => {});\n",
};
const needsDep = {
  'package.json': '{"name":"walk","private":true}\n',
  '.gitignore': 'node_modules/\n',
  'test/a.test.js':
    "require('node:test')('dep', () => { require('node:assert').equal(require('dep'), 42); });\n",
};
const install =
  "const f=require('node:fs');f.mkdirSync('node_modules/dep',{recursive:true});f.writeFileSync('node_modules/dep/index.js','module.exports = 42;')";
const definition = (repositoryId, label, executable, args, extra = {}) => ({
  repositoryId,
  label,
  kind: 'test',
  executable,
  args,
  cwdRelative: '.',
  timeoutMs: 60_000,
  maxOutputBytes: 1_000_000,
  ...extra,
});

/** Approves a root and a repository, imports a receipt, and binds its work item. */
async function bring(api, rootPath, repositoryPath, runId) {
  await api.boot();
  const boot = await api.boot();
  if (!boot.roots.some((entry) => entry.path === rootPath)) {
    await api.post('/api/v1/roots', { path: rootPath, label: path.basename(rootPath) });
  }
  const repository = await api.post('/api/v1/repositories', { path: repositoryPath });
  const receipt = path.join(rootPath, `${runId}.json`);
  await writeReceipt(receipt, runId);
  await api.post('/api/v1/receipts/import', { path: receipt });
  await rm(receipt, { force: true });
  const after = await api.boot();
  const item = after.workItems.find((entry) => entry.sourceRef.endsWith(`:${runId}`));
  await api.post(`/api/v1/work-items/${item.id}/link`, {
    repositoryId: repository.json.repository.id,
  });
  return { repositoryId: repository.json.repository.id, workItemId: item.id };
}
async function rebind(api, repositoryId, workItemId) {
  await api.post(`/api/v1/repositories/${repositoryId}/refresh`, {});
  return api.post(`/api/v1/work-items/${workItemId}/link`, { repositoryId });
}
async function decide(api, repositoryId, workItemId, decision, note, overrideReason = null) {
  const boot = await api.boot();
  const repository = boot.repositories.find((entry) => entry.id === repositoryId);
  const verdicts = boot.verdicts
    .filter((entry) => entry.workItemId === workItemId)
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  const item = boot.workItems.find((entry) => entry.id === workItemId);
  return api.post(`/api/v1/work-items/${workItemId}/verdicts`, {
    decision,
    note,
    overrideReason,
    expected: {
      fingerprint: repository?.snapshot.fingerprint ?? null,
      verdictId: verdicts.at(-1)?.id ?? null,
      claimHash: item.claimHash,
    },
  });
}
const retire = (api, checkRecord, reason) =>
  api.post(`/api/v1/checks/${checkRecord.id}/retire`, {
    reason,
    expected: { definitionHash: checkRecord.definitionHash },
  });
const findCheck = async (api, id) => (await api.boot()).checks.find((entry) => entry.id === id);
const gate = async (api, workItemId) => (await api.boot()).readiness[workItemId];

async function scenario(name, body) {
  console.log(`--- ${name}`);
  try {
    await body();
  } catch (error) {
    check(`${name} ran to its end`, false, String(error?.message ?? error).slice(0, 200));
  }
  await stopServices();
}

await runWalk('DEAD-END WALK', async () => {
  const { root, ref } = await walkOptions();
  const newClone = await cloneUnderTest(root, ref);
  const oldClone = await preparedClone(root, previousRelease);
  const work = path.join(root, 'walk-dead-ends');
  await fresh(work);

  await scenario('A. v1.1.0 check that relies on installed dependencies', async () => {
    const rootPath = path.join(work, 'a-root');
    const repositoryPath = path.join(rootPath, 'deps');
    await makeRepo(repositoryPath, needsDep);
    await mkdir(path.join(repositoryPath, 'node_modules', 'dep'), { recursive: true });
    await writeFile(
      path.join(repositoryPath, 'node_modules', 'dep', 'index.js'),
      'module.exports = 42;\n',
    );
    const dataDir = path.join(work, 'a-data');
    const oldServer = await startApi(oldClone, dataDir);
    const oldApi = client(oldServer.base);
    const { repositoryId, workItemId } = await bring(oldApi, rootPath, repositoryPath, 'walk-a');
    const oldCheck = await oldApi.post(
      '/api/v1/checks',
      definition(repositoryId, 'Unit tests', 'node', ['--test']),
    );
    await rebind(oldApi, repositoryId, workItemId);
    const oldRun = await oldApi.post(`/api/v1/checks/${oldCheck.json.check.id}/run`, {
      workItemId,
    });
    check('v1.1.0 passes it in the work tree', oldRun.json?.evidence?.result === 'passed');
    await oldServer.stop();

    const server = await startApi(newClone, dataDir);
    const api = client(server.base);
    await api.boot();
    const id = oldCheck.json.check.id;
    const tool = await api.get(`/api/v1/checks/${id}/tool`);
    await api.post(`/api/v1/checks/${id}/pin`, { expected: tool.json.tool });
    await rebind(api, repositoryId, workItemId);
    const failed = await api.post(`/api/v1/checks/${id}/run`, { workItemId });
    check('the same check fails in the clean checkout', failed.json?.evidence?.result === 'failed');
    const output = await api.get(`/api/v1/evidence/${failed.json?.evidence?.id}/output`);
    check(
      'the operator can read why',
      output.status === 200 &&
        /Cannot find module/u.test(`${output.json?.stdout}${output.json?.stderr}`),
      `${output.status}`,
    );

    const stale = await api.post(`/api/v1/checks/${id}/replace`, {
      check: definition(repositoryId, 'Unit tests with install', 'node', ['--test'], {
        setupArgs: ['-e', install],
      }),
      reason: 'A stale view.',
      expected: { definitionHash: 'a'.repeat(64) },
    });
    check(
      'a replacement from a stale view changes nothing',
      stale.status === 409 && (await api.boot()).checks.length === 1,
      `${stale.status}`,
    );
    const replacement = await api.post(`/api/v1/checks/${id}/replace`, {
      check: definition(repositoryId, 'Unit tests with install', 'node', ['--test'], {
        setupArgs: ['-e', install],
      }),
      reason: 'It needs a setup step in the clean checkout.',
      expected: { definitionHash: (await findCheck(api, id)).definitionHash },
    });
    check(
      'the replacement approves the new check and retires the old one in one step',
      replacement.status === 201 && Boolean(replacement.json?.retired?.retiredAt),
      message(replacement),
    );
    await rebind(api, repositoryId, workItemId);
    const passed = await api.post(`/api/v1/checks/${replacement.json?.check?.id}/run`, {
      workItemId,
    });
    check(
      'the replacement passes',
      passed.json?.evidence?.result === 'passed',
      passed.json?.evidence?.result ?? message(passed),
    );
    check(
      'the gate counts the replacement alone',
      passed.json?.readiness?.ready === true && passed.json?.readiness?.checkCount === 1,
      JSON.stringify(passed.json?.readiness?.checks),
    );
    const accepted = await decide(
      api,
      repositoryId,
      workItemId,
      'accepted',
      'Accepted after replacing the check.',
    );
    check('a plain acceptance records', accepted.status === 201, message(accepted));

    const boot = await api.boot();
    check(
      'the old check stays listed as retired',
      Boolean(boot.checks.find((entry) => entry.id === id)?.retiredAt),
    );
    check(
      'its failed run stays in the history',
      boot.evidence.some((entry) => entry.checkId === id && entry.result === 'failed'),
    );
    const packet = await api.get(`/api/v1/work-items/${workItemId}/packet/json`);
    const listed = packet.json?.checks?.find((entry) => entry.id === id);
    check(
      'the packet shows the retirement and its reason',
      Boolean(listed?.retiredAt) && /setup step/u.test(listed?.retiredReason ?? ''),
      JSON.stringify(listed?.retiredReason),
    );
    const markdown = await api.get(`/api/v1/work-items/${workItemId}/packet/md`);
    const html = await api.get(`/api/v1/work-items/${workItemId}/packet/html`);
    check(
      'the readable packets show it too',
      /retired/iu.test(markdown.text) && /retired/iu.test(html.text),
    );
    const key = await api.get('/api/v1/workspace/signing-key');
    const packetFile = path.join(work, 'a-packet.json');
    const keyFile = path.join(work, 'a-key.pem');
    await writeFile(packetFile, packet.text);
    await writeFile(keyFile, key.text);
    check('the packet verifies', (await verifyPacket(newClone, packetFile, keyFile)).code === 0);
    await server.stop();
  });

  await scenario('B. v1.1.0 checks whose tool cannot be pinned', async () => {
    const rootPath = path.join(work, 'b-root');
    const repositoryPath = path.join(rootPath, 'forms');
    await makeRepo(repositoryPath, plainTest);
    // Pinning refuses this file for where it lies, so it is never started.
    const toolName = windows ? 'tool.exe' : 'tool';
    await mkdir(path.join(repositoryPath, 'tools'), { recursive: true });
    await writeFile(path.join(repositoryPath, 'tools', toolName), '#!/bin/sh\n', { mode: 0o755 });
    await git(repositoryPath, 'add', '-A');
    await git(repositoryPath, 'commit', '-q', '-m', 'Add a tool');
    const dataDir = path.join(work, 'b-data');
    const oldServer = await startApi(oldClone, dataDir);
    const oldApi = client(oldServer.base);
    const { repositoryId, workItemId } = await bring(oldApi, rootPath, repositoryPath, 'walk-b');
    const forms = [
      ['a relative path', `tools/${toolName}`],
      ['a tool inside the repository', path.join(repositoryPath, 'tools', toolName)],
      // On Windows npm is a .cmd, which needs a shell. Elsewhere it is an ordinary tool that pins.
      ...(windows ? [['a .cmd on Windows', 'npm']] : []),
      ['a command that is not installed', 'this-tool-is-not-installed'],
    ];
    const ids = [];
    for (const [label, executable] of forms) {
      const created = await oldApi.post(
        '/api/v1/checks',
        definition(repositoryId, label, executable, []),
      );
      ids.push([label, created.json.check.id]);
    }
    await oldServer.stop();

    const server = await startApi(newClone, dataDir);
    const api = client(server.base);
    await api.boot();
    for (const [label, id] of ids) {
      const tool = await api.get(`/api/v1/checks/${id}/tool`);
      check(
        `pinning ${label} is refused and names the way out`,
        tool.status === 400 && nextStep(tool, /replace|retire/iu),
        message(tool),
      );
    }
    await rebind(api, repositoryId, workItemId);
    const refused = await api.post(`/api/v1/checks/${ids[0][1]}/run`, { workItemId });
    check(
      'running one is refused and names the way out',
      refused.status === 400 && nextStep(refused, /replace|retire/iu),
      message(refused),
    );
    const replacement = await api.post(
      '/api/v1/checks',
      definition(repositoryId, 'Outside tool', 'node', ['--test']),
    );
    for (const [label, id] of ids) {
      const retired = await retire(api, await findCheck(api, id), `It cannot be pinned: ${label}.`);
      check(`${label} retires`, retired.status === 200, message(retired));
    }
    await rebind(api, repositoryId, workItemId);
    const run = await api.post(`/api/v1/checks/${replacement.json.check.id}/run`, { workItemId });
    check(
      'the gate opens with the outside tool',
      run.json?.readiness?.ready === true,
      JSON.stringify(run.json?.readiness?.checks),
    );
    check(
      'a plain acceptance records',
      (await decide(api, repositoryId, workItemId, 'accepted', 'Accepted.')).status === 201,
    );
    await server.stop();
  });

  await scenario(
    'C. A fresh workspace: a check approved with a typo, and what retiring may not do',
    async () => {
      const rootPath = path.join(work, 'c-root');
      const repositoryPath = path.join(rootPath, 'typo');
      await makeRepo(repositoryPath, plainTest);
      const server = await startApi(newClone, path.join(work, 'c-data'));
      const api = client(server.base);
      const { repositoryId, workItemId } = await bring(api, rootPath, repositoryPath, 'walk-c');
      const typo = await api.post(
        '/api/v1/checks',
        definition(repositoryId, 'Typo', 'node', ['--tset']),
      );
      const fixed = await api.post(
        '/api/v1/checks',
        definition(repositoryId, 'Fixed', 'node', ['--test']),
      );
      await rebind(api, repositoryId, workItemId);
      await api.post(`/api/v1/checks/${typo.json.check.id}/run`, { workItemId });
      const fixedRun = await api.post(`/api/v1/checks/${fixed.json.check.id}/run`, { workItemId });
      check(
        'one bad check holds the gate',
        fixedRun.json?.readiness?.ready === false && fixedRun.json?.readiness?.passingCount === 1,
      );

      const noReason = await api.post(`/api/v1/checks/${typo.json.check.id}/retire`, {
        reason: '',
        expected: { definitionHash: typo.json.check.definitionHash },
      });
      check('retiring needs a reason', noReason.status === 400);
      const staleView = await api.post(`/api/v1/checks/${typo.json.check.id}/retire`, {
        reason: 'Typo.',
        expected: { definitionHash: 'a'.repeat(64) },
      });
      check(
        'retiring refuses a definition the operator did not see',
        staleView.status === 409,
        `${staleView.status}`,
      );
      const retired = await retire(
        api,
        await findCheck(api, typo.json.check.id),
        'Typo in the arguments.',
      );
      check('the check retires', retired.status === 200, message(retired));
      const again = await retire(api, await findCheck(api, typo.json.check.id), 'Again.');
      check('it cannot retire twice', again.status === 409, `${again.status}`);
      const retiredRun = await api.post(`/api/v1/checks/${typo.json.check.id}/run`, { workItemId });
      check(
        'a retired check refuses to run',
        retiredRun.status === 400 && nextStep(retiredRun, /retired/iu),
        message(retiredRun),
      );

      let readiness = await gate(api, workItemId);
      check(
        'retiring opens no gate by itself',
        readiness.ready === false,
        `binding fresh ${readiness.bindingFresh}, passing ${readiness.passingCount}`,
      );
      check(
        'a plain acceptance is still refused',
        (await decide(api, repositoryId, workItemId, 'accepted', 'Too early.')).status === 409,
      );
      await rebind(api, repositoryId, workItemId);
      readiness = await gate(api, workItemId);
      check(
        'after rebinding, the earlier run no longer counts',
        readiness.ready === false,
        `passing ${readiness.passingCount}`,
      );
      const rerun = await api.post(`/api/v1/checks/${fixed.json.check.id}/run`, { workItemId });
      check('a new run under the new set opens the gate', rerun.json?.readiness?.ready === true);
      check(
        'a plain acceptance records',
        (await decide(api, repositoryId, workItemId, 'accepted', 'Accepted.')).status === 201,
      );

      const retiredLast = await retire(
        api,
        await findCheck(api, fixed.json.check.id),
        'Testing the empty set.',
      );
      check('the last check can retire', retiredLast.status === 200);
      await rebind(api, repositoryId, workItemId);
      readiness = await gate(api, workItemId);
      check(
        'with no check left the gate stays closed',
        readiness.ready === false && readiness.checkCount === 0,
        `count ${readiness.checkCount}`,
      );
      check(
        'accepting then needs an override reason',
        (await decide(api, repositoryId, workItemId, 'accepted', 'No checks.')).status === 409,
      );

      const backup = await api.get('/api/v1/workspace/export');
      await server.stop();
      const other = await startApi(newClone, path.join(work, 'c-data-restored'));
      const otherApi = client(other.base);
      await otherApi.boot();
      const restored = await otherApi.post('/api/v1/workspace/import', backup.json);
      check('the backup restores', restored.status === 201, message(restored));
      const restoredChecks = (await otherApi.boot()).checks;
      check(
        'retired checks stay retired after a restore',
        restoredChecks.filter((entry) => entry.retiredAt).length === 2 &&
          restoredChecks.some((entry) => /Typo/u.test(entry.retiredReason ?? '')),
      );
      await other.stop();
    },
  );

  await scenario('D. An approved root folder goes away', async () => {
    const rootA = path.join(work, 'd-root-a');
    const rootB = path.join(work, 'd-root-b');
    const repositoryA = path.join(rootA, 'a');
    const repositoryB = path.join(rootB, 'b');
    await makeRepo(repositoryA, plainTest);
    await makeRepo(repositoryB, plainTest);
    const server = await startApi(newClone, path.join(work, 'd-data'));
    const api = client(server.base);
    const a = await bring(api, rootA, repositoryA, 'walk-da');
    const b = await bring(api, rootB, repositoryB, 'walk-db');
    const checkB = await api.post(
      '/api/v1/checks',
      definition(b.repositoryId, 'B tests', 'node', ['--test']),
    );
    await rm(rootA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const refreshed = await api.post(`/api/v1/repositories/${b.repositoryId}/refresh`, {});
    check('the other root keeps refreshing', refreshed.status === 200, message(refreshed));
    await api.post(`/api/v1/work-items/${b.workItemId}/link`, { repositoryId: b.repositoryId });
    const run = await api.post(`/api/v1/checks/${checkB.json.check.id}/run`, {
      workItemId: b.workItemId,
    });
    check(
      'the other root keeps running checks',
      run.json?.evidence?.result === 'passed',
      run.json?.evidence?.result ?? message(run),
    );
    check(
      'the other root keeps recording verdicts',
      (await decide(api, b.repositoryId, b.workItemId, 'accepted', 'Accepted.')).status === 201,
    );
    const again = await api.post('/api/v1/repositories', { path: repositoryB });
    check('adding a repository works', again.status === 201, message(again));
    const boot = await api.boot();
    check(
      'the missing root is marked',
      boot.roots.find((entry) => entry.path === rootA)?.missing === true,
    );
    const issue = boot.sourceIssues.find((entry) => entry.repositoryId === a.repositoryId);
    check(
      'the issue reads in plain words',
      Boolean(issue) && !rawError.test(issue.message),
      issue?.message?.slice(0, 200),
    );
    const missingDiscover = await api.post('/api/v1/repositories/discover', {
      rootId: boot.roots.find((entry) => entry.path === rootA).id,
    });
    check(
      'discovery on it answers in plain words',
      missingDiscover.status >= 400 && plain(missingDiscover),
      message(missingDiscover),
    );
    check(
      'the item under the missing root can be rejected',
      (await decide(api, a.repositoryId, a.workItemId, 'rejected', 'The folder is gone.'))
        .status === 201,
    );
    await server.stop();
  });

  await scenario('E. A repository folder goes away, its root stays', async () => {
    const rootPath = path.join(work, 'e-root');
    const gone = path.join(rootPath, 'gone');
    const kept = path.join(rootPath, 'kept');
    await makeRepo(gone, plainTest);
    await makeRepo(kept, plainTest);
    const server = await startApi(newClone, path.join(work, 'e-data'));
    const api = client(server.base);
    const g = await bring(api, rootPath, gone, 'walk-eg');
    const checkG = await api.post(
      '/api/v1/checks',
      definition(g.repositoryId, 'Gone tests', 'node', ['--test']),
    );
    await rebind(api, g.repositoryId, g.workItemId);
    await api.post(`/api/v1/checks/${checkG.json.check.id}/run`, { workItemId: g.workItemId });
    check('before: every gate passes', (await gate(api, g.workItemId)).ready === true);
    await rm(gone, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const readiness = await gate(api, g.workItemId);
    check(
      'the gate closes and says why',
      readiness.ready === false &&
        Boolean(readiness.repositoryIssue) &&
        !rawError.test(readiness.repositoryIssue),
      readiness.repositoryIssue?.slice(0, 200),
    );
    const refreshed = await api.post(`/api/v1/repositories/${g.repositoryId}/refresh`, {});
    check(
      'refreshing it answers in plain words',
      refreshed.status >= 400 && plain(refreshed),
      message(refreshed),
    );
    const plainAccept = await decide(api, g.repositoryId, g.workItemId, 'accepted', 'No override.');
    check('a plain acceptance is refused', plainAccept.status === 409, `${plainAccept.status}`);
    check(
      'it can be rejected',
      (await decide(api, g.repositoryId, g.workItemId, 'rejected', 'The folder is gone.'))
        .status === 201,
    );
    const override = await decide(
      api,
      g.repositoryId,
      g.workItemId,
      'accepted',
      'Accepted anyway.',
      'The folder moved; reviewed elsewhere.',
    );
    check('it can be accepted with an override reason', override.status === 201, message(override));
    check(
      'its packet exports',
      (await api.get(`/api/v1/work-items/${g.workItemId}/packet/json`)).status === 200,
    );
    check('a backup exports', (await api.get('/api/v1/workspace/export')).status === 200);
    const retiredAway = await retire(
      api,
      await findCheck(api, checkG.json.check.id),
      'The folder is gone.',
    );
    check(
      'its check can retire while the folder is gone',
      retiredAway.status === 200,
      message(retiredAway),
    );
    await server.stop();
  });

  await scenario('F. Git cannot be started', async () => {
    const rootPath = path.join(work, 'f-root');
    const repositoryPath = path.join(rootPath, 'repo');
    await makeRepo(repositoryPath, plainTest);
    const dataDir = path.join(work, 'f-data');
    const first = await startApi(newClone, dataDir);
    const firstApi = client(first.base);
    const f = await bring(firstApi, rootPath, repositoryPath, 'walk-f');
    await first.stop();
    const server = await startApi(newClone, dataDir, {
      VERIDONE_GIT: path.join(work, 'no-such-git.exe'),
    });
    const api = client(server.base);
    await api.boot();
    const refreshed = await api.post(`/api/v1/repositories/${f.repositoryId}/refresh`, {});
    check(
      'the refusal names VERIDONE_GIT in plain words',
      refreshed.status >= 400 && plain(refreshed) && /VERIDONE_GIT/u.test(message(refreshed)),
      message(refreshed),
    );
    check(
      'the work item can be rejected',
      (await decide(api, f.repositoryId, f.workItemId, 'rejected', 'Git is missing.')).status ===
        201,
    );
    await server.stop();
  });

  await scenario('G. A backup restored where its folders do not exist', async () => {
    const rootPath = path.join(work, 'g-root');
    const repositoryPath = path.join(rootPath, 'moved');
    await makeRepo(repositoryPath, plainTest);
    const first = await startApi(newClone, path.join(work, 'g-data-1'));
    const firstApi = client(first.base);
    const original = await bring(firstApi, rootPath, repositoryPath, 'walk-g');
    const backup = await firstApi.get('/api/v1/workspace/export');
    await first.stop();
    await rm(rootPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const server = await startApi(newClone, path.join(work, 'g-data-2'));
    const api = client(server.base);
    await api.boot();
    check(
      'the backup restores',
      (await api.post('/api/v1/workspace/import', backup.json)).status === 201,
    );
    const restored = await api.boot();
    const approve = await api.post(`/api/v1/roots/${restored.roots[0].id}/approve`, {});
    check(
      'approving the missing root names the way out',
      approve.status === 400 && nextStep(approve, /new root|add/iu),
      message(approve),
    );
    check(
      'the restored item can be rejected with no root approved',
      (await decide(api, original.repositoryId, original.workItemId, 'rejected', 'Elsewhere now.'))
        .status === 201,
    );
    await server.stop();
  });

  await scenario('H. Too many changed paths for a snapshot', async () => {
    const rootPath = path.join(work, 'h-root');
    const repositoryPath = path.join(rootPath, 'wide');
    await makeRepo(repositoryPath, plainTest);
    const server = await startApi(newClone, path.join(work, 'h-data'));
    const api = client(server.base);
    const h = await bring(api, rootPath, repositoryPath, 'walk-h');
    await mkdir(path.join(repositoryPath, 'many'));
    for (let index = 0; index < 10_001; index += 1) {
      await writeFile(path.join(repositoryPath, 'many', `${index}.txt`), '');
    }
    const refreshed = await api.post(`/api/v1/repositories/${h.repositoryId}/refresh`, {});
    check(
      'the refusal reads in plain words',
      refreshed.status >= 400 && plain(refreshed),
      message(refreshed),
    );
    check(
      'the work item can be rejected',
      (await decide(api, h.repositoryId, h.workItemId, 'rejected', 'Too wide.')).status === 201,
    );
    check('a backup exports', (await api.get('/api/v1/workspace/export')).status === 200);
    await server.stop();
  });

  await scenario("I. An agent writes each run's receipt to the same file", async () => {
    const rootPath = path.join(work, 'i-root');
    await mkdir(rootPath, { recursive: true });
    const server = await startApi(newClone, path.join(work, 'i-data'));
    const api = client(server.base);
    await api.boot();
    await api.post('/api/v1/roots', { path: rootPath, label: 'Walk' });
    const receipt = path.join(rootPath, 'receipt.json');
    await writeReceipt(receipt, 'first-run');
    await api.post('/api/v1/receipts/import', { path: receipt });
    await writeReceipt(receipt, 'second-run');
    const second = await api.post('/api/v1/receipts/import', { path: receipt });
    check('the second run imports from the same file', second.status === 201, message(second));
    check('each run has its work item', (await api.boot()).workItems.length === 2);
    check('a backup exports', (await api.get('/api/v1/workspace/export')).status === 200);
    await server.stop();
  });

  await scenario('J. A workspace past the old 25 MB restore limit', async () => {
    const rootPath = path.join(work, 'j-root');
    const repositoryPath = path.join(rootPath, 'noisy');
    await makeRepo(repositoryPath, plainTest);
    const server = await startApi(newClone, path.join(work, 'j-data'));
    const api = client(server.base);
    const j = await bring(api, rootPath, repositoryPath, 'walk-j');
    const noisy = await api.post(
      '/api/v1/checks',
      definition(
        j.repositoryId,
        'Noisy',
        'node',
        ['-e', "process.stdout.write('x'.repeat(4000000))"],
        {
          maxOutputBytes: 5_000_000,
        },
      ),
    );
    await rebind(api, j.repositoryId, j.workItemId);
    let evidenceId = null;
    for (let round = 0; round < 7; round += 1) {
      const run = await api.post(`/api/v1/checks/${noisy.json.check.id}/run`, {
        workItemId: j.workItemId,
      });
      evidenceId = run.json?.evidence?.id ?? evidenceId;
    }
    const bootstrap = await api.get('/api/v1/bootstrap');
    check(
      'polling stays small however much output is stored',
      bootstrap.text.length < 1_000_000,
      `${(bootstrap.text.length / 1_000_000).toFixed(1)} MB`,
    );
    const output = await api.get(`/api/v1/evidence/${evidenceId}/output`);
    check(
      'the output of a run reads on demand, bounded',
      output.status === 200 && output.json?.truncated === true && output.text.length < 1_000_000,
      `${output.status}, ${output.text.length}`,
    );
    const backup = await api.get('/api/v1/workspace/export');
    check(
      'the backup is past 25 MB',
      backup.text.length > 25_000_000,
      `${(backup.text.length / 1_000_000).toFixed(1)} MB`,
    );
    await server.stop();
    const other = await startApi(newClone, path.join(work, 'j-data-2'));
    const otherApi = client(other.base);
    await otherApi.boot();
    const preview = await otherApi.post('/api/v1/workspace/preview', JSON.parse(backup.text));
    check('it previews', preview.status === 200, message(preview));
    const restored = await otherApi.post('/api/v1/workspace/import', JSON.parse(backup.text));
    check('it restores', restored.status === 201, message(restored));
    await other.stop();
  });

  await scenario("K. Receipts v1.1.0 accepted and today's import refuses", async () => {
    const rootPath = path.join(work, 'k-root');
    await mkdir(rootPath, { recursive: true });
    const dataDir = path.join(work, 'k-data');
    const oldServer = await startApi(oldClone, dataDir);
    const oldApi = client(oldServer.base);
    await oldApi.boot();
    await oldApi.post('/api/v1/roots', { path: rootPath, label: 'Walk' });
    const longId = path.join(rootPath, 'long.json');
    await writeReceipt(longId, 'r'.repeat(600));
    const longImport = await oldApi.post('/api/v1/receipts/import', { path: longId });
    check('v1.1.0 imports a 600-character run id', longImport.status === 201);
    const oddTime = path.join(rootPath, 'odd.json');
    await writeFile(
      oddTime,
      JSON.stringify({
        schema_version: 1,
        run_id: 'odd-time',
        started_at: 'yesterday',
        status: 'complete',
        task: { type: 'implementation' },
        stages: [],
      }),
    );
    const oddImport = await oldApi.post('/api/v1/receipts/import', { path: oddTime });
    check(
      'v1.1.0 imports a time that is no timestamp',
      oddImport.status === 201,
      message(oddImport),
    );
    await oldServer.stop();
    const server = await startApi(newClone, dataDir);
    const api = client(server.base);
    const boot = await api.boot();
    check(
      'both work items and receipts are still there',
      boot.workItems.length === 2 && boot.receipts.length === 2,
      `${boot.workItems.length}, ${boot.receipts.length}`,
    );
    const backup = await api.get('/api/v1/workspace/export');
    check('a backup exports after the upgrade', backup.status === 200, message(backup));
    await server.stop();
    const other = await startApi(newClone, path.join(work, 'k-data-2'));
    const otherApi = client(other.base);
    await otherApi.boot();
    const restored = await otherApi.post('/api/v1/workspace/import', backup.json);
    check('that backup restores', restored.status === 201, message(restored));
    await other.stop();
  });
});
