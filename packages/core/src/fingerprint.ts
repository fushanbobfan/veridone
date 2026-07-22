import type { RepositorySnapshot } from './model.js';

export type FingerprintInput = Omit<
  RepositorySnapshot,
  'fingerprint' | 'capturedAt' | 'worktreeHash' | 'diffStats'
> &
  Partial<Pick<RepositorySnapshot, 'worktreeHash' | 'diffStats'>>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }

  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createRepositorySnapshot(
  input: FingerprintInput,
  capturedAt = new Date().toISOString(),
): Promise<RepositorySnapshot> {
  const normalized: Omit<RepositorySnapshot, 'fingerprint' | 'capturedAt'> = {
    ...input,
    statusEntries: [...input.statusEntries].sort(),
    submoduleEntries: [...input.submoduleEntries].sort(),
    worktreeHash:
      input.worktreeHash ??
      (await sha256Hex(canonicalJson({ statusEntries: [...input.statusEntries].sort() }))),
    diffStats: input.diffStats ?? {
      changedFiles: input.statusEntries.length,
      additions: 0,
      deletions: 0,
      binaryFiles: 0,
      untrackedFiles: input.statusEntries.filter((entry) => entry.startsWith('??')).length,
    },
  };

  const repositoryState = {
    repositoryId: normalized.repositoryId,
    head: normalized.head,
    branch: normalized.branch,
    statusEntries: normalized.statusEntries,
    submoduleEntries: normalized.submoduleEntries,
    worktreeHash: normalized.worktreeHash,
  };

  return {
    ...normalized,
    // A claim binds to repository state. Policy versions are checked separately so that
    // approving a new check invalidates old evidence without pretending the Git state changed.
    fingerprint: await sha256Hex(canonicalJson(repositoryState)),
    capturedAt,
  };
}
