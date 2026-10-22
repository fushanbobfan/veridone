import { normalizeReceiptTimestamp, receiptFieldSchemas } from '@veridone/adapters';
import { canonicalJson, repositorySnapshotSchema, sha256Hex } from '@veridone/core';
import { z } from 'zod';

import { checkDefinitionHash, checkRequestSchema } from './check-policy.js';
import type { EvidenceRecord, ReceiptRecord, VerdictRecord, VeriDoneDatabase } from './database.js';

/** A backup disagrees with recorded history. The restore writes nothing. */
export class WorkspaceConflictError extends Error {
  override readonly name = 'WorkspaceConflictError';
}

const isoDate = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[0-9a-f]{64}$/iu);

const approvedRootSchema = z.object({
  id: z.string().uuid(),
  path: z.string().min(1).max(4_096),
  label: z.string().min(1).max(120),
  createdAt: isoDate,
});

const repositorySchema = z.object({
  id: z.string().min(1).max(128),
  path: z.string().min(1).max(4_096),
  name: z.string().min(1).max(512),
  snapshot: repositorySnapshotSchema,
  updatedAt: isoDate,
});

// Receipt and work-item fields use the receipt import's own rules, so whatever imports also exports.
const receiptSchema = z.object({
  id: z.string().uuid(),
  runId: receiptFieldSchemas.runId,
  sourcePath: z.string().min(1).max(4_096),
  taskType: receiptFieldSchemas.taskType,
  status: receiptFieldSchemas.status,
  startedAt: receiptFieldSchemas.timestamp,
  completedAt: receiptFieldSchemas.timestamp.nullable(),
  stageCount: z.number().int().nonnegative().max(100_000),
  degraded: z.boolean(),
  importedAt: isoDate,
});

const workItemSchema = z.object({
  id: z.string().uuid(),
  repositoryId: z.string().min(1).max(128).nullable(),
  sourceType: z.string().min(1).max(100),
  sourceRef: z.string().min(1).max(4_096),
  title: receiptFieldSchemas.title,
  claim: receiptFieldSchemas.claim,
  sourceLabel: z.string().min(1).max(200),
  updatedAt: isoDate,
  snapshotFingerprint: sha256.nullable(),
  humanVerdict: z.enum(['accepted', 'changes-requested', 'rejected']).nullable(),
});

const checkSchema = z.object({
  id: z.string().uuid(),
  repositoryId: z.string().min(1).max(128),
  label: z.string().min(1).max(200),
  kind: z.string().min(1).max(100),
  executable: z.string().min(1).max(4_096),
  args: z.array(z.string().max(4_096)).max(100),
  versionArgs: z.array(z.string().max(4_096)).max(10).default(['--version']),
  scopePaths: z.array(z.string().max(1_024)).max(100).default([]),
  cwdRelative: z.string().min(1).max(1_024),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(30 * 60_000),
  maxOutputBytes: z.number().int().min(1_024).max(10_000_000),
  resolvedExecutable: z.string().min(1).max(4_096).nullable().default(null),
  executableSha256: sha256.nullable().default(null),
  definitionHash: sha256,
  approvedAt: isoDate,
});

const evidenceSchema = z.object({
  id: z.string().uuid(),
  workItemId: z.string().uuid(),
  checkId: z.string().uuid(),
  kind: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  result: z.string().min(1).max(100),
  repositoryId: z.string().min(1).max(128),
  snapshotFingerprint: sha256,
  head: z.string().regex(/^[0-9a-f]{7,64}$/iu),
  contractVersion: z.string().min(1).max(200),
  checkDefinitionVersion: z.string().min(1).max(200),
  startedAt: isoDate,
  completedAt: isoDate,
  durationMs: z.number().int().nonnegative(),
  toolVersion: z.string().max(4_096).nullable().default(null),
  exitCode: z.number().int().nullable().default(null),
  stdout: z.string().max(10_000_000),
  stderr: z.string().max(10_000_000),
  artifactHashes: z.array(sha256).max(10_000),
  invalidReason: z.string().max(2_000).nullable(),
  isolation: z.enum(['clean-checkout']).nullable().default(null),
  toolPath: z.string().min(1).max(4_096).nullable().default(null),
  toolSha256: sha256.nullable().default(null),
  origin: z.enum(['local', 'imported']).default('local'),
});

const verdictSchema = z.object({
  id: z.string().uuid(),
  workItemId: z.string().uuid(),
  decision: z.enum(['accepted', 'changes-requested', 'rejected']),
  note: z.string().max(10_000),
  decidedAt: isoDate,
  snapshotFingerprint: sha256,
  contractVersion: z.string().min(1).max(200),
  evidenceIds: z.array(z.string().uuid()).max(10_000),
  overrideReason: z.string().min(1).max(2_000).nullable(),
  // Version 1 backups predate the verdict chain and carry neither field.
  sequence: z.number().int().min(1).optional(),
  previousVerdictId: z.string().uuid().nullable().optional(),
  claimHash: sha256.nullable().default(null),
});

const contractSchema = z.object({
  id: z.string().min(1).max(128),
  version: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  criteria: z.array(z.unknown()).max(1_000),
  createdAt: isoDate,
});

const workspacePayloadSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    application: z.literal('veridone'),
    exportedAt: isoDate,
    data: z.object({
      approvedRoots: z.array(approvedRootSchema).max(10_000),
      repositories: z.array(repositorySchema).max(10_000),
      receipts: z.array(receiptSchema).max(100_000),
      workItems: z.array(workItemSchema).max(100_000),
      contracts: z.array(contractSchema).max(10_000),
      checks: z.array(checkSchema).max(100_000),
      evidence: z.array(evidenceSchema).max(500_000),
      verdicts: z.array(verdictSchema).max(500_000),
    }),
  })
  .strict();

const integritySchema = z
  .object({
    algorithm: z.literal('sha256'),
    payloadHash: sha256,
  })
  .strict();

export const workspaceDocumentSchema = workspacePayloadSchema
  .extend({ integrity: integritySchema })
  .strict();

export type WorkspaceDocument = z.infer<typeof workspaceDocumentSchema>;
type WorkspaceData = WorkspaceDocument['data'];
export type WorkspaceCounts = Record<keyof WorkspaceData, number>;

/**
 * Receipts imported before import normalized their times may hold a local time without an offset;
 * the backup carries it as an ISO 8601 timestamp.
 */
function exportableReceipt(receipt: ReceiptRecord): ReceiptRecord {
  const timestamp = (value: string) => {
    const normalized = normalizeReceiptTimestamp(value);
    if (normalized === null) {
      throw new Error(
        `Receipt ${receipt.runId} records the time "${value}", which is not a timestamp. Import the receipt again with an ISO 8601 time.`,
      );
    }
    return normalized;
  };
  return {
    ...receipt,
    startedAt: timestamp(receipt.startedAt),
    completedAt: receipt.completedAt === null ? null : timestamp(receipt.completedAt),
  };
}

export async function exportWorkspace(database: VeriDoneDatabase): Promise<WorkspaceDocument> {
  const payload = workspacePayloadSchema.parse({
    schemaVersion: 2,
    application: 'veridone',
    exportedAt: new Date().toISOString(),
    data: {
      approvedRoots: database.listApprovedRoots(),
      repositories: database.listRepositories(),
      receipts: database.listReceipts().map(exportableReceipt),
      workItems: database.listWorkItems(),
      contracts: database.listContracts(),
      checks: database.listChecks(),
      evidence: database.listEvidence(),
      verdicts: database.listVerdicts(),
    },
  });
  return {
    ...payload,
    integrity: {
      algorithm: 'sha256',
      payloadHash: await sha256Hex(canonicalJson(payload)),
    },
  };
}

function emptyCounts(): WorkspaceCounts {
  return {
    approvedRoots: 0,
    repositories: 0,
    receipts: 0,
    workItems: 0,
    contracts: 0,
    checks: 0,
    evidence: 0,
    verdicts: 0,
  };
}

/** Puts each work item's verdicts in chain order, deriving the chain for version 1 backups. */
function verdictHistory(document: WorkspaceDocument): VerdictRecord[] {
  const byWorkItem = new Map<
    string,
    Array<{ verdict: WorkspaceData['verdicts'][number]; index: number }>
  >();
  document.data.verdicts.forEach((verdict, index) => {
    const entries = byWorkItem.get(verdict.workItemId) ?? [];
    entries.push({ verdict, index });
    byWorkItem.set(verdict.workItemId, entries);
  });
  const history: VerdictRecord[] = [];
  for (const entries of byWorkItem.values()) {
    if (document.schemaVersion === 1) {
      // Version 1 lists verdicts newest first; chain them in the order they were decided.
      const ordered = [...entries].sort(
        (left, right) =>
          Date.parse(left.verdict.decidedAt) - Date.parse(right.verdict.decidedAt) ||
          right.index - left.index,
      );
      ordered.forEach(({ verdict }, position) => {
        history.push({
          ...verdict,
          sequence: position + 1,
          previousVerdictId: position === 0 ? null : (ordered[position - 1]?.verdict.id ?? null),
        });
      });
      continue;
    }
    const ordered = [...entries].sort(
      (left, right) => (left.verdict.sequence ?? 0) - (right.verdict.sequence ?? 0),
    );
    for (const { verdict } of ordered) {
      if (verdict.sequence === undefined || verdict.previousVerdictId === undefined) {
        throw new Error(
          'A version 2 backup records the sequence and predecessor of every verdict.',
        );
      }
      history.push({
        ...verdict,
        sequence: verdict.sequence,
        previousVerdictId: verdict.previousVerdictId,
      });
    }
  }
  return history;
}

function sameEvidence(local: EvidenceRecord, incoming: Omit<EvidenceRecord, 'origin'>): boolean {
  const { origin: _origin, ...recorded } = local;
  return canonicalJson(recorded) === canonicalJson(incoming);
}

function sameVerdict(
  local: VerdictRecord,
  incoming: VerdictRecord,
  compareChain: boolean,
): boolean {
  const comparable = ({ sequence, previousVerdictId, ...verdict }: VerdictRecord) =>
    compareChain ? { ...verdict, sequence, previousVerdictId } : verdict;
  return canonicalJson(comparable(local)) === canonicalJson(comparable(incoming));
}

/**
 * Restores a workspace backup by adding what the workspace lacks. Records that already exist are
 * kept as they are; evidence and verdicts that already exist must match the backup exactly. Each
 * work item's verdicts replay in chain order through the same append-only path as new verdicts,
 * so the backup can extend a history but never rewrite it. Restored evidence is marked imported
 * and satisfies no gate, and restored checks must have their tools pinned before they run.
 */
export async function importWorkspace(
  database: VeriDoneDatabase,
  input: unknown,
): Promise<{ imported: WorkspaceCounts; unchanged: WorkspaceCounts }> {
  // The checksum covers the payload exactly as the file carries it, before defaults fill gaps.
  const { integrity, ...rawPayload } = z.looseObject({ integrity: integritySchema }).parse(input);
  if ((await sha256Hex(canonicalJson(rawPayload))) !== integrity.payloadHash) {
    throw new Error('The workspace integrity hash does not match its payload.');
  }
  const document = workspaceDocumentSchema.parse(input);
  const data = document.data;
  const verdicts = verdictHistory(document);
  const checks = await Promise.all(
    data.checks.map(async (record) => {
      const definition = {
        ...checkRequestSchema.parse({
          repositoryId: record.repositoryId,
          label: record.label,
          kind: record.kind,
          executable: record.executable,
          args: record.args,
          versionArgs: record.versionArgs,
          scopePaths: record.scopePaths,
          cwdRelative: record.cwdRelative,
          timeoutMs: record.timeoutMs,
          maxOutputBytes: record.maxOutputBytes,
        }),
        // A backup cannot vouch for a tool file on this machine; the operator pins it again.
        resolvedExecutable: null,
        executableSha256: null,
      };
      return {
        ...definition,
        id: record.id,
        approvedAt: record.approvedAt,
        definitionHash: await checkDefinitionHash(definition),
      };
    }),
  );

  const imported = emptyCounts();
  const unchanged = emptyCounts();
  const tally = (kind: keyof WorkspaceData, added: boolean) => {
    if (added) imported[kind] += 1;
    else unchanged[kind] += 1;
  };
  const connection = database.connection;

  connection
    .transaction(() => {
      const insertRoot = connection.prepare(`
        INSERT INTO approved_roots (id, canonical_path, label, created_at)
        VALUES (@id, @path, @label, @createdAt)
        ON CONFLICT DO NOTHING
      `);
      for (const record of data.approvedRoots) {
        tally('approvedRoots', insertRoot.run(record).changes === 1);
      }

      const insertRepository = connection.prepare(`
        INSERT INTO repositories (
          id, canonical_path, name, branch, head, fingerprint, status_entries_json,
          submodule_entries_json, worktree_hash, diff_stats_json, contract_version,
          check_definition_version, captured_at, updated_at
        ) VALUES (
          @id, @path, @name, @branch, @head, @fingerprint, @statusEntries,
          @submoduleEntries, @worktreeHash, @diffStats, @contractVersion,
          @checkDefinitionVersion, @capturedAt, @updatedAt
        ) ON CONFLICT DO NOTHING
      `);
      for (const record of data.repositories) {
        const result = insertRepository.run({
          ...record,
          ...record.snapshot,
          statusEntries: JSON.stringify(record.snapshot.statusEntries),
          submoduleEntries: JSON.stringify(record.snapshot.submoduleEntries),
          worktreeHash: record.snapshot.worktreeHash,
          diffStats: JSON.stringify(record.snapshot.diffStats),
        });
        tally('repositories', result.changes === 1);
      }

      const insertReceipt = connection.prepare(`
        INSERT INTO receipts (
          id, run_id, source_path, task_type, status, started_at, completed_at,
          stage_count, degraded, imported_at
        ) VALUES (
          @id, @runId, @sourcePath, @taskType, @status, @startedAt, @completedAt,
          @stageCount, @degraded, @importedAt
        ) ON CONFLICT DO NOTHING
      `);
      for (const record of data.receipts) {
        tally(
          'receipts',
          insertReceipt.run({ ...record, degraded: record.degraded ? 1 : 0 }).changes === 1,
        );
      }

      const sameSource = connection.prepare(
        'SELECT id FROM work_items WHERE source_ref = ? AND id <> ?',
      );
      const insertWorkItem = connection.prepare(`
        INSERT INTO work_items (
          id, repository_id, source_type, source_ref, title, claim, source_label,
          updated_at, snapshot_fingerprint, human_verdict
        ) VALUES (
          @id, @repositoryId, @sourceType, @sourceRef, @title, @claim, @sourceLabel,
          @updatedAt, @snapshotFingerprint, NULL
        ) ON CONFLICT(id) DO NOTHING
      `);
      for (const record of data.workItems) {
        if (sameSource.get(record.sourceRef, record.id)) {
          throw new WorkspaceConflictError(
            `The backup's work item "${record.title}" has a different ID than the local work item imported from the same source. Restore into a workspace that has not imported that receipt.`,
          );
        }
        tally('workItems', insertWorkItem.run(record).changes === 1);
      }

      const insertContract = connection.prepare(`
        INSERT INTO acceptance_contracts (id, version, title, criteria_json, created_at)
        VALUES (@id, @version, @title, @criteriaJson, @createdAt)
        ON CONFLICT DO NOTHING
      `);
      for (const record of data.contracts) {
        const result = insertContract.run({
          ...record,
          criteriaJson: JSON.stringify(record.criteria),
        });
        tally('contracts', result.changes === 1);
      }

      const insertCheck = connection.prepare(`
        INSERT INTO checks (
          id, repository_id, label, kind, executable, args_json, cwd_relative,
          timeout_ms, max_output_bytes, definition_hash, approved_at,
          version_args_json, scope_paths_json, resolved_executable, executable_sha256
        ) VALUES (
          @id, @repositoryId, @label, @kind, @executable, @argsJson, @cwdRelative,
          @timeoutMs, @maxOutputBytes, @definitionHash, @approvedAt,
          @versionArgsJson, @scopePathsJson, @resolvedExecutable, @executableSha256
        ) ON CONFLICT(id) DO NOTHING
      `);
      for (const record of checks) {
        const result = insertCheck.run({
          ...record,
          argsJson: JSON.stringify(record.args),
          versionArgsJson: JSON.stringify(record.versionArgs),
          scopePathsJson: JSON.stringify(record.scopePaths),
        });
        tally('checks', result.changes === 1);
      }

      for (const { origin: _origin, ...record } of data.evidence) {
        const local = database.getEvidence(record.id);
        if (local) {
          if (!sameEvidence(local, record)) {
            throw new WorkspaceConflictError(
              `The backup's evidence ${record.id} differs from the local record with the same ID. Recorded evidence is never replaced.`,
            );
          }
          tally('evidence', false);
          continue;
        }
        database.recordImportedEvidence(record);
        tally('evidence', true);
      }

      for (const verdict of verdicts) {
        const local = database.getVerdict(verdict.id);
        if (local) {
          if (!sameVerdict(local, verdict, document.schemaVersion !== 1)) {
            throw new WorkspaceConflictError(
              `The backup's verdict ${verdict.id} differs from the local verdict with the same ID. Recorded verdicts are never replaced.`,
            );
          }
          tally('verdicts', false);
          continue;
        }
        const head = database.latestVerdict(verdict.workItemId);
        if (
          (head?.id ?? null) !== verdict.previousVerdictId ||
          (head?.sequence ?? 0) + 1 !== verdict.sequence
        ) {
          throw new WorkspaceConflictError(
            `The backup's verdict history for work item ${verdict.workItemId} diverges from the local history. A restore can only extend it.`,
          );
        }
        database.appendVerdict(verdict);
        tally('verdicts', true);
      }
    })
    .immediate();

  return { imported, unchanged };
}
