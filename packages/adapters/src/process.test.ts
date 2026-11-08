import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runBoundedProcess, type ProcessRequest } from './process.js';

/** A run under test: what each taskkill try against its direct child does, and what the mock saw. */
interface PlannedRun {
  name: string;
  /** Tries past the end of the list run the real taskkill. */
  taskkill: ('fail' | 'hang')[];
  /** Ending the direct child fails, as Node reports an EPERM from `child.kill()`. */
  killFails: boolean;
  /** Every process a run starts exits once this file exists. */
  stopFile: string;
  child?: ChildProcess;
  taskkillRuns: number;
}

const mocked = vi.hoisted(() => ({
  runs: new Map<string, PlannedRun>(),
  byPid: new Map<number, PlannedRun>(),
  /** Names the run in its environment, so the mock can tell which run a spawn belongs to. */
  runVariable: 'VERIDONE_TEST_RUN',
  /** Waits until the stop file named by its first argument exists or its folder is gone, a minute at most. */
  waitForStop:
    "const fs = require('node:fs'); const path = require('node:path'); const stop = process.argv[1];" +
    ' setInterval(() => {' +
    ' if (fs.existsSync(stop) || !fs.existsSync(path.dirname(stop))) process.exit(0); }, 100);' +
    ' setTimeout(() => process.exit(0), 60000);',
}));

// A taskkill try follows the plan of the run it targets: 'fail' starts a process that exits 1 and kills nothing;
// 'hang' starts one that never answers, even when killed.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    if (/(?:^|[\\/])taskkill\.exe$/iu.test(command)) {
      const run = mocked.byPid.get(Number(args[1]));
      let outcome: string | undefined;
      if (run) {
        outcome = run.taskkill[run.taskkillRuns];
        run.taskkillRuns += 1;
      }
      if (outcome === 'fail') {
        return actual.spawn(process.execPath, ['-e', 'process.exit(1)'], options);
      }
      if (run && outcome === 'hang') {
        const killer = actual.spawn(
          process.execPath,
          ['-e', mocked.waitForStop, run.stopFile],
          options,
        );
        killer.kill = () => true;
        return killer;
      }
      return actual.spawn(command, args, options);
    }
    const child = actual.spawn(command, args, options);
    const run = mocked.runs.get(options.env?.[mocked.runVariable] ?? '');
    if (run && child.pid !== undefined) {
      run.child = child;
      mocked.byPid.set(child.pid, run);
      if (run.killFails) {
        child.kill = () => {
          child.emit(
            'error',
            Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' }),
          );
          return false;
        };
      }
    }
    return child;
  };
  return { ...actual, spawn };
});

/**
 * The direct child. `plain` waits; `flood` writes past a 100-byte output limit and waits; `grandchild` starts a
 * process that shares its output pipes, prints that process's pid, writes past the limit and waits; `orphan` starts
 * the same process, prints its pid and exits.
 */
const childScript = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const [stop, shape] = process.argv.slice(1);',
  "if (shape === 'grandchild' || shape === 'orphan') {",
  `  const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(mocked.waitForStop)}, stop], {`,
  "    stdio: ['ignore', 'inherit', 'inherit'],",
  // Detached, the grandchild leaves the child's process group on Linux and macOS, and on Windows the job object in
  // which Node ends a process's children when it exits, so it outlives the direct child.
  '    detached: true,',
  '  });',
  "  process.stdout.write('grandchild ' + grandchild.pid + ' ', () => {",
  "    if (shape === 'orphan') process.exit(0);",
  '  });',
  '}',
  "if (shape === 'flood' || shape === 'grandchild') process.stdout.write('x'.repeat(10000));",
  'setInterval(() => {',
  '  if (fs.existsSync(stop) || !fs.existsSync(path.dirname(stop))) process.exit(0);',
  '}, 100);',
  'setTimeout(() => process.exit(0), 60000);',
].join('\n');

const inherited = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
const directories: string[] = [];

async function plannedRun(
  taskkill: PlannedRun['taskkill'],
  killFails = false,
): Promise<PlannedRun> {
  const directory = await mkdtemp(path.join(tmpdir(), 'veridone-kill-'));
  directories.push(directory);
  const run: PlannedRun = {
    name: path.basename(directory),
    taskkill,
    killFails,
    stopFile: path.join(directory, 'stop'),
    taskkillRuns: 0,
  };
  mocked.runs.set(run.name, run);
  return run;
}

function start(
  run: PlannedRun,
  shape: 'plain' | 'flood' | 'grandchild' | 'orphan',
  limits: Pick<ProcessRequest, 'timeoutMs' | 'maxOutputBytes' | 'signal'>,
) {
  return runBoundedProcess({
    executable: process.execPath,
    args: ['-e', childScript, run.stopFile, shape],
    cwd: tmpdir(),
    env: { ...inherited, [mocked.runVariable]: run.name },
    ...limits,
  });
}

function childOf(run: PlannedRun): ChildProcess {
  if (!run.child) throw new Error('The run started no child.');
  return run.child;
}

function grandchildPid(stdout: string): number {
  return Number(/^grandchild (\d+) /u.exec(stdout)?.[1]);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

afterEach(async () => {
  const runs = [...mocked.runs.values()];
  mocked.runs.clear();
  mocked.byPid.clear();
  // A process that misses the stop file before its folder goes stops on the missing folder.
  await Promise.all(runs.map((run) => writeFile(run.stopFile, '')));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('ending a process tree', () => {
  it.runIf(process.platform === 'win32')(
    'settles in each limit state when every taskkill try fails, and ends the direct child',
    async () => {
      const timedOut = await plannedRun(['fail', 'fail', 'fail']);
      const cancelled = await plannedRun(['fail', 'fail', 'fail']);
      const capped = await plannedRun(['fail', 'fail', 'fail']);
      const hung = await plannedRun(['hang', 'fail', 'fail']);
      const unkillable = await plannedRun(['fail', 'fail', 'fail'], true);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100).unref();

      const results = await Promise.all([
        start(timedOut, 'plain', { timeoutMs: 100 }),
        start(cancelled, 'plain', { signal: controller.signal }),
        start(capped, 'flood', { maxOutputBytes: 100 }),
        start(hung, 'plain', { timeoutMs: 100 }),
        start(unkillable, 'plain', { timeoutMs: 100 }),
      ]);

      expect(results.map((result) => result.state)).toEqual([
        'timed-out',
        'cancelled',
        'output-capped',
        'timed-out',
        'timed-out',
      ]);
      expect(
        [timedOut, cancelled, capped, hung, unkillable].map((run) => run.taskkillRuns),
      ).toEqual([3, 3, 3, 3, 3]);
      // After the last failed try, the direct child alone is ended through Node.
      expect([timedOut, cancelled, capped, hung].map((run) => childOf(run).signalCode)).toEqual([
        'SIGTERM',
        'SIGTERM',
        'SIGTERM',
        'SIGTERM',
      ]);
      // A failed kill keeps the run's state and output; it is not a spawn failure.
      expect(results[4]?.stderr).toBe('');
      for (const result of results) expect(result.durationMs).toBeLessThan(30_000);
    },
    45_000,
  );

  it.runIf(process.platform === 'win32')(
    'tries taskkill again after a failed try and ends the whole tree',
    async () => {
      const run = await plannedRun(['fail']);
      const result = await start(run, 'grandchild', { maxOutputBytes: 100 });

      expect(result.state).toBe('output-capped');
      // The second try is the real taskkill; should it fail as well, a third one runs.
      expect(run.taskkillRuns).toBeGreaterThanOrEqual(2);
      expect(isAlive(grandchildPid(result.stdout))).toBe(false);
    },
    30_000,
  );

  it('settles with its state when a process outlives the kill and keeps the output pipes open', async () => {
    // On Windows the failed tries leave the direct child alone to end; elsewhere the grandchild left the process group.
    const run = await plannedRun(['fail', 'fail', 'fail']);
    const result = await start(run, 'grandchild', { maxOutputBytes: 100 });

    expect(result.state).toBe('output-capped');
    expect(result.stdout).toMatch(/^grandchild \d+ x+$/u);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(100);
    expect(isAlive(grandchildPid(result.stdout))).toBe(true);
    expect(result.durationMs).toBeLessThan(20_000);
  }, 30_000);

  it('runs no taskkill on a child that has exited, and settles while its grandchild keeps the pipes', async () => {
    const run = await plannedRun([]);
    const controller = new AbortController();
    const running = start(run, 'orphan', { signal: controller.signal });
    await once(childOf(run), 'exit');
    controller.abort();
    const result = await running;

    expect(result).toMatchObject({ state: 'cancelled', exitCode: 0 });
    expect(result.stdout).toMatch(/^grandchild \d+ $/u);
    expect(run.taskkillRuns).toBe(0);
  }, 30_000);
});
