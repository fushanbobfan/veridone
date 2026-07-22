import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const skippedDirectories = new Set(['.git', '.veridone', 'dist', 'node_modules', 'output']);
const skippedFiles = new Set(['pnpm-lock.yaml', 'secret-scan.mjs']);
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['GitHub token', /\b(?:gh[oprsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/u],
  ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/u],
  ['Google API key', /\bAIza[A-Za-z0-9_-]{35}\b/u],
];
const findings = [];

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(absolute);
      continue;
    }
    if (!entry.isFile() || skippedFiles.has(entry.name)) continue;
    let content;
    try {
      content = await readFile(absolute, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) continue;
    for (const [label, pattern] of patterns) {
      if (pattern.test(content)) findings.push(`${path.relative(root, absolute)}: ${label}`);
    }
  }
}

await scan(root);
if (findings.length > 0) {
  process.stderr.write(`Potential secrets found:\n- ${findings.join('\n- ')}\n`);
  process.exit(1);
}
process.stdout.write('No high-confidence secret patterns found.\n');
