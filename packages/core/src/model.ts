import { z } from 'zod';

export const evidenceKindSchema = z.enum([
  'test',
  'lint',
  'typecheck',
  'build',
  'security',
  'accessibility',
  'browser',
  'ci',
  'artifact',
  'manual-inspection',
]);

export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const checkResultSchema = z.enum([
  'passed',
  'failed',
  'timed-out',
  'cancelled',
  'spawn-error',
  'output-capped',
  'mutated',
]);

export type CheckResult = z.infer<typeof checkResultSchema>;

export const repositorySnapshotSchema = z.object({
  repositoryId: z.string().min(1),
  head: z.string().regex(/^[0-9a-f]{7,64}$/i),
  branch: z.string().min(1).nullable(),
  statusEntries: z.array(z.string()).max(10_000),
  submoduleEntries: z.array(z.string()).max(1_000).default([]),
  worktreeHash: z.string().regex(/^[0-9a-f]{64}$/i),
  diffStats: z.object({
    changedFiles: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binaryFiles: z.number().int().nonnegative(),
    untrackedFiles: z.number().int().nonnegative(),
  }),
  contractVersion: z.string().min(1),
  checkDefinitionVersion: z.string().min(1),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/i),
  capturedAt: z.string().datetime(),
});

export type RepositorySnapshot = z.infer<typeof repositorySnapshotSchema>;
