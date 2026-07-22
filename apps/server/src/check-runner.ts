import path from 'node:path';

import {
  captureGitSnapshot,
  resolveWithinApprovedRoots,
  runBoundedProcess,
} from '@veridone/adapters';
import { assessDeclaredScope, canonicalJson, sha256Hex, type CheckResult } from '@veridone/core';

import type { CheckRecord, EvidenceRecord, VeriDoneDatabase } from './database.js';

function minimalEnvironment(): Record<string, string> {
  const names =
    process.platform === 'win32'
      ? ['SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'PATH', 'PATHEXT']
      : ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL'];
  const env: Record<string, string> = { CI: '1', NO_COLOR: '1' };
  for (const name of names) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function redact(value: string): string {
  return value
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]\s*[^\s]+/giu,
      '$1=[REDACTED]',
    )
    .replace(/\b(gh[oprsu]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/gu, '[REDACTED]');
}

export async function aggregateCheckVersion(checks: CheckRecord[]): Promise<string> {
  return sha256Hex(canonicalJson(checks.map((check) => check.definitionHash).sort()));
}

export async function runApprovedCheck(
  database: VeriDoneDatabase,
  checkId: string,
  workItemId: string,
  signal?: AbortSignal,
): Promise<EvidenceRecord> {
  const check = database.getCheck(checkId);
  if (!check) throw new Error('The approved check does not exist.');
  const workItem = database.getWorkItem(workItemId);
  if (!workItem) throw new Error('The work item does not exist.');
  if (workItem.repositoryId !== check.repositoryId) {
    throw new Error('The work item and check are not bound to the same repository.');
  }
  const repository = database.getRepository(check.repositoryId);
  if (!repository) throw new Error('The repository does not exist.');
  const checks = database
    .listChecks()
    .filter((candidate) => candidate.repositoryId === repository.id);
  const checkDefinitionVersion = await aggregateCheckVersion(checks);
  const approvedRoots = database.listApprovedRoots().map((root) => root.path);
  const workingDirectory = await resolveWithinApprovedRoots(
    path.resolve(repository.path, check.cwdRelative),
    [repository.path],
  );

  const before = await captureGitSnapshot(repository.path, {
    approvedRoots,
    contractVersion: 'default-v1',
    checkDefinitionVersion,
  });
  database.upsertRepository(before.repositoryPath, before.snapshot);
  if (workItem.snapshotFingerprint !== before.snapshot.fingerprint) {
    throw new Error(
      'The work item binding is stale. Explicitly rebind it to the current repository state before running checks.',
    );
  }

  const startedAt = new Date().toISOString();
  const versionResult =
    check.versionArgs.length === 0
      ? null
      : await runBoundedProcess({
          executable: check.executable,
          args: check.versionArgs,
          cwd: workingDirectory,
          timeoutMs: 5_000,
          maxOutputBytes: 4_096,
          env: minimalEnvironment(),
          ...(signal ? { signal } : {}),
        });
  const toolVersion = versionResult
    ? (redact(`${versionResult.stdout}\n${versionResult.stderr}`)
        .trim()
        .split(/\r?\n/u)[0]
        ?.slice(0, 4_096) ?? null)
    : null;
  const result = await runBoundedProcess({
    executable: check.executable,
    args: check.args,
    cwd: workingDirectory,
    timeoutMs: check.timeoutMs,
    maxOutputBytes: check.maxOutputBytes,
    env: minimalEnvironment(),
    ...(signal ? { signal } : {}),
  });
  const completedAt = new Date().toISOString();
  const after = await captureGitSnapshot(repository.path, {
    approvedRoots,
    contractVersion: 'default-v1',
    checkDefinitionVersion,
  });
  database.upsertRepository(after.repositoryPath, after.snapshot);

  let checkResult: CheckResult =
    result.state === 'completed' ? (result.exitCode === 0 ? 'passed' : 'failed') : result.state;
  let invalidReason: string | null = null;
  if (before.snapshot.fingerprint !== after.snapshot.fingerprint) {
    checkResult = 'mutated';
    invalidReason = 'The repository state changed while the check was running.';
  }
  const stdout = redact(result.stdout);
  const stderr = redact(result.stderr);
  const artifactHash = await sha256Hex(
    canonicalJson({
      checkId,
      result: checkResult,
      exitCode: result.exitCode,
      toolVersion,
      stdout,
      stderr,
      snapshotFingerprint: before.snapshot.fingerprint,
    }),
  );

  return database.recordEvidence({
    workItemId,
    checkId,
    kind: check.kind,
    label: check.label,
    result: checkResult,
    repositoryId: repository.id,
    snapshotFingerprint: before.snapshot.fingerprint,
    head: before.snapshot.head,
    contractVersion: before.snapshot.contractVersion,
    checkDefinitionVersion,
    startedAt,
    completedAt,
    durationMs: result.durationMs,
    toolVersion,
    exitCode: result.exitCode,
    stdout,
    stderr,
    artifactHashes: [artifactHash],
    invalidReason,
  });
}

export function acceptanceReadiness(
  database: VeriDoneDatabase,
  workItemId: string,
): {
  ready: boolean;
  checkCount: number;
  passingCount: number;
  evidenceIds: string[];
  scopeDeclared: boolean;
  scopeDriftPaths: string[];
} {
  const empty = {
    ready: false,
    checkCount: 0,
    passingCount: 0,
    evidenceIds: [],
    scopeDeclared: false,
    scopeDriftPaths: [],
  };
  const workItem = database.getWorkItem(workItemId);
  if (!workItem?.repositoryId) {
    return empty;
  }
  const repository = database.getRepository(workItem.repositoryId);
  if (!repository) return empty;
  const checks = database.listChecks().filter((check) => check.repositoryId === repository.id);
  const scope = assessDeclaredScope(
    repository.snapshot.statusEntries,
    checks.flatMap((check) => check.scopePaths),
  );
  const allEvidence = database.listEvidence(workItemId);
  const latest = checks
    .map((check) => allEvidence.find((evidence) => evidence.checkId === check.id))
    .filter((evidence): evidence is EvidenceRecord => Boolean(evidence));
  const passing = latest.filter(
    (evidence) =>
      evidence.result === 'passed' &&
      evidence.snapshotFingerprint === repository.snapshot.fingerprint &&
      evidence.contractVersion === repository.snapshot.contractVersion &&
      evidence.checkDefinitionVersion === repository.snapshot.checkDefinitionVersion &&
      evidence.invalidReason === null,
  );
  return {
    ready: checks.length > 0 && passing.length === checks.length && scope.satisfied,
    checkCount: checks.length,
    passingCount: passing.length,
    evidenceIds: passing.map((evidence) => evidence.id),
    scopeDeclared: scope.declared,
    scopeDriftPaths: scope.outsidePaths,
  };
}
