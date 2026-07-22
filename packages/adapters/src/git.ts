import { createRepositorySnapshot, sha256Hex, type RepositorySnapshot } from '@veridone/core';

import { resolveWithinApprovedRoots } from './path-boundary.js';
import { runBoundedProcess } from './process.js';

export class GitAdapterError extends Error {
  override readonly name = 'GitAdapterError';
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await runBoundedProcess({
    executable: 'git',
    args: ['-C', repositoryPath, ...args],
    cwd: repositoryPath,
    timeoutMs: 15_000,
    maxOutputBytes: 2_000_000,
  });

  if (result.state !== 'completed' || result.exitCode !== 0) {
    throw new GitAdapterError(
      result.stderr.trim() || `Git ${args[0] ?? 'command'} failed with ${result.state}.`,
    );
  }

  return result.stdout;
}

async function optionalGit(repositoryPath: string, args: string[]): Promise<string | null> {
  const result = await runBoundedProcess({
    executable: 'git',
    args: ['-C', repositoryPath, ...args],
    cwd: repositoryPath,
    timeoutMs: 15_000,
    maxOutputBytes: 2_000_000,
  });
  return result.state === 'completed' && result.exitCode === 0 ? result.stdout : null;
}

function parseNullDelimited(value: string): string[] {
  return value
    .split('\0')
    .map((entry) => entry.trimEnd())
    .filter(Boolean);
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
  const topLevel = (await git(repositoryPath, ['rev-parse', '--show-toplevel'])).trim();
  const canonicalTopLevel = await resolveWithinApprovedRoots(topLevel, options.approvedRoots);

  if (canonicalTopLevel !== repositoryPath) {
    throw new GitAdapterError('Select the repository root rather than a nested directory.');
  }

  const [head, branch, status, submodules] = await Promise.all([
    optionalGit(repositoryPath, ['rev-parse', '--verify', 'HEAD']),
    git(repositoryPath, ['branch', '--show-current']),
    git(repositoryPath, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
    git(repositoryPath, ['submodule', 'status', '--recursive']),
  ]);
  const repositoryId = await sha256Hex(canonicalTopLevel.replaceAll('\\', '/').toLowerCase());
  const snapshot = await createRepositorySnapshot({
    repositoryId,
    head: head?.trim() || '0000000000000000000000000000000000000000',
    branch: branch.trim() || null,
    statusEntries: parseNullDelimited(status),
    submoduleEntries: submodules
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter(Boolean),
    contractVersion: options.contractVersion,
    checkDefinitionVersion: options.checkDefinitionVersion,
  });

  return { repositoryPath: canonicalTopLevel, snapshot };
}
