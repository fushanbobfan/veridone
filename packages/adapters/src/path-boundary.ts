import { opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export class PathBoundaryError extends Error {
  override readonly name = 'PathBoundaryError';
}

/** The canonical form of a path, with a plain answer when it cannot be read. */
async function canonicalPath(candidate: string): Promise<string> {
  try {
    return await realpath(path.resolve(candidate));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new PathBoundaryError(
      code === 'ENOENT' || code === 'ENOTDIR'
        ? `${candidate} does not exist on this machine.`
        : `${candidate} cannot be read (${code ?? 'unknown error'}).`,
    );
  }
}

export function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export async function resolveWithinApprovedRoots(
  candidate: string,
  approvedRoots: string[],
): Promise<string> {
  if (approvedRoots.length === 0) {
    throw new PathBoundaryError(
      'No filesystem roots have been approved. Add one under Add source, or approve a restored one under Roots.',
    );
  }

  const resolvedCandidate = await canonicalPath(candidate);
  // A root whose folder is gone bounds nothing, and it must not stop the roots that remain.
  const resolvedRoots = (
    await Promise.allSettled(approvedRoots.map((root) => realpath(path.resolve(root))))
  ).flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));

  if (!resolvedRoots.some((root) => isWithin(resolvedCandidate, root))) {
    throw new PathBoundaryError(
      'The requested path is outside the approved roots. Add a folder that holds it as a root under Add source.',
    );
  }

  return resolvedCandidate;
}

export interface DiscoveryOptions {
  maxDepth?: number;
  maxDirectories?: number;
}

export async function discoverGitRepositories(
  approvedRoot: string,
  options: DiscoveryOptions = {},
): Promise<string[]> {
  const root = await canonicalPath(approvedRoot);
  const maxDepth = options.maxDepth ?? 4;
  const maxDirectories = options.maxDirectories ?? 500;
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  const repositories: string[] = [];
  let visited = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    visited += 1;
    if (visited > maxDirectories) {
      throw new PathBoundaryError(`Repository discovery exceeded ${maxDirectories} directories.`);
    }

    const gitMarker = path.join(current.directory, '.git');
    try {
      await stat(gitMarker);
      repositories.push(current.directory);
      continue;
    } catch {
      // A missing .git marker means this directory may contain repositories below it.
    }

    if (current.depth >= maxDepth) continue;
    let entries: Awaited<ReturnType<typeof opendir>>;
    try {
      entries = await opendir(current.directory);
    } catch {
      // A folder that cannot be listed hides what is under it, and the rest of the root still counts.
      continue;
    }
    for await (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (['node_modules', '.cache', 'dist', 'coverage'].includes(entry.name)) continue;
      queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }

  return repositories.sort((left, right) => left.localeCompare(right));
}
