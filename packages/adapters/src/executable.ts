import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

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
      : ['.com', '.exe'].includes(path.extname(command).toLowerCase())
        ? ['']
        : ['.com', '.exe'];
  for (const directory of absolutePathEntries(environmentValue(environment, 'PATH'))) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (await isExecutableFile(candidate)) return realpath(candidate);
    }
  }
  return null;
}
