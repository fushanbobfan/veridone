import { normalizeReceiptTimestamp } from '@veridone/adapters';
import { canonicalJson, repositorySnapshotSchema, sha256Hex } from '@veridone/core';
import { z } from 'zod';

import { checkDefinitionHash, checkRequestSchema } from './check-policy.js';
import {
  claimHash,
  type EvidenceRecord,
  type VerdictRecord,
  type VeriDoneDatabase,
} from './database.js';

/** A backup disagrees with recorded history. The restore writes nothing. */
export class WorkspaceConflictError extends Error {
  override readonly name = 'WorkspaceConflictError';
}

/**
 * The largest backup export writes and restore reads. A backup is read as one string, and a JavaScript string
 * ends a little past 536 million characters.
 */
export const maxWorkspaceBackupBytes = 500_000_000;

const isoDate = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[0-9a-f]{64}$/iu);
// A receipt's own time as an earlier version stored it: an ISO 8601 timestamp when it can be read as one.
const storedTime = z.string().transform((value) => normalizeReceiptTimestamp(value) ?? value);

// Import and approval limit new data. A backup carries whatever the workspace holds, so that export never fails on
// a stored record, and it bounds text and lists only by the size of the whole file.
// A backup from before removals existed names none, and its records read as in the workspace.
const removalFields = {
  removedAt: isoDate.nullable().default(null),
  removedReason: z.string().min(1).nullable().default(null),
};

const approvedRootSchema = z.object({
  id: z.string().uuid(),
  path: z.string().min(1),
  label: z.string().min(1),
  createdAt: isoDate,
  ...removalFields,
});

const repositorySchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1),
  snapshot: repositorySnapshotSchema.extend({
    statusEntries: z.array(z.string()),
    submoduleEntries: z.array(z.string()).default([]),
  }),
  updatedAt: isoDate,
  ...removalFields,
});

const receiptSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().min(1),
  sourcePath: z.string().min(1),
  taskType: z.string(),
  status: z.string(),
  startedAt: storedTime,
  completedAt: storedTime.nullable(),
  stageCount: z.number().int().nonnegative(),
  degraded: z.boolean(),
  importedAt: isoDate,
});

const workItemSchema = z.object({
  id: z.string().uuid(),
  repositoryId: z.string().min(1).nullable(),
  sourceType: z.string().min(1),
  sourceRef: z.string().min(1),
  title: z.string(),
  claim: z.string(),
  sourceLabel: z.string(),
  updatedAt: storedTime,
  snapshotFingerprint: sha256.nullable(),
  humanVerdict: z.enum(['accepted', 'changes-requested', 'rejected']).nullable(),
  ...removalFields,
});

// A restore validates each check again as a new definition, with the approval's limits.
const checkSchema = z.object({
  id: z.string().uuid(),
  repositoryId: z.string().min(1),
  label: z.string().min(1),
  kind: z.string().min(1),
  executable: z.string().min(1),
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
  setupArgs: z.array(z.string().max(4_096)).max(100).default([]),
  setupTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(60 * 60_000)
    .default(10 * 60_000),
  retiredAt: isoDate.nullable().default(null),
  retiredReason: z.string().min(1).max(2_000).nullable().default(null),
});

const evidenceSchema = z.object({
  id: z.string().uuid(),
  workItemId: z.string().uuid(),
  checkId: z.string().uuid(),
  kind: z.string().min(1),
  label: z.string().min(1),
  result: z.string().min(1),
  repositoryId: z.string().min(1),
  snapshotFingerprint: sha256,
  head: z.string().regex(/^[0-9a-f]{7,64}$/iu),
  contractVersion: z.string().min(1),
  checkDefinitionVersion: z.string().min(1),
  startedAt: isoDate,
  completedAt: isoDate,
  durationMs: z.number().int().nonnegative(),
  toolVersion: z.string().nullable().default(null),
  exitCode: z.number().int().nullable().default(null),
  stdout: z.string(),
  stderr: z.string(),
  artifactHashes: z.array(sha256),
  invalidReason: z.string().nullable(),
  isolation: z.enum(['clean-checkout']).nullable().default(null),
  toolPath: z.string().min(1).nullable().default(null),
  toolSha256: sha256.nullable().default(null),
  origin: z.enum(['local', 'imported']).default('local'),
});

const verdictSchema = z.object({
  id: z.string().uuid(),
  workItemId: z.string().uuid(),
  decision: z.enum(['accepted', 'changes-requested', 'rejected']),
  note: z.string(),
  decidedAt: isoDate,
  snapshotFingerprint: sha256,
  contractVersion: z.string().min(1),
  evidenceIds: z.array(z.string().uuid()),
  overrideReason: z.string().min(1).nullable(),
  // Version 1 backups predate the verdict chain and carry neither field.
  sequence: z.number().int().min(1).optional(),
  previousVerdictId: z.string().uuid().nullable().optional(),
  claimHash: sha256.nullable().default(null),
});

const contractSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1),
  criteria: z.array(z.unknown()),
  createdAt: isoDate,
});

const workspacePayloadSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    application: z.literal('veridone'),
    exportedAt: isoDate,
    data: z.object({
      approvedRoots: z.array(approvedRootSchema),
      repositories: z.array(repositorySchema),
      receipts: z.array(receiptSchema),
      workItems: z.array(workItemSchema),
      contracts: z.array(contractSchema),
      checks: z.array(checkSchema),
      evidence: z.array(evidenceSchema),
      verdicts: z.array(verdictSchema),
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

/** The records a restore adds that the operator reviews by name before confirming it. */
export interface RestoreAdditions {
  roots: Array<{ path: string; label: string }>;
  repositories: Array<{ name: string; path: string }>;
  checks: Array<{ label: string; executable: string }>;
  workItems: Array<{ title: string }>;
  /** Records the backup holds as removed, which join the workspace removed. */
  removed: Array<{ kind: 'root' | 'repository' | 'workItem'; name: string }>;
}

export interface RestoreResult {
  imported: WorkspaceCounts;
  unchanged: WorkspaceCounts;
  added: RestoreAdditions;
}

/** Ends a preview's transaction so that everything it inserted rolls back. */
class RestorePreviewed extends Error {}

/** The first thing a schema refused, for a reader who has no way to see the schema. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue?.path.join('.') || 'the file'}: ${issue?.message ?? 'unreadable'}`;
}

export async function exportWorkspace(database: VeriDoneDatabase): Promise<WorkspaceDocument> {
  let payload: z.infer<typeof workspacePayloadSchema>;
  try {
    payload = workspacePayloadSchema.parse({
      schemaVersion: 2,
      application: 'veridone',
      exportedAt: new Date().toISOString(),
      data: {
        // Every root goes into the backup; a restore marks each one pending again.
        approvedRoots: database.listRoots().map(({ status: _status, ...root }) => root),
        repositories: database.listRepositories(),
        receipts: database.listReceipts(),
        workItems: database.listWorkItems(),
        contracts: database.listContracts(),
        checks: database.listChecks(),
        evidence: database.listEvidence(),
        verdicts: database.listVerdicts(),
      },
    });
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    throw new Error(
      `A stored record does not fit the backup format (${firstIssue(error)}). To keep a copy of everything, stop VeriDone and copy its data directory.`,
    );
  }
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

function sameEvidence(
  local: EvidenceRecord,
  incoming: Omit<EvidenceRecord, 'origin'>,
  compareAll: boolean,
): boolean {
  // Version 1 backups carry no isolation or tool identity.
  const comparable = ({
    isolation,
    toolPath,
    toolSha256,
    ...evidence
  }: Omit<EvidenceRecord, 'origin'>) =>
    compareAll ? { ...evidence, isolation, toolPath, toolSha256 } : evidence;
  const { origin: _origin, ...recorded } = local;
  return canonicalJson(comparable(recorded)) === canonicalJson(comparable(incoming));
}

function sameVerdict(
  local: VerdictRecord,
  incoming: VerdictRecord,
  compareChain: boolean,
): boolean {
  // Version 1 backups carry neither the chain fields nor a claim hash.
  const comparable = ({
    sequence,
    previousVerdictId,
    claimHash: judged,
    ...verdict
  }: VerdictRecord) =>
    compareChain ? { ...verdict, sequence, previousVerdictId, claimHash: judged } : verdict;
  return canonicalJson(comparable(local)) === canonicalJson(comparable(incoming));
}

/**
 * Restores a workspace backup by adding what the workspace lacks. Records that already exist are
 * kept as they are; evidence and verdicts that already exist must match the backup exactly. Each
 * work item's verdicts replay in chain order through the same append-only path as new verdicts,
 * so a backup can only extend a history. Restored evidence is marked imported and satisfies no
 * gate, and restored checks must have their tools pinned before they run.
 */
/**
 * Restores a backup, adding only what this workspace lacks. With `dryRun`, it runs every check and insert a
 * restore makes and rolls them back, so a preview reports exactly what the restore would add.
 */
export async function importWorkspace(
  database: VeriDoneDatabase,
  input: unknown,
  options: { dryRun?: boolean } = {},
): Promise<RestoreResult> {
  let document: WorkspaceDocument;
  try {
    // The checksum covers the payload exactly as the file carries it, before defaults fill gaps.
    const { integrity, ...rawPayload } = z.looseObject({ integrity: integritySchema }).parse(input);
    if ((await sha256Hex(canonicalJson(rawPayload))) !== integrity.payloadHash) {
      throw new Error('The workspace integrity hash does not match its payload.');
    }
    document = workspaceDocumentSchema.parse(input);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    throw new Error(
      `This file is not a VeriDone workspace backup this version can read (${firstIssue(error)}).`,
    );
  }
  const data = document.data;
  const verdicts = verdictHistory(document);
  // Verdicts recorded before claim hashes were kept judged the claim their backup carries.
  const backupClaims = new Map(data.workItems.map((item) => [item.id, claimHash(item)]));
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
          // Earlier versions stored "./" as an empty scope path; it declares no scope.
          scopePaths: record.scopePaths.filter((value) => value !== ''),
          cwdRelative: record.cwdRelative,
          timeoutMs: record.timeoutMs,
          maxOutputBytes: record.maxOutputBytes,
          setupArgs: record.setupArgs,
          setupTimeoutMs: record.setupTimeoutMs,
        }),
        // A backup cannot vouch for a tool file on this machine; the operator pins it again.
        resolvedExecutable: null,
        executableSha256: null,
      };
      return {
        ...definition,
        id: record.id,
        approvedAt: record.approvedAt,
        retiredAt: record.retiredAt,
        retiredReason: record.retiredReason,
        definitionHash: await checkDefinitionHash(definition),
      };
    }),
  );

  const imported = emptyCounts();
  const unchanged = emptyCounts();
  const tally = (kind: keyof WorkspaceData, added: boolean) => {
    if (added) imported[kind] += 1;
    else unchanged[kind] += 1;
    return added;
  };
  const added: RestoreAdditions = {
    roots: [],
    repositories: [],
    checks: [],
    workItems: [],
    removed: [],
  };
  const connection = database.connection;

  try {
    connection
      .transaction(() => {
        // A backup cannot vouch for a directory on this machine; a restored root waits for the operator. A record that
        // exists stays as it is, so a backup neither removes it nor brings it back.
        const insertRoot = connection.prepare(`
        INSERT INTO approved_roots (
          id, canonical_path, label, created_at, status, removed_at, removed_reason
        ) VALUES (@id, @path, @label, @createdAt, 'pending', @removedAt, @removedReason)
        ON CONFLICT DO NOTHING
      `);
        for (const record of data.approvedRoots) {
          if (tally('approvedRoots', insertRoot.run(record).changes === 1)) {
            if (record.removedAt) added.removed.push({ kind: 'root', name: record.label });
            else added.roots.push({ path: record.path, label: record.label });
          }
        }

        const insertRepository = connection.prepare(`
        INSERT INTO repositories (
          id, canonical_path, name, branch, head, fingerprint, status_entries_json,
          submodule_entries_json, worktree_hash, diff_stats_json, contract_version,
          check_definition_version, captured_at, updated_at, removed_at, removed_reason
        ) VALUES (
          @id, @path, @name, @branch, @head, @fingerprint, @statusEntries,
          @submoduleEntries, @worktreeHash, @diffStats, @contractVersion,
          @checkDefinitionVersion, @capturedAt, @updatedAt, @removedAt, @removedReason
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
          if (tally('repositories', result.changes === 1)) {
            if (record.removedAt) added.removed.push({ kind: 'repository', name: record.name });
            else added.repositories.push({ name: record.name, path: record.path });
          }
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
          updated_at, snapshot_fingerprint, human_verdict, removed_at, removed_reason
        ) VALUES (
          @id, @repositoryId, @sourceType, @sourceRef, @title, @claim, @sourceLabel,
          @updatedAt, @snapshotFingerprint, NULL, @removedAt, @removedReason
        ) ON CONFLICT(id) DO NOTHING
      `);
        for (const record of data.workItems) {
          if (sameSource.get(record.sourceRef, record.id)) {
            throw new WorkspaceConflictError(
              `The backup's work item "${record.title}" has a different ID than the local work item imported from the same source. Restore into a workspace that has not imported that receipt.`,
            );
          }
          if (tally('workItems', insertWorkItem.run(record).changes === 1)) {
            if (record.removedAt) added.removed.push({ kind: 'workItem', name: record.title });
            else added.workItems.push({ title: record.title });
          }
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
          version_args_json, scope_paths_json, resolved_executable, executable_sha256,
          setup_args_json, setup_timeout_ms, retired_at, retired_reason
        ) VALUES (
          @id, @repositoryId, @label, @kind, @executable, @argsJson, @cwdRelative,
          @timeoutMs, @maxOutputBytes, @definitionHash, @approvedAt,
          @versionArgsJson, @scopePathsJson, @resolvedExecutable, @executableSha256,
          @setupArgsJson, @setupTimeoutMs, @retiredAt, @retiredReason
        ) ON CONFLICT(id) DO NOTHING
      `);
        for (const record of checks) {
          const result = insertCheck.run({
            ...record,
            argsJson: JSON.stringify(record.args),
            versionArgsJson: JSON.stringify(record.versionArgs),
            scopePathsJson: JSON.stringify(record.scopePaths),
            setupArgsJson: JSON.stringify(record.setupArgs),
          });
          if (tally('checks', result.changes === 1)) {
            added.checks.push({ label: record.label, executable: record.executable });
          }
        }

        for (const { origin: _origin, ...record } of data.evidence) {
          const local = database.getEvidence(record.id);
          if (local) {
            if (!sameEvidence(local, record, document.schemaVersion !== 1)) {
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
          // A verdict belongs to the claim it judged; the local work item may show another one.
          const workItem = database.getWorkItem(verdict.workItemId);
          const judged = verdict.claimHash ?? backupClaims.get(verdict.workItemId) ?? null;
          if (workItem && judged !== null && judged !== workItem.claimHash) {
            throw new WorkspaceConflictError(
              `The backup's verdict ${verdict.id} judged a different claim than the local work item "${workItem.title}" shows. A verdict stays with the claim it judged.`,
            );
          }
          database.appendVerdict(verdict);
          tally('verdicts', true);
        }
        if (options.dryRun) throw new RestorePreviewed();
      })
      .immediate();
  } catch (error) {
    if (!(error instanceof RestorePreviewed)) throw error;
  }

  return { imported, unchanged, added };
}
