import { existsSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256File } from '@veridone/adapters';
import { afterEach, describe, expect, it } from 'vitest';

import { checkDefinitionHash } from './check-policy.js';
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

/** Reviews the file that pinning would record, then pins exactly that file. */
async function pinReviewedTool(fixture: Awaited<ReturnType<typeof workspace>>, checkId: string) {
  const reviewed = await fixture.get<{ tool: { path: string; sha256: string } }>(
    `/api/v1/checks/${checkId}/tool`,
  );
  return fixture.post<{ check: { executableSha256: string } }>(`/api/v1/checks/${checkId}/pin`, {
    expected: reviewed.body.tool,
  });
}

interface RunResponse {
  evidence: {
    result: string;
    stdout: string;
    isolation: string | null;
    invalidReason: string | null;
    toolPath: string | null;
    toolSha256: string | null;
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
    await writeFile(path.join(fixture.repositoryPath, 'README.md'), '# Edited after the commit\n');
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

  it('catches a check that commits its own edit inside the checkout', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck(
      "require('node:fs').writeFileSync('README.md', 'changed\\n'); require('node:child_process').execFileSync('git', ['-c', 'user.name=Check', '-c', 'user.email=check@veridone.local', 'commit', '-qam', 'edit']);",
    );

    const run = await fixture.post<RunResponse>(`/api/v1/checks/${checkId}/run`, {
      workItemId: fixture.workItemId,
    });

    expect(run.body.evidence.result).toBe('mutated');
    expect(run.body.evidence.invalidReason).toMatch(/moved its checkout/u);
  }, 30_000);

  it('catches an edit that the check hides from the checkout index', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck(
      "require('node:fs').writeFileSync('README.md', 'changed\\n'); require('node:child_process').execFileSync('git', ['update-index', '--skip-worktree', 'README.md']);",
    );

    const run = await fixture.post<RunResponse>(`/api/v1/checks/${checkId}/run`, {
      workItemId: fixture.workItemId,
    });

    expect(run.body.evidence.result).toBe('mutated');
    expect(run.body.evidence.invalidReason).toContain('README.md');
  }, 30_000);

  it('records a check that leaves its checkout unreadable as mutated', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck(
      "require('node:fs').writeFileSync('.git/config', '[broken');",
    );

    const run = await fixture.post<RunResponse>(`/api/v1/checks/${checkId}/run`, {
      workItemId: fixture.workItemId,
    });

    expect(run.status).toBe(200);
    expect(run.body.evidence.result).toBe('mutated');
    expect(run.body.evidence.invalidReason).toMatch(/could not be compared/u);
  }, 30_000);

  it('gives the check absolute PATH entries only', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck(
      'process.stdout.write(JSON.stringify({ path: process.env.PATH ?? "", noCurrentDirectory: process.env.NoDefaultCurrentDirectoryInExePath ?? null }))',
    );

    const run = await fixture.post<RunResponse>(`/api/v1/checks/${checkId}/run`, {
      workItemId: fixture.workItemId,
    });

    const observed = JSON.parse(run.body.evidence.stdout) as {
      path: string;
      noCurrentDirectory: string | null;
    };
    const entries = observed.path.split(path.delimiter).filter(Boolean);
    expect(entries.every((entry) => path.isAbsolute(entry))).toBe(true);
    expect(observed.noCurrentDirectory).toBe(process.platform === 'win32' ? '1' : null);
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

describe('check tools are pinned', () => {
  it('pins the tool by canonical path and SHA-256 and records it with each result', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck('process.exit(0)');
    const tool = await realpath(process.execPath);
    const sha256 = await sha256File(tool);

    expect(fixture.database.getCheck(checkId)).toMatchObject({
      resolvedExecutable: tool,
      executableSha256: sha256,
    });
    const run = await fixture.post<RunResponse>(`/api/v1/checks/${checkId}/run`, {
      workItemId: fixture.workItemId,
    });
    expect(run.body.evidence).toMatchObject({
      result: 'passed',
      toolPath: tool,
      toolSha256: sha256,
    });
  }, 30_000);

  it('includes the pinned tool in the check definition', async () => {
    const definition = {
      repositoryId: 'repository',
      label: 'Tests',
      kind: 'test',
      executable: 'node',
      args: ['--test'],
      versionArgs: ['--version'],
      scopePaths: [],
      cwdRelative: '.',
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      resolvedExecutable: '/usr/bin/node',
      executableSha256: 'a'.repeat(64),
    };

    expect(await checkDefinitionHash(definition)).not.toBe(
      await checkDefinitionHash({ ...definition, executableSha256: 'b'.repeat(64) }),
    );
  });

  it('refuses a tool whose content no longer matches its pin until it is pinned again', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck('process.exit(0)');
    // Stands in for the tool file changing after approval: the pin and the file now differ.
    fixture.database.connection
      .prepare('UPDATE checks SET executable_sha256 = ? WHERE id = ?')
      .run('0'.repeat(64), checkId);

    const refused = await fixture.post<{ message: string }>(`/api/v1/checks/${checkId}/run`, {
      workItemId: fixture.workItemId,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/changed since it was approved/u);
    expect(fixture.database.listEvidence(fixture.workItemId)).toEqual([]);

    const pinned = await pinReviewedTool(fixture, checkId);
    expect(pinned.status).toBe(200);
    expect(pinned.body.check.executableSha256).toBe(await sha256File(process.execPath));
    const run = await fixture.post<RunResponse>(`/api/v1/checks/${checkId}/run`, {
      workItemId: fixture.workItemId,
    });
    expect(run.body.evidence.result).toBe('passed');
  }, 30_000);

  it('requires a check approved before tools were pinned to be pinned before it runs', async () => {
    const fixture = await workspace();
    const legacy = fixture.database.addCheck({
      repositoryId: fixture.repositoryId,
      label: 'Legacy check',
      kind: 'test',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      versionArgs: ['--version'],
      scopePaths: [],
      cwdRelative: '.',
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
      resolvedExecutable: null,
      executableSha256: null,
      definitionHash: 'a'.repeat(64),
    });
    await fixture.get('/api/v1/bootstrap');

    const refused = await fixture.post<{ message: string }>(`/api/v1/checks/${legacy.id}/run`, {
      workItemId: fixture.workItemId,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/approved before VeriDone pinned tools/u);

    expect((await pinReviewedTool(fixture, legacy.id)).status).toBe(200);
    const run = await fixture.post<RunResponse>(`/api/v1/checks/${legacy.id}/run`, {
      workItemId: fixture.workItemId,
    });
    expect(run.body).toMatchObject({ evidence: { result: 'passed' }, readiness: { ready: true } });
  }, 30_000);

  it('pins only the tool file the operator reviewed', async () => {
    const fixture = await workspace();
    const checkId = await fixture.approveCheck('process.exit(0)');
    const before = fixture.database.getCheck(checkId);
    const reviewed = await fixture.get<{ tool: { path: string; sha256: string } }>(
      `/api/v1/checks/${checkId}/tool`,
    );
    expect(reviewed.body.tool).toEqual({
      path: await realpath(process.execPath),
      sha256: await sha256File(process.execPath),
    });

    const refused = await fixture.post<{ error: string }>(`/api/v1/checks/${checkId}/pin`, {
      expected: { ...reviewed.body.tool, sha256: '0'.repeat(64) },
    });

    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('tool_changed');
    expect(fixture.database.getCheck(checkId)).toEqual(before);
  }, 30_000);

  it('treats a scope of ./ as no declared scope', async () => {
    const fixture = await workspace();

    const response = await fixture.post<{ check: { scopePaths: string[] } }>('/api/v1/checks', {
      repositoryId: fixture.repositoryId,
      label: 'Scoped check',
      kind: 'test',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      scopePaths: ['./', 'src/', '/'],
      cwdRelative: '.',
    });

    expect(response.status).toBe(201);
    expect(response.body.check.scopePaths).toEqual(['src']);
  }, 30_000);

  it('rejects a tool named by a relative path at approval', async () => {
    const fixture = await workspace();

    const response = await fixture.post<{ message: string }>('/api/v1/checks', {
      repositoryId: fixture.repositoryId,
      label: 'Repository script',
      kind: 'test',
      executable: './scripts/test.mjs',
      args: [],
      cwdRelative: '.',
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/relative paths are not pinned/u);
  }, 30_000);
});
