import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { isWithin } from './path-boundary.js';

export class ExecutableResolutionError extends Error {
  override readonly name = 'ExecutableResolutionError';
}

export interface PinnedExecutable {
  /** Canonical absolute path of the file the operator approved. */
  path: string;
  sha256: string;
}

const directlyStartable = ['.com', '.exe'];

/** Reads an environment variable the way the platform does: case-insensitively on Windows. */
export function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== 'win32') return environment[name];
  const wanted = name.toUpperCase();
  const key = Object.keys(environment).find((candidate) => candidate.toUpperCase() === wanted);
  return key === undefined ? undefined : environment[key];
}

/** Keeps the absolute PATH entries. Relative entries would resolve against a working directory. */
export function absolutePathEntries(value: string | undefined): string[] {
  return (value ?? '')
    .split(path.delimiter)
    .filter((entry) => entry !== '' && path.isAbsolute(entry));
}

export async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    if (!(await stat(candidate)).isFile()) return false;
    if (process.platform !== 'win32') await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a command on the absolute PATH entries and returns its canonical path. Unlike a bare-name
 * spawn on Windows, the search never looks in the current directory, and it only accepts files
 * that start without a shell (`.com` and `.exe` on Windows).
 */
export async function findOnPath(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const extensions =
    process.platform !== 'win32'
      ? ['']
      : directlyStartable.includes(path.extname(command).toLowerCase())
        ? ['']
        : directlyStartable;
  for (const directory of absolutePathEntries(environmentValue(environment, 'PATH'))) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (await isExecutableFile(candidate)) return realpath(candidate);
    }
  }
  return null;
}

export async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Resolves the tool an approved check names to one canonical file outside the repository and
 * hashes it. A bare command name is searched on the absolute PATH entries; any other name must
 * be an absolute path.
 */
export async function pinExecutable(
  executable: string,
  options: { repositoryPath: string; environment?: NodeJS.ProcessEnv },
): Promise<PinnedExecutable> {
  let resolved: string | null;
  if (path.isAbsolute(executable)) {
    resolved = (await isExecutableFile(executable)) ? await realpath(executable) : null;
    if (
      resolved &&
      process.platform === 'win32' &&
      !directlyStartable.includes(path.extname(resolved).toLowerCase())
    ) {
      throw new ExecutableResolutionError(
        'On Windows, approve an .exe or .com file; other files need a shell to start.',
      );
    }
  } else if (/[\\/]/u.test(executable)) {
    throw new ExecutableResolutionError(
      'Name the tool by an absolute path or by a command name on PATH; relative paths are not pinned.',
    );
  } else {
    resolved = await findOnPath(executable, options.environment);
  }
  if (!resolved) {
    throw new ExecutableResolutionError(`No executable file was found for ${executable}.`);
  }
  if (isWithin(resolved, await realpath(options.repositoryPath))) {
    throw new ExecutableResolutionError(
      'The tool resolves inside the repository under review. Approve a tool installed outside it.',
    );
  }
  return { path: resolved, sha256: await sha256File(resolved) };
}
