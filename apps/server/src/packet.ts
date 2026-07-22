import { canonicalJson, sha256Hex } from '@veridone/core';

import type { EvidenceRecord, VeriDoneDatabase } from './database.js';

const secretAssignment =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]\s*[^\s,;]+/giu;
const tokenValue = /\b(gh[oprsu]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/gu;
const windowsPath = /\b[A-Za-z]:\\(?:[^\\\s<>:"|?*]+\\)*[^\\\s<>:"|?*]*/gu;
const privatePosixPath = /\/(?:Users|home|var|tmp|opt|etc)\/(?:[^\s<>'"]+)/gu;

export function sanitizeForPacket(value: string): string {
  return value
    .replace(secretAssignment, '$1=[REDACTED]')
    .replace(tokenValue, '[REDACTED]')
    .replace(windowsPath, '[LOCAL_PATH]')
    .replace(privatePosixPath, '[LOCAL_PATH]');
}

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

function publicEvidence(evidence: EvidenceRecord[]) {
  return evidence.map(({ stdout: _stdout, stderr: _stderr, ...item }) => ({
    ...item,
    label: sanitizeForPacket(item.label),
    toolVersion: item.toolVersion ? sanitizeForPacket(item.toolVersion) : null,
    invalidReason: item.invalidReason ? sanitizeForPacket(item.invalidReason) : null,
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
  if (packet.schemaVersion !== 1 || packet.application !== 'veridone') {
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
  const contract = database.listContracts()[0] ?? null;
  const workItem = {
    ...rawWorkItem,
    claim: sanitizeForPacket(rawWorkItem.claim),
    sourceLabel: sanitizeForPacket(rawWorkItem.sourceLabel),
    sourceRef: sanitizeForPacket(rawWorkItem.sourceRef),
  };
  const evidence = publicEvidence(rawEvidence);
  const verdicts = rawVerdicts.map((verdict) => ({
    ...verdict,
    note: sanitizeForPacket(verdict.note),
    overrideReason: verdict.overrideReason ? sanitizeForPacket(verdict.overrideReason) : null,
  }));
  const payload = {
    schemaVersion: 1,
    application: 'veridone',
    privacyMode: 'strict',
    generatedAt,
    workItem,
    repository: repository
      ? {
          id: repository.id,
          name: sanitizeForPacket(repository.name),
          branch: repository.snapshot.branch,
          head: repository.snapshot.head,
          fingerprint: repository.snapshot.fingerprint,
          worktreeHash: repository.snapshot.worktreeHash,
          diffStats: repository.snapshot.diffStats,
          statusEntries: repository.snapshot.statusEntries.map(sanitizeForPacket),
        }
      : null,
    contract,
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
  const latestVerdict = verdicts[0];
  const evidenceMarkdown =
    evidence.length === 0
      ? '_No executable evidence captured._'
      : evidence
          .map(
            (item) =>
              `- **${escapeMarkdown(item.label)}** — ${item.result}; exit ${item.exitCode ?? 'n/a'}; ${item.durationMs} ms; tool ${escapeMarkdown(item.toolVersion ?? 'not captured')}; artifacts ${item.artifactHashes.join(', ') || 'none'}`,
          )
          .join('\n');
  const verdictMarkdown =
    verdicts.length === 0
      ? '_No human verdict recorded._'
      : verdicts
          .map(
            (item) =>
              `- **${item.decision}** — ${escapeMarkdown(item.note || 'No note')} (${item.decidedAt})${item.overrideReason ? `; override: ${escapeMarkdown(item.overrideReason)}` : ''}`,
          )
          .join('\n');
  const markdown = `# VeriDone acceptance packet

## ${escapeMarkdown(workItem.title)}

- Source: ${escapeMarkdown(workItem.sourceLabel)}
- Repository: ${escapeMarkdown(repository?.name ?? 'Unlinked')}
- HEAD: ${repository?.snapshot.head ?? 'Unbound'}
- Fingerprint: ${repository?.snapshot.fingerprint ?? 'Unbound'}
- Contract: ${escapeMarkdown(contract?.title ?? 'No contract')} (${contract?.version ?? 'n/a'})
- Verdict: ${latestVerdict?.decision ?? 'No human verdict'}
- Evidence items: ${evidence.length}
- Privacy mode: strict
- Payload SHA-256: \`${payloadHash}\`

### Claim

${escapeMarkdown(workItem.claim)}

### Evidence

${evidenceMarkdown}

### Verdict history

${verdictMarkdown}
`;
  const evidenceHtml =
    evidence
      .map(
        (item) =>
          `<li><strong>${escapeHtml(item.label)}</strong> — ${escapeHtml(item.result)}; exit ${item.exitCode ?? 'n/a'}; ${item.durationMs} ms; tool ${escapeHtml(item.toolVersion ?? 'not captured')}<br><small>Artifacts: ${escapeHtml(item.artifactHashes.join(', ') || 'none')}</small></li>`,
      )
      .join('') || '<li>No executable evidence captured.</li>';
  const verdictHtml =
    verdicts
      .map(
        (item) =>
          `<li><strong>${escapeHtml(item.decision)}</strong> — ${escapeHtml(item.note || 'No note')} (${escapeHtml(item.decidedAt)})${item.overrideReason ? `<br><small>Override: ${escapeHtml(item.overrideReason)}</small>` : ''}</li>`,
      )
      .join('') || '<li>No human verdict recorded.</li>';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>VeriDone packet — ${escapeHtml(workItem.title)}</title>
<style>body{max-width:780px;margin:48px auto;padding:0 24px;font:16px/1.55 system-ui;color:#171914;background:#f5f4ed}code{font-family:ui-monospace,monospace}.meta{padding:18px 0;border-block:1px solid #bbb}.status{font-weight:700}.hash{word-break:break-all;color:#555}li{margin:8px 0}small{color:#555}</style></head>
<body><small>VERIDONE ACCEPTANCE PACKET · STRICT PRIVACY</small><h1>${escapeHtml(workItem.title)}</h1>
<div class="meta"><p>Repository: <strong>${escapeHtml(repository?.name ?? 'Unlinked')}</strong></p>
<p>HEAD: <code>${escapeHtml(repository?.snapshot.head ?? 'Unbound')}</code></p>
<p>Contract: ${escapeHtml(contract?.title ?? 'No contract')} (${escapeHtml(contract?.version ?? 'n/a')})</p>
<p>Verdict: <span class="status">${escapeHtml(latestVerdict?.decision ?? 'No human verdict')}</span></p></div>
<h2>Claim</h2><p>${escapeHtml(workItem.claim)}</p><h2>Evidence</h2><ul>${evidenceHtml}</ul>
<h2>Verdict history</h2><ul>${verdictHtml}</ul>
<h2>Integrity</h2><p class="hash"><code>${payloadHash}</code></p></body></html>`;

  return { packet, json, markdown, html };
}
