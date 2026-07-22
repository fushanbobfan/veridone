import { describe, expect, it } from 'vitest';

import { CheckCapacityError, CheckExecutionManager } from './check-execution.js';
import type { EvidenceRecord, VeriDoneDatabase } from './database.js';

describe('check execution manager', () => {
  it('enforces concurrency and exposes cancellation by run ID', async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runner = async (
      _database: VeriDoneDatabase,
      _checkId: string,
      _workItemId: string,
      signal?: AbortSignal,
    ): Promise<EvidenceRecord> => {
      started();
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
      throw new Error('cancelled fixture');
    };
    const manager = new CheckExecutionManager(1, runner);
    const database = {} as VeriDoneDatabase;
    const first = manager.run(
      database,
      'check-1',
      'work-1',
      '00000000-0000-4000-8000-000000000001',
    );
    await didStart;
    expect(manager.activeCount).toBe(1);
    await expect(
      manager.run(database, 'check-2', 'work-2', '00000000-0000-4000-8000-000000000002'),
    ).rejects.toBeInstanceOf(CheckCapacityError);
    expect(manager.cancel('00000000-0000-4000-8000-000000000001')).toBe(true);
    await expect(first).rejects.toThrow('cancelled fixture');
    expect(manager.activeCount).toBe(0);
    expect(manager.cancel('00000000-0000-4000-8000-000000000001')).toBe(false);
  });
});
