import { opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export class PathBoundaryError extends Error {
  override readonly name = 'PathBoundaryError';
}

function isWithin(candidate: string, root: string): boolean {
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
    throw new PathBoundaryError('No filesystem roots have been approved.');
  }

  const resolvedCandidate = await realpath(path.resolve(candidate));
  const resolvedRoots = await Promise.all(
    approvedRoots.map(async (root) => realpath(path.resolve(root))),
  );

  if (!resolvedRoots.some((root) => isWithin(resolvedCandidate, root))) {
    throw new PathBoundaryError('The requested path is outside the approved roots.');
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
  const root = await realpath(path.resolve(approvedRoot));
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
    const entries = await opendir(current.directory);
    for await (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (['node_modules', '.cache', 'dist', 'coverage'].includes(entry.name)) continue;
      queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }

  return repositories.sort((left, right) => left.localeCompare(right));
}
