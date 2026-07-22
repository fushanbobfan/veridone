import { describe, expect, it } from 'vitest';

import {
  assessDeclaredScope,
  assessContract,
  assessEvidenceFreshness,
  assessTriage,
  createRepositorySnapshot,
  type AcceptanceContract,
  type Evidence,
  type WorkItem,
} from './index.js';

const capturedAt = '2026-07-21T20:00:00.000Z';

async function fixture() {
  const snapshot = await createRepositorySnapshot(
    {
      repositoryId: 'repo-1',
      head: '1234567890abcdef',
      branch: 'main',
      statusEntries: [],
      submoduleEntries: [],
      contractVersion: '1',
      checkDefinitionVersion: '1',
    },
    capturedAt,
  );
  const evidence: Evidence = {
    id: 'ev-1',
    workItemId: 'work-1',
    kind: 'test',
    label: 'Unit tests',
    source: 'veridone-check',
    result: 'passed',
    repositoryId: snapshot.repositoryId,
    snapshotFingerprint: snapshot.fingerprint,
    head: snapshot.head,
    contractVersion: snapshot.contractVersion,
    checkDefinitionVersion: snapshot.checkDefinitionVersion,
    startedAt: capturedAt,
    completedAt: capturedAt,
    artifactHashes: [],
    invalidReason: null,
  };
  return { snapshot, evidence };
}

describe('repository-bound evidence', () => {
  it('is fresh only for the exact snapshot', async () => {
    const { snapshot, evidence } = await fixture();
    expect(assessEvidenceFreshness(evidence, snapshot).state).toBe('fresh');

    const changed = await createRepositorySnapshot(
      {
        repositoryId: snapshot.repositoryId,
        head: snapshot.head,
        branch: snapshot.branch,
        statusEntries: [' M src/index.ts'],
        submoduleEntries: snapshot.submoduleEntries,
        contractVersion: snapshot.contractVersion,
        checkDefinitionVersion: snapshot.checkDefinitionVersion,
      },
      capturedAt,
    );
    expect(assessEvidenceFreshness(evidence, changed)).toMatchObject({
      state: 'stale-worktree',
      usable: false,
    });
  });

  it('never treats a non-passing check as usable', async () => {
    const { snapshot, evidence } = await fixture();
    expect(assessEvidenceFreshness({ ...evidence, result: 'timed-out' }, snapshot)).toMatchObject({
      state: 'invalid',
      usable: false,
    });
  });

  it('separates repository identity from acceptance-policy freshness', async () => {
    const { snapshot, evidence } = await fixture();
    const policyChanged = await createRepositorySnapshot(
      {
        repositoryId: snapshot.repositoryId,
        head: snapshot.head,
        branch: snapshot.branch,
        statusEntries: snapshot.statusEntries,
        submoduleEntries: snapshot.submoduleEntries,
        worktreeHash: snapshot.worktreeHash,
        diffStats: snapshot.diffStats,
        contractVersion: snapshot.contractVersion,
        checkDefinitionVersion: '2',
      },
      capturedAt,
    );

    expect(policyChanged.fingerprint).toBe(snapshot.fingerprint);
    expect(assessEvidenceFreshness(evidence, policyChanged)).toMatchObject({
      state: 'stale-check-definition',
      usable: false,
    });
  });
});

describe('acceptance gates', () => {
  it('requires fresh evidence for required criteria', async () => {
    const { snapshot, evidence } = await fixture();
    const contract: AcceptanceContract = {
      id: 'contract-1',
      version: '1',
      title: 'Default',
      criteria: [
        { id: 'tests', title: 'Tests pass', required: true, accepts: ['test'] },
        { id: 'browser', title: 'Browser verified', required: true, accepts: ['browser'] },
      ],
    };

    expect(assessContract(contract, [evidence], snapshot)).toMatchObject({
      ready: false,
      requiredSatisfied: 1,
      requiredTotal: 2,
    });
  });
});

describe('triage', () => {
  it('explains stale and risky work', () => {
    const item: WorkItem = {
      id: 'work-1',
      title: 'Harden export',
      repositoryId: 'repo-1',
      sourceLabel: 'Codex',
      updatedAt: capturedAt,
      hasSensitivePaths: true,
      hasScopeDrift: false,
      humanVerdict: null,
    };
    const result = assessTriage(
      item,
      { ready: false, requiredSatisfied: 1, requiredTotal: 2, criteria: [] },
      2,
    );

    expect(result.state).toBe('stale');
    expect(result.score).toBeGreaterThan(80);
    expect(result.reasons).toHaveLength(3);
  });
});

describe('declared scope', () => {
  it('uses path boundaries instead of unsafe string prefixes', () => {
    expect(
      assessDeclaredScope([' M apps/web/src/App.tsx', '?? apps/webhook/escape.ts'], ['apps/web']),
    ).toMatchObject({
      declared: true,
      satisfied: false,
      outsidePaths: ['apps/webhook/escape.ts'],
    });
  });

  it('treats an absent declaration as unknown rather than drift', () => {
    expect(assessDeclaredScope([' M SECURITY.md'], [])).toMatchObject({
      declared: false,
      satisfied: true,
      outsidePaths: [],
    });
  });
});
