import { describe, expect, it } from 'vitest';

import { summarizeTestOutput } from './test-summary.js';

describe('test summaries', () => {
  it('reads the node:test spec reporter', () => {
    const output = [
      '✔ a (0.5ms)',
      'ℹ tests 3',
      'ℹ suites 0',
      'ℹ pass 2',
      'ℹ fail 0',
      'ℹ cancelled 0',
      'ℹ skipped 1',
      'ℹ todo 0',
      'ℹ duration_ms 159.83',
    ].join('\n');
    expect(summarizeTestOutput(output)).toEqual({
      runner: 'node:test',
      total: 3,
      passed: 2,
      failed: 0,
      skipped: 1,
    });
  });

  it('reads the node:test TAP reporter, cancelled tests counting as failed', () => {
    const output = [
      '1..4',
      '# tests 4',
      '# pass 2',
      '# fail 1',
      '# cancelled 1',
      '# skipped 0',
    ].join('\n');
    expect(summarizeTestOutput(output)).toEqual({
      runner: 'node:test',
      total: 4,
      passed: 2,
      failed: 2,
      skipped: 0,
    });
  });

  it('reads vitest, colored or plain, and leaves its file count alone', () => {
    const output =
      ' Test Files  1 failed | 15 passed (16)\n      Tests  \u001b[31m1 failed\u001b[39m | 127 passed | 2 skipped (130)\n';
    expect(summarizeTestOutput(output)).toEqual({
      runner: 'vitest',
      total: 130,
      passed: 127,
      failed: 1,
      skipped: 2,
    });
  });

  it('reads jest', () => {
    expect(
      summarizeTestOutput('Tests:       1 failed, 2 skipped, 3 passed, 6 total\nTime: 1.2 s'),
    ).toEqual({ runner: 'jest', total: 6, passed: 3, failed: 1, skipped: 2 });
  });

  it('reads pytest', () => {
    expect(
      summarizeTestOutput(
        '=========== 1 failed, 5 passed, 2 skipped, 3 warnings in 0.42s ===========',
      ),
    ).toEqual({ runner: 'pytest', total: 8, passed: 5, failed: 1, skipped: 2 });
  });

  it('takes the last summary when a run prints several', () => {
    const output = ['ℹ tests 1', 'ℹ pass 1', 'ℹ fail 0', 'ℹ tests 2', 'ℹ pass 1', 'ℹ fail 1'].join(
      '\n',
    );
    expect(summarizeTestOutput(output)).toMatchObject({ total: 2, passed: 1, failed: 1 });
  });

  it('takes the summary printed last when different runners print one', () => {
    const output = [
      'ℹ tests 5',
      'ℹ pass 5',
      'ℹ fail 0',
      '      Tests  2 failed | 1 passed (3)',
    ].join('\n');
    expect(summarizeTestOutput(output)).toEqual({
      runner: 'vitest',
      total: 3,
      passed: 1,
      failed: 2,
      skipped: 0,
    });
  });

  it('keeps a later summary when lines of an earlier node:test summary follow it', () => {
    const output = [
      '# tests 5',
      '# pass 5',
      '# fail 0',
      'Tests  2 failed | 1 passed (3)',
      '# todo 0',
    ].join('\n');
    expect(summarizeTestOutput(output)).toMatchObject({ runner: 'vitest', total: 3, failed: 2 });
  });

  it('reads lines that end with a carriage return', () => {
    expect(summarizeTestOutput('collected 1 item\r\n===== 1 passed in 0.10s =====\r\n')).toEqual({
      runner: 'pytest',
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
  });

  // The output comes from the commit under review; a pattern with quadratic cost would stall the server.
  it('stays fast on hostile output', () => {
    for (const hostile of [
      '\n'.repeat(200_000),
      ' \n'.repeat(100_000),
      `Tests:${' ,'.repeat(100_000)}`,
      `${'1 a'.repeat(50_000)} in 1s`,
      `      Tests  ${'9'.repeat(50_000)} (1)`,
      `      Tests  x${' '.repeat(50_000)}`,
      `Tests:${' '.repeat(50_000)}`,
      `ℹ tests ${'9'.repeat(50_000)}x`,
      '='.repeat(50_000),
      '1 passed, '.repeat(20_000),
      ` in ${'9'.repeat(50_000)}`,
    ]) {
      const started = performance.now();
      summarizeTestOutput(hostile);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it('returns nothing for output without a summary it knows', () => {
    expect(summarizeTestOutput('verified')).toBeNull();
    expect(summarizeTestOutput('All 12 tests passed.')).toBeNull();
  });
});
