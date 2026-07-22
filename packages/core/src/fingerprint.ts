import type { RepositorySnapshot } from './model.js';

export type FingerprintInput = Omit<RepositorySnapshot, 'fingerprint' | 'capturedAt'>;

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
  const normalized: FingerprintInput = {
    ...input,
    statusEntries: [...input.statusEntries].sort(),
    submoduleEntries: [...input.submoduleEntries].sort(),
  };

  return {
    ...normalized,
    fingerprint: await sha256Hex(canonicalJson(normalized)),
    capturedAt,
  };
}
