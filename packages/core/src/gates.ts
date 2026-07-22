import { assessEvidenceFreshness, type FreshnessAssessment } from './freshness.js';
import type { AcceptanceContract, Criterion, Evidence, RepositorySnapshot } from './model.js';

export interface CriterionAssessment {
  criterion: Criterion;
  satisfied: boolean;
  matchingEvidence: Array<{ evidence: Evidence; freshness: FreshnessAssessment }>;
  reason: string;
}

export interface ContractAssessment {
  ready: boolean;
  requiredSatisfied: number;
  requiredTotal: number;
  criteria: CriterionAssessment[];
}

export function assessContract(
  contract: AcceptanceContract,
  evidence: Evidence[],
  snapshot: RepositorySnapshot,
): ContractAssessment {
  const criteria = contract.criteria.map((criterion): CriterionAssessment => {
    const matchingEvidence = evidence
      .filter((item) => criterion.accepts.includes(item.kind))
      .map((item) => ({ evidence: item, freshness: assessEvidenceFreshness(item, snapshot) }));
    const satisfied = matchingEvidence.some(({ freshness }) => freshness.usable);

    return {
      criterion,
      satisfied,
      matchingEvidence,
      reason: satisfied
        ? 'Satisfied by fresh, passing evidence.'
        : matchingEvidence.length === 0
          ? 'No matching evidence has been captured.'
          : 'Matching evidence exists but is not fresh and passing.',
    };
  });
  const required = criteria.filter(({ criterion }) => criterion.required);

  return {
    ready: required.every(({ satisfied }) => satisfied),
    requiredSatisfied: required.filter(({ satisfied }) => satisfied).length,
    requiredTotal: required.length,
    criteria,
  };
}
