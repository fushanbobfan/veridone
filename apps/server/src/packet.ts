import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { canonicalJson, sha256Hex } from '@veridone/core';

import type { CheckRecord, EvidenceRecord, VeriDoneDatabase } from './database.js';
import { createPacketSanitizer, sanitizeArgsForPacket, sanitizeForPacket } from './redaction.js';
import { summarizeTestOutput, type TestCounts } from './test-summary.js';

/** The packet schemas a verifier accepts; schema 2 carries pseudonymous identifiers and a signature. */
const packetSchemaVersions = new Set([1, 2]);

type Pseudonym = (kind: string, value: string) => string;
type Sanitize = (value: string) => string;

/**
 * JSON with object keys in UTF-16 code-unit order, the order RFC 8785 uses, so a verifier on any machine derives
 * the same bytes. Schema-1 packets used a locale-aware order, which they keep.
 */
export function packetCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => packetCanonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${packetCanonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 of a public key's SPKI encoding, the id a signature names its key by. */
function keyIdOf(publicKey: KeyObject | string): string {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  return createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

/** This workspace's packet signing key; its public half is what others verify packets against. */
export function workspaceSigningKey(database: VeriDoneDatabase): {
  privateKey: KeyObject;
  publicKey: string;
  keyId: string;
} {
  const material = database.workspaceKey('packet-signing');
  // Given a private key in PEM, createPublicKey derives its public half.
  const publicKey = createPublicKey(material).export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey: createPrivateKey(material), publicKey, keyId: keyIdOf(publicKey) };
}

const signatureSchema = z.object({
  algorithm: z.literal('ed25519'),
  keyId: z.string().regex(/^[0-9a-f]{64}$/u),
  publicKey: z.string().max(10_000),
  value: z.string().max(1_000),
});

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
    repositoryId: pseudonym('repository', item.repositoryId),
    snapshotFingerprint: pseudonym('fingerprint', item.snapshotFingerprint),
    checkDefinitionVersion: pseudonym('check-definitions', item.checkDefinitionVersion),
    artifactHashes: item.artifactHashes.map((hash) => pseudonym('artifact', hash)),
  }));
}

/**
 * A text on one line: a line break in it could otherwise pass for a line of the packet, such as a second verdict.
 * Nothing else in it changes, so a check's command stays as it was written.
 */
const oneLine: Sanitize = (value) => value.replace(/[\n\v\f\r\x85\p{Zl}\p{Zp}]+/gu, ' ');

/** A value with every string in it, object keys included, passed through `sanitize`. */
function sanitizeDeep(value: unknown, sanitize: Sanitize): unknown {
  if (typeof value === 'string') return sanitize(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, sanitize));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [sanitize(key), sanitizeDeep(child, sanitize)]),
    );
  }
  return value;
}

/**
 * What each check ran, so a reader can see the command behind its evidence. The value after an option named for a
 * secret is replaced here, where the arguments are still in order.
 */
function publicChecks(checks: CheckRecord[], pseudonym: Pseudonym, sanitize: Sanitize) {
  return checks.map((check) => ({
    id: check.id,
    label: check.label,
    kind: check.kind,
    // The file name and the pinned SHA-256 identify the tool; the directory it sits in stays local.
    executable: check.executable.split(/[\\/]/u).pop() ?? check.executable,
    toolSha256: check.executableSha256,
    args: sanitizeArgsForPacket(check.args, sanitize),
    versionArgs: sanitizeArgsForPacket(check.versionArgs, sanitize),
    cwdRelative: check.cwdRelative,
    scopePaths: check.scopePaths,
    timeoutMs: check.timeoutMs,
    maxOutputBytes: check.maxOutputBytes,
    setupArgs: sanitizeArgsForPacket(check.setupArgs, sanitize),
    setupTimeoutMs: check.setupTimeoutMs,
    definitionHash: pseudonym('check-definition', check.definitionHash),
    approvedAt: check.approvedAt,
    // A check the operator took out of the gate stays listed, so a reader sees that the policy changed and why.
    retiredAt: check.retiredAt,
    retiredReason: check.retiredReason,
  }));
}

export interface PacketVerification {
  valid: boolean;
  issues: string[];
  expectedPayloadHash: string | null;
  actualPayloadHash: string | null;
  /** True when the packet carries an Ed25519 signature that matches its payload. */
  signed: boolean;
  /** The id of the key the signature names, whether or not the signature holds. */
  keyId: string | null;
  /** Whether the signing key is one the caller trusts; null when the caller named no trusted key. */
  trusted: boolean | null;
}

export interface VerificationOptions {
  /** Public keys, in PEM, whose signatures the caller trusts. */
  trustedKeys?: string[];
}

export async function verifyAcceptancePacket(
  input: unknown,
  options: VerificationOptions = {},
): Promise<PacketVerification> {
  const unreadable = (issue: string): PacketVerification => ({
    valid: false,
    issues: [issue],
    expectedPayloadHash: null,
    actualPayloadHash: null,
    signed: false,
    keyId: null,
    trusted: options.trustedKeys ? false : null,
  });
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return unreadable('Packet must be a JSON object.');
  }
  const packet = input as Record<string, unknown>;
  const manifest = packet.manifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return unreadable('Packet manifest is missing.');
  }
  const typedManifest = manifest as Record<string, unknown>;
  const expectedPayloadHash =
    typeof typedManifest.payloadHash === 'string' ? typedManifest.payloadHash : null;
  const { manifest: _manifest, ...payload } = packet;
  const canonical =
    packet.schemaVersion === 1 ? canonicalJson(payload) : packetCanonicalJson(payload);
  const actualPayloadHash = await sha256Hex(canonical);
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

  // Schema-1 packets carry a checksum only; from schema 2 on a packet must be signed.
  let signed = false;
  let keyId: string | null = null;
  if (typedManifest.signature !== undefined || packet.schemaVersion !== 1) {
    const signature = signatureSchema.safeParse(typedManifest.signature);
    if (typedManifest.signature === undefined) {
      issues.push('The packet is not signed.');
    } else if (!signature.success) {
      issues.push('The packet signature is malformed.');
    } else {
      keyId = signature.data.keyId;
      try {
        const publicKey = createPublicKey(signature.data.publicKey);
        // Node verifies with whatever key type the PEM holds, so an RSA key labeled Ed25519 would pass.
        if (publicKey.asymmetricKeyType !== 'ed25519') {
          issues.push('The packet signature is not an Ed25519 signature.');
        } else if (keyIdOf(publicKey) !== keyId) {
          issues.push('The signature names a key other than the one it carries.');
        } else {
          signed = verify(
            null,
            Buffer.from(canonical),
            publicKey,
            Buffer.from(signature.data.value, 'base64'),
          );
          if (!signed) issues.push('The signature does not match the payload.');
        }
      } catch {
        issues.push('The packet signature is malformed.');
      }
    }
  }

  // A sound signature shows only that its key signed; whose key it is, the reader decides.
  let trusted: boolean | null = null;
  if (options.trustedKeys) {
    const trustedIds = new Set(
      options.trustedKeys.flatMap((key) => {
        try {
          return [keyIdOf(key)];
        } catch {
          return [];
        }
      }),
    );
    trusted = signed && keyId !== null && trustedIds.has(keyId);
    if (!trusted) issues.push('The packet is not signed by a trusted key.');
  }

  return {
    valid: issues.length === 0,
    issues,
    expectedPayloadHash,
    actualPayloadHash,
    signed,
    keyId,
    trusted,
  };
}

/** The records a packet's known local paths come from, as the workspace database keeps them. */
export interface KnownPathSources {
  listRoots(): Array<{ path: string; status: string }>;
  listRepositories(): Array<{ path: string }>;
  listChecks(): Array<{ resolvedExecutable: string | null }>;
}

/**
 * The local paths a packet must not show, most trusted first, since the sanitizer keeps a bounded number: the home and
 * temporary directories, the approved roots, the pinned tools, the repositories, and last the roots a restored backup
 * brought, still pending. A path under a directory the system also writes another way, as a Windows short name or
 * macOS's `/var` for `/private/var`, goes in both ways, and a path under the home directory also from `~`.
 */
export async function knownLocalPaths(
  database: KnownPathSources,
  evidence: Array<{ toolPath: string | null }>,
  system = { home: homedir(), temp: tmpdir() },
): Promise<string[]> {
  const aliases: Array<[string, string]> = [];
  for (const written of [system.home, system.temp, '/tmp', '/var']) {
    const canonical = await realpath(written).catch(() => written);
    if (canonical !== written) aliases.push([written, canonical]);
  }
  const homes = [
    system.home,
    ...aliases.flatMap(([written, canonical]) => (written === system.home ? [canonical] : [])),
  ];
  const roots = database.listRoots();
  const ordered = [
    system.home,
    system.temp,
    ...roots.filter((root) => root.status === 'approved').map((root) => root.path),
    ...database.listChecks().flatMap((check) => check.resolvedExecutable ?? []),
    ...evidence.flatMap((item) => item.toolPath ?? []),
    ...database.listRepositories().map((repository) => repository.path),
    ...roots.filter((root) => root.status !== 'approved').map((root) => root.path),
  ];
  const known = new Set<string>();
  for (const knownPath of ordered) {
    const forms = [knownPath];
    for (const [written, canonical] of aliases) {
      for (const [from, to] of [
        [canonical, written],
        [written, canonical],
      ] as const) {
        if (knownPath === from || knownPath.startsWith(`${from}${path.sep}`)) {
          forms.push(`${to}${knownPath.slice(from.length)}`);
        }
      }
    }
    const fromHome = forms.flatMap((form) =>
      homes.flatMap((home) =>
        form.startsWith(`${home}${path.sep}`) ? [`~${form.slice(home.length)}`] : [],
      ),
    );
    for (const form of [...forms, ...fromHome]) known.add(form);
  }
  return [...known];
}

export async function buildAcceptancePacket(database: VeriDoneDatabase, workItemId: string) {
  const rawWorkItem = database.getWorkItem(workItemId);
  if (!rawWorkItem) throw new Error('The work item does not exist.');
  const repository = rawWorkItem.repositoryId
    ? database.getRepository(rawWorkItem.repositoryId)
    : null;
  const rawEvidence = database.listEvidence(workItemId);
  const rawVerdicts = database.listVerdicts(workItemId);
  const sanitize = createPacketSanitizer(await knownLocalPaths(database, rawEvidence));
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
  // The repository id hashes the local path, and the fingerprint, worktree, claim, definition and artifact hashes
  // each mix local data with fields a packet carries, so each could confirm a guessed path or file. They appear as
  // HMACs under a key only this workspace holds; equal values stay equal, so a packet's bindings can still be
  // compared.
  const key = database.workspaceKey('packet-pseudonyms');
  const pseudonym: Pseudonym = (kind, value) =>
    createHmac('sha256', key).update(`${kind}:${value}`).digest('hex');
  const workItem = {
    ...rawWorkItem,
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
    sanitize,
  );
  const verdicts = rawVerdicts.map((verdict) => ({
    ...verdict,
    snapshotFingerprint: pseudonym('fingerprint', verdict.snapshotFingerprint),
    claimHash: verdict.claimHash ? pseudonym('claim', verdict.claimHash) : null,
  }));
  const fingerprint = repository ? pseudonym('fingerprint', repository.snapshot.fingerprint) : null;
  const fields = {
    schemaVersion: 2,
    application: 'veridone',
    privacyMode: 'strict',
    identifiers: 'hmac-sha256-workspace-pseudonyms',
    generatedAt,
    workItem,
    repository: repository
      ? {
          id: pseudonym('repository', repository.id),
          name: repository.name,
          branch: repository.snapshot.branch,
          head: repository.snapshot.head,
          fingerprint,
          worktreeHash: pseudonym('worktree', repository.snapshot.worktreeHash),
          diffStats: repository.snapshot.diffStats,
          statusEntries: repository.snapshot.statusEntries,
          // A removed repository stays named by its last state, so a reader sees what the work was decided on.
          removedAt: repository.removedAt,
          removedReason: repository.removedReason,
        }
      : null,
    contract,
    checks,
    evidence,
    verdicts,
  };
  // Every string in the payload, object keys included, passes through the sanitizer: a restored backup can carry any
  // text in any field, the contract and an evidence record's result included.
  const payload = sanitizeDeep(fields, sanitize) as typeof fields;
  const canonical = packetCanonicalJson(payload);
  const payloadHash = await sha256Hex(canonical);
  // The signature lets a reader who holds this workspace's public key tell a changed packet from the one signed
  // here; the checksum alone only catches accidental damage, since anyone can recompute it.
  const signingKey = workspaceSigningKey(database);
  const packet = {
    ...payload,
    manifest: {
      algorithm: 'sha256',
      payloadHash,
      evidenceArtifacts: evidence.flatMap((item) => item.artifactHashes),
      signature: {
        algorithm: 'ed25519' as const,
        keyId: signingKey.keyId,
        publicKey: signingKey.publicKey,
        value: sign(null, Buffer.from(canonical), signingKey.privateKey).toString('base64'),
      },
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
  workItem: {
    title: string;
    sourceLabel: string;
    claim: string;
    removedAt: string | null;
    removedReason: string | null;
  };
  repository: {
    name: string;
    branch: string | null;
    head: string;
    fingerprint: string | null;
    removedAt: string | null;
    removedReason: string | null;
  } | null;
  contract: { title: string; version: string; criteria: unknown[] } | null;
  checks: Array<{
    label: string;
    executable: string;
    args: string[];
    setupArgs: string[];
    cwdRelative: string;
    toolSha256: string | null;
    retiredAt: string | null;
    retiredReason: string | null;
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
  manifest: { payloadHash: string; signature: { keyId: string } };
}

/**
 * The facts the readable formats show, read from the JSON packet itself so that the three formats cannot drift
 * apart. Every string in it is already sanitized. Each fact sits on one line, except the claim, which is free text
 * under its own heading.
 */
function packetView(packet: PacketViewInput) {
  const removal = (record: { removedAt: string | null; removedReason: string | null } | null) =>
    record?.removedAt ? `${record.removedAt}: ${record.removedReason ?? 'no reason'}` : null;
  const clauses = (packet.contract?.criteria ?? []).map((clause) => {
    const record = (clause ?? {}) as { title?: unknown; required?: unknown };
    return {
      title: sanitizeForPacket(typeof record.title === 'string' ? record.title : 'Untitled clause'),
      required: record.required === true,
    };
  });
  const facts = {
    title: packet.workItem.title,
    source: packet.workItem.sourceLabel,
    removed: removal(packet.workItem),
    repository: packet.repository?.name ?? 'Unlinked',
    repositoryRemoved: removal(packet.repository),
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
      setup:
        check.setupArgs.length > 0
          ? commandLine({ executable: check.executable, args: check.setupArgs })
          : null,
      cwd: check.cwdRelative,
      tool: check.toolSha256 ?? 'not pinned',
      retired: check.retiredAt ? `${check.retiredAt}: ${check.retiredReason ?? 'no reason'}` : null,
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
    keyId: packet.manifest.signature.keyId,
  };
  return { ...(sanitizeDeep(facts, oneLine) as typeof facts), claim: packet.workItem.claim };
}

type PacketView = ReturnType<typeof packetView>;

function renderMarkdown(view: PacketView): string {
  const list = (items: string[], empty: string) => (items.length ? items.join('\n') : empty);
  return `# VeriDone acceptance packet

## ${escapeMarkdown(view.title)}

- Source: ${escapeMarkdown(view.source)}
- Repository: ${escapeMarkdown(view.repository)} (branch ${escapeMarkdown(view.branch)})${view.repositoryRemoved ? `\n- Repository removed: ${escapeMarkdown(view.repositoryRemoved)}` : ''}${view.removed ? `\n- Removed from review: ${escapeMarkdown(view.removed)}` : ''}
- HEAD: ${view.head}
- Fingerprint: ${view.fingerprint}
- Contract: ${escapeMarkdown(view.contract)}
- Verdict: ${view.verdict}
- Privacy mode: strict
- Payload SHA-256: \`${view.payloadHash}\`
- Signed with Ed25519 key: \`${view.keyId}\`

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
      `- **${escapeMarkdown(check.label)}** — \`${escapeMarkdown(check.command)}\` in \`${escapeMarkdown(check.cwd)}\`${check.setup ? `, after setup \`${escapeMarkdown(check.setup)}\`` : ''}; tool SHA-256 ${check.tool}${check.retired ? `; retired ${escapeMarkdown(check.retired)}` : ''}`,
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
<style>body{max-width:780px;margin:48px auto;padding:0 24px;font:16px/1.55 system-ui;color:#171914;background:#f5f4ed;overflow-wrap:anywhere}code{font-family:ui-monospace,monospace;word-break:break-all}.meta{padding:18px 0;border-block:1px solid #bbb}.status{font-weight:700}.hash{word-break:break-all;color:#555}li{margin:8px 0}small{color:#555}</style></head>
<body><small>VERIDONE ACCEPTANCE PACKET · STRICT PRIVACY</small><h1>${escapeHtml(view.title)}</h1>
<div class="meta"><p>Source: ${escapeHtml(view.source)}</p>
<p>Repository: <strong>${escapeHtml(view.repository)}</strong> (branch ${escapeHtml(view.branch)})</p>${view.repositoryRemoved ? `\n<p>Repository removed: ${escapeHtml(view.repositoryRemoved)}</p>` : ''}${view.removed ? `\n<p>Removed from review: ${escapeHtml(view.removed)}</p>` : ''}
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
        `<li><strong>${escapeHtml(check.label)}</strong> — <code>${escapeHtml(check.command)}</code> in <code>${escapeHtml(check.cwd)}</code>${check.setup ? `, after setup <code>${escapeHtml(check.setup)}</code>` : ''}<br><small>Tool SHA-256: ${escapeHtml(check.tool)}</small>${check.retired ? `<br><small>Retired ${escapeHtml(check.retired)}</small>` : ''}</li>`,
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
<h2>Integrity</h2><p>Payload SHA-256: <code class="hash">${view.payloadHash}</code></p>
<p>Signed with Ed25519 key: <code class="hash">${view.keyId}</code></p></body></html>`;
}
