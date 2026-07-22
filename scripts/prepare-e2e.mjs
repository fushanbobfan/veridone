import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(repositoryRoot, 'output');
const targets = [path.join(outputRoot, 'e2e-runtime'), path.join(outputRoot, 'e2e-fixture')];

for (const target of targets) {
  const relative = path.relative(repositoryRoot, target);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !relative.startsWith(`output${path.sep}`)
  ) {
    throw new Error(
      `Refusing to clear an E2E path outside the repository output directory: ${target}`,
    );
  }
  await rm(target, { recursive: true, force: true });
}

await mkdir(outputRoot, { recursive: true });
