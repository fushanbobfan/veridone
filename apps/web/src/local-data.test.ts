import { describe, expect, it } from 'vitest';

import type { BootstrapDto, VerdictDto } from './api.js';
import { latestVerdict, workItemToReview } from './local-data.js';

const currentFingerprint = 'a'.repeat(64);
const earlierFingerprint = 'b'.repeat(64);

function workspace(options: {
  verdict?: Pick<VerdictDto, 'decision' | 'snapshotFingerprint'>;
  evidence?: boolean;
  /** Evidence recorded before checks ran in a clean checkout carries no isolation. */
  legacyEvidence?: boolean;
  restoredEvidence?: boolean;
}): BootstrapDto {
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
            completedAt: '2026-10-22T10:05:00.000Z',
            durationMs: 500,
            toolVersion: 'v24.19.0',
            exitCode: 0,
            invalidReason: null,
            isolation: options.legacyEvidence ? null : 'clean-checkout',
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

  it('does not count evidence that did not run in a clean checkout', () => {
    expect(review({ evidence: true, legacyEvidence: true })).toMatchObject({
      state: 'blocked',
      gatesReady: false,
    });
  });

  it('shows restored evidence as history that passes no gate', () => {
    const restored = review({ evidence: true, restoredEvidence: true });
    expect(restored).toMatchObject({ state: 'blocked', gatesReady: false });
    expect(restored.criteria.find((criterion) => criterion.id === 'check')?.detail).toMatch(
      /Restored from a backup/u,
    );
  });

  it('reads the latest verdict from the chain rather than the list order', () => {
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
