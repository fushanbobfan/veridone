import { spawnSync } from 'node:child_process';

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('Run this check through pnpm so the pinned CLI can be located.');

const result = spawnSync(process.execPath, [pnpmCli, 'licenses', 'list', '--prod', '--json'], {
  encoding: 'utf8',
  shell: false,
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || 'Could not enumerate production dependency licenses.\n');
  process.exit(result.status ?? 1);
}

const licenses = JSON.parse(result.stdout);
const allowed = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'OFL-1.1',
]);
const rejected = Object.keys(licenses).filter((license) => !allowed.has(license));
if (rejected.length > 0) {
  process.stderr.write(`Disallowed or unreviewed production licenses: ${rejected.join(', ')}\n`);
  process.exit(1);
}

const packageCount = Object.values(licenses).reduce(
  (count, entries) => count + (Array.isArray(entries) ? entries.length : 0),
  0,
);
process.stdout.write(
  `Verified ${packageCount} production packages across ${Object.keys(licenses).length} approved licenses.\n`,
);
