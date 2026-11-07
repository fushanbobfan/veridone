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

interface ActiveRun {
  checkId: string;
  workItemId: string;
  controller: AbortController;
}

export class CheckExecutionManager {
  readonly #active = new Map<string, ActiveRun>();

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
    this.#active.set(runId, { checkId, workItemId, controller });
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
    const run = this.#active.get(runId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  /** Cancels the runs that match, as when what they check leaves the workspace; gives how many. */
  cancelWhere(matches: (run: { checkId: string; workItemId: string }) => boolean): number {
    const runs = [...this.#active.values()].filter(matches);
    for (const run of runs) run.controller.abort();
    return runs.length;
  }
}
