import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { ServerConfig } from './config.js';
import { VeriDoneDatabase } from './database.js';

const temporaryDirectories: string[] = [];
const databases: VeriDoneDatabase[] = [];
const execFileAsync = promisify(execFile);

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'veridone-server-'));
  temporaryDirectories.push(directory);
  const database = new VeriDoneDatabase(':memory:');
  databases.push(database);
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 4317,
    dataDirectory: directory,
    databasePath: ':memory:',
    allowedOrigins: ['http://127.0.0.1:4173'],
    demoMode: false,
  };
  const csrfToken = 'test-token';
  return { directory, database, csrfToken, app: createApp({ database, config, csrfToken }) };
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('local API security and persistence', () => {
  it('rejects untrusted browser origins', async () => {
    const { app } = await fixture();
    const response = await app.request('/api/v1/bootstrap', {
      headers: { Origin: 'https://hostile.example' },
    });
    expect(response.status).toBe(403);
  });

  it('requires a per-process token for mutations', async () => {
    const { app, directory } = await fixture();
    const response = await app.request('/api/v1/roots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4173' },
      body: JSON.stringify({ path: directory }),
    });
    expect(response.status).toBe(403);
  });

  it('persists an approved root and returns it from bootstrap', async () => {
    const { app, directory, csrfToken } = await fixture();
    const created = await app.request('/api/v1/roots', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VeriDone-CSRF': csrfToken,
        Origin: 'http://127.0.0.1:4173',
      },
      body: JSON.stringify({ path: directory, label: 'Fixture root' }),
    });
    expect(created.status).toBe(201);

    const bootstrap = await app.request('/api/v1/bootstrap', {
      headers: { Origin: 'http://127.0.0.1:4173' },
    });
    const body = (await bootstrap.json()) as { roots: Array<{ label: string }> };
    expect(body.roots).toEqual([expect.objectContaining({ label: 'Fixture root' })]);
  });

  it('runs an approved check, records a verdict, and exports a verified packet', async () => {
    const { app, directory, csrfToken } = await fixture();
    const repositoryPath = path.join(directory, 'repository');
    await mkdir(repositoryPath);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repositoryPath });
    await execFileAsync('git', ['config', 'user.email', 'test@veridone.local'], {
      cwd: repositoryPath,
    });
    await execFileAsync('git', ['config', 'user.name', 'VeriDone Test'], {
      cwd: repositoryPath,
    });
    await writeFile(path.join(repositoryPath, 'README.md'), '# Fixture\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repositoryPath });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repositoryPath });
    const receiptPath = path.join(directory, 'receipt.json');
    await writeFile(
      receiptPath,
      JSON.stringify({
        schema_version: 1,
        run_id: 'e2e-run',
        started_at: '2026-07-21T20:00:00.000Z',
        status: 'complete',
        task: { type: 'review' },
        stages: [{ name: 'strong', status: 'completed' }],
      }),
    );
    const headers = {
      'Content-Type': 'application/json',
      'X-VeriDone-CSRF': csrfToken,
      Origin: 'http://127.0.0.1:4173',
    };

    await app.request('/api/v1/roots', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: directory, label: 'Fixture' }),
    });
    await app.request('/api/v1/repositories', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: repositoryPath }),
    });
    await app.request('/api/v1/receipts/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: receiptPath }),
    });
    const bootstrapResponse = await app.request('/api/v1/bootstrap', {
      headers: { Origin: 'http://127.0.0.1:4173' },
    });
    const bootstrap = (await bootstrapResponse.json()) as {
      repositories: Array<{ id: string }>;
      workItems: Array<{ id: string }>;
    };
    const repositoryId = bootstrap.repositories[0]?.id;
    const workItemId = bootstrap.workItems[0]?.id;
    expect(repositoryId).toBeTruthy();
    expect(workItemId).toBeTruthy();

    await app.request(`/api/v1/work-items/${workItemId}/link`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ repositoryId }),
    });
    const checkResponse = await app.request('/api/v1/checks', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        repositoryId,
        label: 'Deterministic smoke check',
        kind: 'test',
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("verified")'],
        cwdRelative: '.',
        timeoutMs: 5_000,
        maxOutputBytes: 10_000,
      }),
    });
    expect(checkResponse.status).toBe(201);
    const check = (await checkResponse.json()) as { check: { id: string } };
    const runResponse = await app.request(`/api/v1/checks/${check.check.id}/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workItemId }),
    });
    const run = (await runResponse.json()) as {
      evidence: { result: string; stdout: string };
      readiness: { ready: boolean };
    };
    expect(run).toMatchObject({
      evidence: { result: 'passed', stdout: 'verified' },
      readiness: { ready: true },
    });

    const verdictResponse = await app.request(`/api/v1/work-items/${workItemId}/verdicts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ decision: 'accepted', note: 'Reviewed against current evidence.' }),
    });
    expect(verdictResponse.status).toBe(201);
    const packetResponse = await app.request(`/api/v1/work-items/${workItemId}/packet/json`, {
      headers: { Origin: 'http://127.0.0.1:4173' },
    });
    const packet = (await packetResponse.json()) as {
      manifest: { algorithm: string; payloadHash: string };
      verdicts: Array<{ decision: string }>;
    };
    expect(packet.manifest.algorithm).toBe('sha256');
    expect(packet.manifest.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(packet.verdicts[0]?.decision).toBe('accepted');
  }, 20_000);
});
