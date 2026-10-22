import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pathFromStatusEntry } from '@veridone/core';

import {
  GitAdapterError,
  gitRuntime,
  openGitSession,
  runGitProcess,
  type GitSetting,
} from './git-runtime.js';

export interface CheckoutComparison {
  /** True when the checkout's HEAD is no longer the bound commit. */
  headMoved: boolean;
  /** Files that differ from the bound commit, and new files its .gitignore files do not cover. */
  changedPaths: string[];
}

export interface CleanCheckout {
  directory: string;
  commit: string;
  /** Compares the checkout with the bound commit; throws when the comparison cannot run. */
  compare(): Promise<CheckoutComparison>;
  remove(): Promise<void>;
}

const reviewRef = 'refs/veridone/review';

/**
 * Creates a verifier-owned checkout of `expectedCommit`, the HEAD of the repository at
 * `repositoryPath`. The checkout is a new repository with VeriDone's fixed Git configuration and
 * no hooks. It receives the commit through a shallow fetch, so Git recomputes every object hash on
 * arrival, and nothing from the source work tree, index, ignored files, or configuration reaches
 * it. Submodules are not checked out.
 */
export async function createCleanCheckout(
  repositoryPath: string,
  expectedCommit: string,
  options: { signal?: AbortSignal } = {},
): Promise<CleanCheckout> {
  if (!/^[0-9a-f]{40,64}$/u.test(expectedCommit)) {
    throw new GitAdapterError('The bound commit is not a full object ID.');
  }
  const runtime = await gitRuntime();
  // The checkout sits in `work`; the comparison index sits beside it, outside the work tree.
  const root = await mkdtemp(path.join(tmpdir(), 'veridone-checkout-'));
  const directory = path.join(root, 'work');
  const remove = async () => {
    // A process the check left behind can hold files open on Windows; the operating system's
    // temporary-file cleanup removes whatever remains.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      () => undefined,
    );
  };
  const git = async (args: string[], settings: GitSetting[] = []) => {
    const result = await runGitProcess(runtime, args, settings, {
      timeoutMs: 120_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.state !== 'completed' || result.exitCode !== 0) {
      throw new GitAdapterError(
        result.stderr.trim() || `Preparing the clean checkout failed with ${result.state}.`,
      );
    }
    return result.stdout;
  };

  try {
    await git(['init', '--quiet', '--template=', directory], [['init.defaultBranch', 'review']]);
    if (process.platform === 'win32') {
      await git(['-C', directory, 'config', 'core.longpaths', 'true']);
    }
    await git([
      '-C',
      directory,
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-recurse-submodules',
      '--no-write-fetch-head',
      '--depth=1',
      '--',
      repositoryPath,
      `+HEAD:${reviewRef}`,
    ]);
    const fetched = (
      await git([
        '-C',
        directory,
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${reviewRef}^{commit}`,
      ])
    ).trim();
    if (fetched !== expectedCommit) {
      throw new GitAdapterError(
        'The repository moved to another commit while VeriDone prepared its checkout. Run the checks again.',
      );
    }
    await git(['-C', directory, 'checkout', '--quiet', '--detach', expectedCommit, '--']);
  } catch (error) {
    await remove();
    throw error;
  }

  return {
    directory,
    commit: expectedCommit,
    compare: async () => {
      // The check ran code from the commit, which can rewrite the checkout's HEAD, index, and
      // configuration. A new session rereads that configuration and blanks its filters; the
      // repository and work tree are named explicitly; the work tree is compared with a fresh
      // index read from the bound commit; new files count unless the work tree's own .gitignore
      // files cover them.
      const session = await openGitSession(directory, { operatorSettings: false });
      const pinned = ['--git-dir', path.join(directory, '.git'), '--work-tree', directory];
      const run = async (args: string[], environment?: Record<string, string>) => {
        const result = await session.run([...pinned, ...args], {
          timeoutMs: 120_000,
          ...(environment ? { environment } : {}),
        });
        if (result.state !== 'completed' || result.exitCode !== 0) {
          throw new GitAdapterError(
            result.stderr.trim() || `Git ${args[0] ?? 'command'} failed with ${result.state}.`,
          );
        }
        return result.stdout;
      };
      const head = (
        await run(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])
      ).trim();
      const index = { GIT_INDEX_FILE: path.join(root, 'compare.index') };
      await run(['read-tree', expectedCommit], index);
      const tracked = await run(
        ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=dirty'],
        index,
      );
      const untracked = await run(
        ['ls-files', '--others', '-z', '--exclude-per-directory=.gitignore'],
        index,
      );
      const changedPaths = [
        ...tracked.split('\0').filter(Boolean).map(pathFromStatusEntry),
        ...untracked.split('\0').filter(Boolean),
      ];
      return { headMoved: head !== expectedCommit, changedPaths: [...new Set(changedPaths)] };
    },
    remove,
  };
}
