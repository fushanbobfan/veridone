// Upgrade walk: a workspace made by the real v1.1.0 build is opened by the clone under test and taken through the upgrade,
// through the API. Its workspaces, packets and backups stay in one folder under the walk root.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  check,
  checkArgs,
  client,
  clonePublicRepository,
  cloneUnderTest,
  findPython,
  fresh,
  git,
  preparedClone,
  previousRelease,
  runWalk,
  startApi,
  verifyPacket,
  walkOptions,
  writeReceipt,
} from './walk-lib.mjs';

await runWalk('UPGRADE WALK', async () => {
  const { root, ref } = await walkOptions();
  const pythonPath = await findPython();
  const newClone = await cloneUnderTest(root, ref);
  const oldClone = await preparedClone(root, previousRelease);
  const work = path.join(root, 'walk-upgrade');
  const repoRoot = path.join(work, 'repos');
  const dataDir = path.join(work, 'data');
  const receipt = path.join(repoRoot, 'receipt.json');
  await fresh(work);
  await mkdir(repoRoot, { recursive: true });
  const repository = await clonePublicRepository(repoRoot, 'ai-eval-micro-lab');
  const dirtyFile = path.join(repository, 'walk-dirty.txt');
  await writeReceipt(receipt, 'release-walk-upgrade');
  const head = await git(repository, 'rev-parse', 'HEAD');

  // ---- A workspace made by v1.1.0 ----
  console.log(`--- ${previousRelease} at ${await git(oldClone, 'rev-parse', '--short', 'HEAD')}`);
  const oldServer = await startApi(oldClone, dataDir);
  if (
    !check(
      'v1.1.0 starts',
      oldServer.health?.status === 'ok',
      oldServer.health ? '' : oldServer.output(),
    )
  ) {
    return;
  }
  const oldApi = client(oldServer.base);
  await oldApi.boot();
  const oldRoot = await oldApi.post('/api/v1/roots', {
    path: repoRoot,
    label: 'Walk repositories',
  });
  const oldRepository = await oldApi.post('/api/v1/repositories', { path: repository });
  const oldImport = await oldApi.post('/api/v1/receipts/import', { path: receipt });
  check(
    'v1.1.0 takes a root, a repository and a receipt',
    [oldRoot, oldRepository, oldImport].every((r) => r.status === 201),
  );
  const repositoryId = oldRepository.json.repository.id;
  let oldBoot = await oldApi.boot();
  const workItemId = oldBoot.workItems[0].id;
  await oldApi.post(`/api/v1/work-items/${workItemId}/link`, { repositoryId });
  const oldCheck = await oldApi.post('/api/v1/checks', {
    repositoryId,
    label: 'AI Eval Micro Lab test suite',
    kind: 'test',
    executable: pythonPath,
    args: checkArgs,
    cwdRelative: '.',
    timeoutMs: 180_000,
    maxOutputBytes: 1_000_000,
  });
  check(
    'v1.1.0 approves a check',
    oldCheck.status === 201,
    oldCheck.status === 201 ? '' : oldCheck.text.slice(0, 300),
  );
  const checkId = oldCheck.json.check.id;
  let oldRun = await oldApi.post(`/api/v1/checks/${checkId}/run`, { workItemId });
  if (oldRun.status !== 200) {
    console.log(
      `      first run answered ${oldRun.status}: ${oldRun.text.slice(0, 200)}; rebinding`,
    );
    await oldApi.post(`/api/v1/work-items/${workItemId}/link`, { repositoryId });
    oldRun = await oldApi.post(`/api/v1/checks/${checkId}/run`, { workItemId });
  }
  check(
    'v1.1.0 runs the check and it passes',
    oldRun.json?.evidence?.result === 'passed',
    oldRun.json?.evidence?.result ?? oldRun.text.slice(0, 300),
  );
  const oldVerdict = await oldApi.post(`/api/v1/work-items/${workItemId}/verdicts`, {
    decision: 'accepted',
    note: 'Accepted under v1.1.0.',
    overrideReason: null,
  });
  check(
    'v1.1.0 records an acceptance',
    oldVerdict.status === 201,
    oldVerdict.status === 201 ? '' : oldVerdict.text.slice(0, 300),
  );
  const oldPacket = await oldApi.get(`/api/v1/work-items/${workItemId}/packet/json`);
  const oldBackup = await oldApi.get('/api/v1/workspace/export');
  const oldPacketFile = path.join(work, 'v110-packet.json');
  const oldBackupFile = path.join(work, 'v110-backup.json');
  await writeFile(oldPacketFile, oldPacket.text);
  await writeFile(oldBackupFile, oldBackup.text);
  check(
    'v1.1.0 exports a packet and a backup',
    oldPacket.status === 200 && oldBackup.status === 200,
  );
  oldBoot = await oldApi.boot();
  await oldServer.stop();
  await cp(dataDir, path.join(work, 'data-as-v110-left-it'), { recursive: true });

  // ---- The clone under test opens that workspace ----
  const server = await startApi(newClone, dataDir);
  check(
    'the database migrates on first start',
    server.health?.status === 'ok',
    server.health ? '' : server.output(),
  );
  const api = client(server.base);
  let boot = await api.boot();
  check(
    'everything v1.1.0 recorded is still there',
    boot.roots.length === 1 &&
      boot.repositories.length === 1 &&
      boot.workItems.length === 1 &&
      boot.checks.length === 1 &&
      boot.evidence.length === oldBoot.evidence.length &&
      boot.verdicts.length === 1,
    `roots ${boot.roots.length}, repositories ${boot.repositories.length}, items ${boot.workItems.length}, checks ${boot.checks.length}, evidence ${boot.evidence.length}, verdicts ${boot.verdicts.length}`,
  );
  check(
    'a root from v1.1.0 stays approved',
    boot.roots[0].status === 'approved',
    boot.roots[0].status,
  );
  const readiness = boot.readiness[workItemId];
  check(
    'evidence recorded before the release no longer satisfies a gate',
    readiness.ready === false,
    JSON.stringify(readiness.checks),
  );
  check(
    'the old check has no pinned tool',
    boot.checks[0].resolvedExecutable == null,
    String(boot.checks[0].resolvedExecutable),
  );

  const unpinnedRun = await api.post(`/api/v1/checks/${checkId}/run`, { workItemId });
  check(
    'the old check refuses to run until it is pinned',
    unpinnedRun.status >= 400 && /pinned tools/u.test(unpinnedRun.text),
    `${unpinnedRun.status} ${unpinnedRun.text.slice(0, 200)}`,
  );

  const candidate = await api.get(`/api/v1/checks/${checkId}/tool`);
  const pinned = await api.post(`/api/v1/checks/${checkId}/pin`, {
    expected: { path: candidate.json.tool.path, sha256: candidate.json.tool.sha256 },
  });
  check(
    'pinning under Checks works on the old check',
    pinned.status === 200 && Boolean(pinned.json.check.resolvedExecutable),
    pinned.status === 200 ? '' : pinned.text.slice(0, 200),
  );

  // A stale binding and uncommitted changes, in that order.
  await writeFile(dirtyFile, 'uncommitted\n');
  const staleRun = await api.post(`/api/v1/checks/${checkId}/run`, { workItemId });
  check(
    'a stale binding refuses the run',
    staleRun.status >= 400 && /stale/u.test(staleRun.text),
    `${staleRun.status} ${staleRun.text.slice(0, 160)}`,
  );
  await api.post(`/api/v1/work-items/${workItemId}/link`, { repositoryId });
  const dirtyRun = await api.post(`/api/v1/checks/${checkId}/run`, { workItemId });
  check(
    'uncommitted changes refuse the run',
    dirtyRun.status >= 400 && /uncommitted/u.test(dirtyRun.text),
    `${dirtyRun.status} ${dirtyRun.text.slice(0, 160)}`,
  );
  await rm(dirtyFile);

  // Rebind on the clean tree and run for real.
  await api.post(`/api/v1/repositories/${repositoryId}/refresh`, {});
  await api.post(`/api/v1/work-items/${workItemId}/link`, { repositoryId });
  const run = await api.post(`/api/v1/checks/${checkId}/run`, { workItemId });
  check(
    'on a clean tree with a new binding, the check passes',
    run.json?.evidence?.result === 'passed',
    run.json?.evidence?.result ?? run.text.slice(0, 300),
  );
  check(
    'the new evidence comes from a clean checkout',
    run.json?.evidence?.isolation === 'clean-checkout',
    String(run.json?.evidence?.isolation),
  );
  check(
    'the gate is satisfied again',
    run.json?.readiness?.ready === true,
    JSON.stringify(run.json?.readiness?.checks),
  );
  check(
    'the repository is untouched by the check',
    (await git(repository, 'status', '--porcelain')) === '' &&
      (await git(repository, 'rev-parse', 'HEAD')) === head,
  );

  boot = await api.boot();
  const latest = boot.verdicts.at(-1);
  const expected = {
    fingerprint: boot.repositories[0].snapshot.fingerprint,
    verdictId: latest.id,
    claimHash: boot.workItems[0].claimHash,
  };
  const stale = await api.post(`/api/v1/work-items/${workItemId}/verdicts`, {
    decision: 'accepted',
    note: 'Written against an old view.',
    overrideReason: null,
    expected: { ...expected, verdictId: null },
  });
  check('a verdict against an old view is refused', stale.status === 409, `${stale.status}`);
  const verdict = await api.post(`/api/v1/work-items/${workItemId}/verdicts`, {
    decision: 'accepted',
    note: 'Accepted after the upgrade.',
    overrideReason: null,
    expected,
  });
  check(
    'a new verdict records against the old chain',
    verdict.status === 201,
    verdict.status === 201 ? '' : verdict.text.slice(0, 300),
  );
  boot = await api.boot();
  check(
    'the v1.1.0 verdict is kept beside the new one',
    boot.verdicts.length === 2 && boot.verdicts.some((v) => v.note === 'Accepted under v1.1.0.'),
    `${boot.verdicts.length} verdicts`,
  );

  const packet = await api.get(`/api/v1/work-items/${workItemId}/packet/json`);
  const key = await api.get('/api/v1/workspace/signing-key');
  const packetFile = path.join(work, 'upgraded-packet.json');
  const keyFile = path.join(work, 'signing-key.pem');
  await writeFile(packetFile, packet.text);
  await writeFile(keyFile, key.text);
  check(
    'the new packet is schema version 2 and signed',
    packet.json.schemaVersion === 2 && Boolean(packet.json.manifest?.signature),
    `schema ${packet.json.schemaVersion}`,
  );
  const signedResult = await verifyPacket(newClone, packetFile, keyFile);
  check(
    'the new packet verifies against the workspace key',
    signedResult.code === 0 && /trusted key/u.test(signedResult.output),
    signedResult.output.split('\n').at(-1),
  );
  const oldPacketResult = await verifyPacket(newClone, oldPacketFile);
  check(
    'a v1.1.0 packet still verifies, as unsigned',
    oldPacketResult.code === 0 && /Unsigned/u.test(oldPacketResult.output),
    oldPacketResult.output.split('\n').at(-1),
  );
  const newBackup = await api.get('/api/v1/workspace/export');
  const newBackupFile = path.join(work, 'upgraded-backup.json');
  await writeFile(newBackupFile, newBackup.text);
  check(
    'the new backup is schema version 2',
    newBackup.json?.schemaVersion === 2,
    String(newBackup.json?.schemaVersion),
  );
  await server.stop();

  // ---- The database that migrated from v1.1.0 refuses to rewrite history itself, on a copy ----
  const Database = createRequire(path.join(newClone, 'apps', 'server', 'package.json'))(
    'better-sqlite3',
  );
  const migratedCopy = path.join(work, 'data-as-migrated');
  await cp(dataDir, migratedCopy, { recursive: true });
  const database = new Database(path.join(migratedCopy, 'veridone.db'));
  const rowCounts = () =>
    `${database.prepare('SELECT COUNT(*) AS n FROM verdicts').get().n}/${database.prepare('SELECT COUNT(*) AS n FROM evidence').get().n}`;
  const refusal = (sql) => {
    try {
      database.prepare(sql).run();
      return 'it ran';
    } catch (error) {
      return error.message;
    }
  };
  const rowsBefore = rowCounts();
  // Written over the latest verdict's own id, past the check that a verdict extends the latest one.
  const verdictColumns = database.pragma('table_info(verdicts)').map(({ name }) => name);
  const verdictValues = verdictColumns.map(
    (name) =>
      ({ note: "'changed'", sequence: 'sequence + 1', previous_verdict_id: 'id' })[name] ?? name,
  );
  for (const [label, sql] of [
    ['deleting verdicts', 'DELETE FROM verdicts'],
    ['changing a verdict', "UPDATE verdicts SET note = 'changed'"],
    ['deleting evidence', 'DELETE FROM evidence'],
    ['changing evidence', "UPDATE evidence SET result = 'passed'"],
    ['replacing evidence', 'INSERT OR REPLACE INTO evidence SELECT * FROM evidence'],
    [
      'replacing a verdict',
      `INSERT OR REPLACE INTO verdicts (${verdictColumns.join(', ')}) SELECT ${verdictValues.join(', ')} FROM verdicts ORDER BY sequence DESC LIMIT 1`,
    ],
  ]) {
    const message = refusal(sql);
    check(`the migrated database refuses ${label}`, /append-only/u.test(message), message);
  }
  check(
    'the v1.1.0 verdict and evidence rows are all still there',
    rowCounts() === rowsBefore && rowsBefore === `2/${boot.evidence.length}`,
    `${rowsBefore} before, ${rowCounts()} after`,
  );
  database.close();

  // ---- The v1.1.0 backup restores into an empty workspace ----
  console.log('--- restoring the v1.1.0 backup into an empty workspace');
  const restoreServer = await startApi(newClone, path.join(work, 'data-restored'));
  const restoreApi = client(restoreServer.base);
  await restoreApi.boot();
  const oldDocument = JSON.parse(await readFile(oldBackupFile, 'utf8'));
  check(
    'the v1.1.0 backup is schema version 1',
    oldDocument.schemaVersion === 1,
    String(oldDocument.schemaVersion),
  );
  const preview = await restoreApi.post('/api/v1/workspace/preview', oldDocument);
  check(
    'the preview lists what it would add',
    preview.status === 200,
    JSON.stringify(preview.json?.imported ?? preview.json ?? preview.text).slice(0, 220),
  );
  let restoredBoot = await restoreApi.boot();
  check(
    'the preview writes nothing',
    restoredBoot.roots.length === 0 && restoredBoot.verdicts.length === 0,
  );
  const restored = await restoreApi.post('/api/v1/workspace/import', oldDocument);
  check(
    'the v1.1.0 backup restores',
    restored.status === 201,
    restored.status === 201 ? '' : restored.text.slice(0, 300),
  );
  restoredBoot = await restoreApi.boot();
  check(
    'its verdict and evidence are back',
    restoredBoot.verdicts.length === 1 && restoredBoot.evidence.length === oldBoot.evidence.length,
  );
  check(
    'its root is pending',
    restoredBoot.roots[0]?.status === 'pending',
    restoredBoot.roots[0]?.status,
  );
  const refusedDiscovery = await restoreApi.post('/api/v1/repositories/discover', {
    rootId: restoredBoot.roots[0].id,
  });
  check(
    'discovery refuses a pending root',
    refusedDiscovery.status === 409,
    `${refusedDiscovery.status}`,
  );
  const approved = await restoreApi.post(`/api/v1/roots/${restoredBoot.roots[0].id}/approve`, {});
  const discovery = await restoreApi.post('/api/v1/repositories/discover', {
    rootId: restoredBoot.roots[0].id,
  });
  check(
    'after approval the root works',
    approved.status === 200 && discovery.status === 200,
    `${approved.status}, ${discovery.status}`,
  );
  const again = await restoreApi.post('/api/v1/workspace/import', oldDocument);
  restoredBoot = await restoreApi.boot();
  check(
    'a second restore adds nothing',
    again.status === 201 &&
      restoredBoot.verdicts.length === 1 &&
      restoredBoot.evidence.length === oldBoot.evidence.length,
    `${again.status}`,
  );
  await restoreServer.stop();

  // ---- The upgraded workspace's own backup restores too ----
  const secondServer = await startApi(newClone, path.join(work, 'data-restored-v2'));
  const secondApi = client(secondServer.base);
  await secondApi.boot();
  const secondRestore = await secondApi.post(
    '/api/v1/workspace/import',
    JSON.parse(await readFile(newBackupFile, 'utf8')),
  );
  const secondBoot = await secondApi.boot();
  check(
    'the schema 2 backup restores with both verdicts',
    secondRestore.status === 201 && secondBoot.verdicts.length === 2,
    `${secondRestore.status}, ${secondBoot.verdicts.length} verdicts`,
  );
  await secondServer.stop();

  check(
    'the repository ends as it started',
    (await git(repository, 'status', '--porcelain')) === '' &&
      (await git(repository, 'rev-parse', 'HEAD')) === head,
  );
});
