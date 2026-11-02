import { createHmac } from 'node:crypto';

import { canonicalJson, sha256Hex } from '@veridone/core';

import type { CheckRecord, EvidenceRecord, VeriDoneDatabase } from './database.js';
import { sanitizeForPacket } from './redaction.js';
import { summarizeTestOutput, type TestCounts } from './test-summary.js';

/** The packet schemas a verifier accepts; schema 2 carries pseudonymous identifiers. */
const packetSchemaVersions = new Set([1, 2]);

type Pseudonym = (kind: string, value: string) => string;

function escapeHtml(value: string): string {
  return sanitizeForPacket(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeMarkdown(value: string): string {
  return sanitizeForPacket(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function publicEvidence(evidence: EvidenceRecord[], pseudonym: Pseudonym) {
  // The tool's SHA-256 identifies it; its local path and the output stay out of the packet, and only the counts
  // from a test runner's own summary line go in.
  return evidence.map(({ stdout, stderr, toolPath: _toolPath, ...item }) => ({
    ...item,
    testCounts: summarizeTestOutput(`${stdout}\n${stderr}`),
    label: sanitizeForPacket(item.label),
    toolVersion: item.toolVersion ? sanitizeForPacket(item.toolVersion) : null,
    invalidReason: item.invalidReason ? sanitizeForPacket(item.invalidReason) : null,
    repositoryId: pseudonym('repository', item.repositoryId),
    snapshotFingerprint: pseudonym('fingerprint', item.snapshotFingerprint),
    checkDefinitionVersion: pseudonym('check-definitions', item.checkDefinitionVersion),
    artifactHashes: item.artifactHashes.map((hash) => pseudonym('artifact', hash)),
  }));
}

/** What each check ran, so a reader can see the command behind its evidence. */
function publicChecks(checks: CheckRecord[], pseudonym: Pseudonym) {
  return checks.map((check) => ({
    id: check.id,
    label: sanitizeForPacket(check.label),
    kind: check.kind,
    // The file name and the pinned SHA-256 identify the tool; the directory it sits in stays local.
    executable: sanitizeForPacket(check.executable.split(/[\\/]/u).pop() ?? check.executable),
    toolSha256: check.executableSha256,
    args: check.args.map(sanitizeForPacket),
    versionArgs: check.versionArgs.map(sanitizeForPacket),
    cwdRelative: sanitizeForPacket(check.cwdRelative),
    scopePaths: check.scopePaths.map(sanitizeForPacket),
    timeoutMs: check.timeoutMs,
    maxOutputBytes: check.maxOutputBytes,
    definitionHash: pseudonym('check-definition', check.definitionHash),
    approvedAt: check.approvedAt,
  }));
}

export interface PacketVerification {
  valid: boolean;
  issues: string[];
  expectedPayloadHash: string | null;
  actualPayloadHash: string | null;
}

export async function verifyAcceptancePacket(input: unknown): Promise<PacketVerification> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      valid: false,
      issues: ['Packet must be a JSON object.'],
      expectedPayloadHash: null,
      actualPayloadHash: null,
    };
  }
  const packet = input as Record<string, unknown>;
  const manifest = packet.manifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {
      valid: false,
      issues: ['Packet manifest is missing.'],
      expectedPayloadHash: null,
      actualPayloadHash: null,
    };
  }
  const typedManifest = manifest as Record<string, unknown>;
  const expectedPayloadHash =
    typeof typedManifest.payloadHash === 'string' ? typedManifest.payloadHash : null;
  const { manifest: _manifest, ...payload } = packet;
  const actualPayloadHash = await sha256Hex(canonicalJson(payload));
  const issues: string[] = [];
  if (typedManifest.algorithm !== 'sha256') issues.push('Unsupported manifest algorithm.');
  if (!expectedPayloadHash || expectedPayloadHash !== actualPayloadHash) {
    issues.push('Payload hash does not match the manifest.');
  }

  const evidence = Array.isArray(packet.evidence)
    ? (packet.evidence as Array<Record<string, unknown>>)
    : [];
  const expectedArtifacts = evidence
    .flatMap((item) => (Array.isArray(item.artifactHashes) ? item.artifactHashes : []))
    .filter((value): value is string => typeof value === 'string');
  const manifestArtifacts = Array.isArray(typedManifest.evidenceArtifacts)
    ? typedManifest.evidenceArtifacts.filter((value): value is string => typeof value === 'string')
    : [];
  if (canonicalJson(expectedArtifacts) !== canonicalJson(manifestArtifacts)) {
    issues.push('Evidence artifact hashes do not match the manifest.');
  }
  if (
    typeof packet.schemaVersion !== 'number' ||
    !packetSchemaVersions.has(packet.schemaVersion) ||
    packet.application !== 'veridone'
  ) {
    issues.push('Packet identity or schema version is invalid.');
  }

  return {
    valid: issues.length === 0,
    issues,
    expectedPayloadHash,
    actualPayloadHash,
  };
}

export async function buildAcceptancePacket(database: VeriDoneDatabase, workItemId: string) {
  const rawWorkItem = database.getWorkItem(workItemId);
  if (!rawWorkItem) throw new Error('The work item does not exist.');
  const repository = rawWorkItem.repositoryId
    ? database.getRepository(rawWorkItem.repositoryId)
    : null;
  const rawEvidence = database.listEvidence(workItemId);
  const rawVerdicts = database.listVerdicts(workItemId);
  const generatedAt =
    rawVerdicts[0]?.decidedAt ?? rawEvidence[0]?.completedAt ?? rawWorkItem.updatedAt;
  // The contract the latest verdict, evidence or snapshot was recorded under, which need not be the oldest one.
  const contracts = database.listContracts();
  const contractVersion =
    rawVerdicts[0]?.contractVersion ??
    rawEvidence[0]?.contractVersion ??
    repository?.snapshot.contractVersion;
  const contract =
    contracts.find((candidate) => candidate.version === contractVersion) ?? contracts[0] ?? null;
  // The repository id hashes the local path, and the fingerprint, claim, definition and artifact hashes each mix
  // local data with fields a packet carries, so each could confirm a guessed path. They appear as HMACs under a key
  // only this workspace holds; equal values stay equal, so a packet's bindings can still be compared.
  const key = database.workspaceKey('packet-pseudonyms');
  const pseudonym: Pseudonym = (kind, value) =>
    createHmac('sha256', key).update(`${kind}:${value}`).digest('hex');
  const workItem = {
    ...rawWorkItem,
    title: sanitizeForPacket(rawWorkItem.title),
    claim: sanitizeForPacket(rawWorkItem.claim),
    sourceLabel: sanitizeForPacket(rawWorkItem.sourceLabel),
    sourceRef: sanitizeForPacket(rawWorkItem.sourceRef),
    repositoryId: rawWorkItem.repositoryId
      ? pseudonym('repository', rawWorkItem.repositoryId)
      : null,
    snapshotFingerprint: rawWorkItem.snapshotFingerprint
      ? pseudonym('fingerprint', rawWorkItem.snapshotFingerprint)
      : null,
    claimHash: pseudonym('claim', rawWorkItem.claimHash),
  };
  const evidence = publicEvidence(rawEvidence, pseudonym);
  const evidenceCheckIds = new Set(rawEvidence.map((item) => item.checkId));
  const checks = publicChecks(
    database
      .listChecks()
      .filter(
        (check) =>
          check.repositoryId === rawWorkItem.repositoryId || evidenceCheckIds.has(check.id),
      ),
    pseudonym,
  );
  const verdicts = rawVerdicts.map((verdict) => ({
    ...verdict,
    note: sanitizeForPacket(verdict.note),
    overrideReason: verdict.overrideReason ? sanitizeForPacket(verdict.overrideReason) : null,
    snapshotFingerprint: pseudonym('fingerprint', verdict.snapshotFingerprint),
    claimHash: verdict.claimHash ? pseudonym('claim', verdict.claimHash) : null,
  }));
  const fingerprint = repository ? pseudonym('fingerprint', repository.snapshot.fingerprint) : null;
  const payload = {
    schemaVersion: 2,
    application: 'veridone',
    privacyMode: 'strict',
    identifiers: 'hmac-sha256-workspace-pseudonyms',
    generatedAt,
    workItem,
    repository: repository
      ? {
          id: pseudonym('repository', repository.id),
          name: sanitizeForPacket(repository.name),
          branch: repository.snapshot.branch ? sanitizeForPacket(repository.snapshot.branch) : null,
          head: repository.snapshot.head,
          fingerprint,
          worktreeHash: repository.snapshot.worktreeHash,
          diffStats: repository.snapshot.diffStats,
          statusEntries: repository.snapshot.statusEntries.map(sanitizeForPacket),
        }
      : null,
    contract,
    checks,
    evidence,
    verdicts,
  };
  const payloadHash = await sha256Hex(canonicalJson(payload));
  const packet = {
    ...payload,
    manifest: {
      algorithm: 'sha256',
      payloadHash,
      evidenceArtifacts: evidence.flatMap((item) => item.artifactHashes),
    },
  };
  const json = JSON.stringify(packet, null, 2);
  const view = packetView(packet);
  return { packet, json, markdown: renderMarkdown(view), html: renderHtml(view) };
}

/** A check's command as a reader would type it, each argument quoted when it holds spaces or quotes. */
function commandLine(check: { executable: string; args: string[] }): string {
  const quoted = check.args.map((arg) => (/[\s"'\\]/u.test(arg) ? JSON.stringify(arg) : arg));
  return [check.executable, ...quoted].join(' ');
}

/** The parts of a built packet that its readable formats show. */
interface PacketViewInput {
  workItem: { title: string; sourceLabel: string; claim: string };
  repository: {
    name: string;
    branch: string | null;
    head: string;
    fingerprint: string | null;
  } | null;
  contract: { title: string; version: string; criteria: unknown[] } | null;
  checks: Array<{
    label: string;
    executable: string;
    args: string[];
    cwdRelative: string;
    toolSha256: string | null;
  }>;
  evidence: Array<{
    label: string;
    result: string;
    exitCode: number | null;
    durationMs: number;
    toolVersion: string | null;
    testCounts: TestCounts | null;
    artifactHashes: string[];
  }>;
  verdicts: Array<{
    decision: string;
    note: string;
    decidedAt: string;
    overrideReason: string | null;
  }>;
  manifest: { payloadHash: string };
}

/**
 * The facts the readable formats show, read from the JSON packet itself so that the three formats cannot drift
 * apart. Every string in it is already sanitized.
 */
function packetView(packet: PacketViewInput) {
  const clauses = (packet.contract?.criteria ?? []).map((clause) => {
    const record = (clause ?? {}) as { title?: unknown; required?: unknown };
    return {
      title: sanitizeForPacket(typeof record.title === 'string' ? record.title : 'Untitled clause'),
      required: record.required === true,
    };
  });
  return {
    title: packet.workItem.title,
    source: packet.workItem.sourceLabel,
    claim: packet.workItem.claim,
    repository: packet.repository?.name ?? 'Unlinked',
    branch: packet.repository?.branch ?? 'none',
    head: packet.repository?.head ?? 'Unbound',
    fingerprint: packet.repository?.fingerprint ?? 'Unbound',
    contract: packet.contract
      ? `${sanitizeForPacket(packet.contract.title)} (${packet.contract.version})`
      : 'No contract',
    clauses,
    verdict: packet.verdicts[0]?.decision ?? 'No human verdict',
    checks: packet.checks.map((check) => ({
      label: check.label,
      command: commandLine(check),
      cwd: check.cwdRelative,
      tool: check.toolSha256 ?? 'not pinned',
    })),
    evidence: packet.evidence.map((item) => ({
      label: item.label,
      summary: `${item.result}; exit ${item.exitCode ?? 'n/a'}; ${item.durationMs} ms; tool ${item.toolVersion ?? 'not captured'}`,
      tests: item.testCounts
        ? `${item.testCounts.passed} passed, ${item.testCounts.failed} failed, ${item.testCounts.skipped} skipped of ${item.testCounts.total} (${item.testCounts.runner})`
        : null,
      artifacts: item.artifactHashes.join(', ') || 'none',
    })),
    verdicts: packet.verdicts.map((item) => ({
      decision: item.decision,
      note: item.note || 'No note',
      decidedAt: item.decidedAt,
      overrideReason: item.overrideReason,
    })),
    payloadHash: packet.manifest.payloadHash,
  };
}

type PacketView = ReturnType<typeof packetView>;

function renderMarkdown(view: PacketView): string {
  const list = (items: string[], empty: string) => (items.length ? items.join('\n') : empty);
  return `# VeriDone acceptance packet

## ${escapeMarkdown(view.title)}

- Source: ${escapeMarkdown(view.source)}
- Repository: ${escapeMarkdown(view.repository)} (branch ${escapeMarkdown(view.branch)})
- HEAD: ${view.head}
- Fingerprint: ${view.fingerprint}
- Contract: ${escapeMarkdown(view.contract)}
- Verdict: ${view.verdict}
- Privacy mode: strict
- Payload SHA-256: \`${view.payloadHash}\`

### Claim

${escapeMarkdown(view.claim)}

### Contract clauses

${list(
  view.clauses.map(
    (clause) => `- ${escapeMarkdown(clause.title)}${clause.required ? ' (required)' : ''}`,
  ),
  '_No clauses._',
)}

### Checks

${list(
  view.checks.map(
    (check) =>
      `- **${escapeMarkdown(check.label)}** — \`${escapeMarkdown(check.command)}\` in \`${escapeMarkdown(check.cwd)}\`; tool SHA-256 ${check.tool}`,
  ),
  '_No approved checks._',
)}

### Evidence

${list(
  view.evidence.map(
    (item) =>
      `- **${escapeMarkdown(item.label)}** — ${escapeMarkdown(item.summary)}${item.tests ? `; tests: ${item.tests}` : ''}; artifacts ${item.artifacts}`,
  ),
  '_No executable evidence captured._',
)}

### Verdict history

${list(
  view.verdicts.map(
    (item) =>
      `- **${item.decision}** — ${escapeMarkdown(item.note)} (${item.decidedAt})${item.overrideReason ? `; override: ${escapeMarkdown(item.overrideReason)}` : ''}`,
  ),
  '_No human verdict recorded._',
)}
`;
}

function renderHtml(view: PacketView): string {
  const list = (items: string[], empty: string) =>
    `<ul>${items.length ? items.join('') : `<li>${empty}</li>`}</ul>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>VeriDone packet — ${escapeHtml(view.title)}</title>
<style>body{max-width:780px;margin:48px auto;padding:0 24px;font:16px/1.55 system-ui;color:#171914;background:#f5f4ed}code{font-family:ui-monospace,monospace;word-break:break-all}.meta{padding:18px 0;border-block:1px solid #bbb}.status{font-weight:700}.hash{word-break:break-all;color:#555}li{margin:8px 0}small{color:#555}</style></head>
<body><small>VERIDONE ACCEPTANCE PACKET · STRICT PRIVACY</small><h1>${escapeHtml(view.title)}</h1>
<div class="meta"><p>Source: ${escapeHtml(view.source)}</p>
<p>Repository: <strong>${escapeHtml(view.repository)}</strong> (branch ${escapeHtml(view.branch)})</p>
<p>HEAD: <code>${escapeHtml(view.head)}</code></p>
<p>Fingerprint: <code>${escapeHtml(view.fingerprint)}</code></p>
<p>Contract: ${escapeHtml(view.contract)}</p>
<p>Verdict: <span class="status">${escapeHtml(view.verdict)}</span></p></div>
<h2>Claim</h2><p>${escapeHtml(view.claim)}</p>
<h2>Contract clauses</h2>${list(
    view.clauses.map(
      (clause) =>
        `<li>${escapeHtml(clause.title)}${clause.required ? ' <small>(required)</small>' : ''}</li>`,
    ),
    'No clauses.',
  )}
<h2>Checks</h2>${list(
    view.checks.map(
      (check) =>
        `<li><strong>${escapeHtml(check.label)}</strong> — <code>${escapeHtml(check.command)}</code> in <code>${escapeHtml(check.cwd)}</code><br><small>Tool SHA-256: ${escapeHtml(check.tool)}</small></li>`,
    ),
    'No approved checks.',
  )}
<h2>Evidence</h2>${list(
    view.evidence.map(
      (item) =>
        `<li><strong>${escapeHtml(item.label)}</strong> — ${escapeHtml(item.summary)}${item.tests ? `<br>Tests: ${escapeHtml(item.tests)}` : ''}<br><small>Artifacts: ${escapeHtml(item.artifacts)}</small></li>`,
    ),
    'No executable evidence captured.',
  )}
<h2>Verdict history</h2>${list(
    view.verdicts.map(
      (item) =>
        `<li><strong>${escapeHtml(item.decision)}</strong> — ${escapeHtml(item.note)} (${escapeHtml(item.decidedAt)})${item.overrideReason ? `<br><small>Override: ${escapeHtml(item.overrideReason)}</small>` : ''}</li>`,
    ),
    'No human verdict recorded.',
  )}
<h2>Integrity</h2><p class="hash"><code>${view.payloadHash}</code></p></body></html>`;
}
