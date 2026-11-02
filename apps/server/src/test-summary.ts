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
// Patterns use [ \t] where \s would also match line breaks: on a long run of empty lines that costs quadratic time,
// and the output comes from the commit under review.

function lastMatch(text: string, pattern: RegExp): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  for (const match of text.matchAll(pattern)) last = match;
  return last;
}

/** The number before `word` in a comma- or bar-separated summary, or 0. */
function countOf(summary: string, word: string): number {
  const match = new RegExp(`(\\d+) ${word}\\b`, 'u').exec(summary);
  return match ? Number(match[1]) : 0;
}

function nodeTest(text: string): TestCounts | null {
  // The spec reporter prefixes its summary with ℹ, the TAP reporter with #.
  const count = (name: string) => {
    const match = lastMatch(text, new RegExp(`^[ \\t]*[ℹ#] ${name} (\\d+)[ \\t]*$`, 'gmu'));
    return match ? Number(match[1]) : null;
  };
  const total = count('tests');
  const passed = count('pass');
  const failed = count('fail');
  if (total === null || passed === null || failed === null) return null;
  return {
    runner: 'node:test',
    total,
    passed,
    failed: failed + (count('cancelled') ?? 0),
    skipped: (count('skipped') ?? 0) + (count('todo') ?? 0),
  };
}

function vitest(text: string): TestCounts | null {
  const line = lastMatch(text, /^[ \t]*Tests[ \t]{2,}(.+?)[ \t]*\((\d+)\)[ \t]*$/gmu);
  if (!line?.[1] || !line[2]) return null;
  return {
    runner: 'vitest',
    total: Number(line[2]),
    passed: countOf(line[1], 'passed'),
    failed: countOf(line[1], 'failed'),
    skipped: countOf(line[1], 'skipped') + countOf(line[1], 'todo'),
  };
}

function jest(text: string): TestCounts | null {
  const line = lastMatch(text, /^Tests:[ \t]+(.+?),[ \t]+(\d+) total[ \t]*$/gmu);
  if (!line?.[1] || !line[2]) return null;
  return {
    runner: 'jest',
    total: Number(line[2]),
    passed: countOf(line[1], 'passed'),
    failed: countOf(line[1], 'failed'),
    skipped: countOf(line[1], 'skipped') + countOf(line[1], 'todo'),
  };
}

function pytest(text: string): TestCounts | null {
  const line = lastMatch(text, /^=*[ \t]*((?:\d+ [a-z]+(?:, )?)+) in [\d.]+s\b/gmu);
  if (!line?.[1]) return null;
  const passed = countOf(line[1], 'passed');
  const failed = countOf(line[1], 'failed') + countOf(line[1], 'errors?');
  const skipped = countOf(line[1], 'skipped');
  return { runner: 'pytest', total: passed + failed + skipped, passed, failed, skipped };
}

/** Counts from the last summary a known runner printed, or null when none appears. */
export function summarizeTestOutput(output: string): TestCounts | null {
  const text = output.replace(ansiEscape, '');
  return nodeTest(text) ?? vitest(text) ?? jest(text) ?? pytest(text);
}
