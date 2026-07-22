import { randomUUID } from 'node:crypto';

import { runApprovedCheck } from './check-runner.js';
import type { EvidenceRecord, VeriDoneDatabase } from './database.js';

type CheckRunner = (
  database: VeriDoneDatabase,
  checkId: string,
  workItemId: string,
  signal?: AbortSignal,
) => Promise<EvidenceRecord>;

export class CheckCapacityError extends Error {
  constructor(readonly limit: number) {
    super(`The check concurrency limit (${limit}) is already in use.`);
  }
}

export class CheckExecutionManager {
  readonly #active = new Map<string, AbortController>();

  constructor(
    readonly concurrencyLimit = 2,
    readonly runner: CheckRunner = runApprovedCheck,
  ) {}

  get activeCount(): number {
    return this.#active.size;
  }

  async run(
    database: VeriDoneDatabase,
    checkId: string,
    workItemId: string,
    requestedRunId?: string,
  ): Promise<{ runId: string; evidence: EvidenceRecord }> {
    if (this.#active.size >= this.concurrencyLimit) {
      throw new CheckCapacityError(this.concurrencyLimit);
    }
    const runId = requestedRunId ?? randomUUID();
    if (this.#active.has(runId)) throw new Error('The check run ID is already active.');
    const controller = new AbortController();
    this.#active.set(runId, controller);
    try {
      return {
        runId,
        evidence: await this.runner(database, checkId, workItemId, controller.signal),
      };
    } finally {
      this.#active.delete(runId);
    }
  }

  cancel(runId: string): boolean {
    const controller = this.#active.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}
