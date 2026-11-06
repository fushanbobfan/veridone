import { describe, expect, it } from 'vitest';

import type { BootstrapDto, VerdictDto } from './api.js';
import { latestVerdict, workItemToReview } from './local-data.js';

const currentFingerprint = 'a'.repeat(64);
const earlierFingerprint = 'b'.repeat(64);

/**
 * A workspace as the service reports it. Readiness comes from the service, which decides what counts (its tests
 * cover the conditions); these tests cover how the review view presents it.
 */
function workspace(options: {
  verdict?: Pick<VerdictDto, 'decision' | 'snapshotFingerprint'>;
  evidence?: boolean;
  restoredEvidence?: boolean;
  /** The agent's receipt reports a failing or incomplete stage. */
  degraded?: boolean;
}): BootstrapDto {
  const passing = Boolean(options.evidence && !options.restoredEvidence);
  return {
    mode: 'local',
    csrfToken: 'token',
    sourceIssues: [],
    roots: [],
    repositories: [
      {
        id: 'repo',
        path: 'D:\\work\\repo',
        name: 'repo',
        snapshot: {
          repositoryId: 'repo',
          head: 'c'.repeat(40),
          branch: 'main',
          statusEntries: [],
          worktreeHash: 'd'.repeat(64),
          diffStats: {
            changedFiles: 0,
            additions: 0,
            deletions: 0,
            binaryFiles: 0,
            untrackedFiles: 0,
          },
          fingerprint: currentFingerprint,
          contractVersion: 'default-v1',
          checkDefinitionVersion: 'checks-v2',
          capturedAt: '2026-10-22T10:00:00.000Z',
        },
        updatedAt: '2026-10-22T10:00:00.000Z',
      },
    ],
    receipts: [],
    workItems: [
      {
        id: 'work',
        repositoryId: 'repo',
        sourceType: 'codex',
        sourceRef: 'codex:run',
        title: 'Revise the importer',
        claim: 'The importer is fixed.',
        sourceLabel: 'Codex receipt',
        updatedAt: '2026-10-22T10:00:00.000Z',
        snapshotFingerprint: currentFingerprint,
        humanVerdict: options.verdict?.decision ?? null,
        claimHash: '9'.repeat(64),
      },
    ],
    contracts: [],
    checks: [
      {
        id: 'check',
        repositoryId: 'repo',
        label: 'Unit tests',
        kind: 'test',
        executable: 'node',
        args: ['--test'],
        versionArgs: ['--version'],
        scopePaths: [],
        cwdRelative: '.',
        timeoutMs: 10_000,
        maxOutputBytes: 10_000,
        resolvedExecutable: '/usr/bin/node',
        executableSha256: 'f'.repeat(64),
        definitionHash: 'e'.repeat(64),
        approvedAt: '2026-10-22T10:00:00.000Z',
        setupArgs: [],
        setupTimeoutMs: 600_000,
        retiredAt: null,
        retiredReason: null,
      },
    ],
    evidence: options.evidence
      ? [
          {
            id: 'evidence',
            workItemId: 'work',
            checkId: 'check',
            kind: 'test',
            label: 'Unit tests',
            result: 'passed',
            repositoryId: 'repo',
            snapshotFingerprint: currentFingerprint,
            head: 'c'.repeat(40),
            contractVersion: 'default-v1',
            checkDefinitionVersion: 'checks-v2',
            completedAt: '2026-10-22T10:05:00.000Z',
            durationMs: 500,
            toolVersion: 'v24.19.0',
            exitCode: 0,
            invalidReason: null,
            isolation: 'clean-checkout',
            toolPath: '/usr/bin/node',
            toolSha256: 'f'.repeat(64),
            origin: options.restoredEvidence ? 'imported' : 'local',
          },
        ]
      : [],
    verdicts: options.verdict
      ? [
          {
            id: 'verdict',
            workItemId: 'work',
            note: 'Reviewed.',
            decidedAt: '2026-10-22T10:06:00.000Z',
            overrideReason: null,
            sequence: 1,
            previousVerdictId: null,
            claimHash: '9'.repeat(64),
            ...options.verdict,
          },
        ]
      : [],
    signingKey: { keyId: 'e'.repeat(64) },
    readiness: {
      work: {
        ready: passing && !options.degraded,
        repositoryIssue: null,
        bound: true,
        bindingFresh: true,
        degraded: options.degraded ?? false,
        checkCount: 1,
        passingCount: passing ? 1 : 0,
        evidenceIds: passing ? ['evidence'] : [],
        scopeDeclared: false,
        scopeDriftPaths: [],
        checks: [
          {
            checkId: 'check',
            state: passing ? 'passed' : options.evidence ? 'stale' : 'missing',
            evidenceId: options.evidence ? 'evidence' : null,
          },
        ],
      },
    },
  };
}

function review(options: Parameters<typeof workspace>[0]) {
  const bootstrap = workspace(options);
  const item = bootstrap.workItems[0];
  if (!item) throw new Error('fixture has no work item');
  return workItemToReview(item, bootstrap);
}

describe('local review state', () => {
  it('locks acceptance while an approved check lacks fresh passing evidence', () => {
    expect(review({ evidence: false })).toMatchObject({ state: 'blocked', gatesReady: false });
  });

  it('opens acceptance once every gate has fresh passing evidence', () => {
    expect(review({ evidence: true })).toMatchObject({ state: 'ready', gatesReady: true });
  });

  it('counts the receipt as a gate that a degraded run fails', () => {
    const clean = review({ evidence: true });
    const degraded = review({ evidence: true, degraded: true });
    expect(degraded).toMatchObject({ state: 'blocked', gatesReady: false });
    expect(degraded.criteria.find((criterion) => criterion.id === 'provenance')?.state).toBe(
      'failed',
    );
    expect(clean.requiredTotal).toBe(degraded.requiredTotal);
    expect(degraded.requiredSatisfied).toBe(clean.requiredSatisfied - 1);
  });

  it('shows restored evidence as history that passes no gate', () => {
    const restored = review({ evidence: true, restoredEvidence: true });
    expect(restored).toMatchObject({ state: 'blocked', gatesReady: false });
    expect(restored.criteria.find((criterion) => criterion.id === 'check')?.detail).toMatch(
      /Restored from a backup/u,
    );
  });

  it('leaves a retired check out of the gate rows', () => {
    const bootstrap = workspace({ evidence: true });
    const item = bootstrap.workItems[0];
    if (!item) throw new Error('fixture has no work item');
    const retired = {
      ...bootstrap,
      checks: bootstrap.checks.map((check) => ({
        ...check,
        retiredAt: '2026-11-05T10:00:00.000Z',
        retiredReason: 'It had a typo.',
      })),
    };
    const row = workItemToReview(item, retired).criteria.map((criterion) => criterion.id);
    expect(row).not.toContain('check');
    expect(row).toContain('checks');
  });

  it('gives the run behind a check row, whose output the review can read', () => {
    const row = review({ evidence: true }).criteria.find((criterion) => criterion.id === 'check');
    expect(row?.evidenceId).toBe('evidence');
    const none = review({ evidence: false }).criteria.find((item) => item.id === 'check');
    expect(none?.evidenceId).toBeUndefined();
  });

  it('leads with the reason a repository cannot be read', () => {
    const bootstrap = workspace({ evidence: true });
    const item = bootstrap.workItems[0];
    const readiness = bootstrap.readiness.work;
    if (!item || !readiness) throw new Error('fixture has no work item');
    const issue = 'VeriDone cannot read the repository app.';
    const unreadable = {
      ...bootstrap,
      readiness: { work: { ...readiness, ready: false, repositoryIssue: issue } },
    };
    expect(workItemToReview(item, unreadable)).toMatchObject({
      reason: issue,
      gatesReady: false,
      state: 'blocked',
    });
  });

  it('names the way out when a check needs fresh evidence', () => {
    expect(review({ evidence: false }).reason).toMatch(/replace or retire it under Checks/u);
  });

  it('copes with a stored time that is no timestamp', () => {
    const bootstrap = workspace({ evidence: true });
    const item = bootstrap.workItems[0];
    if (!item) throw new Error('fixture has no work item');
    expect(workItemToReview({ ...item, updatedAt: 'yesterday' }, bootstrap).updatedLabel).toBe(
      'time unknown',
    );
  });

  it('reads the latest verdict from its position in the chain', () => {
    const bootstrap = workspace({
      evidence: true,
      verdict: { decision: 'accepted', snapshotFingerprint: currentFingerprint },
    });
    const [first] = bootstrap.verdicts;
    if (!first) throw new Error('fixture has no verdict');
    bootstrap.verdicts = [
      first,
      {
        ...first,
        id: 'superseded',
        decision: 'rejected',
        sequence: 2,
        previousVerdictId: first.id,
      },
    ];
    expect(latestVerdict(bootstrap.verdicts, 'work')?.id).toBe('superseded');
  });

  it('keeps a verdict on the current state decided without locking acceptance', () => {
    expect(
      review({
        evidence: true,
        verdict: { decision: 'changes-requested', snapshotFingerprint: currentFingerprint },
      }),
    ).toMatchObject({ state: 'decided', gatesReady: true });
  });

  it('marks a verdict on an earlier state superseded and reopens the item', () => {
    const superseded = review({
      evidence: true,
      verdict: { decision: 'changes-requested', snapshotFingerprint: earlierFingerprint },
    });
    expect(superseded).toMatchObject({ state: 'ready', gatesReady: true });
    expect(superseded.reason).toMatch(/superseded/i);
  });
});
