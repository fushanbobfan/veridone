import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { canonicalJson, sha256Hex } from '@veridone/core';
import { afterEach, describe, expect, it } from 'vitest';

import { acceptanceReadiness } from './check-runner.js';
import { RemovedRecordError, VeriDoneDatabase } from './database.js';
import { buildAcceptancePacket, knownLocalPaths, verifyAcceptancePacket } from './packet.js';
import { boundWorkspace } from './test-fixtures.js';
import { exportWorkspace, importWorkspace, type WorkspaceDocument } from './workspace.js';

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
const unknownId = '00000000-0000-4000-8000-000000000000';

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Fixture = Awaited<ReturnType<typeof boundWorkspace>>;

async function workspace(options: Parameters<typeof boundWorkspace>[0] = {}): Promise<Fixture> {
  const fixture = await boundWorkspace(options);
  cleanups.push(fixture.cleanup);
  return fixture;
}

function freshDatabase(): VeriDoneDatabase {
  const database = new VeriDoneDatabase(':memory:');
  cleanups.push(async () => database.close());
  return database;
}

/** A temporary folder outside the fixture's root, under the name the workspace records for it. */
async function outsideFolder(): Promise<string> {
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), 'veridone-removal-')));
  cleanups.push(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

async function makeRepository(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const git = (...args: string[]) => execFileAsync('git', args, { cwd: directory });
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@veridone.local');
  await git('config', 'user.name', 'VeriDone Test');
  await writeFile(path.join(directory, 'README.md'), '# Fixture\n');
  await git('add', '-A');
  await git('commit', '-m', 'fixture');
}

interface RemovedFields {
  removedAt: string | null;
  removedReason: string | null;
}
interface RootBody extends RemovedFields {
  id: string;
  path: string;
  label: string;
  status: string;
  missing?: boolean;
  onlyCovers?: string[];
}
interface RepositoryBody extends RemovedFields {
  id: string;
  name: string;
  path: string;
  snapshot: { fingerprint: string; head: string };
}
interface WorkItemBody extends RemovedFields {
  id: string;
  title: string;
  claim: string;
  claimHash: string;
  repositoryId: string | null;
  humanVerdict: string | null;
}
interface BootstrapBody {
  roots: RootBody[];
  repositories: RepositoryBody[];
  workItems: WorkItemBody[];
  checks: Array<{ id: string; repositoryId: string; retiredAt: string | null }>;
  removed: { roots: RootBody[]; repositories: RepositoryBody[]; workItems: WorkItemBody[] };
  sourceIssues: Array<{ repositoryId: string; message: string }>;
  readiness: Record<
    string,
    {
      ready: boolean;
      bound: boolean;
      bindingFresh: boolean;
      repositoryIssue: string | null;
      degraded?: boolean;
      checkCount: number;
      passingCount: number;
    }
  >;
  verdicts: Array<{ id: string; workItemId: string; sequence: number }>;
  evidence: Array<{ id: string; workItemId: string; result: string }>;
}
interface ErrorBody {
  error: string;
  message?: string;
}
interface RunBody extends ErrorBody {
  evidence: { id: string; result: string };
  readiness: { ready: boolean };
}

const boot = async (fixture: Fixture) =>
  (await fixture.get<BootstrapBody>('/api/v1/bootstrap')).body;

const onlyRoot = async (fixture: Fixture) => {
  const [root] = (await boot(fixture)).roots;
  if (!root) throw new Error('The fixture has no root.');
  return root;
};

const removeRoot = (
  fixture: Fixture,
  rootId: string,
  reason = 'The disk is gone for good.',
  repositoryIds: string[] = [],
) =>
  fixture.post<ErrorBody & { root: RootBody; repositories: RepositoryBody[] }>(
    `/api/v1/roots/${rootId}/remove`,
    { reason, repositoryIds },
  );
const removeRepository = (
  fixture: Fixture,
  repositoryId = fixture.repositoryId,
  reason = 'Moved to another disk.',
) =>
  fixture.post<ErrorBody & { repository: RepositoryBody }>(
    `/api/v1/repositories/${repositoryId}/remove`,
    { reason },
  );
const putBackRepository = (fixture: Fixture, repositoryId = fixture.repositoryId) =>
  fixture.post<ErrorBody & { repository: RepositoryBody; issue: string | null }>(
    `/api/v1/repositories/${repositoryId}/put-back`,
    {},
  );
const removeWorkItem = async (
  fixture: Fixture,
  workItemId = fixture.workItemId,
  reason = 'Added by mistake.',
) => {
  const item = (await boot(fixture)).workItems.find((candidate) => candidate.id === workItemId);
  return fixture.post<ErrorBody & { workItem: WorkItemBody }>(
    `/api/v1/work-items/${workItemId}/remove`,
    { reason, expected: { claimHash: item?.claimHash ?? 'a'.repeat(64) } },
  );
};
const putBackWorkItem = (fixture: Fixture, workItemId = fixture.workItemId) =>
  fixture.post<ErrorBody & { workItem: WorkItemBody }>(
    `/api/v1/work-items/${workItemId}/put-back`,
    {},
  );

const link = (fixture: Fixture, repositoryId = fixture.repositoryId) =>
  fixture.post<ErrorBody>(`/api/v1/work-items/${fixture.workItemId}/link`, { repositoryId });
const run = (fixture: Fixture, checkId: string) =>
  fixture.post<RunBody>(`/api/v1/checks/${checkId}/run`, { workItemId: fixture.workItemId });

/** A check that passes, run on the current state, so the work item's gate is open. */
async function passingGate(fixture: Fixture): Promise<string> {
  const checkId = await fixture.approveCheck('process.exit(0)');
  await link(fixture);
  const ran = await run(fixture, checkId);
  expect(ran.body.readiness.ready).toBe(true);
  return checkId;
}

const nextStep = /put .*back/iu;

describe('removing a root', () => {
  it('takes it out of what VeriDone reads and lists it as removed, with its reason', async () => {
    const fixture = await workspace();
    const root = await onlyRoot(fixture);

    const removed = await removeRoot(fixture, root.id);
    expect(removed.status).toBe(200);
    expect(removed.body.root.removedAt).toEqual(expect.any(String));
    expect(removed.body.root.removedReason).toBe('The disk is gone for good.');

    const body = await boot(fixture);
    expect(body.roots).toEqual([]);
    expect(body.removed.roots.map((entry) => entry.id)).toEqual([root.id]);
    expect(body.removed.roots[0]?.removedReason).toBe('The disk is gone for good.');
    expect(fixture.database.listApprovedRoots()).toEqual([]);
    expect(fixture.database.getApprovedRoot(root.id)).toBeNull();

    const discovered = await fixture.post<ErrorBody>('/api/v1/repositories/discover', {
      rootId: root.id,
    });
    expect(discovered.status).toBe(409);
    expect(discovered.body.error).toBe('root_removed');
    expect(discovered.body.message).toMatch(nextStep);

    const added = await fixture.post<ErrorBody>('/api/v1/repositories', {
      path: fixture.repositoryPath,
    });
    expect(added.status).toBe(400);
  }, 60_000);

  it('names the next step for a path only a removed root covered', async () => {
    const fixture = await workspace();
    const root = await onlyRoot(fixture);
    const folder = await outsideFolder();
    await fixture.post('/api/v1/roots', { path: folder });
    await removeRoot(fixture, root.id);

    const added = await fixture.post<ErrorBody>('/api/v1/repositories', {
      path: fixture.repositoryPath,
    });
    expect(added.status).toBe(400);
    expect(added.body.message).toMatch(/outside the approved roots/u);
    expect(added.body.message).toMatch(/under Add source/u);
    const preview = await fixture.post<ErrorBody>('/api/v1/receipts/preview', {
      path: path.join(root.path, 'receipt.json'),
    });
    expect(preview.status).toBe(400);
    expect(preview.body.message).toMatch(/under Add source/u);

    // The step it names works: adding the folder as a root brings it back.
    await fixture.post('/api/v1/roots', { path: root.path });
    expect(
      (await fixture.post<ErrorBody>('/api/v1/repositories', { path: fixture.repositoryPath }))
        .status,
    ).toBe(201);
  }, 60_000);

  it('asks for a reason, knows the root, and happens once', async () => {
    const fixture = await workspace();
    const root = await onlyRoot(fixture);

    const noReason = await fixture.post<ErrorBody>(`/api/v1/roots/${root.id}/remove`, {
      reason: '   ',
    });
    expect(noReason.status).toBe(400);
    expect((await removeRoot(fixture, unknownId)).status).toBe(404);

    expect((await removeRoot(fixture, root.id)).status).toBe(200);
    const twice = await removeRoot(fixture, root.id);
    expect(twice.status).toBe(409);
    expect(twice.body.error).toBe('record_removed');
  }, 60_000);

  it('names the repositories only it covers, and removes those the operator saw', async () => {
    const fixture = await workspace();
    const outer = await onlyRoot(fixture);
    const folder = await outsideFolder();
    const soloPath = path.join(folder, 'solo');
    await makeRepository(soloPath);
    await makeRepository(path.join(folder, 'never-seen'));
    const other = await fixture.post<{ root: RootBody }>('/api/v1/roots', { path: folder });
    const solo = await fixture.post<{ repository: RepositoryBody }>('/api/v1/repositories', {
      path: soloPath,
    });
    const unseen = await fixture.post<{ repository: RepositoryBody }>('/api/v1/repositories', {
      path: path.join(folder, 'never-seen'),
    });
    // A second root over the fixture's repository means neither of the two is its only cover.
    const nested = await fixture.post<{ root: RootBody }>('/api/v1/roots', {
      path: fixture.repositoryPath,
    });

    const listed = await boot(fixture);
    const coverOf = (id: string) => listed.roots.find((root) => root.id === id)?.onlyCovers;
    expect(coverOf(outer.id)).toEqual([]);
    expect(coverOf(nested.body.root.id)).toEqual([]);
    expect(coverOf(other.body.root.id)?.toSorted()).toEqual(
      [solo.body.repository.id, unseen.body.repository.id].toSorted(),
    );

    const removed = await removeRoot(fixture, other.body.root.id, 'Handed over.', [
      solo.body.repository.id,
      // Under another root, so this request does not reach it.
      fixture.repositoryId,
      unknownId,
    ]);
    expect(removed.status).toBe(200);
    expect(removed.body.repositories.map((repository) => repository.id)).toEqual([
      solo.body.repository.id,
    ]);

    const body = await boot(fixture);
    expect(body.removed.repositories.map((repository) => repository.id)).toEqual([
      solo.body.repository.id,
    ]);
    expect(body.removed.repositories[0]?.removedReason).toBe('Handed over.');
    expect(body.repositories.map((repository) => repository.id).toSorted()).toEqual(
      [fixture.repositoryId, unseen.body.repository.id].toSorted(),
    );
    expect(body.sourceIssues.map((issue) => issue.repositoryId)).toEqual([
      unseen.body.repository.id,
    ]);
  }, 60_000);

  it('leaves a repository the operator kept, which says why it cannot be read', async () => {
    const fixture = await workspace();
    await passingGate(fixture);
    const root = await onlyRoot(fixture);
    await removeRoot(fixture, root.id);

    const body = await boot(fixture);
    expect(body.repositories.map((repository) => repository.id)).toEqual([fixture.repositoryId]);
    expect(body.sourceIssues[0]?.repositoryId).toBe(fixture.repositoryId);
    const message = body.sourceIssues[0]?.message;
    expect(message).toContain(`Its root ${root.label} was removed`);
    expect(message).toMatch(nextStep);
    expect(message).toMatch(/remove it/iu);
    expect(body.readiness[fixture.workItemId]).toMatchObject({ ready: false });
    const plainly = await fixture.decide<ErrorBody>('accepted', 'Accepting.');
    expect(plainly.status).toBe(409);
    expect(plainly.body.error).toBe('required_gates_open');
    expect((await fixture.decide('rejected', 'Elsewhere now.')).status).toBe(201);
  }, 60_000);

  it('adds a check once on a repository that lost its root, and says why it cannot be read', async () => {
    const fixture = await workspace();
    await removeRoot(fixture, (await onlyRoot(fixture)).id);
    const added = await fixture.post<ErrorBody>('/api/v1/checks', {
      repositoryId: fixture.repositoryId,
      label: 'Added after the root left',
      kind: 'test',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwdRelative: '.',
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    });
    expect(added.status).toBe(201);
    const body = await boot(fixture);
    expect(body.checks).toHaveLength(1);
    expect(body.sourceIssues[0]?.message).toContain('was removed');
  }, 60_000);

  it('refuses a plain acceptance whose only root leaves while it reads the repository', async () => {
    const fixture = await workspace();
    await passingGate(fixture);
    const root = await onlyRoot(fixture);
    const expected = await fixture.expectedState();
    const accepting = fixture.decide<ErrorBody>('accepted', 'Accepting.', { expected });
    // The acceptance is reading the repository by now, under the roots it started with.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await removeRoot(fixture, root.id)).status).toBe(200);

    const answered = await accepting;
    expect(answered.status).toBe(409);
    expect(answered.body.error).toBe('required_gates_open');
    expect(answered.body.message).toContain(`Its root ${root.label} was removed`);
    expect(fixture.database.listVerdicts(fixture.workItemId)).toEqual([]);
  }, 60_000);

  it('removes a root restored from a backup, whose folder is not on this machine', async () => {
    const fixture = await workspace();
    const document = await exportWorkspace(fixture.database);
    await rm(fixture.directory, { recursive: true, force: true });
    const target = await workspace({ runId: 'a-run-of-this-machine' });
    await importWorkspace(target.database, document);
    const pending = (await boot(target)).roots.find((root) => root.status === 'pending');
    if (!pending) throw new Error('The backup brought no root.');
    expect(pending.missing).toBe(true);

    // Its repository came with it, under a root no one approved here.
    expect((await boot(target)).roots.find((root) => root.id === pending.id)?.onlyCovers).toContain(
      fixture.repositoryId,
    );
    const removed = await removeRoot(target, pending.id, 'From the old laptop.', [
      fixture.repositoryId,
    ]);
    expect(removed.status).toBe(200);
    const body = await boot(target);
    expect(body.roots.map((root) => root.id)).not.toContain(pending.id);
    expect(body.removed.roots[0]).toMatchObject({ id: pending.id, status: 'pending' });
    expect(body.sourceIssues.map((issue) => issue.repositoryId)).not.toContain(
      fixture.repositoryId,
    );
  }, 60_000);

  it('goes back through the checks that approve a root', async () => {
    const fixture = await workspace();
    const folder = await outsideFolder();
    const gone = path.join(folder, 'gone');
    await mkdir(gone);
    const kept = await fixture.post<{ root: RootBody }>('/api/v1/roots', { path: folder });
    const leaving = await fixture.post<{ root: RootBody }>('/api/v1/roots', { path: gone });
    await removeRoot(fixture, kept.body.root.id);
    await removeRoot(fixture, leaving.body.root.id);
    await rm(gone, { recursive: true, force: true });

    const refused = await fixture.post<ErrorBody>(
      `/api/v1/roots/${leaving.body.root.id}/approve`,
      {},
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('root_missing');
    expect(refused.body.message).toMatch(/add its new location/iu);
    expect(
      (await boot(fixture)).removed.roots.map((root) => root.id).includes(leaving.body.root.id),
    ).toBe(true);

    const back = await fixture.post<{ root: RootBody }>(
      `/api/v1/roots/${kept.body.root.id}/approve`,
      {},
    );
    expect(back.status).toBe(200);
    expect(back.body.root).toMatchObject({
      status: 'approved',
      removedAt: null,
      removedReason: null,
    });
    expect(fixture.database.listApprovedRoots().map((root) => root.id)).toContain(
      kept.body.root.id,
    );
  }, 60_000);

  it('comes back when the operator adds its path again', async () => {
    const fixture = await workspace();
    const root = await onlyRoot(fixture);
    await removeRoot(fixture, root.id);
    const again = await fixture.post<{ root: RootBody }>('/api/v1/roots', { path: root.path });
    expect(again.status).toBe(201);
    expect(again.body.root).toMatchObject({ id: root.id, status: 'approved', removedAt: null });
    expect((await boot(fixture)).removed.roots).toEqual([]);
  }, 60_000);
});

describe('removing a repository', () => {
  it('stops reading it, and its work items stay on the last state captured', async () => {
    const fixture = await workspace();
    const before = fixture.database.getRepository(fixture.repositoryId);
    await rm(fixture.repositoryPath, { recursive: true, force: true });
    expect((await boot(fixture)).sourceIssues).toHaveLength(1);

    const removed = await removeRepository(fixture);
    expect(removed.status).toBe(200);
    expect(removed.body.repository.removedReason).toBe('Moved to another disk.');

    const body = await boot(fixture);
    expect(body.sourceIssues).toEqual([]);
    expect(body.repositories).toEqual([]);
    expect(body.removed.repositories.map((repository) => repository.id)).toEqual([
      fixture.repositoryId,
    ]);
    expect(body.removed.repositories[0]?.snapshot.fingerprint).toBe(before?.snapshot.fingerprint);
    expect(body.workItems.map((item) => item.id)).toEqual([fixture.workItemId]);
    expect(body.workItems[0]?.repositoryId).toBe(fixture.repositoryId);
    const issue = body.readiness[fixture.workItemId]?.repositoryIssue;
    expect(issue).toContain('Moved to another disk.');
    expect(issue).toMatch(/link this work item/iu);
    expect(issue).toMatch(nextStep);
    expect(issue).toMatch(/override reason/iu);
  }, 60_000);

  it('closes the gate, and every decision but a plain acceptance records on the last state', async () => {
    const fixture = await workspace();
    await passingGate(fixture);
    const fingerprint = fixture.database.getRepository(fixture.repositoryId)?.snapshot.fingerprint;
    await removeRepository(fixture);

    expect(acceptanceReadiness(fixture.database, fixture.workItemId)).toMatchObject({
      ready: false,
      repositoryIssue: expect.stringContaining('Moved to another disk.'),
    });
    const plainly = await fixture.decide<ErrorBody>('accepted', 'Accepting.');
    expect(plainly.status).toBe(409);
    expect(plainly.body.error).toBe('required_gates_open');
    expect(plainly.body.message).toContain('Moved to another disk.');

    const rejected = await fixture.decide<{ verdict: { snapshotFingerprint: string } }>(
      'rejected',
      'It went away.',
    );
    expect(rejected.status).toBe(201);
    expect(rejected.body.verdict.snapshotFingerprint).toBe(fingerprint);
    expect((await fixture.decide('changes-requested', 'Bring it back.')).status).toBe(201);
    const overridden = await fixture.decide<{ verdict: { overrideReason: string } }>(
      'accepted',
      'Reviewed from a copy.',
      { overrideReason: 'The folder moved.' },
    );
    expect(overridden.status).toBe(201);
    expect(overridden.body.verdict.overrideReason).toBe('The folder moved.');
  }, 60_000);

  it('refuses what needs a repository in the workspace, and names the way back', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck('process.exit(0)');
    const { body: listed } = await fixture.get<{
      checks: Array<{ id: string; definitionHash: string }>;
    }>('/api/v1/bootstrap');
    const definitionHash = listed.checks[0]?.definitionHash;
    const definition = {
      repositoryId: fixture.repositoryId,
      label: 'Another',
      kind: 'test',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwdRelative: '.',
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    };
    await removeRepository(fixture);

    const refusals = [
      await fixture.post<ErrorBody>(`/api/v1/repositories/${fixture.repositoryId}/refresh`, {}),
      await link(fixture),
      await fixture.post<ErrorBody>('/api/v1/checks', definition),
      await fixture.get<ErrorBody>(`/api/v1/checks/${checkId}/tool`),
      await fixture.post<ErrorBody>(`/api/v1/checks/${checkId}/pin`, {
        expected: { path: process.execPath, sha256: 'a'.repeat(64) },
      }),
      await fixture.post<ErrorBody>(`/api/v1/checks/${checkId}/replace`, {
        check: definition,
        reason: 'Replacing.',
        expected: { definitionHash },
      }),
      await run(fixture, checkId),
    ];
    for (const refusal of refusals) {
      expect(refusal.status).toBe(409);
      expect(refusal.body.error).toBe('record_removed');
      expect(refusal.body.message).toMatch(nextStep);
    }
    expect((await removeRepository(fixture)).status).toBe(409);
    expect((await removeRepository(fixture, unknownId)).status).toBe(404);
    expect(
      (
        await fixture.post<ErrorBody>(`/api/v1/repositories/${fixture.repositoryId}/remove`, {
          reason: ' ',
        })
      ).status,
    ).toBe(400);
  }, 60_000);

  it('lets a work item move to another repository, whose gate its old evidence does not satisfy', async () => {
    const fixture = await workspace();
    await passingGate(fixture);
    const movedPath = path.join(fixture.directory, 'moved');
    await makeRepository(movedPath);
    const moved = await fixture.post<{ repository: RepositoryBody }>('/api/v1/repositories', {
      path: movedPath,
    });
    await removeRepository(fixture);

    const relinked = await link(fixture, moved.body.repository.id);
    expect(relinked.status).toBe(200);
    expect((await boot(fixture)).readiness[fixture.workItemId]).toMatchObject({
      ready: false,
      repositoryIssue: null,
      bindingFresh: true,
      checkCount: 0,
    });

    const added = await fixture.post<{ check: { id: string } }>('/api/v1/checks', {
      repositoryId: moved.body.repository.id,
      label: 'On the new repository',
      kind: 'test',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwdRelative: '.',
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    });
    await link(fixture, moved.body.repository.id);
    const body = await boot(fixture);
    expect(body.evidence).toHaveLength(1);
    expect(body.readiness[fixture.workItemId]).toMatchObject({
      ready: false,
      checkCount: 1,
      passingCount: 0,
    });
    const ran = await run(fixture, added.body.check.id);
    expect(ran.body.readiness.ready).toBe(true);
  }, 60_000);

  it('goes back with its checks and bindings, and the gate is judged again', async () => {
    const fixture = await workspace();
    await passingGate(fixture);
    await removeRepository(fixture);

    const back = await putBackRepository(fixture);
    expect(back.status).toBe(200);
    expect(back.body.issue).toBeNull();
    expect(back.body.repository).toMatchObject({ removedAt: null, removedReason: null });

    const body = await boot(fixture);
    expect(body.removed.repositories).toEqual([]);
    expect(body.repositories.map((repository) => repository.id)).toEqual([fixture.repositoryId]);
    expect(body.checks).toHaveLength(1);
    expect(body.workItems[0]?.repositoryId).toBe(fixture.repositoryId);
    expect(body.readiness[fixture.workItemId]).toMatchObject({ ready: true, passingCount: 1 });

    expect((await putBackRepository(fixture)).status).toBe(409);
    expect((await putBackRepository(fixture, unknownId)).status).toBe(404);
  }, 60_000);

  it('says why it cannot be read when it goes back with its folder gone', async () => {
    const fixture = await workspace();
    await removeRepository(fixture);
    await rm(fixture.repositoryPath, { recursive: true, force: true });
    const back = await putBackRepository(fixture);
    expect(back.status).toBe(200);
    expect(back.body.issue).toMatch(/cannot read the repository/iu);
    expect((await boot(fixture)).sourceIssues).toHaveLength(1);
  }, 60_000);

  it('comes back when the operator adds its path again', async () => {
    const fixture = await workspace();
    await removeRepository(fixture);
    const again = await fixture.post<{ repository: RepositoryBody }>('/api/v1/repositories', {
      path: fixture.repositoryPath,
    });
    expect(again.status).toBe(201);
    expect(again.body.repository).toMatchObject({ id: fixture.repositoryId, removedAt: null });
    expect((await boot(fixture)).removed.repositories).toEqual([]);
  }, 60_000);

  it('stays removed when the removal arrives during an add of the same path', async () => {
    const fixture = await workspace();
    const adding = fixture.post('/api/v1/repositories', { path: fixture.repositoryPath });
    // The add is past its first read by now, and its capture takes far longer than this.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await removeRepository(fixture)).status).toBe(200);
    expect((await adding).status).toBe(201);
    expect(fixture.database.getRepository(fixture.repositoryId)?.removedReason).toBe(
      'Moved to another disk.',
    );
  }, 60_000);

  it('stays as it was when a capture finishes after the removal', async () => {
    const fixture = await workspace();
    const stored = fixture.database.getRepository(fixture.repositoryId);
    if (!stored) throw new Error('The repository is missing.');
    await removeRepository(fixture);

    const written = fixture.database.upsertRepository(stored.path, {
      ...stored.snapshot,
      fingerprint: 'c'.repeat(64),
    });
    expect(written.removedAt).toEqual(expect.any(String));
    expect(written.snapshot.fingerprint).toBe(stored.snapshot.fingerprint);
    expect(fixture.database.getRepository(fixture.repositoryId)).toMatchObject({
      removedReason: 'Moved to another disk.',
      snapshot: { fingerprint: stored.snapshot.fingerprint },
    });
  }, 60_000);
});

describe('removing a work item', () => {
  it('takes it out of the inbox and the gates, and refuses what needs it, naming the way back', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck('process.exit(0)');
    await link(fixture);
    const opened = await fixture.expectedState();

    const removed = await removeWorkItem(fixture);
    expect(removed.status).toBe(200);
    expect(removed.body.workItem.removedReason).toBe('Added by mistake.');

    const body = await boot(fixture);
    expect(body.workItems).toEqual([]);
    expect(body.readiness[fixture.workItemId]).toBeUndefined();
    expect(body.removed.workItems.map((item) => item.id)).toEqual([fixture.workItemId]);
    expect(fixture.database.getWorkItem(fixture.workItemId)?.removedReason).toBe(
      'Added by mistake.',
    );

    const refusals = [
      await link(fixture),
      await run(fixture, checkId),
      await fixture.post<ErrorBody>(`/api/v1/work-items/${fixture.workItemId}/verdicts`, {
        decision: 'rejected',
        note: 'No.',
        expected: opened,
      }),
    ];
    for (const refusal of refusals) {
      expect(refusal.status).toBe(409);
      expect(refusal.body.error).toBe('record_removed');
      expect(refusal.body.message).toMatch(nextStep);
    }
    expect(() =>
      fixture.database.recordVerdict(
        {
          workItemId: fixture.workItemId,
          decision: 'rejected',
          note: 'A verdict racing the removal.',
          snapshotFingerprint: 'b'.repeat(64),
          contractVersion: 'default-v1',
          evidenceIds: [],
          overrideReason: null,
        },
        opened,
      ),
    ).toThrow(RemovedRecordError);
  }, 60_000);

  it('says it was removed, whether or not it was ever bound', async () => {
    const fixture = await workspace();
    const receipt = path.join(fixture.directory, 'unbound.json');
    await writeFile(
      receipt,
      JSON.stringify({
        schema_version: 1,
        run_id: 'never-bound',
        source: 'codex',
        title: 'Never bound',
        claim: 'Nothing to bind.',
        status: 'complete',
        started_at: '2026-10-22T10:00:00.000Z',
      }),
    );
    const { imported } = (
      await fixture.post<{ imported: Array<{ workItem: WorkItemBody }> }>(
        '/api/v1/receipts/import',
        { path: receipt },
      )
    ).body;
    const unbound = imported[0]?.workItem;
    if (!unbound) throw new Error('The receipt was not imported.');
    await removeWorkItem(fixture, unbound.id);

    const refused = await fixture.post<ErrorBody>(`/api/v1/work-items/${unbound.id}/verdicts`, {
      decision: 'rejected',
      note: 'No.',
      expected: { fingerprint: null, verdictId: null, claimHash: unbound.claimHash },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('record_removed');
    expect(refused.body.message).toMatch(nextStep);
  }, 60_000);

  it('asks for a reason and the claim the operator saw, and happens once', async () => {
    const fixture = await workspace();
    const url = `/api/v1/work-items/${fixture.workItemId}/remove`;
    const { claimHash } = await fixture.expectedState();

    const noReason = await fixture.post<ErrorBody>(url, { reason: ' ', expected: { claimHash } });
    expect(noReason.status).toBe(400);
    const noClaim = await fixture.post<ErrorBody>(url, { reason: 'Mistake.' });
    expect(noClaim.status).toBe(400);
    const staleView = await fixture.post<ErrorBody>(url, {
      reason: 'Mistake.',
      expected: { claimHash: 'a'.repeat(64) },
    });
    expect(staleView.status).toBe(409);
    expect(staleView.body.error).toBe('work_item_changed');
    expect((await boot(fixture)).workItems).toHaveLength(1);
    expect(
      (
        await fixture.post<ErrorBody>(`/api/v1/work-items/${unknownId}/remove`, {
          reason: 'Mistake.',
          expected: { claimHash },
        })
      ).status,
    ).toBe(404);

    expect(
      (await fixture.post<ErrorBody>(url, { reason: 'Mistake.', expected: { claimHash } })).status,
    ).toBe(200);
    const twice = await fixture.post<ErrorBody>(url, { reason: 'Again.', expected: { claimHash } });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toBe('record_removed');
  }, 60_000);

  it('is never ready while removed, whatever evidence it holds', async () => {
    const fixture = await workspace();
    await passingGate(fixture);
    await removeWorkItem(fixture);
    expect(acceptanceReadiness(fixture.database, fixture.workItemId).ready).toBe(false);
    await putBackWorkItem(fixture);
    expect(acceptanceReadiness(fixture.database, fixture.workItemId).ready).toBe(true);
  }, 60_000);

  it('goes back with its binding and verdicts, and the gate is judged again', async () => {
    const fixture = await workspace();
    await passingGate(fixture);
    await fixture.decide('changes-requested', 'Add a test.');
    await removeWorkItem(fixture);

    const back = await putBackWorkItem(fixture);
    expect(back.status).toBe(200);
    expect(back.body.workItem).toMatchObject({
      removedAt: null,
      removedReason: null,
      repositoryId: fixture.repositoryId,
      humanVerdict: 'changes-requested',
    });
    const body = await boot(fixture);
    expect(body.removed.workItems).toEqual([]);
    expect(body.verdicts).toHaveLength(1);
    expect(body.readiness[fixture.workItemId]).toMatchObject({ ready: true });

    expect((await putBackWorkItem(fixture)).status).toBe(409);
    expect((await putBackWorkItem(fixture, unknownId)).status).toBe(404);
  }, 60_000);

  it('stays removed when its run is imported again, and the preview and the result say so', async () => {
    const fixture = await workspace();
    await fixture.decide('rejected', 'Not this.');
    await removeWorkItem(fixture);
    const receipt = path.join(fixture.directory, 'receipt.json');

    await fixture.writeReceipt('A claim revised after the removal.');
    const previewed = await fixture.post<{ previews: Array<{ removedAt: string | null }> }>(
      '/api/v1/receipts/preview',
      { path: receipt },
    );
    expect(previewed.body.previews[0]?.removedAt).toEqual(expect.any(String));

    const imported = await fixture.post<{
      imported: Array<{ workItem: WorkItemBody }>;
    }>('/api/v1/receipts/import', { path: receipt });
    expect(imported.status).toBe(201);
    expect(imported.body.imported[0]?.workItem).toMatchObject({
      id: fixture.workItemId,
      claim: 'The importer is fixed.',
      removedReason: 'Added by mistake.',
    });
    const body = await boot(fixture);
    expect(body.workItems).toEqual([]);
    expect(fixture.database.getWorkItem(fixture.workItemId)?.claim).toBe('The importer is fixed.');
  }, 60_000);

  it('keeps its receipt too, so a run revised meanwhile opens no gate when it goes back', async () => {
    const fixture = await workspace({ status: 'failed' });
    const checkId = await fixture.approveCheck('process.exit(0)');
    await link(fixture);
    await run(fixture, checkId);
    expect((await boot(fixture)).readiness[fixture.workItemId]).toMatchObject({ ready: false });
    await fixture.decide('rejected', 'The run failed.');
    await removeWorkItem(fixture);

    // The agent writes the run again as complete, under a claim its verdict never judged.
    await writeFile(
      path.join(fixture.directory, 'receipt.json'),
      JSON.stringify({
        schema_version: 1,
        run_id: 'fixture-run',
        source: 'codex',
        title: 'Fix the importer',
        claim: 'Everything is fine now.',
        status: 'complete',
        started_at: '2026-10-22T10:00:00.000Z',
      }),
    );
    expect((await fixture.importReceipt()).status).toBe(201);
    await putBackWorkItem(fixture);

    expect(fixture.database.listReceipts()[0]?.degraded).toBe(true);
    expect((await boot(fixture)).readiness[fixture.workItemId]).toMatchObject({
      ready: false,
      degraded: true,
    });
    const plainly = await fixture.decide<ErrorBody>('accepted', 'Accepting.');
    expect(plainly.status).toBe(409);
    expect(plainly.body.error).toBe('required_gates_open');
  }, 60_000);

  it('stays out of a directory import, and the other runs in it still import', async () => {
    const fixture = await workspace();
    await fixture.decide('rejected', 'Not this.');
    await removeWorkItem(fixture);
    const batch = path.join(fixture.directory, 'batch');
    await mkdir(batch);
    const receipt = (runId: string, claim: string) =>
      JSON.stringify({
        schema_version: 1,
        run_id: runId,
        source: 'codex',
        title: runId,
        claim,
        status: 'complete',
        started_at: '2026-10-22T10:00:00.000Z',
      });
    // The first run's claim differs from the one its verdict judged, which alone would refuse the batch.
    await writeFile(path.join(batch, 'a.json'), receipt('fixture-run', 'A revised claim.'));
    await writeFile(path.join(batch, 'b.json'), receipt('a-new-run', 'A new claim.'));

    const previewed = await fixture.post<{
      previews: Array<{ runId: string; removedAt: string | null }>;
    }>('/api/v1/receipts/preview', { path: batch });
    const removedAtOf = (runId: string) =>
      previewed.body.previews.find((preview) => preview.runId === runId)?.removedAt;
    expect(removedAtOf('fixture-run')).toEqual(expect.any(String));
    expect(removedAtOf('a-new-run')).toBeNull();

    const imported = await fixture.post<ErrorBody>('/api/v1/receipts/import', { path: batch });
    expect(imported.status).toBe(201);
    const body = await boot(fixture);
    expect(body.workItems.map((item) => item.title)).toEqual(['a-new-run']);
    expect(body.removed.workItems.map((item) => item.id)).toEqual([fixture.workItemId]);
  }, 60_000);
});

describe('recorded history', () => {
  const historyRows = (database: VeriDoneDatabase) =>
    JSON.stringify({
      verdicts: database.connection.prepare('SELECT * FROM verdicts ORDER BY id').all(),
      evidence: database.connection.prepare('SELECT * FROM evidence ORDER BY id').all(),
    });

  it('keeps every verdict and evidence row through removals and put backs, and the triggers hold', async () => {
    const fixture = await workspace();
    await passingGate(fixture);
    await fixture.decide('changes-requested', 'First.');
    await fixture.decide('rejected', 'Second.');
    const before = historyRows(fixture.database);
    const root = await onlyRoot(fixture);

    await removeWorkItem(fixture);
    expect(historyRows(fixture.database)).toBe(before);
    await removeRepository(fixture);
    expect(historyRows(fixture.database)).toBe(before);
    await removeRoot(fixture, root.id);
    expect(historyRows(fixture.database)).toBe(before);
    await fixture.post(`/api/v1/roots/${root.id}/approve`, {});
    await putBackRepository(fixture);
    await putBackWorkItem(fixture);
    expect(historyRows(fixture.database)).toBe(before);

    const connection = fixture.database.connection;
    expect(() => connection.prepare('DELETE FROM verdicts').run()).toThrow(/append-only/u);
    expect(() => connection.prepare('DELETE FROM evidence').run()).toThrow(/append-only/u);
    expect(() => connection.prepare("UPDATE verdicts SET note = 'changed'").run()).toThrow(
      /append-only/u,
    );
  }, 60_000);

  it('still reads a removed work item in full: chain, output and packet', async () => {
    const fixture = await workspace();
    await passingGate(fixture);
    await fixture.decide('changes-requested', 'First.');
    await fixture.decide('rejected', 'Second.');
    await removeWorkItem(fixture);

    const body = await boot(fixture);
    expect(
      body.verdicts
        .filter((verdict) => verdict.workItemId === fixture.workItemId)
        .map((verdict) => verdict.sequence)
        .toSorted(),
    ).toEqual([1, 2]);
    const evidenceId = body.evidence[0]?.id;
    expect((await fixture.get(`/api/v1/evidence/${evidenceId}/output`)).status).toBe(200);
    const packet = await fixture.get<{ verdicts: unknown[] }>(
      `/api/v1/work-items/${fixture.workItemId}/packet/json`,
    );
    expect(packet.status).toBe(200);
    expect(packet.body.verdicts).toHaveLength(2);
  }, 60_000);
});

describe('packets', () => {
  it('show a removed work item in every format, and the packet verifies', async () => {
    const fixture = await workspace();
    await fixture.decide('rejected', 'Not this.');
    await removeWorkItem(fixture, fixture.workItemId, 'Added by mistake.');

    const built = await buildAcceptancePacket(fixture.database, fixture.workItemId);
    expect(built.packet.workItem.removedAt).toEqual(expect.any(String));
    expect(built.packet.workItem.removedReason).toBe('Added by mistake.');
    for (const text of [built.markdown, built.html]) {
      expect(text).toContain('Removed from review');
      expect(text).toContain('Added by mistake.');
    }
    const verified = await verifyAcceptancePacket(JSON.parse(built.json));
    expect(verified.valid).toBe(true);
    expect(verified.signed).toBe(true);
  }, 60_000);

  it('show a removed repository with its last state in every format, and the packet verifies', async () => {
    const fixture = await workspace();
    const stored = fixture.database.getRepository(fixture.repositoryId);
    await fixture.decide('rejected', 'Not this.');
    await removeRepository(fixture, fixture.repositoryId, 'Moved to another disk.');

    const built = await buildAcceptancePacket(fixture.database, fixture.workItemId);
    expect(built.packet.repository).toMatchObject({
      name: path.basename(fixture.repositoryPath),
      head: stored?.snapshot.head,
      removedAt: expect.any(String),
      removedReason: 'Moved to another disk.',
    });
    for (const text of [built.markdown, built.html]) {
      expect(text).toContain('Repository removed');
      expect(text).toContain('Moved to another disk.');
      expect(text).toContain(stored?.snapshot.head ?? 'no head');
    }
    expect((await verifyAcceptancePacket(JSON.parse(built.json))).valid).toBe(true);
  }, 60_000);

  it('keep a reason of several lines on the one line that states it', async () => {
    const fixture = await workspace();
    await removeWorkItem(fixture, fixture.workItemId, 'One line.\n- Verdict: accepted');
    const built = await buildAcceptancePacket(fixture.database, fixture.workItemId);
    expect(built.markdown.split('\n').filter((line) => line.startsWith('- Verdict:'))).toEqual([
      '- Verdict: No human verdict',
    ]);
    expect(built.packet.workItem.removedReason).toBe('One line.\n- Verdict: accepted');
  }, 60_000);

  it('say nothing of a removal while nothing is removed', async () => {
    const fixture = await workspace();
    const built = await buildAcceptancePacket(fixture.database, fixture.workItemId);
    expect(built.packet.workItem.removedAt).toBeNull();
    expect(built.packet.repository?.removedAt).toBeNull();
    for (const text of [built.markdown, built.html]) {
      expect(text).not.toContain('Removed from review');
      expect(text).not.toContain('Repository removed');
    }
  }, 60_000);

  it('keep the paths of removed roots and repositories on the redaction list', async () => {
    const fixture = await workspace();
    const added = fixture.database.addApprovedRoot('/work/clients/acme', 'Acme');
    fixture.database.removeRoot(added.id, 'Handed over.');
    const repositoryPath = fixture.database.getRepository(fixture.repositoryId)?.path ?? '';
    await removeRepository(fixture);

    const known = await knownLocalPaths(fixture.database, []);
    expect(known).toContain('/work/clients/acme');
    expect(known).toContain(repositoryPath);

    await fixture.writeReceipt('It read /work/clients/acme/plan.txt on the way.');
    await fixture.importReceipt();
    const built = await buildAcceptancePacket(fixture.database, fixture.workItemId);
    expect(built.json).not.toContain('clients/acme');
    expect(built.json).toContain('[LOCAL_PATH]');
  }, 60_000);

  it('redact a local path written into a reason', async () => {
    const fixture = await workspace();
    const recorded = fixture.database.getRepository(fixture.repositoryId)?.path ?? '';
    await removeRepository(fixture, fixture.repositoryId, `Moved away from ${recorded}.`);
    await removeWorkItem(fixture, fixture.workItemId, `Filed under ${recorded}.`);
    const built = await buildAcceptancePacket(fixture.database, fixture.workItemId);
    expect(built.json).not.toContain(path.basename(path.dirname(recorded)));
    expect(built.markdown).not.toContain(path.basename(path.dirname(recorded)));
    expect(built.html).not.toContain(path.basename(path.dirname(recorded)));
  }, 60_000);
});

describe('backups', () => {
  /** A removal of each kind on a workspace with history. */
  async function withRemovals() {
    const fixture = await workspace();
    await passingGate(fixture);
    await fixture.decide('rejected', 'Not this.');
    const root = await onlyRoot(fixture);
    await removeWorkItem(fixture, fixture.workItemId, 'Item reason.');
    await removeRepository(fixture, fixture.repositoryId, 'Repository reason.');
    await removeRoot(fixture, root.id, 'Root reason.');
    return { fixture, root };
  }

  /** The document as a build without these fields wrote it. */
  async function withoutRemovalFields(document: WorkspaceDocument) {
    const { integrity: _integrity, ...payload } = structuredClone(document);
    const data = payload.data as unknown as Record<string, Array<Record<string, unknown>>>;
    for (const list of [data.approvedRoots, data.repositories, data.workItems]) {
      for (const record of list ?? []) {
        delete record.removedAt;
        delete record.removedReason;
      }
    }
    return {
      ...payload,
      integrity: { algorithm: 'sha256', payloadHash: await sha256Hex(canonicalJson(payload)) },
    };
  }

  /** The document with a change to its data, under a hash that matches. */
  async function altered(
    document: WorkspaceDocument,
    change: (data: WorkspaceDocument['data']) => void,
  ) {
    const { integrity: _integrity, ...payload } = structuredClone(document);
    change(payload.data);
    return {
      ...payload,
      integrity: { algorithm: 'sha256', payloadHash: await sha256Hex(canonicalJson(payload)) },
    };
  }

  it('carry removed records, which stay removed where the workspace lacks them', async () => {
    const { fixture, root } = await withRemovals();
    const document = await exportWorkspace(fixture.database);
    expect(document.data.approvedRoots[0]).toMatchObject({ removedReason: 'Root reason.' });
    expect(document.data.repositories[0]).toMatchObject({ removedReason: 'Repository reason.' });
    expect(document.data.workItems[0]).toMatchObject({ removedReason: 'Item reason.' });

    const target = freshDatabase();
    const preview = await importWorkspace(target, document, { dryRun: true });
    expect(target.listRoots()).toEqual([]);
    expect(preview.added.roots).toEqual([]);
    expect(preview.added.repositories).toEqual([]);
    expect(preview.added.workItems).toEqual([]);
    expect(preview.added.removed.map((record) => record.kind).toSorted()).toEqual([
      'repository',
      'root',
      'workItem',
    ]);
    expect(preview.imported).toMatchObject({ approvedRoots: 1, repositories: 1, workItems: 1 });

    await importWorkspace(target, document);
    expect(target.getRoot(root.id)).toMatchObject({
      status: 'pending',
      removedReason: 'Root reason.',
    });
    expect(target.getRepository(fixture.repositoryId)?.removedReason).toBe('Repository reason.');
    expect(target.getWorkItem(fixture.workItemId)?.removedReason).toBe('Item reason.');
    expect(target.listActiveRoots()).toEqual([]);
    expect(target.listActiveRepositories()).toEqual([]);
    expect(target.listActiveWorkItems()).toEqual([]);
    expect(target.listEvidence()).toHaveLength(1);
    expect(target.listVerdicts()).toHaveLength(1);
    // A second round trip finds every record in place.
    const again = await importWorkspace(target, document);
    expect(again.imported).toMatchObject({ approvedRoots: 0, repositories: 0, workItems: 0 });
  }, 60_000);

  it('restore a backup from before removals existed, with nothing removed', async () => {
    const fixture = await workspace();
    await passingGate(fixture);
    await fixture.decide('rejected', 'Not this.');
    const older = await withoutRemovalFields(await exportWorkspace(fixture.database));

    const target = freshDatabase();
    const result = await importWorkspace(target, older);
    expect(result.added.removed).toEqual([]);
    expect(result.added.workItems).toHaveLength(1);
    expect(target.listActiveWorkItems()).toHaveLength(1);
    expect(target.listActiveRepositories()).toHaveLength(1);
    expect(target.listActiveRoots().map((root) => root.status)).toEqual(['pending']);
  }, 60_000);

  it('never undo a local removal, and find those records unchanged', async () => {
    const { fixture, root } = await withRemovals();
    const older = await withoutRemovalFields(await exportWorkspace(fixture.database));

    const result = await importWorkspace(fixture.database, older);
    expect(result.imported).toMatchObject({ approvedRoots: 0, repositories: 0, workItems: 0 });
    expect(result.unchanged).toMatchObject({ approvedRoots: 1, repositories: 1, workItems: 1 });
    expect(result.added.removed).toEqual([]);
    expect(fixture.database.getRoot(root.id)?.removedReason).toBe('Root reason.');
    expect(fixture.database.getRepository(fixture.repositoryId)?.removedReason).toBe(
      'Repository reason.',
    );
    expect(fixture.database.getWorkItem(fixture.workItemId)?.removedReason).toBe('Item reason.');
  }, 60_000);

  it('never remove a local record', async () => {
    const fixture = await workspace();
    const document = await altered(await exportWorkspace(fixture.database), (data) => {
      for (const list of [data.approvedRoots, data.repositories, data.workItems]) {
        for (const record of list) {
          record.removedAt = new Date().toISOString();
          record.removedReason = 'A backup says so.';
        }
      }
    });

    await importWorkspace(fixture.database, document);
    expect(fixture.database.listActiveRoots()).toHaveLength(1);
    expect(fixture.database.listActiveRepositories()).toHaveLength(1);
    expect(fixture.database.listActiveWorkItems()).toHaveLength(1);
  }, 60_000);

  it('can add a verdict to a removed work item, which stays removed', async () => {
    const fixture = await workspace();
    await fixture.decide('rejected', 'First.');
    const target = freshDatabase();
    await importWorkspace(target, await exportWorkspace(fixture.database));
    await fixture.decide('changes-requested', 'Second.');
    const later = await exportWorkspace(fixture.database);
    target.removeWorkItem(fixture.workItemId, 'Not wanted here.');

    const result = await importWorkspace(target, later);
    expect(result.imported.verdicts).toBe(1);
    expect(target.listVerdicts(fixture.workItemId)).toHaveLength(2);
    expect(target.getWorkItem(fixture.workItemId)?.removedReason).toBe('Not wanted here.');
  }, 60_000);
});

describe('a check running when its work leaves', () => {
  /** Starts a check that says when it has started and then waits. */
  async function runningCheck(fixture: Fixture) {
    const started = path.join(fixture.directory, 'started');
    const checkId = await fixture.approveCheck(
      `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'x'); setTimeout(() => {}, 60000)`,
    );
    await link(fixture);
    const running = run(fixture, checkId);
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await access(started);
        return { running };
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  it('is cancelled by removing its work item, and the run stays on record', async () => {
    const fixture = await workspace();
    const { running } = await runningCheck(fixture);
    await removeWorkItem(fixture);
    const finished = await running;
    expect(finished.status).toBe(200);
    expect(finished.body.evidence.result).toBe('cancelled');
    expect(fixture.database.listEvidence(fixture.workItemId)).toHaveLength(1);
  }, 120_000);

  it('is cancelled by removing its repository, which stays as it was', async () => {
    const fixture = await workspace();
    const { running } = await runningCheck(fixture);
    const before = fixture.database.getRepository(fixture.repositoryId)?.snapshot.fingerprint;
    await removeRepository(fixture);
    const finished = await running;
    expect(finished.status).toBe(200);
    expect(finished.body.evidence.result).toBe('cancelled');
    expect(fixture.database.getRepository(fixture.repositoryId)?.snapshot.fingerprint).toBe(before);
  }, 120_000);

  it('is cancelled by removing the only root over its repository', async () => {
    const fixture = await workspace();
    const { running } = await runningCheck(fixture);
    await removeRoot(fixture, (await onlyRoot(fixture)).id);
    const readAtRemoval = fixture.database.getRepository(fixture.repositoryId)?.updatedAt;
    const finished = await running;
    expect(finished.status).toBe(200);
    expect(finished.body.evidence.result).toBe('cancelled');
    // VeriDone reads the repository no more once the root is gone, even for the run it was already in.
    expect(fixture.database.getRepository(fixture.repositoryId)?.updatedAt).toBe(readAtRemoval);
  }, 120_000);

  it('runs on when a root that is not its only cover leaves', async () => {
    const fixture = await workspace();
    const other = await fixture.post<{ root: RootBody }>('/api/v1/roots', {
      path: fixture.repositoryPath,
    });
    const { running } = await runningCheck(fixture);
    await removeRoot(fixture, other.body.root.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fixture.database.listEvidence(fixture.workItemId)).toEqual([]);
    // The check has nothing left to wait for once its own limit passes; this one ends by its timeout.
    const finished = await running;
    expect(finished.body.evidence.result).not.toBe('cancelled');
  }, 120_000);
});
