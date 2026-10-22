import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  absolutePathEntries,
  environmentValue,
  findOnPath,
  isExecutableFile,
} from './executable.js';
import { runBoundedProcess, type ProcessResult } from './process.js';

export class GitAdapterError extends Error {
  override readonly name = 'GitAdapterError';
}

export interface GitRuntime {
  /** Absolute path of the Git executable, from VERIDONE_GIT or the absolute PATH entries. */
  executable: string;
  version: string;
  emptyConfigFile: string;
  hooksDirectory: string;
  /** Working directory of every Git process; it lies outside any repository. */
  workingDirectory: string;
}

export interface GitRunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export type GitSetting = [key: string, value: string];

export interface GitSession {
  readonly runtime: GitRuntime;
  run(args: string[], options?: GitRunOptions): Promise<ProcessResult>;
}

// These settings decide how working files compare with the index and never name a program, so
// VeriDone carries them over from the operator's own configuration for the operator's repositories.
const comparisonSettings = new Set([
  'core.autocrlf',
  'core.eol',
  'core.filemode',
  'core.ignorecase',
  'core.precomposeunicode',
  'core.symlinks',
  'core.longpaths',
  'core.checkstat',
  'core.trustctime',
  'core.excludesfile',
  'core.attributesfile',
]);

const passthroughVariables =
  process.platform === 'win32'
    ? ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']
    : ['PATH', 'HOME', 'TMPDIR'];

const maxFilterDrivers = 100;

/**
 * Settings imposed on every Git process. They are passed as command-scope configuration, which
 * outranks the system, global, and repository files.
 */
function fixedSettings(runtime: GitRuntime): GitSetting[] {
  return [
    ['core.fsmonitor', 'false'],
    ['core.hooksPath', runtime.hooksDirectory],
    ['core.untrackedCache', 'false'],
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    ['transfer.fsckObjects', 'true'],
  ];
}

export function gitEnvironment(
  runtime: GitRuntime,
  settings: GitSetting[],
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of passthroughVariables) {
    const value = environmentValue(process.env, name);
    if (value) environment[name] = value;
  }
  environment.PATH = absolutePathEntries(environment.PATH).join(path.delimiter);
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome && path.isAbsolute(xdgConfigHome)) environment.XDG_CONFIG_HOME = xdgConfigHome;
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: runtime.emptyConfigFile,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file',
    LC_ALL: 'C',
  });
  const entries = [...settings, ...fixedSettings(runtime)];
  environment.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}

/** The operator's own view of Git configuration, without variables that redirect a repository. */
function operatorEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (
      upper.startsWith('GIT_') &&
      !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'].includes(upper)
    ) {
      continue;
    }
    environment[name] = value;
  }
  return environment;
}

export function parseConfigList(output: string): GitSetting[] {
  return output
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const newline = entry.indexOf('\n');
      return newline === -1 ? [entry, 'true'] : [entry.slice(0, newline), entry.slice(newline + 1)];
    });
}

/**
 * Turns a repository's configuration listing into command-scope settings: every filter driver it
 * defines is blanked, and with `operatorSettings` the comparison settings and safe directories
 * are carried over.
 */
export function repositorySettings(entries: GitSetting[], operatorSettings: boolean): GitSetting[] {
  const carried = new Map<string, string>();
  const safeDirectories: GitSetting[] = [];
  const drivers = new Set<string>();
  for (const [key, value] of entries) {
    const driver = /^filter\.(.+)\.(?:clean|smudge|process|required)$/su.exec(key)?.[1];
    if (driver) drivers.add(driver);
    if (!operatorSettings) continue;
    if (key === 'safe.directory') safeDirectories.push([key, value]);
    else if (comparisonSettings.has(key)) carried.set(key, value);
  }
  if (drivers.size > maxFilterDrivers) {
    throw new GitAdapterError(
      `The repository configures more than ${maxFilterDrivers} filter drivers.`,
    );
  }
  return [
    ...carried.entries(),
    ...safeDirectories,
    ...[...drivers].flatMap((driver): GitSetting[] => [
      [`filter.${driver}.clean`, ''],
      [`filter.${driver}.smudge`, ''],
      [`filter.${driver}.process`, ''],
      [`filter.${driver}.required`, 'false'],
    ]),
  ];
}

export async function resolveGitExecutable(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const configured = environment.VERIDONE_GIT;
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new GitAdapterError('VERIDONE_GIT must be an absolute path to the Git executable.');
    }
    const resolved = await realpath(configured);
    if (!(await isExecutableFile(resolved))) {
      throw new GitAdapterError('VERIDONE_GIT does not name an executable file.');
    }
    return resolved;
  }
  const found = await findOnPath('git', environment);
  if (!found) {
    throw new GitAdapterError(
      'Git was not found on PATH. Install Git or set VERIDONE_GIT to its absolute path.',
    );
  }
  return found;
}

function parseGitVersion(output: string): [number, number] | null {
  const match = /git version (\d+)\.(\d+)/u.exec(output);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

async function createGitRuntime(): Promise<GitRuntime> {
  const executable = await resolveGitExecutable();
  const home = await mkdtemp(path.join(tmpdir(), 'veridone-git-'));
  process.once('exit', () => rmSync(home, { recursive: true, force: true }));
  const hooksDirectory = path.join(home, 'hooks');
  const emptyConfigFile = path.join(home, 'empty.gitconfig');
  await mkdir(hooksDirectory);
  await writeFile(emptyConfigFile, '');
  const runtime: GitRuntime = {
    executable,
    version: '',
    emptyConfigFile,
    hooksDirectory,
    workingDirectory: home,
  };
  const result = await runGitProcess(runtime, ['--version'], []);
  const version = parseGitVersion(result.stdout);
  if (result.state !== 'completed' || result.exitCode !== 0 || !version) {
    throw new GitAdapterError(`Git could not be started from ${executable}.`);
  }
  // Command-scope configuration through GIT_CONFIG_COUNT and GIT_CONFIG_GLOBAL arrived in Git 2.32.
  if (version[0] < 2 || (version[0] === 2 && version[1] < 32)) {
    throw new GitAdapterError(`VeriDone needs Git 2.32 or later; ${executable} is older.`);
  }
  runtime.version = result.stdout.trim().split(/\r?\n/u)[0] ?? '';
  return runtime;
}

let runtimePromise: Promise<GitRuntime> | null = null;

/** Resolves Git once per process and prepares its empty configuration and hook directory. */
export function gitRuntime(): Promise<GitRuntime> {
  runtimePromise ??= createGitRuntime().catch((error: unknown) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

export function runGitProcess(
  runtime: GitRuntime,
  args: string[],
  settings: GitSetting[],
  options: GitRunOptions = {},
): Promise<ProcessResult> {
  return runBoundedProcess({
    executable: runtime.executable,
    args,
    cwd: runtime.workingDirectory,
    env: gitEnvironment(runtime, settings),
    timeoutMs: options.timeoutMs ?? 15_000,
    maxOutputBytes: options.maxOutputBytes ?? 2_000_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Opens Git for one repository. The repository's configuration is read without running anything
 * it names; filter drivers it defines are blanked for every later command. `operatorSettings`
 * also carries over the operator's comparison settings, so status matches the operator's own Git;
 * repositories VeriDone created itself use the fixed configuration alone.
 */
export async function openGitSession(
  repositoryPath: string,
  options: { operatorSettings: boolean },
): Promise<GitSession> {
  const runtime = await gitRuntime();
  const listed = await runBoundedProcess({
    executable: runtime.executable,
    args: ['-C', repositoryPath, 'config', '--list', '-z'],
    cwd: runtime.workingDirectory,
    env: options.operatorSettings ? operatorEnvironment() : gitEnvironment(runtime, []),
    timeoutMs: 15_000,
    maxOutputBytes: 2_000_000,
  });
  if (listed.state !== 'completed' || listed.exitCode !== 0) {
    throw new GitAdapterError(
      listed.stderr.trim() || 'Git could not read the repository configuration.',
    );
  }
  const settings = repositorySettings(parseConfigList(listed.stdout), options.operatorSettings);
  return {
    runtime,
    run: (args, runOptions) =>
      runGitProcess(runtime, ['-C', repositoryPath, ...args], settings, runOptions),
  };
}
