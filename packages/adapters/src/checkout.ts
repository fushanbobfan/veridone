import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  GitAdapterError,
  gitRuntime,
  openGitSession,
  runGitProcess,
  type GitSetting,
} from './git-runtime.js';

export interface CleanCheckout {
  directory: string;
  commit: string;
  /** Porcelain status entries of the checkout; empty unless something changed its files. */
  changes(): Promise<string[]>;
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
  const directory = await mkdtemp(path.join(tmpdir(), 'veridone-checkout-'));
  const remove = async () => {
    // A process the check left behind can hold files open on Windows; the operating system's
    // temporary-file cleanup removes whatever remains.
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
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
    changes: async () => {
      // A new session rereads the configuration, which the check itself may have edited.
      const session = await openGitSession(directory, { operatorSettings: false });
      const result = await session.run(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty'],
        { timeoutMs: 60_000 },
      );
      if (result.state !== 'completed' || result.exitCode !== 0) {
        throw new GitAdapterError(result.stderr.trim() || 'The checkout status could not be read.');
      }
      return result.stdout.split('\0').filter(Boolean);
    },
    remove,
  };
}
