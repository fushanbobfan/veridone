/** Test counts read from a runner's summary line; the output itself never leaves the machine. */
export interface TestCounts {
  runner: 'node:test' | 'vitest' | 'jest' | 'pytest';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

// Terminal color codes start with ESC (0x1b).
const ansiEscape = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'gu');

// The output comes from the commit under review, so every pattern here runs in linear time: each one is anchored to
// the start of a line or a part of one, and no two neighbouring quantifiers can match the same character. Splitting
// and slicing do the rest.
const nodeLine = /^[ \t]*[ℹ#] (tests|pass|fail|cancelled|skipped|todo) (\d+)[ \t]*$/u;
const vitestPrefix = /^[ \t]*Tests[ \t]{2,}/u;
const jestPrefix = /^Tests:[ \t]/u;
const pytestPrefix = /^=*[ \t]*/u;
const pytestTime = / in [\d.]+s\b/u;
const pytestCounts = /^\d+ [a-z]+(?:, \d+ [a-z]+)*$/u;
const countPart = /^[ \t]*(\d+) ([a-z]+)[ \t]*$/u;

/** The `<number> <word>` parts of a summary, keyed by word; parts that read otherwise are left out. */
function countsIn(parts: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const part of parts) {
    const match = countPart.exec(part);
    if (match?.[1] && match[2]) counts.set(match[2], Number(match[1]));
  }
  return counts;
}

function vitestOrJest(runner: 'vitest' | 'jest', parts: string[], total: number): TestCounts {
  const counts = countsIn(parts);
  const count = (word: string) => counts.get(word) ?? 0;
  return {
    runner,
    total,
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped') + count('todo'),
  };
}

function vitest(line: string): TestCounts | null {
  const prefix = vitestPrefix.exec(line);
  if (!prefix) return null;
  // `Tests  1 failed | 127 passed | 2 skipped (130)`: the total closes the line in parentheses.
  const rest = line.trimEnd();
  const open = rest.lastIndexOf('(');
  if (open <= prefix[0].length || !rest.endsWith(')')) return null;
  const total = rest.slice(open + 1, -1);
  if (!/^\d+$/u.test(total)) return null;
  return vitestOrJest('vitest', rest.slice(prefix[0].length, open).split('|'), Number(total));
}

function jest(line: string): TestCounts | null {
  if (!jestPrefix.test(line)) return null;
  // `Tests:       1 failed, 2 skipped, 3 passed, 6 total`
  const parts = line.slice('Tests:'.length).trimEnd().split(',');
  const total = /^[ \t]*(\d+) total$/u.exec(parts.pop() ?? '');
  if (!total?.[1]) return null;
  return vitestOrJest('jest', parts, Number(total[1]));
}

function pytest(line: string): TestCounts | null {
  // `===== 1 failed, 5 passed, 2 skipped, 3 warnings in 0.42s =====`
  const text = line.replace(pytestPrefix, '');
  const end = text.search(pytestTime);
  if (end <= 0) return null;
  const head = text.slice(0, end);
  if (!pytestCounts.test(head)) return null;
  const counts = countsIn(head.split(','));
  const count = (word: string) => counts.get(word) ?? 0;
  const passed = count('passed');
  const failed = count('failed') + count('error') + count('errors');
  const skipped = count('skipped');
  return { runner: 'pytest', total: passed + failed + skipped, passed, failed, skipped };
}

/** Counts from the summary printed last by a runner VeriDone knows, or null when none appears. */
export function summarizeTestOutput(output: string): TestCounts | null {
  const lines = output.replace(ansiEscape, '').split(/\r?\n/u);
  let found: TestCounts | null = null;
  // node:test prints its summary over several lines, which form one block from `tests` on.
  let block: Map<string, number> | null = null;
  for (const line of lines) {
    const node = nodeLine.exec(line);
    if (node?.[1] && node[2]) {
      if (node[1] === 'tests') block = new Map();
      if (!block) continue;
      block.set(node[1], Number(node[2]));
      const total = block.get('tests');
      const passed = block.get('pass');
      const failed = block.get('fail');
      if (total !== undefined && passed !== undefined && failed !== undefined) {
        found = {
          runner: 'node:test',
          total,
          passed,
          failed: failed + (block.get('cancelled') ?? 0),
          skipped: (block.get('skipped') ?? 0) + (block.get('todo') ?? 0),
        };
      }
      continue;
    }
    const other = vitest(line) ?? jest(line) ?? pytest(line);
    if (other) {
      found = other;
      // A node:test line after another runner's summary starts nothing: only a new `tests` line opens a block.
      block = null;
    }
  }
  return found;
}
