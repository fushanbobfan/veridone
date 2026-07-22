import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  captureGitSnapshot,
  readHarnessReceipt,
  resolveWithinApprovedRoots,
  runBoundedProcess,
} from './index.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'veridone-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('path boundaries', () => {
  it('allows canonical children and rejects paths outside the root', async () => {
    const root = await temporaryDirectory();
    const child = path.join(root, 'child');
    const outside = await temporaryDirectory();
    await mkdir(child);

    await expect(resolveWithinApprovedRoots(child, [root])).resolves.toBe(
      await resolveWithinApprovedRoots(child, [root]),
    );
    await expect(resolveWithinApprovedRoots(outside, [root])).rejects.toThrow(
      'outside the approved roots',
    );
  });

  it.runIf(process.platform !== 'win32')('rejects a symlink escape', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const link = path.join(root, 'escape');
    await symlink(outside, link, 'dir');

    await expect(resolveWithinApprovedRoots(link, [root])).rejects.toThrow(
      'outside the approved roots',
    );
  });
});

describe('bounded process execution', () => {
  it('passes hostile-looking text as a literal argument without a shell', async () => {
    const cwd = await temporaryDirectory();
    const marker = path.join(cwd, 'should-not-exist');
    const literal =
      process.platform === 'win32' ? `& echo unsafe > ${marker}` : `; touch ${marker}`;
    const result = await runBoundedProcess({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', literal],
      cwd,
    });

    expect(result).toMatchObject({ state: 'completed', exitCode: 0, stdout: literal });
    await expect(resolveWithinApprovedRoots(marker, [cwd])).rejects.toThrow();
  });

  it('caps output and terminates the process', async () => {
    const cwd = await temporaryDirectory();
    const result = await runBoundedProcess({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(10000))'],
      cwd,
      maxOutputBytes: 100,
    });

    expect(result.state).toBe('output-capped');
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(100);
  });
});

describe('real adapters', () => {
  it('captures an unborn Git repository without inventing a commit', async () => {
    const repository = await temporaryDirectory();
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(path.join(repository, 'README.md'), '# Unborn\n');

    const result = await captureGitSnapshot(repository, {
      approvedRoots: [repository],
      contractVersion: '1',
      checkDefinitionVersion: '1',
    });

    expect(result.snapshot.head).toBe('0000000000000000000000000000000000000000');
    expect(result.snapshot.branch).toBe('main');
    expect(result.snapshot.statusEntries).toEqual(['?? README.md']);
  });

  it('captures a Git snapshot and detects worktree changes', async () => {
    const repository = await temporaryDirectory();
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository });
    await execFileAsync('git', ['config', 'user.email', 'test@veridone.local'], {
      cwd: repository,
    });
    await execFileAsync('git', ['config', 'user.name', 'VeriDone Test'], { cwd: repository });
    await writeFile(path.join(repository, 'README.md'), '# Fixture\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repository });

    const clean = await captureGitSnapshot(repository, {
      approvedRoots: [repository],
      contractVersion: '1',
      checkDefinitionVersion: '1',
    });
    await writeFile(path.join(repository, 'README.md'), '# Changed\n');
    const dirty = await captureGitSnapshot(repository, {
      approvedRoots: [repository],
      contractVersion: '1',
      checkDefinitionVersion: '1',
    });

    expect(clean.snapshot.statusEntries).toEqual([]);
    expect(dirty.snapshot.statusEntries).toEqual([' M README.md']);
    expect(dirty.snapshot.fingerprint).not.toBe(clean.snapshot.fingerprint);
  });

  it('validates a harness receipt without trusting its output', async () => {
    const root = await temporaryDirectory();
    const receiptPath = path.join(root, 'receipt.json');
    await writeFile(
      receiptPath,
      JSON.stringify({
        schema_version: 1,
        run_id: 'run-1',
        started_at: '2026-07-21T20:00:00.000Z',
        completed_at: '2026-07-21T20:01:00.000Z',
        status: 'degraded',
        task: { type: 'review', mode: 'strong' },
        stages: [{ name: 'review', status: 'failed', output: 'rm -rf /' }],
      }),
    );

    const result = await readHarnessReceipt(receiptPath, [root]);
    expect(result.preview).toMatchObject({
      runId: 'run-1',
      taskType: 'review',
      degraded: true,
    });
  });

  it('accepts completed as a successful harness stage vocabulary', async () => {
    const root = await temporaryDirectory();
    const receiptPath = path.join(root, 'receipt.json');
    await writeFile(
      receiptPath,
      JSON.stringify({
        schema_version: 1,
        run_id: 'run-complete',
        started_at: '2026-07-21T20:00:00.000Z',
        status: 'complete',
        task: { type: 'review' },
        stages: [{ name: 'strong', status: 'completed' }],
      }),
    );

    const result = await readHarnessReceipt(receiptPath, [root]);
    expect(result.preview.degraded).toBe(false);
  });
});
