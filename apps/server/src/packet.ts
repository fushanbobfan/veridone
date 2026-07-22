import { canonicalJson, sha256Hex } from '@veridone/core';

import type { VeriDoneDatabase } from './database.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export async function buildAcceptancePacket(database: VeriDoneDatabase, workItemId: string) {
  const workItem = database.getWorkItem(workItemId);
  if (!workItem) throw new Error('The work item does not exist.');
  const repository = workItem.repositoryId ? database.getRepository(workItem.repositoryId) : null;
  const evidence = database.listEvidence(workItemId);
  const verdicts = database.listVerdicts(workItemId);
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workItem,
    repository: repository
      ? {
          id: repository.id,
          name: repository.name,
          branch: repository.snapshot.branch,
          head: repository.snapshot.head,
          fingerprint: repository.snapshot.fingerprint,
          statusEntries: repository.snapshot.statusEntries,
        }
      : null,
    evidence: evidence.map(({ stdout: _stdout, stderr: _stderr, ...item }) => item),
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
  const markdown = `# VeriDone acceptance packet

## ${workItem.title}

- Source: ${workItem.sourceLabel}
- Repository: ${repository?.name ?? 'Unlinked'}
- HEAD: ${repository?.snapshot.head ?? 'Unbound'}
- Verdict: ${latestVerdict?.decision ?? 'No human verdict'}
- Evidence items: ${evidence.length}
- Payload SHA-256: \`${payloadHash}\`

### Claim

${workItem.claim}

### Evidence

${evidence.length === 0 ? '_No executable evidence captured._' : evidence.map((item) => `- **${item.label}** — ${item.result} (${item.durationMs} ms)`).join('\n')}

### Verdict history

${verdicts.length === 0 ? '_No human verdict recorded._' : verdicts.map((item) => `- **${item.decision}** — ${item.note || 'No note'} (${item.decidedAt})`).join('\n')}
`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>VeriDone packet — ${escapeHtml(workItem.title)}</title>
<style>body{max-width:780px;margin:48px auto;padding:0 24px;font:16px/1.55 system-ui;color:#171914;background:#f5f4ed}code{font-family:ui-monospace,monospace}.meta{padding:18px 0;border-block:1px solid #bbb}.status{font-weight:700}.hash{word-break:break-all;color:#555}li{margin:8px 0}</style></head>
<body><small>VERIDONE ACCEPTANCE PACKET</small><h1>${escapeHtml(workItem.title)}</h1>
<div class="meta"><p>Repository: <strong>${escapeHtml(repository?.name ?? 'Unlinked')}</strong></p>
<p>Verdict: <span class="status">${escapeHtml(latestVerdict?.decision ?? 'No human verdict')}</span></p></div>
<h2>Claim</h2><p>${escapeHtml(workItem.claim)}</p><h2>Evidence</h2><ul>
${evidence.map((item) => `<li><strong>${escapeHtml(item.label)}</strong> — ${escapeHtml(item.result)} (${item.durationMs} ms)</li>`).join('') || '<li>No executable evidence captured.</li>'}
</ul><h2>Integrity</h2><p class="hash"><code>${payloadHash}</code></p></body></html>`;

  return { packet, json, markdown, html };
}
