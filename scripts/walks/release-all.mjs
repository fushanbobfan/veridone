// One run at one head: a fresh clone of --ref, every step of `pnpm quality`, all Playwright projects, then the walks. Once
// the clone is built, steps run one by one, so a failure in one hides no other, and each step's output stays in a log. It
// ends with ALL: PASS, or ALL: FAIL with the steps that failed.
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { CannotStart, git, pnpmToLog, preparedClone, walkOptions } from './walk-lib.mjs';

// A busy machine pushes tests past budgets that hold on a calm one, so here a test that fails runs again and the summary
// lists every retry. CI runs the default settings on clean machines, with no retries.
const testStep = 'test --maxWorkers=4 --retry=2 --reporter=verbose';
const steps = [
  'format:check',
  'lint',
  'typecheck',
  testStep,
  'verify:published-evidence',
  'build',
  'smoke:built',
  'audit --audit-level low',
  'licenses:check',
  'secrets:check',
  'test:e2e --workers=2',
];
const walks = [
  ['walk:upgrade', 'UPGRADE WALK: PASS'],
  ['walk:first-workspace', 'FIRST WORKSPACE WALK: PASS'],
  ['walk:dead-ends', 'DEAD-END WALK: PASS'],
];

async function cpuLoad() {
  const sample = () => {
    let busy = 0;
    let total = 0;
    for (const { times } of os.cpus()) {
      busy += times.user + times.nice + times.sys + times.irq;
      total += times.user + times.nice + times.sys + times.irq + times.idle;
    }
    return { busy, total };
  };
  const before = sample();
  await delay(1_000);
  const after = sample();
  return Math.round((100 * (after.busy - before.busy)) / (after.total - before.total));
}

const logName = (step) => `${step.replaceAll(/[^a-zA-Z0-9]+/gu, '-')}.log`;
const colorCode = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, 'gu');

try {
  const { root, ref } = await walkOptions();
  if (!ref) throw new CannotStart('Name the commit to check: pnpm walk:release --ref REF');
  const clone = await preparedClone(root, ref, { reuse: false });
  const logs = `${clone}-logs`;
  const head = await git(clone, 'rev-parse', 'HEAD');
  const failed = [];

  const run = async (step, extraArgs = []) => {
    const started = Date.now();
    const logFile = path.join(logs, logName(step));
    const code = await pnpmToLog(clone, [...step.split(' '), ...extraArgs], logFile);
    const seconds = Math.round((Date.now() - started) / 1_000);
    console.log(`${step}: exit ${code} in ${seconds} s, machine load ${await cpuLoad()}%`);
    if (code !== 0) failed.push(step);
    return logFile;
  };

  for (const step of steps) await run(step);
  const testLog = await readFile(path.join(logs, logName(testStep)), 'utf8');
  const retried = testLog.replaceAll(colorCode, '').match(/.*\(retry x\d+\).*/gu) ?? [];
  console.log(`test retries: ${retried.length}`);
  for (const line of retried) console.log(`  ${line.trim()}`);

  for (const [step, passLine] of walks) {
    const logFile = await run(step, ['--root', root]);
    const log = await readFile(logFile, 'utf8');
    for (const line of log.split('\n')) if (line.startsWith('FAIL')) console.log(`  ${line}`);
    if (!log.includes(passLine) && !failed.includes(step)) failed.push(step);
  }

  console.log(`---\nhead: ${head}`);
  const changed = await git(clone, 'status', '--porcelain');
  console.log(`files the run changed: ${changed === '' ? 'none' : `\n${changed}`}`);
  if (changed !== '') failed.push('a clean tree');
  console.log(`logs: ${logs}`);
  console.log(failed.length === 0 ? 'ALL: PASS' : `ALL: FAIL (${failed.join(', ')})`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  if (!(error instanceof CannotStart)) throw error;
  console.error(`ALL: COULD NOT START\n${error.message}`);
  process.exitCode = 2;
}
