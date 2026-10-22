import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acceptanceReadiness } from './check-runner.js';
import { boundWorkspace } from './test-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function workspace(files?: Record<string, string>) {
  const fixture = await boundWorkspace(files ? { files } : {});
  cleanups.push(fixture.cleanup);
  return fixture;
}

interface RunResponse {
  evidence: {
    result: string;
    stdout: string;
    isolation: string | null;
    invalidReason: string | null;
  };
  readiness: { ready: boolean };
}

describe('checks run in a clean checkout', () => {
  it('runs an approved check in a fresh checkout of the bound commit', async () => {
    const fixture = await workspace({ 'README.md': '# Fixture\n', '.gitignore': 'ignored.txt\n' });
    await writeFile(path.join(fixture.repositoryPath, 'ignored.txt'), 'state outside the commit\n');
    const checkId = await fixture.approveCheck(
      "const fs = require('node:fs'); process.stdout.write(JSON.stringify({ cwd: process.cwd(), ignored: fs.existsSync('ignored.txt'), readme: fs.readFileSync('README.md', 'utf8') }))",
    );

    const run = await fixture.post<RunResponse>(`/api/v1/checks/${checkId}/run`, {
      workItemId: fixture.workItemId,
    });

    expect(run.status).toBe(200);
    expect(run.body.evidence).toMatchObject({ result: 'passed', isolation: 'clean-checkout' });
    expect(run.body.readiness.ready).toBe(true);
    const observed = JSON.parse(run.body.evidence.stdout) as {
      cwd: string;
      ignored: boolean;
      readme: string;
    };
    expect(observed.ignored).toBe(false);
    expect(observed.readme).toBe('# Fixture\n');
    expect(path.relative(fixture.repositoryPath, observed.cwd).startsWith('..')).toBe(true);
    expect(existsSync(observed.cwd)).toBe(false);
  }, 30_000);

  it('refuses to run checks while the repository has uncommitted changes', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck('process.exit(0)');
    await writeFile(path.join(fixture.repositoryPath, 'README.md'), '# Edited, not committed\n');
    await fixture.post(`/api/v1/repositories/${fixture.repositoryId}/refresh`, {});
    await fixture.post(`/api/v1/work-items/${fixture.workItemId}/link`, {
      repositoryId: fixture.repositoryId,
    });

    const run = await fixture.post<{ message: string }>(`/api/v1/checks/${checkId}/run`, {
      workItemId: fixture.workItemId,
    });

    expect(run.status).toBe(400);
    expect(run.body.message).toMatch(/uncommitted changes/u);
  }, 30_000);

  it('marks a check that edits its checkout as mutated and leaves the repository alone', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck(
      "require('node:fs').writeFileSync('README.md', 'changed by the check\\n')",
    );

    const run = await fixture.post<RunResponse>(`/api/v1/checks/${checkId}/run`, {
      workItemId: fixture.workItemId,
    });

    expect(run.body.evidence).toMatchObject({ result: 'mutated', isolation: 'clean-checkout' });
    expect(run.body.evidence.invalidReason).toContain('README.md');
    expect(run.body.readiness.ready).toBe(false);
    await expect(readFile(path.join(fixture.repositoryPath, 'README.md'), 'utf8')).resolves.toBe(
      '# Fixture\n',
    );
  }, 30_000);

  it('does not count passing evidence that ran outside a clean checkout', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck('process.exit(0)');
    await fixture.post(`/api/v1/checks/${checkId}/run`, { workItemId: fixture.workItemId });
    expect(acceptanceReadiness(fixture.database, fixture.workItemId).ready).toBe(true);

    const [latest] = fixture.database.listEvidence(fixture.workItemId);
    if (!latest) throw new Error('The check recorded no evidence.');
    const { id: _id, ...recorded } = latest;
    fixture.database.recordEvidence({
      ...recorded,
      completedAt: new Date(Date.parse(latest.completedAt) + 1_000).toISOString(),
      isolation: null,
    });

    expect(acceptanceReadiness(fixture.database, fixture.workItemId).ready).toBe(false);
  }, 30_000);
});
