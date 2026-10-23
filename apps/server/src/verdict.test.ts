import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { VeriDoneDatabase } from './database.js';

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function boundWorkItem() {
  const directory = await mkdtemp(path.join(tmpdir(), 'veridone-verdict-'));
  const database = new VeriDoneDatabase(':memory:');
  cleanups.push(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const csrfToken = 'test-token';
  const app = createApp({
    database,
    csrfToken,
    config: {
      host: '127.0.0.1',
      port: 4317,
      dataDirectory: directory,
      databasePath: ':memory:',
      allowedOrigins: ['http://127.0.0.1:4173'],
      demoMode: false,
    },
  });
  const post = async <T>(url: string, body: unknown): Promise<{ status: number; body: T }> => {
    const response = await app.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VeriDone-CSRF': csrfToken },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  };

  const repositoryPath = path.join(directory, 'repository');
  await mkdir(repositoryPath);
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repositoryPath });
  await execFileAsync('git', ['config', 'user.email', 'test@veridone.local'], {
    cwd: repositoryPath,
  });
  await execFileAsync('git', ['config', 'user.name', 'VeriDone Test'], { cwd: repositoryPath });
  await writeFile(path.join(repositoryPath, 'README.md'), '# Fixture\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repositoryPath });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repositoryPath });
  const receiptPath = path.join(directory, 'receipt.json');
  await writeFile(
    receiptPath,
    JSON.stringify({
      schema_version: 1,
      run_id: 'verdict-run',
      source: 'codex',
      title: 'Fix the importer',
      claim: 'The importer is fixed.',
      status: 'complete',
      started_at: '2026-10-22T10:00:00.000Z',
    }),
  );

  await post('/api/v1/roots', { path: directory });
  const { repository } = (
    await post<{ repository: { id: string } }>('/api/v1/repositories', { path: repositoryPath })
  ).body;
  const { imported } = (
    await post<{ imported: Array<{ workItem: { id: string } }> }>('/api/v1/receipts/import', {
      path: receiptPath,
    })
  ).body;
  const workItemId = imported[0]?.workItem.id ?? '';
  await post(`/api/v1/work-items/${workItemId}/link`, { repositoryId: repository.id });
  const { check } = (
    await post<{ check: { id: string } }>('/api/v1/checks', {
      repositoryId: repository.id,
      label: 'Deterministic check',
      kind: 'test',
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("verified")'],
      cwdRelative: '.',
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    })
  ).body;

  return { post, workItemId, checkId: check.id };
}

type VerdictResponse = { verdict: { overrideReason: string | null } };

describe('verdict recording', () => {
  it('records an override reason only when required gates are open', async () => {
    const { post, workItemId, checkId } = await boundWorkItem();

    const overridden = await post<VerdictResponse>(`/api/v1/work-items/${workItemId}/verdicts`, {
      decision: 'accepted',
      note: 'Accepted before the check ran.',
      overrideReason: 'The maintainer reviewed the diff by hand.',
    });
    expect(overridden.status).toBe(201);
    expect(overridden.body.verdict.overrideReason).toBe(
      'The maintainer reviewed the diff by hand.',
    );

    const run = await post<{ readiness: { ready: boolean } }>(`/api/v1/checks/${checkId}/run`, {
      workItemId,
    });
    expect(run.body.readiness.ready).toBe(true);

    const accepted = await post<VerdictResponse>(`/api/v1/work-items/${workItemId}/verdicts`, {
      decision: 'accepted',
      note: 'Accepted with fresh passing evidence.',
      overrideReason: 'Sent by a client that thought the gates were open.',
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.verdict.overrideReason).toBeNull();
  }, 20_000);
});
