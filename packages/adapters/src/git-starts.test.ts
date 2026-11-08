import { execFile } from 'node:child_process';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureGitSnapshot, gitRuntime } from './index.js';

// Every process VeriDone starts goes through spawn, so the arguments of each start are recorded here.
const { started } = vi.hoisted(() => ({ started: [] as string[][] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    started.push([...((args[1] as readonly string[] | undefined) ?? [])]);
    return actual.spawn(...args);
  }) as typeof actual.spawn;
  return { ...actual, spawn };
});

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** The Git command of each start since the last call, `-C <path>` left out. */
function gitCommands(): string[] {
  return started
    .splice(0)
    .map((args) => (args[0] === '-C' ? args[2] : args[0]) ?? '')
    .sort();
}

describe('Git starts', () => {
  it('starts seven Git processes to capture a clean repository, and ten when it has changes', async () => {
    const repository = await mkdtemp(path.join(tmpdir(), 'veridone-starts-'));
    temporaryDirectories.push(repository);
    const git = (...args: string[]) => execFileAsync('git', args, { cwd: repository });
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@veridone.local');
    await git('config', 'user.name', 'VeriDone Test');
    await writeFile(path.join(repository, 'README.md'), '# Fixture\n');
    await git('add', 'README.md');
    await git('commit', '-m', 'fixture');
    const options = {
      approvedRoots: [repository],
      contractVersion: '1',
      checkDefinitionVersion: '1',
    };
    // Resolving Git starts it too, once per process.
    await gitRuntime();
    started.length = 0;

    await captureGitSnapshot(repository, options);
    expect(gitCommands()).toEqual([
      'branch',
      'config',
      'diff',
      'diff',
      'rev-parse',
      'rev-parse',
      'status',
    ]);

    const everyCommand = [
      'branch',
      'config',
      'diff',
      'diff',
      'diff',
      'diff',
      'ls-files',
      'rev-parse',
      'rev-parse',
      'status',
    ];
    await writeFile(path.join(repository, 'README.md'), '# Changed\n');
    await captureGitSnapshot(repository, options);
    expect(gitCommands()).toEqual(everyCommand);

    // With diff.autoRefreshIndex off, a file whose timestamps alone changed is on the changed files list while status
    // reports nothing, and the capture runs every command.
    await git('checkout', '--', 'README.md');
    await git('config', 'diff.autoRefreshIndex', 'false');
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(repository, 'README.md'), later, later);
    started.length = 0;
    await captureGitSnapshot(repository, options);
    expect(gitCommands()).toEqual(everyCommand);
  }, 30_000);
});
