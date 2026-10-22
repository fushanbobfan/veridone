import { randomUUID } from 'node:crypto';

import { canonicalJson, sha256Hex } from '@veridone/core';
import { afterEach, describe, expect, it } from 'vitest';

import { checkDefinitionHash } from './check-policy.js';
import { acceptanceReadiness } from './check-runner.js';
import { VeriDoneDatabase } from './database.js';
import { boundWorkspace } from './test-fixtures.js';
import { exportWorkspace, importWorkspace, WorkspaceConflictError } from './workspace.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function emptyDatabase(): VeriDoneDatabase {
  const database = new VeriDoneDatabase(':memory:');
  cleanups.push(() => database.close());
  return database;
}

type Backup = Record<string, unknown> & {
  schemaVersion: number;
  data: {
    workItems: Array<Record<string, unknown>>;
    checks: Array<Record<string, unknown>>;
    evidence: Array<Record<string, unknown>>;
    verdicts: Array<Record<string, unknown>>;
  };
};

/** Recomputes a backup's checksum, as anyone who edits the file can. */
async function resealed(backup: Backup): Promise<Backup> {
  const { integrity: _integrity, ...payload } = backup;
  return {
    ...payload,
    integrity: { algorithm: 'sha256', payloadHash: await sha256Hex(canonicalJson(payload)) },
  } as Backup;
}

/** A workspace whose work item has a passing check run between two verdicts. */
async function decidedWorkspace() {
  const fixture = await boundWorkspace();
  cleanups.push(fixture.cleanup);
  const checkId = await fixture.approveCheck('process.exit(0)');
  const decide = async (decision: string, note: string) => {
    const response = await fixture.post(`/api/v1/work-items/${fixture.workItemId}/verdicts`, {
      decision,
      note,
    });
    expect(response.status).toBe(201);
  };
  await decide('changes-requested', 'Add a regression test.');
  await fixture.post(`/api/v1/checks/${checkId}/run`, { workItemId: fixture.workItemId });
  await decide('accepted', 'Reviewed with fresh evidence.');
  const backup = (await exportWorkspace(fixture.database)) as unknown as Backup;
  return { ...fixture, checkId, backup };
}

function history(database: VeriDoneDatabase, workItemId: string) {
  return database
    .listVerdicts(workItemId)
    .map(({ id, decision, sequence, previousVerdictId }) => ({
      id,
      decision,
      sequence,
      previousVerdictId,
    }))
    .sort((left, right) => left.sequence - right.sequence);
}

describe('verdict and evidence history is append-only', () => {
  it('refuses to change or remove a recorded verdict or evidence record', async () => {
    const { database } = await decidedWorkspace();
    const statements = [
      "UPDATE verdicts SET decision = 'rejected'",
      'DELETE FROM verdicts',
      "UPDATE evidence SET result = 'failed'",
      'DELETE FROM evidence',
    ];
    for (const statement of statements) {
      expect(() => database.connection.prepare(statement).run()).toThrow(/append-only/u);
    }
  }, 30_000);

  it('accepts a verdict only as the successor of the latest one', async () => {
    const { database, workItemId } = await decidedWorkspace();
    const latest = database.latestVerdict(workItemId);
    if (!latest) throw new Error('The fixture recorded no verdict.');
    const successor = { ...latest, id: randomUUID(), decision: 'rejected' as const };

    expect(() =>
      database.appendVerdict({ ...successor, sequence: 1, previousVerdictId: null }),
    ).toThrow(/extend the latest verdict/u);
    expect(() =>
      database.appendVerdict({
        ...successor,
        sequence: latest.sequence + 1,
        previousVerdictId: latest.previousVerdictId,
      }),
    ).toThrow(/extend the latest verdict/u);
    database.appendVerdict({
      ...successor,
      sequence: latest.sequence + 1,
      previousVerdictId: latest.id,
    });
    expect(database.latestVerdict(workItemId)?.id).toBe(successor.id);
  }, 30_000);
});

describe('workspace restore', () => {
  it('replays the verdict history into an empty workspace', async () => {
    const { database, workItemId, backup } = await decidedWorkspace();
    const restored = emptyDatabase();

    const result = await importWorkspace(restored, backup);

    expect(result.imported).toMatchObject({ workItems: 1, checks: 1, evidence: 1, verdicts: 2 });
    expect(history(restored, workItemId)).toEqual(history(database, workItemId));
    expect(restored.getWorkItem(workItemId)?.humanVerdict).toBe('accepted');
    expect(restored.listEvidence().map((evidence) => evidence.origin)).toEqual(['imported']);
  }, 30_000);

  it('makes restored checks wait for a pinned tool and recomputes their definition', async () => {
    const { backup } = await decidedWorkspace();
    const restored = emptyDatabase();

    await importWorkspace(restored, backup);

    const [check] = restored.listChecks();
    if (!check) throw new Error('The backup restored no check.');
    expect(check).toMatchObject({ resolvedExecutable: null, executableSha256: null });
    expect(check.definitionHash).toBe(await checkDefinitionHash(check));
  }, 30_000);

  it('never lets restored evidence satisfy a gate', async () => {
    const { database, workItemId } = await decidedWorkspace();
    const [passing] = database.listEvidence(workItemId);
    if (!passing) throw new Error('The fixture recorded no evidence.');
    const later = (milliseconds: number) =>
      new Date(Date.parse(passing.completedAt) + milliseconds).toISOString();
    const { id: _id, ...recorded } = passing;
    database.recordEvidence({ ...recorded, result: 'failed', completedAt: later(1_000) });
    expect(acceptanceReadiness(database, workItemId).ready).toBe(false);

    database.recordImportedEvidence({ ...passing, id: randomUUID(), completedAt: later(2_000) });

    expect(acceptanceReadiness(database, workItemId).ready).toBe(false);
  }, 30_000);

  it('adds nothing when the workspace already holds the backup', async () => {
    const { database, backup } = await decidedWorkspace();
    const restored = emptyDatabase();
    await importWorkspace(restored, backup);

    for (const target of [restored, database]) {
      const result = await importWorkspace(target, backup);
      expect(Object.values(result.imported).every((count) => count === 0)).toBe(true);
      expect(result.unchanged).toMatchObject({ workItems: 1, evidence: 1, verdicts: 2 });
    }
  }, 30_000);

  it('rejects a backup that rewrites a recorded verdict, even with a recomputed checksum', async () => {
    const { post, database, workItemId, backup } = await decidedWorkspace();
    const before = history(database, workItemId);
    const edited = structuredClone(backup);
    for (const verdict of edited.data.verdicts) verdict.decision = 'rejected';

    const response = await post<{ error: string; message: string }>(
      '/api/v1/workspace/import',
      await resealed(edited),
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: 'workspace_conflict' });
    expect(response.body.message).toMatch(/never replaced/u);
    expect(history(database, workItemId)).toEqual(before);
  }, 30_000);

  it('rejects a backup whose verdict history diverges from the local one', async () => {
    const { database, workItemId, backup } = await decidedWorkspace();
    const other = emptyDatabase();
    await importWorkspace(other, backup);
    const head = database.latestVerdict(workItemId);
    if (!head) throw new Error('The fixture recorded no verdict.');
    const {
      id: _id,
      decidedAt: _decidedAt,
      sequence: _s,
      previousVerdictId: _p,
      ...verdict
    } = head;
    database.recordVerdict({ ...verdict, decision: 'rejected', note: 'Decided here.' });
    other.recordVerdict({ ...verdict, decision: 'changes-requested', note: 'Decided elsewhere.' });
    const before = history(database, workItemId);

    await expect(importWorkspace(database, await exportWorkspace(other))).rejects.toThrow(
      WorkspaceConflictError,
    );
    expect(history(database, workItemId)).toEqual(before);
  }, 30_000);

  it('keeps a local record when the backup carries a different copy of it', async () => {
    const { database, workItemId, backup } = await decidedWorkspace();
    const edited = structuredClone(backup);
    const [workItem] = edited.data.workItems;
    if (workItem) workItem.title = 'Renamed in the backup';

    const result = await importWorkspace(database, await resealed(edited));

    expect(result.unchanged.workItems).toBe(1);
    expect(database.getWorkItem(workItemId)?.title).toBe('Fix the importer');
  }, 30_000);

  it('restores a backup written by VeriDone 1.1', async () => {
    const { database, workItemId, backup } = await decidedWorkspace();
    const legacy = structuredClone(backup);
    legacy.schemaVersion = 1;
    for (const verdict of legacy.data.verdicts) {
      delete verdict.sequence;
      delete verdict.previousVerdictId;
    }
    for (const evidence of legacy.data.evidence) {
      for (const field of ['isolation', 'toolPath', 'toolSha256', 'origin']) delete evidence[field];
    }
    for (const check of legacy.data.checks) {
      delete check.resolvedExecutable;
      delete check.executableSha256;
    }
    const restored = emptyDatabase();

    const result = await importWorkspace(restored, await resealed(legacy));

    expect(result.imported.verdicts).toBe(2);
    expect(history(restored, workItemId)).toEqual(history(database, workItemId));
  }, 30_000);
});
