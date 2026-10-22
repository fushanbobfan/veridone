import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createApp } from './app.js';
import { VeriDoneDatabase, type VerdictExpectation } from './database.js';

const execFileAsync = promisify(execFile);

export interface ApiResponse<T> {
  status: number;
  body: T;
}

/**
 * A local workspace with one committed repository and one imported receipt whose work item is
 * bound to it. Every request goes through the real API.
 */
export async function boundWorkspace(
  options: { files?: Record<string, string>; runId?: string } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'veridone-fixture-'));
  const database = new VeriDoneDatabase(':memory:');
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
  const post = async <T>(url: string, body: unknown): Promise<ApiResponse<T>> => {
    const response = await app.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VeriDone-CSRF': csrfToken },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  };
  const get = async <T>(url: string): Promise<ApiResponse<T>> => {
    const response = await app.request(url);
    return { status: response.status, body: (await response.json()) as T };
  };

  const repositoryPath = path.join(directory, 'repository');
  await mkdir(repositoryPath);
  const git = (...args: string[]) => execFileAsync('git', args, { cwd: repositoryPath });
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@veridone.local');
  await git('config', 'user.name', 'VeriDone Test');
  for (const [name, content] of Object.entries(options.files ?? { 'README.md': '# Fixture\n' })) {
    await writeFile(path.join(repositoryPath, name), content);
  }
  await git('add', '-A');
  await git('commit', '-m', 'fixture');
  const receiptPath = path.join(directory, 'receipt.json');
  /** Writes the agent's receipt; importing it again reports the claim under the same run. */
  const writeReceipt = (claim = 'The importer is fixed.') =>
    writeFile(
      receiptPath,
      JSON.stringify({
        schema_version: 1,
        run_id: options.runId ?? 'fixture-run',
        source: 'codex',
        title: 'Fix the importer',
        claim,
        status: 'complete',
        started_at: '2026-10-22T10:00:00.000Z',
      }),
    );
  await writeReceipt();

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

  /** Approves a Node check that runs `script` with `node -e`. */
  const approveCheck = async (script: string, label = 'Deterministic check') => {
    const response = await post<{ check: { id: string } }>('/api/v1/checks', {
      repositoryId: repository.id,
      label,
      kind: 'test',
      executable: process.execPath,
      args: ['-e', script],
      cwdRelative: '.',
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    });
    if (response.status !== 201) throw new Error(`Check approval failed: ${response.status}`);
    return response.body.check.id;
  };

  /** The state the review view shows for the work item, which a verdict request expects. */
  const expectedState = async (): Promise<VerdictExpectation> => {
    const { body } = await get<{
      repositories: Array<{ id: string; snapshot: { fingerprint: string } }>;
      workItems: Array<{ id: string; repositoryId: string | null; claimHash: string }>;
      verdicts: Array<{ id: string; workItemId: string; sequence: number }>;
    }>('/api/v1/bootstrap');
    const workItem = body.workItems.find((item) => item.id === workItemId);
    if (!workItem) throw new Error('The work item is missing.');
    const repository = body.repositories.find((item) => item.id === workItem.repositoryId);
    const latest = body.verdicts
      .filter((verdict) => verdict.workItemId === workItemId)
      .sort((left, right) => right.sequence - left.sequence)[0];
    return {
      fingerprint: repository?.snapshot.fingerprint ?? null,
      verdictId: latest?.id ?? null,
      claimHash: workItem.claimHash,
    };
  };

  /** Posts a verdict that expects the state given, or the state the review view shows now. */
  const decide = async <T = unknown>(
    decision: string,
    note: string,
    extra: { overrideReason?: string; expected?: VerdictExpectation } = {},
  ) =>
    post<T>(`/api/v1/work-items/${workItemId}/verdicts`, {
      decision,
      note,
      ...(extra.overrideReason ? { overrideReason: extra.overrideReason } : {}),
      expected: extra.expected ?? (await expectedState()),
    });

  return {
    app,
    database,
    directory,
    repositoryPath,
    repositoryId: repository.id,
    workItemId,
    csrfToken,
    git,
    post,
    get,
    approveCheck,
    writeReceipt,
    importReceipt: () => post('/api/v1/receipts/import', { path: receiptPath }),
    expectedState,
    decide,
    cleanup: async () => {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
