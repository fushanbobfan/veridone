import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { acceptanceReadiness } from './check-runner.js';
import { exportWorkspace, importWorkspace, maxWorkspaceBackupBytes } from './workspace.js';
import { buildAcceptancePacket, verifyAcceptancePacket } from './packet.js';
import { VeriDoneDatabase, type VerdictExpectation } from './database.js';
import { boundWorkspace } from './test-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function workspace(options: Parameters<typeof boundWorkspace>[0] = {}) {
  const fixture = await boundWorkspace(options);
  cleanups.push(fixture.cleanup);
  return fixture;
}

interface CheckBody {
  check: {
    id: string;
    definitionHash: string;
    retiredAt: string | null;
    retiredReason: string | null;
  };
}
interface ReadinessBody {
  ready: boolean;
  checkCount: number;
  passingCount: number;
  bindingFresh: boolean;
  repositoryIssue: string | null;
}
interface BootstrapBody {
  checks: Array<{
    id: string;
    definitionHash: string;
    retiredAt: string | null;
    retiredReason: string | null;
  }>;
  evidence: Array<{ id: string; stdout?: string; stderr?: string }>;
  readiness: Record<string, ReadinessBody>;
  roots: Array<{ path: string; missing: boolean }>;
  sourceIssues: Array<{ repositoryId: string; message: string }>;
}
interface RunBody {
  evidence: { id: string; result: string };
  readiness: ReadinessBody;
}
interface ErrorBody {
  error: string;
  message?: string;
}

const rawErrors = /ENOENT|UNIQUE constraint|SQLITE|realpath/u;

describe('retiring a check', () => {
  async function retire(
    fixture: Awaited<ReturnType<typeof workspace>>,
    checkId: string,
    reason = 'The arguments had a typo.',
  ) {
    const { body } = await fixture.get<BootstrapBody>('/api/v1/bootstrap');
    const check = body.checks.find((candidate) => candidate.id === checkId);
    return fixture.post<CheckBody & ErrorBody>(`/api/v1/checks/${checkId}/retire`, {
      reason,
      expected: { definitionHash: check?.definitionHash },
    });
  }
  const rebind = async (fixture: Awaited<ReturnType<typeof workspace>>) => {
    await fixture.post(`/api/v1/repositories/${fixture.repositoryId}/refresh`, {});
    await fixture.post(`/api/v1/work-items/${fixture.workItemId}/link`, {
      repositoryId: fixture.repositoryId,
    });
  };
  const run = (fixture: Awaited<ReturnType<typeof workspace>>, checkId: string) =>
    fixture.post<RunBody & ErrorBody>(`/api/v1/checks/${checkId}/run`, {
      workItemId: fixture.workItemId,
    });

  it('takes the check out of the gate and keeps its history, once the rest run again', async () => {
    const fixture = await workspace();
    const typo = await fixture.approveCheck('process.exit(1)', 'Typo');
    const fixed = await fixture.approveCheck('process.stdout.write("verified")', 'Fixed');
    await rebind(fixture);
    await run(fixture, typo);
    const held = await run(fixture, fixed);
    expect(held.body.readiness).toMatchObject({ ready: false, checkCount: 2, passingCount: 1 });

    const retired = await retire(fixture, typo);
    expect(retired.status).toBe(200);
    expect(retired.body.check.retiredReason).toBe('The arguments had a typo.');
    expect(retired.body.check.retiredAt).toEqual(expect.any(String));

    // The check set changed, so the earlier run of the other check belongs to the old set.
    const { body } = await fixture.get<BootstrapBody>('/api/v1/bootstrap');
    expect(body.readiness[fixture.workItemId]).toMatchObject({
      ready: false,
      bindingFresh: true,
      checkCount: 1,
      passingCount: 0,
    });

    const again = await run(fixture, fixed);
    expect(again.body.readiness).toMatchObject({ ready: true, checkCount: 1, passingCount: 1 });
    expect((await fixture.decide('accepted', 'Accepted.')).status).toBe(201);
    expect(body.evidence.length).toBe(2);
  }, 120_000);

  it('keeps a slow capture from bringing an older set back', async () => {
    const fixture = await workspace();
    const failing = await fixture.approveCheck('process.exit(1)', 'Failing');
    const passing = await fixture.approveCheck('process.exit(0)', 'Passing');
    await run(fixture, failing);
    await run(fixture, passing);
    // A capture that began before the retirement carries the version of the old set.
    const { snapshot: capturedBefore, path: repositoryPath } = fixture.database.getRepository(
      fixture.repositoryId,
    )!;
    await retire(fixture, failing);
    const afterRetire = fixture.database.getRepository(fixture.repositoryId)!;
    expect(afterRetire.snapshot.checkDefinitionVersion).not.toBe(
      capturedBefore.checkDefinitionVersion,
    );

    const written = fixture.database.upsertRepository(repositoryPath, capturedBefore);
    expect(written.snapshot.checkDefinitionVersion).toBe(
      afterRetire.snapshot.checkDefinitionVersion,
    );
    expect(acceptanceReadiness(fixture.database, fixture.workItemId)).toMatchObject({
      ready: false,
      checkCount: 1,
      passingCount: 0,
    });
  }, 120_000);

  it('records the new set at once, even while the repository cannot be read', async () => {
    const fixture = await workspace();
    const failing = await fixture.approveCheck('process.exit(1)', 'Failing');
    const passing = await fixture.approveCheck('process.exit(0)', 'Passing');
    await run(fixture, failing);
    await run(fixture, passing);
    await rm(fixture.repositoryPath, { recursive: true, force: true });
    await retire(fixture, failing);
    expect(acceptanceReadiness(fixture.database, fixture.workItemId)).toMatchObject({
      ready: false,
      passingCount: 0,
    });
  }, 120_000);

  it('replaces in one step, and a refusal leaves the old check counting', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck('process.exit(1)', 'Old');
    const { body } = await fixture.get<BootstrapBody>('/api/v1/bootstrap');
    const definitionHash = body.checks[0]?.definitionHash;
    const definition = (executable: string) => ({
      repositoryId: fixture.repositoryId,
      label: 'New',
      kind: 'test',
      executable,
      args: ['-e', 'process.exit(0)'],
      cwdRelative: '.',
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    });
    const count = () => fixture.database.listChecks().length;

    const staleView = await fixture.post<ErrorBody>(`/api/v1/checks/${checkId}/replace`, {
      check: definition(process.execPath),
      reason: 'Stale view.',
      expected: { definitionHash: 'a'.repeat(64) },
    });
    expect(staleView.status).toBe(409);
    expect(count()).toBe(1);
    const badTool = await fixture.post<ErrorBody>(`/api/v1/checks/${checkId}/replace`, {
      check: definition('this-tool-is-not-installed'),
      reason: 'A tool that is not there.',
      expected: { definitionHash },
    });
    expect(badTool.status).toBe(400);
    expect(count()).toBe(1);
    const otherRepository = await fixture.post<ErrorBody>(`/api/v1/checks/${checkId}/replace`, {
      check: { ...definition(process.execPath), repositoryId: 'another-repository' },
      reason: 'The wrong repository.',
      expected: { definitionHash },
    });
    expect(otherRepository.status).toBe(400);
    expect(count()).toBe(1);
    expect(fixture.database.getCheck(checkId)?.retiredAt).toBeNull();

    const replaced = await fixture.post<{
      check: { id: string };
      retired: { id: string; retiredReason: string };
    }>(`/api/v1/checks/${checkId}/replace`, {
      check: definition(process.execPath),
      reason: 'It always failed.',
      expected: { definitionHash },
    });
    expect(replaced.status).toBe(201);
    expect(replaced.body.retired).toMatchObject({
      id: checkId,
      retiredReason: 'It always failed.',
    });
    expect(fixture.database.listActiveChecks(fixture.repositoryId).map((c) => c.label)).toEqual([
      'New',
    ]);
    const ran = await run(fixture, replaced.body.check.id);
    expect(ran.body.readiness).toMatchObject({ ready: true, checkCount: 1 });
  }, 120_000);

  it('asks for a reason and the definition the operator saw, and happens once', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck('process.exit(0)');
    const { body } = await fixture.get<BootstrapBody>('/api/v1/bootstrap');
    const definitionHash = body.checks[0]?.definitionHash;

    const noReason = await fixture.post<ErrorBody>(`/api/v1/checks/${checkId}/retire`, {
      reason: '  ',
      expected: { definitionHash },
    });
    expect(noReason.status).toBe(400);
    const staleView = await fixture.post<ErrorBody>(`/api/v1/checks/${checkId}/retire`, {
      reason: 'Stale view.',
      expected: { definitionHash: 'a'.repeat(64) },
    });
    expect(staleView.status).toBe(409);
    expect(staleView.body.error).toBe('check_changed');
    const unknown = await fixture.post<ErrorBody>(
      '/api/v1/checks/00000000-0000-4000-8000-000000000000/retire',
      { reason: 'Unknown.', expected: { definitionHash } },
    );
    expect(unknown.status).toBe(404);

    expect((await retire(fixture, checkId)).status).toBe(200);
    const twice = await retire(fixture, checkId);
    expect(twice.status).toBe(409);
    expect(twice.body.error).toBe('check_retired');
  }, 30_000);

  it('refuses to run or pin a retired check, and says it is retired', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck('process.exit(0)');
    await retire(fixture, checkId);
    await rebind(fixture);

    const ran = await run(fixture, checkId);
    expect(ran.status).toBe(400);
    expect(ran.body.message).toContain('retired');
    const tool = await fixture.get<ErrorBody>(`/api/v1/checks/${checkId}/tool`);
    expect(tool.status).toBe(409);
    expect(tool.body.error).toBe('check_retired');
    const pinned = await fixture.post<ErrorBody>(`/api/v1/checks/${checkId}/pin`, {
      expected: { path: process.execPath, sha256: 'a'.repeat(64) },
    });
    expect(pinned.status).toBe(409);
  }, 30_000);

  it('leaves the gate closed when no check is left', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck('process.exit(0)');
    await rebind(fixture);
    expect((await run(fixture, checkId)).body.readiness.ready).toBe(true);

    await retire(fixture, checkId);
    await rebind(fixture);
    const { body } = await fixture.get<BootstrapBody>('/api/v1/bootstrap');
    expect(body.readiness[fixture.workItemId]).toMatchObject({ ready: false, checkCount: 0 });
    expect((await fixture.decide('accepted', 'Nothing left to pass.')).status).toBe(409);
  }, 30_000);

  it('shows the retirement and its reason in every packet format, and the packet verifies', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck('process.exit(0)', 'Old tests');
    await retire(fixture, checkId, 'Replaced by the suite with a setup step.');

    const built = await buildAcceptancePacket(fixture.database, fixture.workItemId);
    const listed = built.packet.checks.find((check) => check.id === checkId);
    expect(listed?.retiredAt).toEqual(expect.any(String));
    expect(listed?.retiredReason).toBe('Replaced by the suite with a setup step.');
    for (const text of [built.markdown, built.html]) {
      expect(text).toContain('Old tests');
      expect(text).toContain('Replaced by the suite with a setup step.');
      expect(text).toMatch(/retired/iu);
    }
    expect((await verifyAcceptancePacket(JSON.parse(built.json))).valid).toBe(true);
  }, 30_000);

  it('redacts a local path written into the reason', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck('process.exit(0)');
    await retire(fixture, checkId, `Moved away from ${fixture.repositoryPath}.`);
    const built = await buildAcceptancePacket(fixture.database, fixture.workItemId);
    expect(built.json).not.toContain(path.basename(fixture.directory));
  }, 30_000);

  it('carries through a backup, and a backup never retires a local check', async () => {
    const fixture = await workspace();
    const retiredId = await fixture.approveCheck('process.exit(1)', 'Retired');
    const activeId = await fixture.approveCheck('process.exit(0)', 'Active');
    await retire(fixture, retiredId, 'No longer needed.');
    const document = await exportWorkspace(fixture.database);

    const restored = new VeriDoneDatabase(':memory:');
    cleanups.push(async () => restored.close());
    await importWorkspace(restored, document);
    const back = restored.listChecks().find((check) => check.id === retiredId);
    expect(back?.retiredReason).toBe('No longer needed.');
    expect(restored.listChecks().find((check) => check.id === activeId)?.retiredAt).toBeNull();

    // The same backup, with the active check retired in it, leaves the local check as it is.
    const { integrity: _integrity, ...payload } = document;
    const altered = structuredClone(payload);
    const entry = altered.data.checks.find((check) => check.id === activeId);
    if (!entry) throw new Error('The check is missing from the backup.');
    entry.retiredAt = new Date().toISOString();
    entry.retiredReason = 'A backup says so.';
    const { canonicalJson, sha256Hex } = await import('@veridone/core');
    await importWorkspace(fixture.database, {
      ...altered,
      integrity: { algorithm: 'sha256', payloadHash: await sha256Hex(canonicalJson(altered)) },
    });
    expect(fixture.database.getCheck(activeId)?.retiredAt).toBeNull();
  }, 30_000);

  it('can retire while the repository folder is gone', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck('process.exit(0)');
    await rm(fixture.repositoryPath, { recursive: true, force: true });
    expect((await retire(fixture, checkId, 'The folder is gone.')).status).toBe(200);
  }, 30_000);

  it('names replacing or retiring when a legacy tool cannot be pinned', async () => {
    const fixture = await workspace();
    const added = fixture.database.addCheck({
      repositoryId: fixture.repositoryId,
      label: 'Legacy',
      kind: 'test',
      executable: '.venv/bin/pytest',
      args: [],
      versionArgs: ['--version'],
      scopePaths: [],
      cwdRelative: '.',
      timeoutMs: 60_000,
      maxOutputBytes: 1_000_000,
      resolvedExecutable: null,
      executableSha256: null,
      definitionHash: 'b'.repeat(64),
      setupArgs: [],
      setupTimeoutMs: 600_000,
    });
    const tool = await fixture.get<ErrorBody>(`/api/v1/checks/${added.id}/tool`);
    expect(tool.status).toBe(400);
    expect(tool.body.message).toMatch(/replace it .*or retire it/iu);
    await rebind(fixture);
    const ran = await run(fixture, added.id);
    expect(ran.status).toBe(400);
    expect(ran.body.message).toMatch(/replace or retire/iu);
  }, 30_000);
});

describe('decisions when the repository cannot be read', () => {
  it('still records a rejection, a change request and an override, and refuses a plain acceptance', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck('process.exit(0)');
    await fixture.post(`/api/v1/work-items/${fixture.workItemId}/link`, {
      repositoryId: fixture.repositoryId,
    });
    await fixture.post(`/api/v1/checks/${checkId}/run`, { workItemId: fixture.workItemId });
    const expected: VerdictExpectation = await fixture.expectedState();
    await rm(fixture.repositoryPath, { recursive: true, force: true });

    const { body } = await fixture.get<BootstrapBody>('/api/v1/bootstrap');
    const readiness = body.readiness[fixture.workItemId];
    expect(readiness?.ready).toBe(false);
    expect(readiness?.repositoryIssue).toContain(fixture.repositoryPath);
    expect(readiness?.repositoryIssue).toMatch(/override reason/u);
    expect(readiness?.repositoryIssue).not.toMatch(rawErrors);
    expect(body.sourceIssues[0]?.message).not.toMatch(rawErrors);

    const plainly = await fixture.decide<ErrorBody>('accepted', 'No override.', { expected });
    expect(plainly.status).toBe(409);
    expect(plainly.body.error).toBe('required_gates_open');
    expect(plainly.body.message).toContain(fixture.repositoryPath);

    expect((await fixture.decide('rejected', 'The folder is gone.')).status).toBe(201);
    expect((await fixture.decide('changes-requested', 'Restore the folder.')).status).toBe(201);
    const overridden = await fixture.decide<{ verdict: { overrideReason: string } }>(
      'accepted',
      'Reviewed from another copy.',
      { overrideReason: 'The folder moved.' },
    );
    expect(overridden.status).toBe(201);
    expect(overridden.body.verdict.overrideReason).toBe('The folder moved.');
    const packet = await fixture.get('/api/v1/work-items/' + fixture.workItemId + '/packet/json');
    expect(packet.status).toBe(200);
  }, 30_000);

  it('still compares what the reviewer saw', async () => {
    const fixture = await workspace();
    const stale = await fixture.expectedState();
    await fixture.decide('rejected', 'First.');
    await rm(fixture.repositoryPath, { recursive: true, force: true });
    const conflict = await fixture.decide<ErrorBody>('rejected', 'Second.', { expected: stale });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('verdict_conflict');
  }, 30_000);

  it('records a decision on a restored work item with no root approved', async () => {
    const fixture = await workspace();
    const document = await exportWorkspace(fixture.database);
    const fresh = new VeriDoneDatabase(':memory:');
    cleanups.push(async () => fresh.close());
    await importWorkspace(fresh, document);
    expect(fresh.listApprovedRoots()).toEqual([]);
    const { createApp } = await import('./app.js');
    const app = createApp({
      database: fresh,
      csrfToken: 'test-token',
      config: {
        host: '127.0.0.1',
        port: 4317,
        dataDirectory: fixture.directory,
        databasePath: ':memory:',
        allowedOrigins: [],
        demoMode: false,
      },
    });
    const response = await app.request(
      `http://127.0.0.1:4317/api/v1/work-items/${fixture.workItemId}/verdicts`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-VeriDone-CSRF': 'test-token' },
        body: JSON.stringify({
          decision: 'rejected',
          note: 'Elsewhere now.',
          expected: await fixture.expectedState(),
        }),
      },
    );
    expect(response.status).toBe(201);
  }, 30_000);
});

describe('a missing root folder', () => {
  it('stops nothing under the other roots and is marked', async () => {
    const fixture = await workspace();
    const other = await realpath(await mkdtemp(path.join(tmpdir(), 'veridone-other-root-')));
    cleanups.push(() => rm(other, { recursive: true, force: true }));
    await fixture.post('/api/v1/roots', { path: other });
    await rm(other, { recursive: true, force: true });

    const refreshed = await fixture.post(
      `/api/v1/repositories/${fixture.repositoryId}/refresh`,
      {},
    );
    expect(refreshed.status).toBe(200);
    const added = await fixture.post('/api/v1/repositories', { path: fixture.repositoryPath });
    expect(added.status).toBe(201);
    expect((await fixture.decide('rejected', 'Still decided.')).status).toBe(201);

    const { body } = await fixture.get<BootstrapBody>('/api/v1/bootstrap');
    expect(body.roots.find((root) => root.path === other)?.missing).toBe(true);
    expect(body.roots.find((root) => root.path !== other)?.missing).toBe(false);
  }, 30_000);

  it('answers discovery and adding in plain words', async () => {
    const fixture = await workspace();
    const other = await realpath(await mkdtemp(path.join(tmpdir(), 'veridone-other-root-')));
    cleanups.push(() => rm(other, { recursive: true, force: true }));
    const created = await fixture.post<{ root: { id: string } }>('/api/v1/roots', { path: other });
    await rm(other, { recursive: true, force: true });

    const discovered = await fixture.post<ErrorBody>('/api/v1/repositories/discover', {
      rootId: created.body.root.id,
    });
    expect(discovered.status).toBe(400);
    expect(discovered.body.message).toContain(other);
    expect(discovered.body.message).not.toMatch(rawErrors);
    const again = await fixture.post<ErrorBody>('/api/v1/roots', { path: other });
    expect(again.status).toBe(400);
    expect(again.body.message).not.toMatch(rawErrors);
  }, 30_000);
});

describe('backups', () => {
  it('writes nothing a restore would refuse, and names the next step', async () => {
    const database = new VeriDoneDatabase(':memory:');
    cleanups.push(async () => database.close());
    const { createApp } = await import('./app.js');
    const app = createApp({
      database,
      csrfToken: 'test-token',
      maxBackupBytes: 100,
      config: {
        host: '127.0.0.1',
        port: 4317,
        dataDirectory: 'the-data-directory',
        databasePath: ':memory:',
        allowedOrigins: [],
        demoMode: false,
      },
    });
    const response = await app.request('http://127.0.0.1:4317/api/v1/workspace/export');
    expect(response.status).toBe(413);
    const body = (await response.json()) as ErrorBody;
    expect(body.error).toBe('workspace_too_large');
    expect(body.message).toContain('the-data-directory');
  });

  it('refuses from the stored size alone, before reading any output', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck("process.stdout.write('x'.repeat(5000))");
    await fixture.post(`/api/v1/work-items/${fixture.workItemId}/link`, {
      repositoryId: fixture.repositoryId,
    });
    await fixture.post(`/api/v1/checks/${checkId}/run`, { workItemId: fixture.workItemId });
    expect(fixture.database.evidenceOutputBytes()).toBeGreaterThanOrEqual(5000);

    const { createApp } = await import('./app.js');
    const small = createApp({
      database: fixture.database,
      maxBackupBytes: 4000,
      config: {
        host: '127.0.0.1',
        port: 4317,
        dataDirectory: fixture.directory,
        databasePath: ':memory:',
        allowedOrigins: [],
        demoMode: false,
      },
    });
    const listEvidence = vi.spyOn(fixture.database, 'listEvidence');
    const response = await small.request('http://127.0.0.1:4317/api/v1/workspace/export');
    expect(response.status).toBe(413);
    expect(listEvidence).not.toHaveBeenCalled();
    listEvidence.mockRestore();
  }, 30_000);

  it('restores what export writes, up to one shared limit', async () => {
    const fixture = await workspace();
    const response = await fixture.app.request('http://127.0.0.1:4317/api/v1/workspace/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(maxWorkspaceBackupBytes + 1),
        'X-VeriDone-CSRF': fixture.csrfToken,
      },
      body: '{}',
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as ErrorBody;
    expect(body.error).toBe('workspace_too_large');
    expect(body.message).toContain('500 MB');

    const under = await fixture.app.request('http://127.0.0.1:4317/api/v1/workspace/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '26000000',
        'X-VeriDone-CSRF': fixture.csrfToken,
      },
      body: '{}',
    });
    expect(under.status).not.toBe(413);
  });

  it('says a file is no backup in plain words', async () => {
    const fixture = await workspace();
    for (const body of ['not json', '{"integrity":{"algorithm":"sha256"}}']) {
      const response = await fixture.app.request('http://127.0.0.1:4317/api/v1/workspace/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-VeriDone-CSRF': fixture.csrfToken },
        body,
      });
      expect(response.status, body).toBe(400);
      const answer = (await response.json()) as ErrorBody;
      expect(answer.message, body).toMatch(/backup/iu);
    }
  });
});

describe('records an older version stored', () => {
  const insertReceipt = (
    database: VeriDoneDatabase,
    fields: { runId: string; startedAt: string; status?: string; taskType?: string },
  ) => {
    database.importReceipts([
      {
        runId: fields.runId,
        taskType: fields.taskType ?? 'implementation',
        status: fields.status ?? 'complete',
        startedAt: fields.startedAt,
        completedAt: null,
        stageCount: 0,
        degraded: false,
        sourcePath: `/legacy/${fields.runId.slice(0, 16)}.json`,
        sourceType: 'harness',
        sourceLabel: 'Legacy',
        title: 'Legacy run',
        claim: 'A claim from an older version.',
      },
    ]);
  };

  it("exports a snapshot wider than today's capture records", async () => {
    const fixture = await workspace();
    const { path: repositoryPath, snapshot } = fixture.database.getRepository(
      fixture.repositoryId,
    )!;
    fixture.database.upsertRepository(repositoryPath, {
      ...snapshot,
      statusEntries: Array.from({ length: 10_001 }, (_, index) => `?? file-${index}`),
      submoduleEntries: Array.from({ length: 1_001 }, (_, index) => `+abc module-${index}`),
    });
    const document = await exportWorkspace(fixture.database);
    const restored = new VeriDoneDatabase(':memory:');
    cleanups.push(async () => restored.close());
    await importWorkspace(restored, document);
    expect(restored.getRepository(fixture.repositoryId)?.snapshot.submoduleEntries).toHaveLength(
      1_001,
    );
  }, 30_000);

  it('exports a root whose folder name is longer than a label may be', async () => {
    const fixture = await workspace();
    fixture.database.addApprovedRoot(path.join(fixture.directory, 'x'.repeat(121)));
    const document = await exportWorkspace(fixture.database);
    const restored = new VeriDoneDatabase(':memory:');
    cleanups.push(async () => restored.close());
    await importWorkspace(restored, document);
    expect(restored.listRoots().some((root) => root.label === 'x'.repeat(121))).toBe(true);
  }, 30_000);

  it("exports and restores values that today's import would refuse", async () => {
    const fixture = await workspace();
    insertReceipt(fixture.database, { runId: 'r'.repeat(600), startedAt: '2026-07-01T00:00:00Z' });
    insertReceipt(fixture.database, { runId: 'odd-time', startedAt: 'yesterday' });
    insertReceipt(fixture.database, {
      runId: 'long-fields',
      startedAt: '2026-07-01T00:00:00Z',
      status: 's'.repeat(300),
      taskType: 't'.repeat(300),
    });

    const document = await exportWorkspace(fixture.database);
    expect(document.data.receipts.map((receipt) => receipt.runId)).toContain('r'.repeat(600));
    const restored = new VeriDoneDatabase(':memory:');
    cleanups.push(async () => restored.close());
    const result = await importWorkspace(restored, document);
    expect(result.imported.receipts).toBe(document.data.receipts.length);
  }, 30_000);
});

describe('receipts', () => {
  it('imports a second run from the same file, and a revised claim under a new run id', async () => {
    const fixture = await workspace();
    const receiptPath = path.join(fixture.directory, 'same.json');
    const write = (runId: string, claim: string) =>
      writeFile(
        receiptPath,
        JSON.stringify({
          schema_version: 1,
          run_id: runId,
          source: 'codex',
          title: 'Same file',
          claim,
          status: 'complete',
          started_at: '2026-10-22T10:00:00.000Z',
        }),
      );
    await write('first-run', 'First claim.');
    expect((await fixture.post('/api/v1/receipts/import', { path: receiptPath })).status).toBe(201);
    await write('second-run', 'Second claim.');
    const second = await fixture.post<ErrorBody>('/api/v1/receipts/import', { path: receiptPath });
    expect(second.status).toBe(201);
    const runs = fixture.database.listReceipts().map((receipt) => receipt.runId);
    expect(runs).toEqual(expect.arrayContaining(['first-run', 'second-run']));
    // Both rows name the same file, and a backup carries both.
    const document = await exportWorkspace(fixture.database);
    const restored = new VeriDoneDatabase(':memory:');
    cleanups.push(async () => restored.close());
    await importWorkspace(restored, document);
    expect(restored.listReceipts().map((receipt) => receipt.runId)).toEqual(
      expect.arrayContaining(['first-run', 'second-run']),
    );
  }, 30_000);
});

describe('the receipts table', () => {
  it('holds a receipt by its run id, and its index survives the rebuild', () => {
    const database = new VeriDoneDatabase(':memory:');
    cleanups.push(async () => database.close());
    const indexes = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'receipts'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain('receipts_started_at_idx');
    const columns = database.connection.prepare('PRAGMA index_list(receipts)').all() as Array<{
      name: string;
      unique: number;
    }>;
    const uniqueColumns = columns
      .filter((index) => index.unique === 1)
      .flatMap(
        (index) =>
          database.connection.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{
            name: string;
          }>,
      )
      .map((column) => column.name);
    expect(uniqueColumns).toContain('run_id');
    expect(uniqueColumns).not.toContain('source_path');
  });
});

describe('check output', () => {
  it('stays out of the bootstrap and reads on demand, bounded', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck(
      "process.stdout.write('x'.repeat(9000)); process.stderr.write('Cannot find module')",
    );
    await fixture.post(`/api/v1/work-items/${fixture.workItemId}/link`, {
      repositoryId: fixture.repositoryId,
    });
    const run = await fixture.post<RunBody>(`/api/v1/checks/${checkId}/run`, {
      workItemId: fixture.workItemId,
    });
    const { body } = await fixture.get<BootstrapBody>('/api/v1/bootstrap');
    expect(body.evidence[0]).not.toHaveProperty('stdout');
    expect(body.evidence[0]).not.toHaveProperty('stderr');

    const output = await fixture.get<{ stdout: string; stderr: string; truncated: boolean }>(
      `/api/v1/evidence/${run.body.evidence.id}/output`,
    );
    expect(output.status).toBe(200);
    expect(output.body.stdout).toHaveLength(9000);
    expect(output.body.stderr).toBe('Cannot find module');
    expect(output.body.truncated).toBe(false);
    const unknown = await fixture.get(
      '/api/v1/evidence/00000000-0000-4000-8000-000000000000/output',
    );
    expect(unknown.status).toBe(404);
  }, 30_000);

  it('keeps the end of a long output, where a failure usually shows', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck(
      "process.stdout.write('x'.repeat(200000) + 'the end')",
    );
    await fixture.database.connection
      .prepare('UPDATE checks SET max_output_bytes = 1000000 WHERE id = ?')
      .run(checkId);
    await fixture.post(`/api/v1/work-items/${fixture.workItemId}/link`, {
      repositoryId: fixture.repositoryId,
    });
    const run = await fixture.post<RunBody>(`/api/v1/checks/${checkId}/run`, {
      workItemId: fixture.workItemId,
    });
    const output = await fixture.get<{ stdout: string; truncated: boolean }>(
      `/api/v1/evidence/${run.body.evidence.id}/output`,
    );
    expect(output.body.truncated).toBe(true);
    expect(output.body.stdout.length).toBeLessThanOrEqual(65_536);
    expect(output.body.stdout.endsWith('the end')).toBe(true);
  }, 30_000);
});
