import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { RepositorySnapshot } from '@veridone/core';
import type { ReceiptPreview } from '@veridone/adapters';

const migrationOne = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE approved_roots (
    id TEXT PRIMARY KEY,
    canonical_path TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE repositories (
    id TEXT PRIMARY KEY,
    canonical_path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    branch TEXT,
    head TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status_entries_json TEXT NOT NULL,
    submodule_entries_json TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    check_definition_version TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE receipts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    source_path TEXT NOT NULL UNIQUE,
    task_type TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    stage_count INTEGER NOT NULL,
    degraded INTEGER NOT NULL CHECK (degraded IN (0, 1)),
    imported_at TEXT NOT NULL
  );

  CREATE TABLE work_items (
    id TEXT PRIMARY KEY,
    repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
    source_type TEXT NOT NULL,
    source_ref TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    claim TEXT NOT NULL,
    source_label TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    snapshot_fingerprint TEXT,
    human_verdict TEXT CHECK (human_verdict IN ('accepted', 'changes-requested', 'rejected'))
  );

  CREATE INDEX repositories_updated_at_idx ON repositories(updated_at DESC);
  CREATE INDEX receipts_started_at_idx ON receipts(started_at DESC);
  CREATE INDEX work_items_updated_at_idx ON work_items(updated_at DESC);
`;

const migrationTwo = `
  CREATE TABLE acceptance_contracts (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    title TEXT NOT NULL,
    criteria_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE checks (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    kind TEXT NOT NULL,
    executable TEXT NOT NULL,
    args_json TEXT NOT NULL,
    cwd_relative TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL,
    max_output_bytes INTEGER NOT NULL,
    definition_hash TEXT NOT NULL,
    approved_at TEXT NOT NULL
  );

  CREATE TABLE evidence (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    check_id TEXT NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    result TEXT NOT NULL,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    snapshot_fingerprint TEXT NOT NULL,
    head TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    check_definition_version TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    stdout TEXT NOT NULL,
    stderr TEXT NOT NULL,
    artifact_hashes_json TEXT NOT NULL,
    invalid_reason TEXT
  );

  CREATE TABLE verdicts (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK (decision IN ('accepted', 'changes-requested', 'rejected')),
    note TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    snapshot_fingerprint TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL,
    override_reason TEXT
  );

  CREATE INDEX checks_repository_idx ON checks(repository_id);
  CREATE INDEX evidence_work_item_idx ON evidence(work_item_id, completed_at DESC);
  CREATE INDEX verdicts_work_item_idx ON verdicts(work_item_id, decided_at DESC);
`;

const migrationThree = `
  ALTER TABLE repositories ADD COLUMN worktree_hash TEXT NOT NULL
    DEFAULT '0000000000000000000000000000000000000000000000000000000000000000';
  ALTER TABLE repositories ADD COLUMN diff_stats_json TEXT NOT NULL
    DEFAULT '{"changedFiles":0,"additions":0,"deletions":0,"binaryFiles":0,"untrackedFiles":0}';
`;

const migrationFour = `
  ALTER TABLE checks ADD COLUMN version_args_json TEXT NOT NULL DEFAULT '["--version"]';
  ALTER TABLE checks ADD COLUMN scope_paths_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE evidence ADD COLUMN tool_version TEXT;
  ALTER TABLE evidence ADD COLUMN exit_code INTEGER;
`;

// Evidence recorded before this migration ran in the operator's work tree and keeps a null isolation.
const migrationFive = `
  ALTER TABLE evidence ADD COLUMN isolation TEXT CHECK (isolation IN ('clean-checkout'));
`;

// Checks approved before this migration have no pinned tool and must be pinned before they run.
const migrationSix = `
  ALTER TABLE checks ADD COLUMN resolved_executable TEXT;
  ALTER TABLE checks ADD COLUMN executable_sha256 TEXT;
  ALTER TABLE evidence ADD COLUMN tool_path TEXT;
  ALTER TABLE evidence ADD COLUMN tool_sha256 TEXT;
`;

export interface ApprovedRootRecord {
  id: string;
  path: string;
  label: string;
  createdAt: string;
}

export interface RepositoryRecord {
  id: string;
  path: string;
  name: string;
  snapshot: RepositorySnapshot;
  updatedAt: string;
}

export interface ReceiptRecord extends Omit<
  ReceiptPreview,
  'sourcePath' | 'sourceType' | 'sourceLabel' | 'title' | 'claim'
> {
  id: string;
  sourcePath: string;
  importedAt: string;
}

export interface WorkItemRecord {
  id: string;
  repositoryId: string | null;
  sourceType: string;
  sourceRef: string;
  title: string;
  claim: string;
  sourceLabel: string;
  updatedAt: string;
  snapshotFingerprint: string | null;
  humanVerdict: 'accepted' | 'changes-requested' | 'rejected' | null;
}

export interface ContractRecord {
  id: string;
  version: string;
  title: string;
  criteria: unknown[];
  createdAt: string;
}

export interface CheckRecord {
  id: string;
  repositoryId: string;
  label: string;
  kind: string;
  executable: string;
  args: string[];
  versionArgs: string[];
  scopePaths: string[];
  cwdRelative: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Canonical path of the tool file the operator approved; null until the tool is pinned. */
  resolvedExecutable: string | null;
  executableSha256: string | null;
  definitionHash: string;
  approvedAt: string;
}

export interface EvidenceRecord {
  id: string;
  workItemId: string;
  checkId: string;
  kind: string;
  label: string;
  result: string;
  repositoryId: string;
  snapshotFingerprint: string;
  head: string;
  contractVersion: string;
  checkDefinitionVersion: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  toolVersion: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  artifactHashes: string[];
  invalidReason: string | null;
  /** `clean-checkout` when the check ran in a verifier-owned checkout of the bound commit. */
  isolation: 'clean-checkout' | null;
  /** The pinned tool file that ran, and its SHA-256 as verified immediately before the run. */
  toolPath: string | null;
  toolSha256: string | null;
}

export interface VerdictRecord {
  id: string;
  workItemId: string;
  decision: 'accepted' | 'changes-requested' | 'rejected';
  note: string;
  decidedAt: string;
  snapshotFingerprint: string;
  contractVersion: string;
  evidenceIds: string[];
  overrideReason: string | null;
}

export class VeriDoneDatabase {
  readonly connection: Database.Database;

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.connection = new Database(filename);
    this.connection.pragma('foreign_keys = ON');
    this.connection.pragma('journal_mode = WAL');
    this.connection.pragma('synchronous = NORMAL');
    this.migrate();
  }

  private migrate(): void {
    this.connection.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    const migrations = [
      { version: 1, sql: migrationOne },
      { version: 2, sql: migrationTwo },
      { version: 3, sql: migrationThree },
      { version: 4, sql: migrationFour },
      { version: 5, sql: migrationFive },
      { version: 6, sql: migrationSix },
    ];

    for (const migration of migrations) {
      const existing = this.connection
        .prepare('SELECT version FROM schema_migrations WHERE version = ?')
        .get(migration.version);
      if (existing) continue;
      this.connection.transaction(() => {
        this.connection.exec(migration.sql);
        this.connection
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString());
      })();
    }

    this.connection
      .prepare(
        `INSERT OR IGNORE INTO acceptance_contracts
          (id, version, title, criteria_json, created_at)
         VALUES ('default', 'default-v1', 'Default acceptance contract', ?, ?)`,
      )
      .run(
        JSON.stringify([
          {
            id: 'approved-checks',
            title: 'Every approved check has fresh passing evidence',
            required: true,
          },
        ]),
        new Date().toISOString(),
      );
  }

  close(): void {
    this.connection.close();
  }

  addApprovedRoot(canonicalPath: string, label = path.basename(canonicalPath)): ApprovedRootRecord {
    const record: ApprovedRootRecord = {
      id: randomUUID(),
      path: canonicalPath,
      label: label || canonicalPath,
      createdAt: new Date().toISOString(),
    };
    this.connection
      .prepare(
        `INSERT INTO approved_roots (id, canonical_path, label, created_at)
         VALUES (@id, @path, @label, @createdAt)
         ON CONFLICT(canonical_path) DO UPDATE SET label = excluded.label`,
      )
      .run(record);
    const existing = this.connection
      .prepare(
        'SELECT id, canonical_path, label, created_at FROM approved_roots WHERE canonical_path = ?',
      )
      .get(canonicalPath) as
      { id: string; canonical_path: string; label: string; created_at: string } | undefined;
    if (!existing) throw new Error('The approved root could not be persisted.');
    return {
      id: existing.id,
      path: existing.canonical_path,
      label: existing.label,
      createdAt: existing.created_at,
    };
  }

  listApprovedRoots(): ApprovedRootRecord[] {
    return (
      this.connection
        .prepare(
          'SELECT id, canonical_path, label, created_at FROM approved_roots ORDER BY label COLLATE NOCASE',
        )
        .all() as Array<{ id: string; canonical_path: string; label: string; created_at: string }>
    ).map((row) => ({
      id: row.id,
      path: row.canonical_path,
      label: row.label,
      createdAt: row.created_at,
    }));
  }

  getApprovedRoot(id: string): ApprovedRootRecord | null {
    const row = this.connection
      .prepare('SELECT id, canonical_path, label, created_at FROM approved_roots WHERE id = ?')
      .get(id) as
      { id: string; canonical_path: string; label: string; created_at: string } | undefined;
    return row
      ? { id: row.id, path: row.canonical_path, label: row.label, createdAt: row.created_at }
      : null;
  }

  upsertRepository(canonicalPath: string, snapshot: RepositorySnapshot): RepositoryRecord {
    const updatedAt = new Date().toISOString();
    const values = {
      id: snapshot.repositoryId,
      path: canonicalPath,
      name: path.basename(canonicalPath),
      branch: snapshot.branch,
      head: snapshot.head,
      fingerprint: snapshot.fingerprint,
      statusEntries: JSON.stringify(snapshot.statusEntries),
      submoduleEntries: JSON.stringify(snapshot.submoduleEntries),
      worktreeHash: snapshot.worktreeHash,
      diffStats: JSON.stringify(snapshot.diffStats),
      contractVersion: snapshot.contractVersion,
      checkDefinitionVersion: snapshot.checkDefinitionVersion,
      capturedAt: snapshot.capturedAt,
      updatedAt,
    };
    this.connection
      .prepare(
        `INSERT INTO repositories (
          id, canonical_path, name, branch, head, fingerprint, status_entries_json,
          submodule_entries_json, worktree_hash, diff_stats_json, contract_version,
          check_definition_version, captured_at, updated_at
        ) VALUES (
          @id, @path, @name, @branch, @head, @fingerprint, @statusEntries,
          @submoduleEntries, @worktreeHash, @diffStats, @contractVersion,
          @checkDefinitionVersion, @capturedAt, @updatedAt
        ) ON CONFLICT(canonical_path) DO UPDATE SET
          id = excluded.id,
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
          updated_at = excluded.updated_at`,
      )
      .run(values);
    return {
      id: snapshot.repositoryId,
      path: canonicalPath,
      name: values.name,
      snapshot,
      updatedAt,
    };
  }

  listRepositories(): RepositoryRecord[] {
    return (
      this.connection.prepare('SELECT * FROM repositories ORDER BY updated_at DESC').all() as Array<
        Record<string, unknown>
      >
    ).map((row) => this.repositoryFromRow(row));
  }

  getRepository(id: string): RepositoryRecord | null {
    const row = this.connection.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return row ? this.repositoryFromRow(row) : null;
  }

  private repositoryFromRow(row: Record<string, unknown>): RepositoryRecord {
    const snapshot: RepositorySnapshot = {
      repositoryId: String(row.id),
      head: String(row.head),
      branch: row.branch === null ? null : String(row.branch),
      statusEntries: JSON.parse(String(row.status_entries_json)) as string[],
      submoduleEntries: JSON.parse(String(row.submodule_entries_json)) as string[],
      worktreeHash: String(row.worktree_hash),
      diffStats: JSON.parse(String(row.diff_stats_json)) as RepositorySnapshot['diffStats'],
      contractVersion: String(row.contract_version),
      checkDefinitionVersion: String(row.check_definition_version),
      fingerprint: String(row.fingerprint),
      capturedAt: String(row.captured_at),
    };
    return {
      id: String(row.id),
      path: String(row.canonical_path),
      name: String(row.name),
      snapshot,
      updatedAt: String(row.updated_at),
    };
  }

  importReceipt(preview: ReceiptPreview): { receipt: ReceiptRecord; workItem: WorkItemRecord } {
    const importedAt = new Date().toISOString();
    const receipt: ReceiptRecord = {
      id: randomUUID(),
      ...preview,
      importedAt,
    };
    const workItem: WorkItemRecord = {
      id: randomUUID(),
      repositoryId: null,
      sourceType: preview.sourceType,
      sourceRef: `${preview.sourceType}:${preview.runId}`,
      title: preview.title,
      claim: preview.claim,
      sourceLabel: preview.sourceLabel,
      updatedAt: preview.completedAt ?? preview.startedAt,
      snapshotFingerprint: null,
      humanVerdict: null,
    };

    this.connection.transaction(() => {
      this.connection
        .prepare(
          `INSERT INTO receipts (
            id, run_id, source_path, task_type, status, started_at, completed_at,
            stage_count, degraded, imported_at
          ) VALUES (
            @id, @runId, @sourcePath, @taskType, @status, @startedAt, @completedAt,
            @stageCount, @degraded, @importedAt
          ) ON CONFLICT(run_id) DO UPDATE SET
            source_path = excluded.source_path,
            task_type = excluded.task_type,
            status = excluded.status,
            started_at = excluded.started_at,
            completed_at = excluded.completed_at,
            stage_count = excluded.stage_count,
            degraded = excluded.degraded,
            imported_at = excluded.imported_at`,
        )
        .run({ ...receipt, degraded: receipt.degraded ? 1 : 0 });
      this.connection
        .prepare(
          `INSERT INTO work_items (
            id, repository_id, source_type, source_ref, title, claim, source_label,
            updated_at, snapshot_fingerprint, human_verdict
          ) VALUES (
            @id, @repositoryId, @sourceType, @sourceRef, @title, @claim, @sourceLabel,
            @updatedAt, @snapshotFingerprint, @humanVerdict
          ) ON CONFLICT(source_ref) DO UPDATE SET
            title = excluded.title,
            claim = excluded.claim,
            source_label = excluded.source_label,
            updated_at = excluded.updated_at`,
        )
        .run(workItem);
    })();

    const persistedReceipt = this.listReceipts().find((item) => item.runId === preview.runId);
    const persistedWorkItem = this.listWorkItems().find(
      (item) => item.sourceRef === workItem.sourceRef,
    );
    if (!persistedReceipt || !persistedWorkItem)
      throw new Error('The receipt import did not commit.');
    return { receipt: persistedReceipt, workItem: persistedWorkItem };
  }

  importReceipts(
    previews: ReceiptPreview[],
  ): Array<{ receipt: ReceiptRecord; workItem: WorkItemRecord }> {
    return this.connection.transaction(() =>
      previews.map((preview) => this.importReceipt(preview)),
    )();
  }

  listReceipts(): ReceiptRecord[] {
    return (
      this.connection.prepare('SELECT * FROM receipts ORDER BY started_at DESC').all() as Array<
        Record<string, unknown>
      >
    ).map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      sourcePath: String(row.source_path),
      taskType: String(row.task_type),
      status: String(row.status),
      startedAt: String(row.started_at),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
      stageCount: Number(row.stage_count),
      degraded: Boolean(row.degraded),
      importedAt: String(row.imported_at),
    }));
  }

  listWorkItems(): WorkItemRecord[] {
    return (
      this.connection.prepare('SELECT * FROM work_items ORDER BY updated_at DESC').all() as Array<
        Record<string, unknown>
      >
    ).map((row) => ({
      id: String(row.id),
      repositoryId: row.repository_id === null ? null : String(row.repository_id),
      sourceType: String(row.source_type),
      sourceRef: String(row.source_ref),
      title: String(row.title),
      claim: String(row.claim),
      sourceLabel: String(row.source_label),
      updatedAt: String(row.updated_at),
      snapshotFingerprint:
        row.snapshot_fingerprint === null ? null : String(row.snapshot_fingerprint),
      humanVerdict:
        row.human_verdict === null
          ? null
          : (String(row.human_verdict) as WorkItemRecord['humanVerdict']),
    }));
  }

  getWorkItem(id: string): WorkItemRecord | null {
    return this.listWorkItems().find((item) => item.id === id) ?? null;
  }

  listContracts(): ContractRecord[] {
    return (
      this.connection
        .prepare('SELECT * FROM acceptance_contracts ORDER BY created_at')
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      id: String(row.id),
      version: String(row.version),
      title: String(row.title),
      criteria: JSON.parse(String(row.criteria_json)) as unknown[],
      createdAt: String(row.created_at),
    }));
  }

  linkWorkItem(workItemId: string, repositoryId: string): WorkItemRecord {
    const repository = this.getRepository(repositoryId);
    if (!repository) throw new Error('The repository does not exist.');
    const result = this.connection
      .prepare(
        `UPDATE work_items
         SET repository_id = ?, snapshot_fingerprint = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(repositoryId, repository.snapshot.fingerprint, new Date().toISOString(), workItemId);
    if (result.changes !== 1) throw new Error('The work item does not exist.');
    const workItem = this.getWorkItem(workItemId);
    if (!workItem) throw new Error('The linked work item could not be read.');
    return workItem;
  }

  addCheck(input: Omit<CheckRecord, 'id' | 'approvedAt'>): CheckRecord {
    if (!this.getRepository(input.repositoryId)) throw new Error('The repository does not exist.');
    const record: CheckRecord = {
      ...input,
      id: randomUUID(),
      approvedAt: new Date().toISOString(),
    };
    this.connection
      .prepare(
        `INSERT INTO checks (
          id, repository_id, label, kind, executable, args_json, cwd_relative,
          timeout_ms, max_output_bytes, definition_hash, approved_at,
          version_args_json, scope_paths_json, resolved_executable, executable_sha256
        ) VALUES (
          @id, @repositoryId, @label, @kind, @executable, @argsJson, @cwdRelative,
          @timeoutMs, @maxOutputBytes, @definitionHash, @approvedAt,
          @versionArgsJson, @scopePathsJson, @resolvedExecutable, @executableSha256
        )`,
      )
      .run({
        ...record,
        argsJson: JSON.stringify(record.args),
        versionArgsJson: JSON.stringify(record.versionArgs),
        scopePathsJson: JSON.stringify(record.scopePaths),
      });
    return record;
  }

  /** Records a newly approved tool file for a check; its definition hash changes with it. */
  updateCheckPin(
    checkId: string,
    tool: { path: string; sha256: string },
    definitionHash: string,
  ): CheckRecord {
    const result = this.connection
      .prepare(
        `UPDATE checks
         SET resolved_executable = ?, executable_sha256 = ?, definition_hash = ?, approved_at = ?
         WHERE id = ?`,
      )
      .run(tool.path, tool.sha256, definitionHash, new Date().toISOString(), checkId);
    if (result.changes !== 1) throw new Error('The approved check does not exist.');
    const check = this.getCheck(checkId);
    if (!check) throw new Error('The pinned check could not be read.');
    return check;
  }

  listChecks(): CheckRecord[] {
    return (
      this.connection.prepare('SELECT * FROM checks ORDER BY approved_at').all() as Array<
        Record<string, unknown>
      >
    ).map((row) => ({
      id: String(row.id),
      repositoryId: String(row.repository_id),
      label: String(row.label),
      kind: String(row.kind),
      executable: String(row.executable),
      args: JSON.parse(String(row.args_json)) as string[],
      versionArgs: JSON.parse(String(row.version_args_json)) as string[],
      scopePaths: JSON.parse(String(row.scope_paths_json)) as string[],
      cwdRelative: String(row.cwd_relative),
      timeoutMs: Number(row.timeout_ms),
      maxOutputBytes: Number(row.max_output_bytes),
      resolvedExecutable: row.resolved_executable === null ? null : String(row.resolved_executable),
      executableSha256: row.executable_sha256 === null ? null : String(row.executable_sha256),
      definitionHash: String(row.definition_hash),
      approvedAt: String(row.approved_at),
    }));
  }

  getCheck(id: string): CheckRecord | null {
    return this.listChecks().find((check) => check.id === id) ?? null;
  }

  recordEvidence(input: Omit<EvidenceRecord, 'id'>): EvidenceRecord {
    const record: EvidenceRecord = { ...input, id: randomUUID() };
    this.connection
      .prepare(
        `INSERT INTO evidence (
          id, work_item_id, check_id, kind, label, result, repository_id,
          snapshot_fingerprint, head, contract_version, check_definition_version,
          started_at, completed_at, duration_ms, tool_version, exit_code, stdout, stderr,
          artifact_hashes_json, invalid_reason, isolation, tool_path, tool_sha256
        ) VALUES (
          @id, @workItemId, @checkId, @kind, @label, @result, @repositoryId,
          @snapshotFingerprint, @head, @contractVersion, @checkDefinitionVersion,
          @startedAt, @completedAt, @durationMs, @toolVersion, @exitCode, @stdout, @stderr,
          @artifactHashesJson, @invalidReason, @isolation, @toolPath, @toolSha256
        )`,
      )
      .run({ ...record, artifactHashesJson: JSON.stringify(record.artifactHashes) });
    return record;
  }

  listEvidence(workItemId?: string): EvidenceRecord[] {
    const rows = workItemId
      ? (this.connection
          .prepare('SELECT * FROM evidence WHERE work_item_id = ? ORDER BY completed_at DESC')
          .all(workItemId) as Array<Record<string, unknown>>)
      : (this.connection
          .prepare('SELECT * FROM evidence ORDER BY completed_at DESC')
          .all() as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      id: String(row.id),
      workItemId: String(row.work_item_id),
      checkId: String(row.check_id),
      kind: String(row.kind),
      label: String(row.label),
      result: String(row.result),
      repositoryId: String(row.repository_id),
      snapshotFingerprint: String(row.snapshot_fingerprint),
      head: String(row.head),
      contractVersion: String(row.contract_version),
      checkDefinitionVersion: String(row.check_definition_version),
      startedAt: String(row.started_at),
      completedAt: String(row.completed_at),
      durationMs: Number(row.duration_ms),
      toolVersion: row.tool_version === null ? null : String(row.tool_version),
      exitCode: row.exit_code === null ? null : Number(row.exit_code),
      stdout: String(row.stdout),
      stderr: String(row.stderr),
      artifactHashes: JSON.parse(String(row.artifact_hashes_json)) as string[],
      invalidReason: row.invalid_reason === null ? null : String(row.invalid_reason),
      isolation: row.isolation === 'clean-checkout' ? 'clean-checkout' : null,
      toolPath: row.tool_path === null ? null : String(row.tool_path),
      toolSha256: row.tool_sha256 === null ? null : String(row.tool_sha256),
    }));
  }

  recordVerdict(input: Omit<VerdictRecord, 'id' | 'decidedAt'>): VerdictRecord {
    const record: VerdictRecord = {
      ...input,
      id: randomUUID(),
      decidedAt: new Date().toISOString(),
    };
    this.connection.transaction(() => {
      this.connection
        .prepare(
          `INSERT INTO verdicts (
            id, work_item_id, decision, note, decided_at, snapshot_fingerprint,
            contract_version, evidence_ids_json, override_reason
          ) VALUES (
            @id, @workItemId, @decision, @note, @decidedAt, @snapshotFingerprint,
            @contractVersion, @evidenceIdsJson, @overrideReason
          )`,
        )
        .run({ ...record, evidenceIdsJson: JSON.stringify(record.evidenceIds) });
      this.connection
        .prepare('UPDATE work_items SET human_verdict = ?, updated_at = ? WHERE id = ?')
        .run(record.decision, record.decidedAt, record.workItemId);
    })();
    return record;
  }

  listVerdicts(workItemId?: string): VerdictRecord[] {
    const rows = workItemId
      ? (this.connection
          .prepare('SELECT * FROM verdicts WHERE work_item_id = ? ORDER BY decided_at DESC')
          .all(workItemId) as Array<Record<string, unknown>>)
      : (this.connection.prepare('SELECT * FROM verdicts ORDER BY decided_at DESC').all() as Array<
          Record<string, unknown>
        >);
    return rows.map((row) => ({
      id: String(row.id),
      workItemId: String(row.work_item_id),
      decision: String(row.decision) as VerdictRecord['decision'],
      note: String(row.note),
      decidedAt: String(row.decided_at),
      snapshotFingerprint: String(row.snapshot_fingerprint),
      contractVersion: String(row.contract_version),
      evidenceIds: JSON.parse(String(row.evidence_ids_json)) as string[],
      overrideReason: row.override_reason === null ? null : String(row.override_reason),
    }));
  }
}
