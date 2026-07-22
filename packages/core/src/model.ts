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
  contractVersion: z.string().min(1),
  checkDefinitionVersion: z.string().min(1),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/i),
  capturedAt: z.string().datetime(),
});

export type RepositorySnapshot = z.infer<typeof repositorySnapshotSchema>;

export const claimSchema = z.object({
  id: z.string().min(1),
  workItemId: z.string().min(1),
  sourceType: z.enum(['codex', 'claude-code', 'harness', 'ci', 'generic', 'manual']),
  sourceRef: z.string().min(1),
  statement: z.string().min(1).max(20_000),
  claimedAt: z.string().datetime().nullable(),
});

export type Claim = z.infer<typeof claimSchema>;

export const evidenceSchema = z.object({
  id: z.string().min(1),
  workItemId: z.string().min(1),
  kind: evidenceKindSchema,
  label: z.string().min(1).max(200),
  source: z.enum(['veridone-check', 'ci', 'imported-artifact', 'manual-inspection']),
  result: checkResultSchema,
  repositoryId: z.string().min(1).nullable(),
  snapshotFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .nullable(),
  head: z.string().nullable(),
  contractVersion: z.string().min(1).nullable(),
  checkDefinitionVersion: z.string().min(1).nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  artifactHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/i)),
  invalidReason: z.string().max(2_000).nullable(),
});

export type Evidence = z.infer<typeof evidenceSchema>;

export const criterionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(300),
  required: z.boolean(),
  accepts: z.array(evidenceKindSchema).min(1),
});

export type Criterion = z.infer<typeof criterionSchema>;

export const acceptanceContractSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1).max(200),
  criteria: z.array(criterionSchema).min(1).max(100),
});

export type AcceptanceContract = z.infer<typeof acceptanceContractSchema>;

export const workItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(300),
  repositoryId: z.string().min(1),
  sourceLabel: z.string().min(1).max(200),
  updatedAt: z.string().datetime(),
  hasSensitivePaths: z.boolean(),
  hasScopeDrift: z.boolean(),
  humanVerdict: z.enum(['accepted', 'changes-requested', 'rejected']).nullable(),
});

export type WorkItem = z.infer<typeof workItemSchema>;

export const verdictSchema = z.object({
  id: z.string().min(1),
  workItemId: z.string().min(1),
  decision: z.enum(['accepted', 'changes-requested', 'rejected']),
  note: z.string().max(10_000),
  decidedAt: z.string().datetime(),
  snapshotFingerprint: z.string().regex(/^[0-9a-f]{64}$/i),
  contractVersion: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
  overrideReason: z.string().min(1).max(2_000).nullable(),
});

export type Verdict = z.infer<typeof verdictSchema>;
