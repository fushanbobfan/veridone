import { AlertTriangle, Check, CircleDashed, Clock3, X } from 'lucide-react';

import type { CriterionState, ReviewState } from '../data.js';

type State = ReviewState | CriterionState;

const labels: Record<State, string> = {
  blocked: 'Blocked',
  decided: 'Decided',
  failed: 'Failed',
  missing: 'Missing',
  passed: 'Fresh',
  ready: 'Ready to decide',
  stale: 'Stale',
};

export function StatusMark({ state, compact = false }: { state: State; compact?: boolean }) {
  const Icon =
    state === 'passed' || state === 'ready' || state === 'decided'
      ? Check
      : state === 'stale'
        ? Clock3
        : state === 'failed' || state === 'blocked'
          ? X
          : state === 'missing'
            ? CircleDashed
            : AlertTriangle;

  return (
    <span className={`status-mark status-${state}`} data-state={state}>
      <Icon aria-hidden="true" size={compact ? 13 : 15} strokeWidth={2.25} />
      <span>{labels[state]}</span>
    </span>
  );
}
