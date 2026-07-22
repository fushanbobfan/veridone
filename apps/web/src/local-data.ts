import type { BootstrapDto, WorkItemDto } from './api.js';
import type { ReviewItem } from './data.js';

function relativeTime(iso: string): string {
  const difference = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.round(difference / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function workItemToReview(item: WorkItemDto, bootstrap: BootstrapDto): ReviewItem {
  const repository = bootstrap.repositories.find((candidate) => candidate.id === item.repositoryId);
  const receipt = bootstrap.receipts.find(
    (candidate) => `harness:${candidate.runId}` === item.sourceRef,
  );
  const isBound = Boolean(repository && item.snapshotFingerprint);
  const isDegraded = receipt?.degraded ?? false;
  const checks = bootstrap.checks.filter((check) => check.repositoryId === item.repositoryId);
  const checkAssessments = checks.map((check) => {
    const evidence = bootstrap.evidence.find(
      (candidate) => candidate.workItemId === item.id && candidate.checkId === check.id,
    );
    const fresh =
      evidence?.result === 'passed' &&
      evidence.snapshotFingerprint === repository?.snapshot.fingerprint &&
      evidence.invalidReason === null;
    return { check, evidence, fresh };
  });
  const passingChecks = checkAssessments.filter((assessment) => assessment.fresh).length;
  const checksReady = checks.length > 0 && passingChecks === checks.length;
  const verdict = bootstrap.verdicts.find((candidate) => candidate.workItemId === item.id);
  const requiredTotal = 2 + Math.max(checks.length, 1);
  const requiredSatisfied = 1 + (isBound ? 1 : 0) + passingChecks;

  return {
    id: item.id,
    title: item.title,
    repository: repository?.name ?? 'Unlinked receipt',
    branch: repository?.snapshot.branch ?? 'not bound',
    head: repository?.snapshot.head.slice(0, 8) ?? 'unbound',
    source: item.sourceLabel,
    state:
      item.humanVerdict || verdict
        ? 'decided'
        : isDegraded
          ? 'blocked'
          : isBound && checksReady
            ? 'ready'
            : 'blocked',
    updatedLabel: relativeTime(item.updatedAt),
    reason: isDegraded
      ? 'The imported run contains a degraded or failing stage.'
      : isBound && checksReady
        ? 'Every approved check has fresh passing evidence. Human review remains.'
        : isBound
          ? checks.length === 0
            ? 'The claim is bound, but no acceptance checks have been approved.'
            : `${checks.length - passingChecks} approved check(s) need fresh passing evidence.`
          : 'The receipt is valid, but its claim is not bound to a repository snapshot.',
    requiredSatisfied,
    requiredTotal,
    changedFiles: repository?.snapshot.statusEntries.length ?? 0,
    additions: 0,
    deletions: 0,
    dirty: (repository?.snapshot.statusEntries.length ?? 0) > 0,
    sensitive: false,
    scopeDrift: false,
    claim: item.claim,
    claimSource: `${item.sourceLabel} · ${relativeTime(item.updatedAt)}`,
    criteria: [
      {
        id: 'provenance',
        title: 'Source parses with preserved provenance',
        detail: receipt
          ? `${receipt.stageCount} stage(s) · ${receipt.status} · imported locally`
          : 'Local source metadata is available',
        state: 'passed',
        evidenceLabel: 'Import validation',
      },
      {
        id: 'binding',
        title: 'Claim is bound to the current repository state',
        detail: isBound
          ? `${repository?.snapshot.head.slice(0, 8)} · current fingerprint`
          : 'No repository snapshot has been linked',
        state: isBound ? 'passed' : 'missing',
        evidenceLabel: 'Git snapshot',
      },
      ...(checkAssessments.length === 0
        ? [
            {
              id: 'checks',
              title: 'At least one acceptance check is approved',
              detail: 'No local executable check has been approved',
              state: 'missing' as const,
              evidenceLabel: 'Independent checks',
            },
          ]
        : checkAssessments.map(({ check, evidence, fresh }) => ({
            id: check.id,
            title: check.label,
            detail: evidence
              ? `${evidence.result} · ${evidence.durationMs} ms · ${evidence.head.slice(0, 8)}`
              : 'Approved, but not run for this work item',
            state: fresh
              ? ('passed' as const)
              : evidence?.result === 'failed' || evidence?.result === 'mutated'
                ? ('failed' as const)
                : evidence
                  ? ('stale' as const)
                  : ('missing' as const),
            evidenceLabel: check.kind,
          }))),
    ],
  };
}
