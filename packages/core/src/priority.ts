import type { ContractAssessment } from './gates.js';
import type { WorkItem } from './model.js';

export type TriageState = 'blocked' | 'stale' | 'risky' | 'ready' | 'decided';

export interface TriageAssessment {
  state: TriageState;
  score: number;
  reasons: string[];
}

export function assessTriage(
  item: WorkItem,
  contract: ContractAssessment,
  staleEvidenceCount: number,
): TriageAssessment {
  const reasons: string[] = [];
  let score = 0;

  if (item.humanVerdict) {
    return { state: 'decided', score: -10, reasons: [`Human verdict: ${item.humanVerdict}.`] };
  }

  if (!contract.ready) {
    score += 40;
    reasons.push(
      `${contract.requiredTotal - contract.requiredSatisfied} required gate(s) are open.`,
    );
  }

  if (staleEvidenceCount > 0) {
    score += 30 + Math.min(staleEvidenceCount, 5);
    reasons.push(`${staleEvidenceCount} evidence item(s) are stale.`);
  }

  if (item.hasSensitivePaths) {
    score += 20;
    reasons.push('The change touches security-sensitive paths.');
  }

  if (item.hasScopeDrift) {
    score += 15;
    reasons.push('Changed files extend beyond the declared scope.');
  }

  if (staleEvidenceCount > 0) return { state: 'stale', score, reasons };
  if (!contract.ready) return { state: 'blocked', score, reasons };
  if (item.hasSensitivePaths || item.hasScopeDrift) return { state: 'risky', score, reasons };

  return {
    state: 'ready',
    score: 10,
    reasons: ['All required gates have fresh evidence; a human decision is still required.'],
  };
}
