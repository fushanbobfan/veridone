import { pathFromStatusEntry } from '@veridone/core';

import type { BootstrapDto, ReadinessDto, VerdictDto, WorkItemDto } from './api.js';
import type { ReviewItem } from './data.js';

const verdictNames: Record<VerdictDto['decision'], string> = {
  accepted: 'acceptance',
  'changes-requested': 'change request',
  rejected: 'rejection',
};

/** The verdict at the head of a work item's chain. */
export function latestVerdict(verdicts: VerdictDto[], workItemId: string): VerdictDto | undefined {
  return verdicts
    .filter((verdict) => verdict.workItemId === workItemId)
    .reduce<VerdictDto | undefined>(
      (latest, verdict) => (!latest || verdict.sequence > latest.sequence ? verdict : latest),
      undefined,
    );
}

function relativeTime(iso: string): string {
  const difference = Date.now() - new Date(iso).getTime();
  // An earlier version could store a receipt time that is no timestamp.
  if (Number.isNaN(difference)) return 'time unknown';
  const minutes = Math.max(0, Math.round(difference / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const unreported: ReadinessDto = {
  ready: false,
  repositoryIssue: null,
  bound: false,
  bindingFresh: false,
  degraded: false,
  checkCount: 0,
  passingCount: 0,
  evidenceIds: [],
  scopeDeclared: false,
  scopeDriftPaths: [],
  checks: [],
};

export function workItemToReview(item: WorkItemDto, bootstrap: BootstrapDto): ReviewItem {
  const repository = bootstrap.repositories.find((candidate) => candidate.id === item.repositoryId);
  const receipt = bootstrap.receipts.find((candidate) =>
    item.sourceRef.endsWith(`:${candidate.runId}`),
  );
  // Readiness is the service's, computed as its verdict gate computes it; this view only presents it.
  const readiness = bootstrap.readiness[item.id] ?? unreported;
  const isBound = readiness.bound;
  const bindingFresh = readiness.bindingFresh;
  const isDegraded = readiness.degraded;
  const checks = bootstrap.checks.filter(
    (check) => check.repositoryId === item.repositoryId && !check.retiredAt,
  );
  const checkAssessments = checks.map((check) => {
    const gate = readiness.checks.find((candidate) => candidate.checkId === check.id);
    const evidence = bootstrap.evidence.find((candidate) => candidate.id === gate?.evidenceId);
    return { check, evidence, state: gate?.state ?? ('missing' as const) };
  });
  const passingChecks = readiness.passingCount;
  const scope = {
    declared: readiness.scopeDeclared,
    satisfied: readiness.scopeDriftPaths.length === 0,
    outsidePaths: readiness.scopeDriftPaths,
  };
  const gatesReady = readiness.ready;
  // A verdict decides the repository state it was recorded on; once that state changes, the
  // verdict stays in the history and the item opens again.
  const verdict = latestVerdict(bootstrap.verdicts, item.id);
  const verdictCurrent = Boolean(
    verdict && repository && verdict.snapshotFingerprint === repository.snapshot.fingerprint,
  );
  const supersededNote =
    verdict && !verdictCurrent
      ? `An earlier ${verdictNames[verdict.decision]} was recorded on a previous repository state and is superseded. `
      : '';
  // The receipt counts as a gate like the others: a run that reports a failing stage fails it.
  const requiredTotal = 2 + Math.max(checks.length, 1) + (scope.declared ? 1 : 0);
  const requiredSatisfied =
    (isDegraded ? 0 : 1) +
    (bindingFresh ? 1 : 0) +
    passingChecks +
    (scope.declared && scope.satisfied ? 1 : 0);
  const riskPaths =
    repository?.snapshot.statusEntries
      .map(pathFromStatusEntry)
      .filter((entry) =>
        /(^|[\\/])(\.env|auth|oauth|crypto|security|permission|secret|token|credential|exports?|packet|workspace|check-runner|path-boundary|\.github)([.\\/]|$)/iu.test(
          entry,
        ),
      ) ?? [];

  return {
    id: item.id,
    title: item.title,
    repository: repository?.name ?? 'Unlinked receipt',
    branch: repository?.snapshot.branch ?? 'not bound',
    head: repository?.snapshot.head.slice(0, 8) ?? 'unbound',
    source: item.sourceLabel,
    state: verdictCurrent
      ? 'decided'
      : isDegraded
        ? 'blocked'
        : gatesReady
          ? 'ready'
          : isBound && !bindingFresh
            ? 'stale'
            : 'blocked',
    gatesReady,
    updatedLabel: relativeTime(item.updatedAt),
    updatedAt: item.updatedAt,
    reason:
      supersededNote +
      (readiness.repositoryIssue
        ? readiness.repositoryIssue
        : isDegraded
          ? 'The imported run contains a degraded or failing stage.'
          : gatesReady
            ? 'Every approved check and declared scope gate has fresh evidence. Human review remains.'
            : scope.declared && !scope.satisfied
              ? `${scope.outsidePaths.length} changed file(s) fall outside the declared scope.`
              : isBound && !bindingFresh
                ? 'The repository changed after this claim was bound. Rebind before running checks.'
                : bindingFresh
                  ? checks.length === 0
                    ? 'The claim is bound, but no acceptance checks have been approved.'
                    : (repository?.snapshot.statusEntries.length ?? 0) > 0
                      ? 'The repository has uncommitted changes. Checks run on a clean checkout of the bound commit; commit the work and rebind.'
                      : `${checks.length - passingChecks} approved check(s) need fresh passing evidence. If one cannot pass as defined, replace or retire it under Checks.`
                  : 'The receipt is valid, but its claim is not bound to a repository snapshot.'),
    requiredSatisfied,
    requiredTotal,
    changedFiles: repository?.snapshot.diffStats.changedFiles ?? 0,
    additions: repository?.snapshot.diffStats.additions ?? 0,
    deletions: repository?.snapshot.diffStats.deletions ?? 0,
    dirty: (repository?.snapshot.statusEntries.length ?? 0) > 0,
    sensitive: riskPaths.length > 0,
    riskPaths,
    scopeDrift: scope.declared && !scope.satisfied,
    scopeDriftPaths: scope.outsidePaths,
    claim: item.claim,
    claimSource: `${item.sourceLabel} · ${relativeTime(item.updatedAt)}`,
    criteria: [
      {
        id: 'provenance',
        title: 'Source parses with preserved provenance',
        detail: receipt
          ? `${receipt.stageCount} stage(s) · ${receipt.status} · imported locally`
          : 'Local source metadata is available',
        state: isDegraded ? 'failed' : 'passed',
        evidenceLabel: 'Import validation',
      },
      {
        id: 'binding',
        title: 'Claim is bound to the current repository state',
        detail: isBound
          ? `${repository?.snapshot.head.slice(0, 8)} · current fingerprint`
          : 'No repository snapshot has been linked',
        state: bindingFresh ? 'passed' : isBound ? 'stale' : 'missing',
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
        : checkAssessments.map(({ check, evidence, state }) => ({
            id: check.id,
            title: check.label,
            detail: !check.executableSha256
              ? 'Approved before tools were pinned; pin, replace or retire it under Checks'
              : evidence?.origin === 'imported'
                ? `Restored from a backup (${evidence.result}); run the check here to count it`
                : evidence
                  ? `${evidence.result} · ${evidence.durationMs} ms · ${evidence.head.slice(0, 8)}${evidence.toolSha256 ? ` · tool ${evidence.toolSha256.slice(0, 8)}` : ''}`
                  : 'Approved; run it for this work item to record evidence',
            state,
            evidenceLabel: check.kind,
            ...(evidence ? { evidenceId: evidence.id } : {}),
          }))),
      ...(scope.declared
        ? [
            {
              id: 'declared-scope',
              title: 'Changed files remain inside declared scope',
              detail: scope.satisfied
                ? 'Every changed path matches an approved prefix'
                : `${scope.outsidePaths.length} outside: ${scope.outsidePaths.slice(0, 3).join(', ')}`,
              state: scope.satisfied ? ('passed' as const) : ('failed' as const),
              evidenceLabel: 'Scope inspection',
            },
          ]
        : []),
    ],
  };
}
