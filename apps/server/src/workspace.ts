import { canonicalJson, repositorySnapshotSchema, sha256Hex } from '@veridone/core';
import { z } from 'zod';

import type { VeriDoneDatabase } from './database.js';

const isoDate = z.string().datetime({ offset: true });
const nullableIsoDate = isoDate.nullable();

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

const receiptSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().min(1).max(512),
  sourcePath: z.string().min(1).max(4_096),
  taskType: z.string().min(1).max(200),
  status: z.string().min(1).max(200),
  startedAt: isoDate,
  completedAt: nullableIsoDate,
  stageCount: z.number().int().nonnegative().max(100_000),
  degraded: z.boolean(),
  importedAt: isoDate,
});

const workItemSchema = z.object({
  id: z.string().uuid(),
  repositoryId: z.string().min(1).max(128).nullable(),
  sourceType: z.string().min(1).max(100),
  sourceRef: z.string().min(1).max(4_096),
  title: z.string().min(1).max(300),
  claim: z.string().min(1).max(20_000),
  sourceLabel: z.string().min(1).max(200),
  updatedAt: isoDate,
  snapshotFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/iu)
    .nullable(),
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
  executableSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/iu)
    .nullable()
    .default(null),
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/iu),
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
  snapshotFingerprint: z.string().regex(/^[0-9a-f]{64}$/iu),
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
  artifactHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/iu)).max(10_000),
  invalidReason: z.string().max(2_000).nullable(),
  isolation: z.enum(['clean-checkout']).nullable().default(null),
  toolPath: z.string().min(1).max(4_096).nullable().default(null),
  toolSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/iu)
    .nullable()
    .default(null),
});

const verdictSchema = z.object({
  id: z.string().uuid(),
  workItemId: z.string().uuid(),
  decision: z.enum(['accepted', 'changes-requested', 'rejected']),
  note: z.string().max(10_000),
  decidedAt: isoDate,
  snapshotFingerprint: z.string().regex(/^[0-9a-f]{64}$/iu),
  contractVersion: z.string().min(1).max(200),
  evidenceIds: z.array(z.string().uuid()).max(10_000),
  overrideReason: z.string().min(1).max(2_000).nullable(),
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
    schemaVersion: z.literal(1),
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

export const workspaceDocumentSchema = workspacePayloadSchema
  .extend({
    integrity: z
      .object({
        algorithm: z.literal('sha256'),
        payloadHash: z.string().regex(/^[0-9a-f]{64}$/iu),
      })
      .strict(),
  })
  .strict();

export type WorkspaceDocument = z.infer<typeof workspaceDocumentSchema>;

export async function exportWorkspace(database: VeriDoneDatabase): Promise<WorkspaceDocument> {
  const payload = workspacePayloadSchema.parse({
    schemaVersion: 1,
    application: 'veridone',
    exportedAt: new Date().toISOString(),
    data: {
      approvedRoots: database.listApprovedRoots(),
      repositories: database.listRepositories(),
      receipts: database.listReceipts(),
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

export async function importWorkspace(
  database: VeriDoneDatabase,
  input: unknown,
): Promise<{ imported: Record<keyof WorkspaceDocument['data'], number> }> {
  const document = workspaceDocumentSchema.parse(input);
  const { integrity: _integrity, ...payload } = document;
  const actualHash = await sha256Hex(canonicalJson(payload));
  if (actualHash !== document.integrity.payloadHash) {
    throw new Error('The workspace integrity hash does not match its payload.');
  }

  const data = document.data;
  database.connection.transaction(() => {
    const insertRoot = database.connection.prepare(`
      INSERT INTO approved_roots (id, canonical_path, label, created_at)
      VALUES (@id, @path, @label, @createdAt)
      ON CONFLICT(id) DO UPDATE SET
        canonical_path = excluded.canonical_path,
        label = excluded.label,
        created_at = excluded.created_at
    `);
    for (const record of data.approvedRoots) insertRoot.run(record);

    const insertRepository = database.connection.prepare(`
      INSERT INTO repositories (
        id, canonical_path, name, branch, head, fingerprint, status_entries_json,
        submodule_entries_json, worktree_hash, diff_stats_json, contract_version,
        check_definition_version, captured_at, updated_at
      ) VALUES (
        @id, @path, @name, @branch, @head, @fingerprint, @statusEntries,
        @submoduleEntries, @worktreeHash, @diffStats, @contractVersion,
        @checkDefinitionVersion, @capturedAt, @updatedAt
      ) ON CONFLICT(id) DO UPDATE SET
        canonical_path = excluded.canonical_path,
        name = excluded.name,
        branch = excluded.branch,
        head = excluded.head,
        fingerprint = excluded.fingerprint,
        status_entries_json = excluded.status_entries_json,
        submodule_entries_json = excluded.submodule_entries_json,
        worktree_hash = excluded.worktree_hash,
        diff_stats_json = excluded.diff_stats_json,
        contract_version = excluded.contract_version,
        check_definition_version = excluded.check_definition_version,
        captured_at = excluded.captured_at,
        updated_at = excluded.updated_at
    `);
    for (const record of data.repositories) {
      insertRepository.run({
        ...record,
        ...record.snapshot,
        statusEntries: JSON.stringify(record.snapshot.statusEntries),
        submoduleEntries: JSON.stringify(record.snapshot.submoduleEntries),
        worktreeHash: record.snapshot.worktreeHash,
        diffStats: JSON.stringify(record.snapshot.diffStats),
      });
    }

    const insertReceipt = database.connection.prepare(`
      INSERT INTO receipts (
        id, run_id, source_path, task_type, status, started_at, completed_at,
        stage_count, degraded, imported_at
      ) VALUES (
        @id, @runId, @sourcePath, @taskType, @status, @startedAt, @completedAt,
        @stageCount, @degraded, @importedAt
      ) ON CONFLICT(id) DO UPDATE SET
        run_id = excluded.run_id,
        source_path = excluded.source_path,
        task_type = excluded.task_type,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        stage_count = excluded.stage_count,
        degraded = excluded.degraded,
        imported_at = excluded.imported_at
    `);
    for (const record of data.receipts) {
      insertReceipt.run({ ...record, degraded: record.degraded ? 1 : 0 });
    }

    const insertWorkItem = database.connection.prepare(`
      INSERT INTO work_items (
        id, repository_id, source_type, source_ref, title, claim, source_label,
        updated_at, snapshot_fingerprint, human_verdict
      ) VALUES (
        @id, @repositoryId, @sourceType, @sourceRef, @title, @claim, @sourceLabel,
        @updatedAt, @snapshotFingerprint, @humanVerdict
      ) ON CONFLICT(id) DO UPDATE SET
        repository_id = excluded.repository_id,
        source_type = excluded.source_type,
        source_ref = excluded.source_ref,
        title = excluded.title,
        claim = excluded.claim,
        source_label = excluded.source_label,
        updated_at = excluded.updated_at,
        snapshot_fingerprint = excluded.snapshot_fingerprint,
        human_verdict = excluded.human_verdict
    `);
    for (const record of data.workItems) insertWorkItem.run(record);

    const insertContract = database.connection.prepare(`
      INSERT INTO acceptance_contracts (id, version, title, criteria_json, created_at)
      VALUES (@id, @version, @title, @criteriaJson, @createdAt)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        title = excluded.title,
        criteria_json = excluded.criteria_json,
        created_at = excluded.created_at
    `);
    for (const record of data.contracts) {
      insertContract.run({ ...record, criteriaJson: JSON.stringify(record.criteria) });
    }

    const insertCheck = database.connection.prepare(`
      INSERT INTO checks (
        id, repository_id, label, kind, executable, args_json, cwd_relative,
        timeout_ms, max_output_bytes, definition_hash, approved_at,
        version_args_json, scope_paths_json, resolved_executable, executable_sha256
      ) VALUES (
        @id, @repositoryId, @label, @kind, @executable, @argsJson, @cwdRelative,
        @timeoutMs, @maxOutputBytes, @definitionHash, @approvedAt,
        @versionArgsJson, @scopePathsJson, @resolvedExecutable, @executableSha256
      ) ON CONFLICT(id) DO UPDATE SET
        repository_id = excluded.repository_id,
        label = excluded.label,
        kind = excluded.kind,
        executable = excluded.executable,
        args_json = excluded.args_json,
        cwd_relative = excluded.cwd_relative,
        timeout_ms = excluded.timeout_ms,
        max_output_bytes = excluded.max_output_bytes,
        definition_hash = excluded.definition_hash,
        approved_at = excluded.approved_at,
        version_args_json = excluded.version_args_json,
        scope_paths_json = excluded.scope_paths_json,
        resolved_executable = excluded.resolved_executable,
        executable_sha256 = excluded.executable_sha256
    `);
    for (const record of data.checks) {
      insertCheck.run({
        ...record,
        argsJson: JSON.stringify(record.args),
        versionArgsJson: JSON.stringify(record.versionArgs),
        scopePathsJson: JSON.stringify(record.scopePaths),
      });
    }

    const insertEvidence = database.connection.prepare(`
      INSERT INTO evidence (
        id, work_item_id, check_id, kind, label, result, repository_id,
        snapshot_fingerprint, head, contract_version, check_definition_version,
        started_at, completed_at, duration_ms, tool_version, exit_code, stdout, stderr,
        artifact_hashes_json, invalid_reason, isolation, tool_path, tool_sha256
      ) VALUES (
        @id, @workItemId, @checkId, @kind, @label, @result, @repositoryId,
        @snapshotFingerprint, @head, @contractVersion, @checkDefinitionVersion,
        @startedAt, @completedAt, @durationMs, @toolVersion, @exitCode, @stdout, @stderr,
        @artifactHashesJson, @invalidReason, @isolation, @toolPath, @toolSha256
      ) ON CONFLICT(id) DO UPDATE SET
        work_item_id = excluded.work_item_id,
        check_id = excluded.check_id,
        kind = excluded.kind,
        label = excluded.label,
        result = excluded.result,
        repository_id = excluded.repository_id,
        snapshot_fingerprint = excluded.snapshot_fingerprint,
        head = excluded.head,
        contract_version = excluded.contract_version,
        check_definition_version = excluded.check_definition_version,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        duration_ms = excluded.duration_ms,
        tool_version = excluded.tool_version,
        exit_code = excluded.exit_code,
        stdout = excluded.stdout,
        stderr = excluded.stderr,
        artifact_hashes_json = excluded.artifact_hashes_json,
        invalid_reason = excluded.invalid_reason,
        isolation = excluded.isolation,
        tool_path = excluded.tool_path,
        tool_sha256 = excluded.tool_sha256
    `);
    for (const record of data.evidence) {
      insertEvidence.run({
        ...record,
        artifactHashesJson: JSON.stringify(record.artifactHashes),
      });
    }

    const insertVerdict = database.connection.prepare(`
      INSERT INTO verdicts (
        id, work_item_id, decision, note, decided_at, snapshot_fingerprint,
        contract_version, evidence_ids_json, override_reason
      ) VALUES (
        @id, @workItemId, @decision, @note, @decidedAt, @snapshotFingerprint,
        @contractVersion, @evidenceIdsJson, @overrideReason
      ) ON CONFLICT(id) DO UPDATE SET
        work_item_id = excluded.work_item_id,
        decision = excluded.decision,
        note = excluded.note,
        decided_at = excluded.decided_at,
        snapshot_fingerprint = excluded.snapshot_fingerprint,
        contract_version = excluded.contract_version,
        evidence_ids_json = excluded.evidence_ids_json,
        override_reason = excluded.override_reason
    `);
    for (const record of data.verdicts) {
      insertVerdict.run({ ...record, evidenceIdsJson: JSON.stringify(record.evidenceIds) });
    }
  })();

  return {
    imported: {
      approvedRoots: data.approvedRoots.length,
      repositories: data.repositories.length,
      receipts: data.receipts.length,
      workItems: data.workItems.length,
      contracts: data.contracts.length,
      checks: data.checks.length,
      evidence: data.evidence.length,
      verdicts: data.verdicts.length,
    },
  };
}
