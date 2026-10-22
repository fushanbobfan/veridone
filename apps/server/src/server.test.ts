import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { ServerConfig } from './config.js';
import { VeriDoneDatabase } from './database.js';
import { verifyAcceptancePacket } from './packet.js';

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
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });

  it('rejects oversized workspace bodies before parsing', async () => {
    const { app, csrfToken } = await fixture();
    const response = await app.request('/api/v1/workspace/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '25000001',
        'X-VeriDone-CSRF': csrfToken,
        Origin: 'http://127.0.0.1:4173',
      },
      body: '{}',
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'workspace_too_large' });
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

  it('imports receipt directories atomically after every file validates', async () => {
    const { app, directory, csrfToken } = await fixture();
    const receiptDirectory = path.join(directory, 'receipts');
    await mkdir(receiptDirectory);
    const firstReceipt = path.join(receiptDirectory, '01-codex.json');
    const secondReceipt = path.join(receiptDirectory, '02-ci.json');
    await writeFile(
      firstReceipt,
      JSON.stringify({
        schema_version: 1,
        run_id: 'batch-codex',
        source: 'codex',
        title: 'Implement the batch importer',
        claim: 'Implemented and tested an atomic receipt-directory import.',
        status: 'complete',
        started_at: '2026-07-21T20:00:00.000Z',
      }),
    );
    await writeFile(secondReceipt, '{ invalid json');
    const headers = {
      'Content-Type': 'application/json',
      'X-VeriDone-CSRF': csrfToken,
      Origin: 'http://127.0.0.1:4173',
    };
    await app.request('/api/v1/roots', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: directory, label: 'Batch fixture' }),
    });

    const rejected = await app.request('/api/v1/receipts/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: receiptDirectory }),
    });
    expect(rejected.status).toBe(400);
    let bootstrap = (await (
      await app.request('/api/v1/bootstrap', {
        headers: { Origin: 'http://127.0.0.1:4173' },
      })
    ).json()) as { receipts: unknown[]; workItems: unknown[] };
    expect(bootstrap.receipts).toHaveLength(0);
    expect(bootstrap.workItems).toHaveLength(0);

    await writeFile(
      secondReceipt,
      JSON.stringify({
        schema_version: 1,
        run_id: 'batch-ci',
        source: 'ci',
        title: 'Exercise the importer',
        claim: 'Verified the atomic import boundary.',
        status: 'passed',
        started_at: '2026-07-21T20:01:00.000Z',
      }),
    );
    const imported = await app.request('/api/v1/receipts/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: receiptDirectory }),
    });
    expect(imported.status).toBe(201);
    await expect(imported.json()).resolves.toMatchObject({ imported: [{}, {}] });
    bootstrap = (await (
      await app.request('/api/v1/bootstrap', {
        headers: { Origin: 'http://127.0.0.1:4173' },
      })
    ).json()) as { receipts: unknown[]; workItems: unknown[] };
    expect(bootstrap.receipts).toHaveLength(2);
    expect(bootstrap.workItems).toHaveLength(2);
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
        started_at: '2026-07-21T13:00:00.1234567-07:00',
        completed_at: '2026-07-21T13:00:01.7654321-07:00',
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
    /** The state the review view shows, which every verdict request expects. */
    const expected = async () => {
      const current = (await (
        await app.request('/api/v1/bootstrap', { headers: { Origin: 'http://127.0.0.1:4173' } })
      ).json()) as {
        repositories: Array<{ snapshot: { fingerprint: string } }>;
        workItems: Array<{ id: string; claimHash: string }>;
        verdicts: Array<{ id: string; sequence: number }>;
      };
      const latest = [...current.verdicts].sort((left, right) => right.sequence - left.sequence)[0];
      return {
        fingerprint: current.repositories[0]?.snapshot.fingerprint ?? null,
        verdictId: latest?.id ?? null,
        claimHash: current.workItems.find((item) => item.id === workItemId)?.claimHash ?? '',
      };
    };
    const lockedAcceptance = await app.request(`/api/v1/work-items/${workItemId}/verdicts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        decision: 'accepted',
        note: 'Attempted without passing evidence.',
        expected: await expected(),
      }),
    });
    expect(lockedAcceptance.status).toBe(409);
    const overrideAcceptance = await app.request(`/api/v1/work-items/${workItemId}/verdicts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        decision: 'accepted',
        note: 'Fixture override decision.',
        overrideReason: 'Explicitly testing the audited override path.',
        expected: await expected(),
      }),
    });
    expect(overrideAcceptance.status).toBe(201);
    for (const decision of ['changes-requested', 'rejected'] as const) {
      const response = await app.request(`/api/v1/work-items/${workItemId}/verdicts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          decision,
          note: `Fixture ${decision} decision.`,
          expected: await expected(),
        }),
      });
      expect(response.status).toBe(201);
    }
    const runResponse = await app.request(`/api/v1/checks/${check.check.id}/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workItemId }),
    });
    const run = (await runResponse.json()) as {
      evidence: {
        result: string;
        stdout: string;
        toolVersion: string | null;
        exitCode: number | null;
      };
      readiness: { ready: boolean };
    };
    expect(run).toMatchObject({
      evidence: {
        result: 'passed',
        stdout: 'verified',
        toolVersion: expect.stringMatching(/^v?\d+/u),
        exitCode: 0,
      },
      readiness: { ready: true },
    });

    const verdictResponse = await app.request(`/api/v1/work-items/${workItemId}/verdicts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        decision: 'accepted',
        note: `Reviewed at ${directory}; password=hunter2.`,
        expected: await expected(),
      }),
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
    expect(JSON.stringify(packet)).not.toContain(directory);
    expect(JSON.stringify(packet)).not.toContain('hunter2');
    expect(JSON.stringify(packet)).toContain('[REDACTED]');
    expect(await verifyAcceptancePacket(packet)).toMatchObject({ valid: true, issues: [] });
    const tamperedPacket = structuredClone(packet) as { workItem?: { title?: string } };
    if (tamperedPacket.workItem) tamperedPacket.workItem.title = 'Tampered packet';
    expect(await verifyAcceptancePacket(tamperedPacket)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining(['Payload hash does not match the manifest.']),
    });

    for (const format of ['md', 'html'] as const) {
      const response = await app.request(`/api/v1/work-items/${workItemId}/packet/${format}`, {
        headers: { Origin: 'http://127.0.0.1:4173' },
      });
      const exported = await response.text();
      expect(exported).toContain('Deterministic smoke check');
      expect(exported).toContain('accepted');
      expect(exported).toContain(packet.manifest.payloadHash);
      expect(exported).not.toContain(directory);
      expect(exported).not.toContain('hunter2');
    }

    const workspaceResponse = await app.request('/api/v1/workspace/export', {
      headers: { Origin: 'http://127.0.0.1:4173' },
    });
    const workspace = (await workspaceResponse.json()) as Record<string, unknown>;
    const restored = await fixture();
    const restoreResponse = await restored.app.request('/api/v1/workspace/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VeriDone-CSRF': restored.csrfToken,
        Origin: 'http://127.0.0.1:4173',
      },
      body: JSON.stringify(workspace),
    });
    expect(restoreResponse.status).toBe(201);
    const restoredBootstrapResponse = await restored.app.request('/api/v1/bootstrap', {
      headers: { Origin: 'http://127.0.0.1:4173' },
    });
    const restoredBootstrap = (await restoredBootstrapResponse.json()) as {
      roots: unknown[];
      repositories: unknown[];
      receipts: unknown[];
      workItems: unknown[];
      checks: unknown[];
      evidence: unknown[];
      verdicts: unknown[];
    };
    expect(restoredBootstrap.roots.length).toBeGreaterThan(0);
    expect(restoredBootstrap.repositories.length).toBeGreaterThan(0);
    expect(restoredBootstrap.receipts.length).toBeGreaterThan(0);
    expect(restoredBootstrap.workItems.length).toBeGreaterThan(0);
    expect(restoredBootstrap.checks.length).toBeGreaterThan(0);
    expect(restoredBootstrap.evidence.length).toBeGreaterThan(0);
    expect(restoredBootstrap.verdicts).toHaveLength(4);

    const tampered = structuredClone(workspace) as {
      data: { workItems: Array<{ title: string }> };
    };
    if (tampered.data.workItems[0]) tampered.data.workItems[0].title = 'Tampered title';
    const tamperedResponse = await restored.app.request('/api/v1/workspace/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VeriDone-CSRF': restored.csrfToken,
        Origin: 'http://127.0.0.1:4173',
      },
      body: JSON.stringify(tampered),
    });
    expect(tamperedResponse.status).toBe(400);
  }, 60_000);
});
