import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalJson,
  createRepositorySnapshot,
  sha256Hex,
  type RepositorySnapshot,
} from '@veridone/core';

import { GitAdapterError, openGitSession, type GitSession } from './git-runtime.js';
import { resolveWithinApprovedRoots } from './path-boundary.js';

async function git(session: GitSession, args: string[]): Promise<string> {
  const result = await session.run(args);

  if (result.state !== 'completed' || result.exitCode !== 0) {
    throw new GitAdapterError(
      result.stderr.trim() || `Git ${args[0] ?? 'command'} failed with ${result.state}.`,
    );
  }

  return result.stdout;
}

async function optionalGit(session: GitSession, args: string[]): Promise<string | null> {
  const result = await session.run(args);
  return result.state === 'completed' && result.exitCode === 0 ? result.stdout : null;
}

function parseNullDelimited(value: string): string[] {
  return value
    .split('\0')
    .map((entry) => entry.trimEnd())
    .filter(Boolean);
}

function parseNumstat(value: string): {
  additions: number;
  deletions: number;
  binaryFiles: number;
} {
  let additions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  for (const line of value.split(/\r?\n/u).filter(Boolean)) {
    const [added, deleted] = line.split('\t');
    if (added === '-' || deleted === '-') {
      binaryFiles += 1;
      continue;
    }
    additions += Number(added ?? 0);
    deletions += Number(deleted ?? 0);
  }
  return { additions, deletions, binaryFiles };
}

async function hashWorkingPath(
  repositoryPath: string,
  relativePath: string,
): Promise<string | null> {
  const absolutePath = path.resolve(repositoryPath, relativePath);
  const boundary = `${path.resolve(repositoryPath)}${path.sep}`;
  if (!absolutePath.startsWith(boundary)) {
    throw new GitAdapterError('Git returned a path outside the repository boundary.');
  }
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    return sha256Hex(`symlink:${await readlink(absolutePath)}`);
  }
  if (!metadata.isFile()) return null;
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolutePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function hashWorkingPaths(
  repositoryPath: string,
  relativePaths: string[],
): Promise<Array<{ path: string; hash: string }>> {
  const result: Array<{ path: string; hash: string }> = [];
  const unique = [...new Set(relativePaths)].sort();
  for (let index = 0; index < unique.length; index += 32) {
    const batch = unique.slice(index, index + 32);
    const hashes = await Promise.all(
      batch.map(async (relativePath) => ({
        path: relativePath,
        hash: await hashWorkingPath(repositoryPath, relativePath),
      })),
    );
    result.push(
      ...hashes.filter((entry): entry is { path: string; hash: string } => entry.hash !== null),
    );
  }
  return result;
}

export interface CaptureGitSnapshotOptions {
  approvedRoots: string[];
  contractVersion: string;
  checkDefinitionVersion: string;
}

export async function captureGitSnapshot(
  requestedPath: string,
  options: CaptureGitSnapshotOptions,
): Promise<{ repositoryPath: string; snapshot: RepositorySnapshot }> {
  const repositoryPath = await resolveWithinApprovedRoots(requestedPath, options.approvedRoots);
  const session = await openGitSession(repositoryPath, { operatorSettings: true });
  const topLevel = (await git(session, ['rev-parse', '--show-toplevel'])).trim();
  const canonicalTopLevel = await resolveWithinApprovedRoots(topLevel, options.approvedRoots);

  if (canonicalTopLevel !== repositoryPath) {
    throw new GitAdapterError('Select the repository root rather than a nested directory.');
  }

  // Submodule work trees are compared by commit only, so no command runs inside a submodule,
  // whose configuration VeriDone has not read.
  const diff = ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty'];
  const [head, branch, status, submodules, unstagedPaths, stagedPaths, untrackedPaths, cachedDiff] =
    await Promise.all([
      optionalGit(session, ['rev-parse', '--verify', 'HEAD']),
      git(session, ['branch', '--show-current']),
      git(session, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=dirty',
      ]),
      git(session, ['submodule', 'status', '--recursive']),
      git(session, [...diff, '--name-only', '-z', '--']),
      git(session, [...diff, '--cached', '--name-only', '-z', '--']),
      git(session, ['ls-files', '--others', '--exclude-standard', '-z']),
      git(session, [...diff, '--cached', '--raw', '--full-index', '-z', '--']),
    ]);
  const statusEntries = parseNullDelimited(status);
  const untracked = parseNullDelimited(untrackedPaths);
  const workingContent = await hashWorkingPaths(repositoryPath, [
    ...parseNullDelimited(unstagedPaths),
    ...parseNullDelimited(stagedPaths),
    ...untracked,
  ]);
  const worktreeHash = await sha256Hex(
    canonicalJson({ statusEntries, cachedDiff, workingContent }),
  );
  const numstat = head
    ? parseNumstat(await git(session, [...diff, '--numstat', 'HEAD', '--']))
    : { additions: 0, deletions: 0, binaryFiles: 0 };
  const repositoryId = await sha256Hex(canonicalTopLevel.replaceAll('\\', '/').toLowerCase());
  const snapshot = await createRepositorySnapshot({
    repositoryId,
    head: head?.trim() || '0000000000000000000000000000000000000000',
    branch: branch.trim() || null,
    statusEntries,
    submoduleEntries: submodules
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter(Boolean),
    worktreeHash,
    diffStats: {
      changedFiles: statusEntries.length,
      additions: numstat.additions,
      deletions: numstat.deletions,
      binaryFiles: numstat.binaryFiles,
      untrackedFiles: untracked.length,
    },
    contractVersion: options.contractVersion,
    checkDefinitionVersion: options.checkDefinitionVersion,
  });

  return { repositoryPath: canonicalTopLevel, snapshot };
}
