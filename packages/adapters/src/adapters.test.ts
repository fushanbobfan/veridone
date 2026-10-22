import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  absolutePathEntries,
  captureGitSnapshot,
  environmentValue,
  findOnPath,
  pinExecutable,
  sha256File,
  gitEnvironment,
  gitRuntime,
  normalizeReceiptTimestamp,
  openGitSession,
  parseConfigList,
  readHarnessReceipt,
  readReceiptCollection,
  repositorySettings,
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

  it('distinguishes timeout, cancellation, and spawn failures', async () => {
    const cwd = await temporaryDirectory();
    const timedOut = await runBoundedProcess({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd,
      timeoutMs: 50,
    });
    expect(timedOut.state).toBe('timed-out');

    const controller = new AbortController();
    const running = runBoundedProcess({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50).unref();
    await expect(running).resolves.toMatchObject({ state: 'cancelled' });

    const spawnFailure = await runBoundedProcess({
      executable: path.join(cwd, 'definitely-not-an-executable'),
      args: [],
      cwd,
    });
    expect(spawnFailure).toMatchObject({ state: 'spawn-error', exitCode: null });
  });
});

async function committedRepository(
  files: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const repository = await temporaryDirectory();
  const run = (args: string[]) => execFileAsync('git', args, { cwd: repository, env });
  await run(['init', '-b', 'main']);
  await run(['config', 'user.email', 'test@veridone.local']);
  await run(['config', 'user.name', 'VeriDone Test']);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(repository, name), content);
  }
  await run(['add', '-A']);
  await run(['commit', '-m', 'fixture']);
  return repository;
}

/** Moves a file's timestamps forward so Git has to compare its content with the index. */
async function touchLater(file: string): Promise<void> {
  const later = new Date(Date.now() + 60_000);
  await utimes(file, later, later);
}

describe('tool pinning', () => {
  it('pins a tool to its canonical path and content hash', async () => {
    const repository = await temporaryDirectory();
    const tool = await realpath(process.execPath);

    await expect(pinExecutable(process.execPath, { repositoryPath: repository })).resolves.toEqual({
      path: tool,
      sha256: await sha256File(tool),
    });
  });

  it('refuses relative tool paths and tools inside the repository', async () => {
    const repository = await temporaryDirectory();
    const fileName = process.platform === 'win32' ? 'tool.exe' : 'tool';
    await writeFile(path.join(repository, fileName), '');
    await chmod(path.join(repository, fileName), 0o755);

    for (const relative of ['./tool', 'bin/tool', '..\\tool']) {
      await expect(pinExecutable(relative, { repositoryPath: repository })).rejects.toThrow(
        /relative paths are not pinned/u,
      );
    }
    await expect(
      pinExecutable(path.join(repository, fileName), { repositoryPath: repository }),
    ).rejects.toThrow(/inside the repository/u);
    await expect(
      pinExecutable('tool', { repositoryPath: repository, environment: { PATH: repository } }),
    ).rejects.toThrow(/inside the repository/u);
  });

  it.runIf(process.platform === 'win32')('refuses files that need a shell on Windows', async () => {
    const tools = await temporaryDirectory();
    await writeFile(path.join(tools, 'test.cmd'), '@echo off\r\n');

    await expect(
      pinExecutable(path.join(tools, 'test.cmd'), { repositoryPath: await temporaryDirectory() }),
    ).rejects.toThrow(/\.exe or \.com/u);
  });
});

describe('Git invocation', () => {
  it('resolves Git to an absolute executable and records its version', async () => {
    const runtime = await gitRuntime();
    expect(path.isAbsolute(runtime.executable)).toBe(true);
    expect(runtime.version).toMatch(/^git version \d+\.\d+/u);
  });

  it('searches only absolute PATH entries for a command', async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    const fileName = process.platform === 'win32' ? 'veridone-tool.exe' : 'veridone-tool';
    await writeFile(path.join(second, fileName), '');
    await chmod(path.join(second, fileName), 0o755);
    const searchPath = ['relative-bin', first, '', second].join(path.delimiter);

    expect(absolutePathEntries(searchPath)).toEqual([first, second]);
    await expect(findOnPath('veridone-tool', { PATH: searchPath })).resolves.toBe(
      await realpath(path.join(second, fileName)),
    );
    // Windows reads environment names case-insensitively, as `Path` and `SystemRoot` show.
    expect(environmentValue({ systemroot: 'C:\\Windows' }, 'SystemRoot')).toBe(
      process.platform === 'win32' ? 'C:\\Windows' : undefined,
    );
  });

  it('imposes a fixed configuration that outranks the repository files', async () => {
    const runtime = await gitRuntime();
    const listing = [
      'filter.lfs.clean\ngit-lfs clean -- %f',
      'core.autocrlf\ntrue',
      'core.fsmonitor\n/usr/local/bin/hook',
      'safe.directory\n*',
      '',
    ].join('\0');
    const environment = gitEnvironment(runtime, repositorySettings(parseConfigList(listing), true));
    const settings = Array.from({ length: Number(environment.GIT_CONFIG_COUNT) }, (_, index) => [
      environment[`GIT_CONFIG_KEY_${index}`],
      environment[`GIT_CONFIG_VALUE_${index}`],
    ]);
    const lastValue = (key: string) => settings.findLast(([name]) => name === key)?.[1];

    expect(environment).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: runtime.emptyConfigFile,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_ALLOW_PROTOCOL: 'file',
    });
    expect(lastValue('core.fsmonitor')).toBe('false');
    expect(lastValue('core.hooksPath')).toBe(runtime.hooksDirectory);
    expect(lastValue('filter.lfs.clean')).toBe('');
    expect(lastValue('filter.lfs.process')).toBe('');
    expect(lastValue('filter.lfs.required')).toBe('false');
    expect(lastValue('core.autocrlf')).toBe('true');
    expect(lastValue('safe.directory')).toBe('*');
  });

  it('does not run a filter command that the repository configures', async () => {
    const repository = await committedRepository({
      '.gitattributes': '*.dat filter=example\n',
      'data.dat': 'payload',
    });
    const configure = (args: string[]) => execFileAsync('git', args, { cwd: repository });
    await configure(['config', 'filter.example.clean', 'veridone-missing-filter-command']);
    await configure(['config', 'filter.example.required', 'true']);
    await touchLater(path.join(repository, 'data.dat'));

    // The operator's own Git tries to run the configured command and fails because it is missing.
    await expect(configure(['status', '--porcelain'])).rejects.toThrow(/filter/u);
    const result = await captureGitSnapshot(repository, {
      approvedRoots: [repository],
      contractVersion: '1',
      checkDefinitionVersion: '1',
    });
    expect(result.snapshot.statusEntries).toEqual([]);
  }, 20_000);

  it('compares working files with the operator line-ending settings', async () => {
    const operatorConfig = path.join(await temporaryDirectory(), 'operator.gitconfig');
    await writeFile(operatorConfig, '[core]\n\tautocrlf = true\n');
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = operatorConfig;
    try {
      const repository = await committedRepository(
        { 'notes.txt': 'first\r\nsecond\r\n' },
        {
          ...process.env,
          GIT_CONFIG_GLOBAL: operatorConfig,
        },
      );
      await touchLater(path.join(repository, 'notes.txt'));

      const captured = await captureGitSnapshot(repository, {
        approvedRoots: [repository],
        contractVersion: '1',
        checkDefinitionVersion: '1',
      });
      expect(captured.snapshot.statusEntries).toEqual([]);
      // Without the operator's settings the CRLF working file differs from its LF blob.
      const fixedOnly = await openGitSession(repository, { operatorSettings: false });
      const status = await fixedOnly.run(['status', '--porcelain=v1']);
      expect(status.stdout.trim()).toBe('M notes.txt');
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  }, 20_000);
});

describe('real adapters', () => {
  it('records submodule commits under the fixed Git configuration', async () => {
    const library = await committedRepository({ 'library.txt': 'shared code\n' });
    const repository = await committedRepository({ 'README.md': '# Parent\n' });
    const run = (args: string[]) => execFileAsync('git', args, { cwd: repository });
    // Git refuses local submodule URLs unless the file transport is allowed for the command.
    await run(['-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'vendor/library']);
    await run(['commit', '-m', 'Add the library']);
    const libraryHead = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: library })
    ).stdout.trim();

    const result = await captureGitSnapshot(repository, {
      approvedRoots: [repository],
      contractVersion: '1',
      checkDefinitionVersion: '1',
    });

    expect(result.snapshot.statusEntries).toEqual([]);
    expect(result.snapshot.submoduleEntries).toEqual([
      expect.stringMatching(new RegExp(`^${libraryHead} vendor/library`, 'u')),
    ]);
  }, 30_000);

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
    expect(result.snapshot.diffStats).toMatchObject({ changedFiles: 1, untrackedFiles: 1 });
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
    await writeFile(path.join(repository, 'README.md'), '# Changed again\n');
    const dirtier = await captureGitSnapshot(repository, {
      approvedRoots: [repository],
      contractVersion: '1',
      checkDefinitionVersion: '1',
    });

    expect(clean.snapshot.statusEntries).toEqual([]);
    expect(dirty.snapshot.statusEntries).toEqual([' M README.md']);
    expect(dirty.snapshot.fingerprint).not.toBe(clean.snapshot.fingerprint);
    expect(dirty.snapshot.diffStats).toMatchObject({
      changedFiles: 1,
      additions: 1,
      deletions: 1,
    });
    expect(dirtier.snapshot.statusEntries).toEqual(dirty.snapshot.statusEntries);
    expect(dirtier.snapshot.worktreeHash).not.toBe(dirty.snapshot.worktreeHash);
    expect(dirtier.snapshot.fingerprint).not.toBe(dirty.snapshot.fingerprint);
  }, 20_000);

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

  it('imports a portable Codex receipt without inventing claim text', async () => {
    const root = await temporaryDirectory();
    const receiptPath = path.join(root, 'codex-receipt.json');
    await writeFile(
      receiptPath,
      JSON.stringify({
        schema_version: 1,
        run_id: 'codex-portable-1',
        source: 'codex',
        title: 'Ship the evidence explorer',
        claim: 'Implemented the explorer and verified its keyboard flow.',
        started_at: '2026-07-21T20:00:00.000Z',
        completed_at: '2026-07-21T20:02:00.000Z',
        status: 'complete',
        stages: [{ name: 'test', status: 'passed' }],
      }),
    );

    const result = await readHarnessReceipt(receiptPath, [root]);
    expect(result.preview).toMatchObject({
      sourceType: 'codex',
      sourceLabel: 'Codex receipt',
      title: 'Ship the evidence explorer',
      claim: 'Implemented the explorer and verified its keyboard flow.',
      degraded: false,
    });
  });

  it('stores receipt times as ISO 8601 timestamps and refuses values that are not times', async () => {
    const root = await temporaryDirectory();
    const receipt = (fields: Record<string, unknown>) =>
      JSON.stringify({
        schema_version: 1,
        run_id: 'times',
        title: 'Times',
        claim: 'Timestamps are recorded.',
        status: 'complete',
        started_at: '2026-07-21T20:00:00Z',
        ...fields,
      });
    const read = async (fields: Record<string, unknown>) => {
      const receiptPath = path.join(root, 'receipt.json');
      await writeFile(receiptPath, receipt(fields));
      return (await readHarnessReceipt(receiptPath, [root])).preview;
    };

    await expect(read({ started_at: '2026-07-21T13:00:00.1234567-07:00' })).resolves.toMatchObject({
      startedAt: '2026-07-21T13:00:00.1234567-07:00',
    });
    await expect(read({ started_at: '2026-07-21 13:00:00' })).resolves.toMatchObject({
      startedAt: new Date(2026, 6, 21, 13, 0, 0).toISOString(),
    });
    for (const startedAt of ['yesterday', '2026-02-30 10:00:00', '1']) {
      await expect(read({ started_at: startedAt })).rejects.toThrow(/started_at: Use an ISO 8601/u);
    }
    await expect(read({ run_id: 'r'.repeat(513) })).rejects.toThrow(/run_id/u);
    expect(normalizeReceiptTimestamp('2026-07-21T20:00:00Z')).toBe('2026-07-21T20:00:00Z');
  });

  it('rejects receipt collections that exceed their byte budget before parsing', async () => {
    const root = await temporaryDirectory();
    const receiptDirectory = path.join(root, 'receipts');
    await mkdir(receiptDirectory);
    await writeFile(path.join(receiptDirectory, 'oversized.json'), Buffer.alloc(1_025, 32));

    await expect(
      readReceiptCollection(receiptDirectory, [root], { maxTotalBytes: 1_024 }),
    ).rejects.toThrow('1024-byte total limit');
  });
});
