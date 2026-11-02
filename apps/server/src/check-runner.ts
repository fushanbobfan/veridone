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
import { redactSecrets } from './redaction.js';

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
  await verifyPinnedTool(check);

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
  let setup: Awaited<ReturnType<typeof runBoundedProcess>> | null = null;
  let comparison: CheckoutComparison | { error: string };
  let tool: { path: string; sha256: string };
  let toolUnchanged: boolean;
  try {
    const workingDirectory = await resolveWithinApprovedRoots(
      path.resolve(checkout.directory, check.cwdRelative),
      [checkout.directory],
    );
    // Preparing the checkout can take a while; verify the tool again just before it starts.
    tool = await verifyPinnedTool(check);
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
      ? (redactSecrets(`${versionResult.stdout}\n${versionResult.stderr}`)
          .trim()
          .split(/\r?\n/u)[0]
          ?.slice(0, 4_096) ?? null)
      : null;
    // Setup runs the same pinned tool in the checkout first, for example to install dependencies from the
    // lockfile; a setup that fails ends the run, and its exit code and output become the evidence.
    if (check.setupArgs.length > 0) {
      setup = await runBoundedProcess({
        executable: tool.path,
        args: check.setupArgs,
        cwd: workingDirectory,
        timeoutMs: check.setupTimeoutMs,
        maxOutputBytes: check.maxOutputBytes,
        env: minimalEnvironment(),
        ...(signal ? { signal } : {}),
      });
    }
    result =
      setup && !(setup.state === 'completed' && setup.exitCode === 0)
        ? setup
        : await runBoundedProcess({
            executable: tool.path,
            args: check.args,
            cwd: workingDirectory,
            timeoutMs: check.timeoutMs,
            maxOutputBytes: check.maxOutputBytes,
            env: minimalEnvironment(),
            ...(signal ? { signal } : {}),
          });
    completedAt = new Date().toISOString();
    toolUnchanged = (await sha256File(tool.path).catch(() => null)) === tool.sha256;
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
  if (!toolUnchanged) {
    invalidReason = `The pinned tool ${tool.path} changed while the check ran.`;
  } else if ('error' in comparison) {
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
  // With a setup, the output carries both steps under headers; when the setup failed, it is the setup's alone.
  // Each text stays within the check's output limit, since a backup refuses a longer one and evidence never
  // changes: the setup's part is cut first, and the cap applies again after redaction, whose markers can be
  // longer than what they replace.
  const checkRan = setup !== result;
  const limit = check.maxOutputBytes;
  const joined = (setupText: string, head: string, tail: string) =>
    `${head}${setupText.slice(0, Math.max(0, limit - head.length - tail.length))}${tail}`;
  const stdout = redactSecrets(
    setup
      ? joined(
          setup.stdout,
          `--- setup exited with ${setup.exitCode ?? setup.state} ---\n`,
          checkRan ? `\n--- check ---\n${result.stdout}` : '',
        )
      : result.stdout,
  ).slice(0, limit);
  const stderr = redactSecrets(
    setup ? joined(setup.stderr, '', checkRan ? result.stderr : '') : result.stderr,
  ).slice(0, limit);
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
    durationMs: result.durationMs + (setup && checkRan ? setup.durationMs : 0),
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

/** One approved check's gate: its state and the run that state comes from. */
export interface CheckReadiness {
  checkId: string;
  state: 'passed' | 'failed' | 'stale' | 'missing';
  /** The latest run this workspace produced, or a restored one when this workspace has none. */
  evidenceId: string | null;
}

/** Whether a work item may be accepted without an override, and why; the web shows exactly this. */
export interface AcceptanceReadiness {
  ready: boolean;
  /** The work item is bound to a repository snapshot. */
  bound: boolean;
  /** The bound snapshot is the repository's current state. */
  bindingFresh: boolean;
  /** The agent's receipt reports a failing or incomplete stage. */
  degraded: boolean;
  checkCount: number;
  passingCount: number;
  evidenceIds: string[];
  scopeDeclared: boolean;
  scopeDriftPaths: string[];
  checks: CheckReadiness[];
}

export function acceptanceReadiness(
  database: VeriDoneDatabase,
  workItemId: string,
): AcceptanceReadiness {
  const workItem = database.getWorkItem(workItemId);
  // A receipt's work item has the source reference `<source type>:<run id>`, and no source type holds a colon, so
  // the run id is all that follows the first colon. Run ids may hold colons themselves: a suffix match would let the
  // degraded run `child` hold up the work item of the run `parent:child`.
  const runId = workItem?.sourceRef.slice(workItem.sourceRef.indexOf(':') + 1);
  const degraded = database
    .listReceipts()
    .some((receipt) => receipt.degraded && receipt.runId === runId);
  const repository = workItem?.repositoryId ? database.getRepository(workItem.repositoryId) : null;
  if (!workItem || !repository) {
    return {
      ready: false,
      bound: false,
      bindingFresh: false,
      degraded,
      checkCount: 0,
      passingCount: 0,
      evidenceIds: [],
      scopeDeclared: false,
      scopeDriftPaths: [],
      checks: [],
    };
  }
  const bindingFresh = workItem.snapshotFingerprint === repository.snapshot.fingerprint;
  const checks = database.listChecks().filter((check) => check.repositoryId === repository.id);
  const scope = assessDeclaredScope(
    repository.snapshot.statusEntries,
    checks.flatMap((check) => check.scopePaths),
  );
  const evidence = database.listEvidence(workItemId);
  const isFresh = (run: EvidenceRecord) =>
    // Only evidence this workspace produced counts; restored evidence stays history.
    run.origin === 'local' &&
    run.result === 'passed' &&
    run.isolation === 'clean-checkout' &&
    run.snapshotFingerprint === repository.snapshot.fingerprint &&
    run.contractVersion === repository.snapshot.contractVersion &&
    run.checkDefinitionVersion === repository.snapshot.checkDefinitionVersion &&
    run.invalidReason === null;
  const checkStates = checks.map((check): CheckReadiness & { fresh: boolean } => {
    const runs = evidence.filter((run) => run.checkId === check.id);
    const latest = runs.find((run) => run.origin === 'local') ?? runs[0];
    const fresh = latest ? isFresh(latest) : false;
    return {
      checkId: check.id,
      state: fresh
        ? 'passed'
        : latest?.result === 'failed' || latest?.result === 'mutated'
          ? 'failed'
          : latest
            ? 'stale'
            : 'missing',
      evidenceId: latest?.id ?? null,
      fresh,
    };
  });
  const passing = checkStates.filter((check) => check.fresh);
  return {
    ready:
      !degraded &&
      bindingFresh &&
      checks.length > 0 &&
      passing.length === checks.length &&
      scope.satisfied,
    bound: workItem.snapshotFingerprint !== null,
    bindingFresh,
    degraded,
    checkCount: checks.length,
    passingCount: passing.length,
    evidenceIds: passing.flatMap((check) => (check.evidenceId ? [check.evidenceId] : [])),
    scopeDeclared: scope.declared,
    scopeDriftPaths: scope.outsidePaths,
    checks: checkStates.map(({ fresh: _fresh, ...check }) => check),
  };
}
