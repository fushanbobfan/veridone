import type { Evidence, RepositorySnapshot } from './model.js';

export type FreshnessState =
  | 'fresh'
  | 'unbound'
  | 'mismatched-repository'
  | 'stale-commit'
  | 'stale-worktree'
  | 'stale-contract'
  | 'stale-check-definition'
  | 'invalid';

export interface FreshnessAssessment {
  state: FreshnessState;
  usable: boolean;
  reason: string;
}

export function assessEvidenceFreshness(
  evidence: Evidence,
  current: RepositorySnapshot,
): FreshnessAssessment {
  if (evidence.invalidReason || evidence.result !== 'passed') {
    return {
      state: 'invalid',
      usable: false,
      reason: evidence.invalidReason ?? `The check result is ${evidence.result}.`,
    };
  }

  if (!evidence.repositoryId || !evidence.snapshotFingerprint || !evidence.head) {
    return {
      state: 'unbound',
      usable: false,
      reason: 'This evidence is not bound to a repository snapshot.',
    };
  }

  if (evidence.repositoryId !== current.repositoryId) {
    return {
      state: 'mismatched-repository',
      usable: false,
      reason: 'This evidence belongs to a different repository.',
    };
  }

  if (evidence.head !== current.head) {
    return {
      state: 'stale-commit',
      usable: false,
      reason: `The repository moved from ${evidence.head.slice(0, 8)} to ${current.head.slice(0, 8)}.`,
    };
  }

  if (evidence.contractVersion !== current.contractVersion) {
    return {
      state: 'stale-contract',
      usable: false,
      reason: 'The acceptance contract changed after this evidence was captured.',
    };
  }

  if (evidence.checkDefinitionVersion !== current.checkDefinitionVersion) {
    return {
      state: 'stale-check-definition',
      usable: false,
      reason: 'The check definition changed after this evidence was captured.',
    };
  }

  if (evidence.snapshotFingerprint !== current.fingerprint) {
    return {
      state: 'stale-worktree',
      usable: false,
      reason: 'The worktree or index changed after this evidence was captured.',
    };
  }

  return {
    state: 'fresh',
    usable: true,
    reason: 'This evidence matches the current repository and acceptance state.',
  };
}
