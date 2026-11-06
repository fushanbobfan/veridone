import { describe, expect, it } from 'vitest';

import { checkRequestSchema } from './check-policy.js';
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

  // The output comes from the commit under review; a pattern with quadratic cost would stall the server. Each line
  // here fits within the longest line the patterns read, so each one reaches them.
  it('stays fast on hostile output', () => {
    for (const hostile of [
      '\n'.repeat(200_000),
      ' \n'.repeat(100_000),
      `Tests:${' ,'.repeat(32_000)}`,
      `${'1 a'.repeat(21_000)} in 1s`,
      `${'1 a, '.repeat(13_000)}x in 1s`,
      `1 a${', 1 subtests passed'.repeat(3_400)}x in 1s`,
      `Tests: 1 a,${' '.repeat(60_000)}x`,
      `      Tests  ${'9'.repeat(50_000)} (1)`,
      `      Tests  x${' '.repeat(50_000)}`,
      `Tests:${' '.repeat(50_000)}`,
      `ℹ tests ${'9'.repeat(50_000)}x`,
      '='.repeat(50_000),
      '1 passed, '.repeat(6_500),
      ` in ${'9'.repeat(50_000)}`,
    ]) {
      const started = performance.now();
      summarizeTestOutput(hostile);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it('keeps to the form of each summary line', () => {
    const counts = (runner: string, total: number, passed: number, failed = 0, skipped = 0) => ({
      runner,
      total,
      passed,
      failed,
      skipped,
    });
    const cases: Array<[string, ReturnType<typeof counts> | null]> = [
      [
        '# tests 7\r\n# pass 1\r\n# fail 1\r\n# cancelled 1\r\n# skipped 1\r\n# todo 2\r\n',
        counts('node:test', 7, 1, 2, 3),
      ],
      ['  # tests 1  \n\t# pass 1\t\n# fail 0 ', counts('node:test', 1, 1)],
      ['Tests  1 passed | 1 skipped | 1 todo (3)', counts('vitest', 3, 1, 0, 2)],
      ['Tests 1 passed (1)', null],
      ['Tests  (3)', null],
      ['Tests  1 passed (1x', null],
      ['Tests:\t1 passed, 1 skipped, 1 todo, 3 total', counts('jest', 3, 1, 0, 2)],
      ['Tests: 1 passed, x 1 total', null],
      ['1 passed in 0.10s', counts('pytest', 1, 1)],
      ['  1 passed in 0.10s', counts('pytest', 1, 1)],
      ['== 1 error, 1 passed, 2 errors in 1s ==', counts('pytest', 4, 1, 3)],
      ['1 passed in 1sx', null],
      ['1  in 1s', null],
      ['x 1 passed in 1s', null],
      // pytest prints its passed subtests apart at some verbosity settings, and they stay out of the counts.
      ['179 passed, 157 subtests passed in 1.15s', counts('pytest', 179, 179)],
      [
        '== 2 failed, 2 passed, 1 skipped, 5 subtests passed in 0.22s ==',
        counts('pytest', 5, 2, 2, 1),
      ],
      [
        '3 failed, 1 passed, 2 skipped, 1 xfailed, 1 subtests passed in 1s',
        counts('pytest', 6, 1, 3, 2),
      ],
      ['1 subtests passed in 1s', null],
      ['1 passed, 1 subtests failed in 1s', null],
      ['1 passed, 1 other passed in 1s', null],
      // What `pytest --collect-only` prints is no summary, and leaves the one before it standing.
      ['2 tests collected in 0.02s', null],
      ['5 passed in 1s\n2 tests collected in 0.02s', counts('pytest', 5, 5)],
      // `K` erases the line and only `m` closes a color code, so this code stays and the line holds no summary.
      [`${String.fromCharCode(0x1b)}[2K1 passed in 1s`, null],
    ];
    for (const [output, expected] of cases) {
      expect(summarizeTestOutput(output), JSON.stringify(output)).toEqual(expected);
    }
  });

  it('returns nothing for output without a summary it knows', () => {
    expect(summarizeTestOutput('verified')).toBeNull();
    expect(summarizeTestOutput('All 12 tests passed.')).toBeNull();
  });
});

describe('output up to the largest limit', () => {
  const limit = 10_000_000;
  const longestLine = 65_536;
  const esc = String.fromCharCode(0x1b);
  const han = String.fromCharCode(0x5ba2);
  const onePassed = { runner: 'pytest', total: 1, passed: 1, failed: 0, skipped: 0 };

  // The slowest text here, all line breaks, takes under 3 seconds at the limit on a desktop. This leaves a slow runner
  // room, and a quadratic pattern still misses it at the shortest length, in seconds.
  const budget = (length: number) => 1_000 + length / 250;

  /** `lead`, `run` repeated as far as `length` allows, then `tail`; line breaks make up any difference. */
  const textOf = (lead: string, run: string, tail: string, length: number) => {
    const rounds = Math.floor((length - lead.length - tail.length) / run.length);
    const line = `${lead}${run.repeat(rounds)}${tail}`;
    return `${line}${'\n'.repeat(length - line.length)}`;
  };

  it('runs at the largest output limit a check may set', () => {
    const maxOutputBytes = checkRequestSchema.shape.maxOutputBytes;
    expect(maxOutputBytes.safeParse(limit).success).toBe(true);
    expect(maxOutputBytes.safeParse(limit + 1).success).toBe(false);
  });

  // Each one is a single line, past the longest line the patterns read, aimed at one quantifier in them.
  const longLines: Array<[string, string, string, string]> = [
    ['a color code that nothing closes', `${esc}[`, '1', ''],
    ['spaces before a node:test line', '', ' ', '# tests 1'],
    ['tabs before a node:test line', '', '\t', '# tests 1'],
    ['digits in a node:test line', '# tests ', '1', ''],
    ['spaces after a node:test line', '# tests 1', ' ', ''],
    ['spaces before a Vitest line', '', ' ', 'Tests  1 passed (1)'],
    ['spaces after the word Tests', '  Tests', ' ', '1 passed (1)'],
    ['digits in a Vitest total', 'Tests  1 passed (', '1', ')'],
    ['digits in a Vitest part', 'Tests  ', '1', ' passed (1)'],
    ['a long word in a Vitest part', 'Tests  1 ', 'a', ' (1)'],
    ['many Vitest parts', 'Tests  ', '1 a|', '(1)'],
    ['spaces after a Vitest total', 'Tests  1 passed (1)', ' ', ''],
    ['spaces before a Jest part', 'Tests: ', ' ', '1 passed, 1 total'],
    ['spaces before a Jest total', 'Tests: 1 passed,', ' ', '1 total'],
    ['digits in a Jest total', 'Tests: ', '1', ' total'],
    ['digits in a Jest part', 'Tests: ', '1', ' a, 1 total'],
    ['a long word in a Jest part', 'Tests: 1 ', 'a', ', 1 total'],
    ['many Jest parts', 'Tests: ', '1 a,', ' 1 total'],
    ['equals signs before a pytest line', '', '=', ' 1 passed in 1s'],
    ['spaces before a pytest line', '', ' ', '1 passed in 1s'],
    ['equals signs after a pytest line', '1 passed in 1s ', '=', ''],
    ['a long word in a pytest line', '1 ', 'a', ' in 1s'],
    ['digits in a pytest line', '', '1', ' a in 1s'],
    ['many pytest parts', '', '1 a, ', '1 a in 1s'],
    ['digits in a pytest time', 'x in ', '1', 's'],
    ['periods in a pytest time', 'x in ', '.', 's'],
    ['a pytest time with no end', 'x in ', '1', ''],
    ['many pytest times', '', ' in 1', ''],
    ['one word', '', 'a', ''],
    ['only spaces', '', ' ', ''],
  ];

  // A pattern that keeps a backtrack entry per round throws at the longest texts. A character past Latin-1 makes V8
  // store the whole text in two bytes per character, where a pattern with the `u` flag keeps more entries.
  for (const [name, lead, run, tail] of longLines) {
    it(`skips ${name}, in time proportional to its length`, { timeout: 180_000 }, () => {
      for (let length = limit / 64; length <= limit; length *= 2) {
        const output = `${han}\n${textOf(lead, run, tail, length - 2)}`;
        expect(output.length).toBe(length);
        const started = performance.now();
        const counts = summarizeTestOutput(output);
        const elapsed = performance.now() - started;
        expect(elapsed, `the time at ${length}`).toBeLessThan(budget(length));
        if (length === limit) expect(counts, 'two bytes per character').toBeNull();
      }
      expect(summarizeTestOutput(textOf(lead, run, tail, limit)), 'one byte each').toBeNull();
      // What follows the line is read as if the line were not there.
      const summary = '\n===== 1 passed in 0.10s =====';
      const before = textOf(lead, run, tail, limit - summary.length);
      expect(summarizeTestOutput(`${before}${summary}`)).toEqual(onePassed);
    });
  }

  // Each text holds many lines just short enough to read, so every line reaches the patterns.
  const longestLines: Array<[string, string, string, string, object]> = [
    ['pytest parts', '', '1 a, ', '1 a in 1s', { runner: 'pytest', total: 0, passed: 0 }],
    ['pytest padding', '', '=', ' 1 passed in 1s', onePassed],
    ['Vitest parts', 'Tests  ', '1 a|', '(1)', { runner: 'vitest', total: 1, passed: 0 }],
    ['Jest parts', 'Tests: ', '1 a,', ' 1 total', { runner: 'jest', total: 1, passed: 0 }],
  ];

  for (const [name, lead, run, tail, counts] of longestLines) {
    it(`reads lines of ${name} up to the longest it reads`, { timeout: 180_000 }, () => {
      const line = `${textOf(lead, run, tail, longestLine).trimEnd()}\n`;
      const lines = line.repeat(Math.floor((limit - 2) / line.length));
      for (const output of [lines, `${han}\n${lines}`]) {
        const started = performance.now();
        expect(summarizeTestOutput(output)).toMatchObject(counts);
        expect(performance.now() - started).toBeLessThan(budget(limit));
      }
    });
  }

  it(
    'strips a color code of any length, in time proportional to its length',
    { timeout: 180_000 },
    () => {
      for (const run of ['1', ';']) {
        for (let length = limit / 64; length <= limit; length *= 2) {
          const code = textOf(`${esc}[`, run, 'm', length - 2).trimEnd();
          const started = performance.now();
          const counts = summarizeTestOutput(`${han}\n${code}1 passed in 1s`);
          expect(performance.now() - started, `the time at ${length}`).toBeLessThan(budget(length));
          expect(counts, 'two bytes per character').toEqual(onePassed);
          expect(summarizeTestOutput(`${code}1 passed in 1s`), 'one byte each').toEqual(onePassed);
        }
      }
    },
  );

  for (const [name, flood] of [
    ['line breaks', '\n'],
    ['carriage returns', '\r'],
    ['color codes', `${esc}[1m`],
    ['starts of color codes', `${esc}[`],
  ] as const) {
    it(`reads a text of ${name}, in time proportional to its length`, { timeout: 180_000 }, () => {
      for (let length = limit / 64; length <= limit; length *= 2) {
        const output = `${han}\n${textOf('', flood, '', length - 2)}`;
        const started = performance.now();
        expect(summarizeTestOutput(output), `the counts at ${length}`).toBeNull();
        expect(performance.now() - started, `the time at ${length}`).toBeLessThan(budget(length));
      }
      expect(summarizeTestOutput(textOf('', flood, '', limit)), 'one byte each').toBeNull();
    });
  }

  // A packet reads a check's stdout and stderr joined by one line break. A check and its setup step can fill one stream
  // each, and a restored backup can hold both at the limit, so a text runs to twice it.
  it('reads both streams at the limit, joined as a packet joins them', { timeout: 180_000 }, () => {
    const stdout = textOf(`${han}\nTests: `, ' ', '1 passed, 1 total', limit);
    const stderr = textOf(`${esc}[`, '1', 'm', limit - '1 passed in 1s'.length).trimEnd();
    const counts = summarizeTestOutput(`${stdout}\n${stderr}1 passed in 1s`);
    expect(counts).toEqual(onePassed);
    expect(summarizeTestOutput(`${stdout}\n${stdout}`)).toBeNull();
  });

  it('reads a line up to the longest it reads, as wide as pytest pads one', () => {
    // pytest pads its summary line to within a column of the terminal's width.
    const padded = (width: number) => {
      const title = ' 1 passed in 0.10s ';
      const left = '='.repeat(Math.floor((width - title.length) / 2));
      return `${left}${title}${'='.repeat(width - title.length - left.length)}`;
    };
    expect(padded(longestLine)).toHaveLength(longestLine);
    expect(summarizeTestOutput(padded(longestLine))).toEqual(onePassed);
    expect(summarizeTestOutput(padded(longestLine + 1))).toBeNull();
    expect(
      summarizeTestOutput(`${' '.repeat(longestLine - 9)}# tests 1\n# pass 1\n# fail 0`),
    ).toEqual({ runner: 'node:test', total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(
      summarizeTestOutput(`${' '.repeat(longestLine - 8)}# tests 1\n# pass 1\n# fail 0`),
    ).toBeNull();
  });

  it('measures a line without its color codes', () => {
    const green = `${esc}[32m`;
    const colored = `${green}1 passed${esc}[m in 0.10s${green.repeat(longestLine / green.length)}`;
    expect(colored.length).toBeGreaterThan(longestLine);
    expect(summarizeTestOutput(colored)).toEqual(onePassed);
  });

  it('reads past a long line as past any other line', () => {
    const long = 'a'.repeat(longestLine + 1);
    expect(summarizeTestOutput(`${long}\n===== 1 passed in 0.10s =====`)).toEqual(onePassed);
    expect(summarizeTestOutput(`===== 1 passed in 0.10s =====\n${long}`)).toEqual(onePassed);
    // A node:test summary goes on across it, since only another runner's summary closes the block.
    expect(summarizeTestOutput(`# tests 2\n${long}\n# pass 2\n${long}\n# fail 0`)).toEqual({
      runner: 'node:test',
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
  });
});
