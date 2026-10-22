import path from 'node:path';

import {
  absolutePathEntries,
  captureGitSnapshot,
  createCleanCheckout,
  resolveWithinApprovedRoots,
  runBoundedProcess,
  sha256File,
  type CheckoutComparison,
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
  // Programs the tool starts by name are found on absolute PATH entries, never in the checkout.
  env.PATH = absolutePathEntries(env.PATH).join(path.delimiter);
  if (process.platform === 'win32') env.NoDefaultCurrentDirectoryInExePath = '1';
  return env;
}

/** Hashes the pinned tool file and refuses to continue unless it is the file the operator approved. */
async function verifyPinnedTool(check: CheckRecord): Promise<{ path: string; sha256: string }> {
  if (!check.resolvedExecutable || !check.executableSha256) {
    throw new Error(
      `The check "${check.label}" was approved before VeriDone pinned tools. Pin its tool again under Checks before running it.`,
    );
  }
  let sha256: string;
  try {
    sha256 = await sha256File(check.resolvedExecutable);
  } catch {
    throw new Error(
      `The pinned tool ${check.resolvedExecutable} is missing. Pin the check's tool again under Checks.`,
    );
  }
  if (sha256 !== check.executableSha256) {
    throw new Error(
      `The pinned tool ${check.resolvedExecutable} changed since it was approved. Review the new version, then pin the check's tool again under Checks.`,
    );
  }
  return { path: check.resolvedExecutable, sha256 };
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
  if (before.snapshot.statusEntries.length > 0) {
    throw new Error(
      'The repository has uncommitted changes. Checks run on a clean checkout of the bound commit, so commit the work and rebind the claim before running checks.',
    );
  }
  if (/^0+$/u.test(before.snapshot.head)) {
    throw new Error('The repository has no commit to check out yet.');
  }
  const tool = await verifyPinnedTool(check);

  // The check runs in a checkout VeriDone creates from the bound commit, so nothing in the
  // operator's work tree, index, ignored files, or Git configuration can influence the result.
  const checkout = await createCleanCheckout(
    before.repositoryPath,
    before.snapshot.head,
    signal ? { signal } : {},
  );
  let startedAt: string;
  let completedAt: string;
  let toolVersion: string | null;
  let result: Awaited<ReturnType<typeof runBoundedProcess>>;
  let comparison: CheckoutComparison | { error: string };
  try {
    const workingDirectory = await resolveWithinApprovedRoots(
      path.resolve(checkout.directory, check.cwdRelative),
      [checkout.directory],
    );
    startedAt = new Date().toISOString();
    const versionResult =
      check.versionArgs.length === 0
        ? null
        : await runBoundedProcess({
            executable: tool.path,
            args: check.versionArgs,
            cwd: workingDirectory,
            timeoutMs: 5_000,
            maxOutputBytes: 4_096,
            env: minimalEnvironment(),
            ...(signal ? { signal } : {}),
          });
    toolVersion = versionResult
      ? (redact(`${versionResult.stdout}\n${versionResult.stderr}`)
          .trim()
          .split(/\r?\n/u)[0]
          ?.slice(0, 4_096) ?? null)
      : null;
    result = await runBoundedProcess({
      executable: tool.path,
      args: check.args,
      cwd: workingDirectory,
      timeoutMs: check.timeoutMs,
      maxOutputBytes: check.maxOutputBytes,
      env: minimalEnvironment(),
      ...(signal ? { signal } : {}),
    });
    completedAt = new Date().toISOString();
    // A checkout the check left unreadable counts as changed; the run is still recorded.
    comparison = await checkout.compare().catch((error: unknown) => ({
      error: error instanceof Error ? error.message : 'The comparison failed.',
    }));
  } finally {
    await checkout.remove();
  }
  const after = await captureGitSnapshot(repository.path, {
    approvedRoots,
    contractVersion: 'default-v1',
    checkDefinitionVersion,
  });
  database.upsertRepository(after.repositoryPath, after.snapshot);

  let checkResult: CheckResult =
    result.state === 'completed' ? (result.exitCode === 0 ? 'passed' : 'failed') : result.state;
  let invalidReason: string | null = null;
  if ('error' in comparison) {
    invalidReason = `The checkout could not be compared with the bound commit after the check: ${comparison.error}`;
  } else if (comparison.headMoved) {
    invalidReason = 'The check moved its checkout away from the bound commit.';
  } else if (comparison.changedPaths.length > 0) {
    const { changedPaths } = comparison;
    invalidReason = `The check changed files in its checkout: ${changedPaths.slice(0, 5).join(', ')}${changedPaths.length > 5 ? ', …' : ''}.`;
  }
  if (invalidReason !== null) {
    checkResult = 'mutated';
    invalidReason = invalidReason.slice(0, 2_000);
  }
  const stdout = redact(result.stdout);
  const stderr = redact(result.stderr);
  const artifactHash = await sha256Hex(
    canonicalJson({
      checkId,
      result: checkResult,
      exitCode: result.exitCode,
      toolVersion,
      toolSha256: tool.sha256,
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
    isolation: 'clean-checkout',
    toolPath: tool.path,
    toolSha256: tool.sha256,
    origin: 'local',
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
  // Only evidence this workspace produced counts; restored evidence stays history.
  const allEvidence = database
    .listEvidence(workItemId)
    .filter((evidence) => evidence.origin === 'local');
  const latest = checks
    .map((check) => allEvidence.find((evidence) => evidence.checkId === check.id))
    .filter((evidence): evidence is EvidenceRecord => Boolean(evidence));
  const passing = latest.filter(
    (evidence) =>
      evidence.result === 'passed' &&
      evidence.isolation === 'clean-checkout' &&
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
