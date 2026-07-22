export type ReviewState = 'stale' | 'blocked' | 'ready' | 'decided';
export type CriterionState = 'passed' | 'stale' | 'failed' | 'missing';

export interface ReviewCriterion {
  id: string;
  title: string;
  detail: string;
  state: CriterionState;
  evidenceLabel: string;
}

export interface ReviewItem {
  id: string;
  title: string;
  repository: string;
  branch: string;
  head: string;
  source: string;
  state: ReviewState;
  updatedLabel: string;
  reason: string;
  requiredSatisfied: number;
  requiredTotal: number;
  changedFiles: number;
  additions: number;
  deletions: number;
  dirty: boolean;
  sensitive: boolean;
  scopeDrift: boolean;
  claim: string;
  claimSource: string;
  criteria: ReviewCriterion[];
}

export const demoReviews: ReviewItem[] = [
  {
    id: 'export-hardening',
    title: 'Harden workspace export bundles',
    repository: 'veridone',
    branch: 'feat/portable-packets',
    head: '8b19f21a',
    source: 'Codex',
    state: 'stale',
    updatedLabel: '8 min ago',
    reason: 'Two checks belong to the previous worktree fingerprint.',
    requiredSatisfied: 3,
    requiredTotal: 5,
    changedFiles: 11,
    additions: 482,
    deletions: 67,
    dirty: true,
    sensitive: true,
    scopeDrift: false,
    claim: 'Export validation, integrity manifests, and all related tests are complete.',
    claimSource: 'Codex run · 8 minutes ago',
    criteria: [
      {
        id: 'manifest',
        title: 'Manifest detects artifact tampering',
        detail: '22 assertions · 1.8 s · current HEAD',
        state: 'passed',
        evidenceLabel: 'Integration test',
      },
      {
        id: 'secrets',
        title: 'Exports exclude secrets and absolute paths',
        detail: 'Secret scan · 0 findings · current HEAD',
        state: 'passed',
        evidenceLabel: 'Security check',
      },
      {
        id: 'roundtrip',
        title: 'Workspace round-trip is transactional',
        detail: 'Passed on 6c20ee9d; worktree changed afterward',
        state: 'stale',
        evidenceLabel: 'Integration test',
      },
      {
        id: 'browser',
        title: 'Export journey works in a real browser',
        detail: 'No browser evidence has been captured',
        state: 'missing',
        evidenceLabel: 'Playwright',
      },
      {
        id: 'scope',
        title: 'Changed files remain inside declared scope',
        detail: '11 changed files match the acceptance contract',
        state: 'passed',
        evidenceLabel: 'Scope inspection',
      },
    ],
  },
  {
    id: 'receipt-import',
    title: 'Import harness run receipts',
    repository: 'veridone',
    branch: 'feat/receipt-adapter',
    head: 'f3c9e74b',
    source: 'Codex',
    state: 'ready',
    updatedLabel: '21 min ago',
    reason: 'All required gates have fresh evidence. Human review remains.',
    requiredSatisfied: 4,
    requiredTotal: 4,
    changedFiles: 7,
    additions: 319,
    deletions: 14,
    dirty: false,
    sensitive: false,
    scopeDrift: false,
    claim: 'Complete and degraded harness receipts import with source provenance preserved.',
    claimSource: 'Codex run · 21 minutes ago',
    criteria: [
      {
        id: 'complete',
        title: 'Complete receipts preserve run metadata',
        detail: 'Fixture and real-receipt tests · current HEAD',
        state: 'passed',
        evidenceLabel: 'Adapter test',
      },
      {
        id: 'degraded',
        title: 'Degraded stages remain visible',
        detail: '4 degraded states checked · current HEAD',
        state: 'passed',
        evidenceLabel: 'Adapter test',
      },
      {
        id: 'inert',
        title: 'Imported command text stays inert',
        detail: 'Hostile payload regression test · current HEAD',
        state: 'passed',
        evidenceLabel: 'Security test',
      },
      {
        id: 'invalid',
        title: 'Malformed and oversized files fail atomically',
        detail: '9 boundary cases · current HEAD',
        state: 'passed',
        evidenceLabel: 'Integration test',
      },
    ],
  },
  {
    id: 'keyboard-flow',
    title: 'Restore keyboard-only review flow',
    repository: 'veridone',
    branch: 'fix/focus-return',
    head: '2a74d88c',
    source: 'Claude Code',
    state: 'blocked',
    updatedLabel: '47 min ago',
    reason: 'Focus does not return to the trigger after closing the evidence dialog.',
    requiredSatisfied: 2,
    requiredTotal: 4,
    changedFiles: 4,
    additions: 88,
    deletions: 31,
    dirty: false,
    sensitive: false,
    scopeDrift: true,
    claim: 'Keyboard navigation and dialog focus management are fixed.',
    claimSource: 'Claude Code run · 47 minutes ago',
    criteria: [
      {
        id: 'tab',
        title: 'All review actions are keyboard reachable',
        detail: 'Chromium keyboard journey · current HEAD',
        state: 'passed',
        evidenceLabel: 'Playwright',
      },
      {
        id: 'focus',
        title: 'Dialogs return focus to their trigger',
        detail: 'Expected trigger focus; received document body',
        state: 'failed',
        evidenceLabel: 'Playwright',
      },
      {
        id: 'axe',
        title: 'No serious or critical axe violations',
        detail: '0 serious violations · current HEAD',
        state: 'passed',
        evidenceLabel: 'Accessibility scan',
      },
      {
        id: 'scope',
        title: 'No unrelated files changed',
        detail: 'Theme persistence changed outside declared scope',
        state: 'missing',
        evidenceLabel: 'Scope inspection',
      },
    ],
  },
];
