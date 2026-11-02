import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { VeriDoneDatabase } from './database.js';
import { buildAcceptancePacket, verifyAcceptancePacket } from './packet.js';
import { boundWorkspace } from './test-fixtures.js';
import { exportWorkspace } from './workspace.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('acceptance packets', () => {
  it('sanitizes the title and the branch in the JSON packet', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    await fixture.writeReceipt(
      'The importer is fixed.',
      String.raw`Fix C:\Users\bob\client-acme\importer with token=abc123def`,
    );
    await fixture.importReceipt();
    await fixture.git('checkout', '-b', 'fix/token=abc123def');
    await fixture.post(`/api/v1/repositories/${fixture.repositoryId}/refresh`, {});

    const { packet, json } = await buildAcceptancePacket(fixture.database, fixture.workItemId);

    expect(packet.workItem.title).toBe('Fix [LOCAL_PATH] with token=[REDACTED]');
    expect(packet.repository?.branch).toBe('fix/token=[REDACTED]');
    expect(json).not.toContain('abc123def');
    expect(json).not.toContain('client-acme');
  }, 30_000);

  // The repository id hashes the local path, and every hash below takes it, or the claim before
  // sanitizing, as one input among fields a packet carries; each one would confirm a guessed path.
  it('leaves no identifier computed from local data in a packet', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const checkId = await fixture.approveCheck('process.stdout.write("verified")');
    await fixture.post(`/api/v1/checks/${checkId}/run`, { workItemId: fixture.workItemId });
    expect((await fixture.decide('accepted', 'Reviewed.')).status).toBe(201);
    const repository = fixture.database.getRepository(fixture.repositoryId);
    const workItem = fixture.database.getWorkItem(fixture.workItemId);
    const evidence = fixture.database.listEvidence(fixture.workItemId)[0];
    if (!repository || !workItem || !evidence) throw new Error('The fixture is incomplete.');
    const localValues = [
      repository.id,
      repository.snapshot.fingerprint,
      workItem.claimHash,
      evidence.checkDefinitionVersion,
      ...evidence.artifactHashes,
    ];

    const { packet, json, markdown, html } = await buildAcceptancePacket(
      fixture.database,
      fixture.workItemId,
    );

    expect(packet.schemaVersion).toBe(2);
    for (const value of localValues) {
      for (const format of [json, markdown, html]) expect(format).not.toContain(value);
    }
    // Equal values stay equal inside a packet, so its bindings can still be compared.
    const fingerprint = packet.repository?.fingerprint;
    expect(packet.workItem.snapshotFingerprint).toBe(fingerprint);
    expect(packet.evidence[0]?.snapshotFingerprint).toBe(fingerprint);
    expect(packet.verdicts[0]?.snapshotFingerprint).toBe(fingerprint);
    expect(packet.verdicts[0]?.claimHash).toBe(packet.workItem.claimHash);
    expect(packet.workItem.repositoryId).toBe(packet.repository?.id);
    expect(packet.manifest.evidenceArtifacts).toEqual(packet.evidence[0]?.artifactHashes);
    expect(await verifyAcceptancePacket(packet)).toMatchObject({ valid: true, issues: [] });
  }, 30_000);

  it('names each check and counts its tests without carrying its output', async () => {
    const fixture = await boundWorkspace({
      files: {
        'README.md': '# Fixture\n',
        'example.test.mjs': [
          "import test from 'node:test';",
          "test('a', () => {});",
          "test('b', () => {});",
          "test('c', { skip: true }, () => {});",
        ].join('\n'),
      },
    });
    cleanups.push(fixture.cleanup);
    const approved = await fixture.post<{ check: { id: string } }>('/api/v1/checks', {
      repositoryId: fixture.repositoryId,
      label: 'Node tests',
      kind: 'test',
      executable: process.execPath,
      args: ['--test'],
      cwdRelative: '.',
      timeoutMs: 30_000,
      maxOutputBytes: 100_000,
    });
    const run = await fixture.post<{ evidence: { result: string } }>(
      `/api/v1/checks/${approved.body.check.id}/run`,
      { workItemId: fixture.workItemId },
    );
    expect(run.body.evidence.result).toBe('passed');

    const { packet, json } = await buildAcceptancePacket(fixture.database, fixture.workItemId);

    expect(packet.checks).toEqual([
      expect.objectContaining({
        id: approved.body.check.id,
        label: 'Node tests',
        executable: path.basename(process.execPath),
        toolSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        args: ['--test'],
        cwdRelative: '.',
        timeoutMs: 30_000,
      }),
    ]);
    expect(packet.evidence[0]?.testCounts).toEqual({
      runner: 'node:test',
      total: 3,
      passed: 2,
      failed: 0,
      skipped: 1,
    });
    // The output and the tool's local path stay on this machine.
    expect(json).not.toContain('duration_ms');
    expect(json).not.toContain(JSON.stringify(process.execPath).slice(1, -1));
  }, 60_000);

  it('renders the same facts in its readable formats as in its JSON', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const checkId = await fixture.approveCheck('process.stdout.write("verified")', 'Smoke check');
    await fixture.post(`/api/v1/checks/${checkId}/run`, { workItemId: fixture.workItemId });
    expect((await fixture.decide('accepted', 'Reviewed the smoke check.')).status).toBe(201);

    const { packet, markdown, html } = await buildAcceptancePacket(
      fixture.database,
      fixture.workItemId,
    );

    const clauses = (packet.contract?.criteria ?? []) as Array<{ title: string }>;
    expect(clauses.length).toBeGreaterThan(0);
    for (const text of [markdown, html]) {
      expect(text).toContain(packet.workItem.sourceLabel);
      expect(text).toContain(packet.repository?.head ?? 'missing head');
      expect(text).toContain(packet.repository?.fingerprint ?? 'missing fingerprint');
      for (const clause of clauses) expect(text).toContain(clause.title);
      expect(text).toContain('Smoke check');
      expect(text).toContain(`${path.basename(process.execPath)} -e`);
      expect(text).toContain('Reviewed the smoke check.');
      expect(text).toContain(packet.manifest.payloadHash);
    }
  }, 30_000);

  it('embeds the contract its evidence and verdicts were recorded under', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const checkId = await fixture.approveCheck('process.stdout.write("verified")');
    await fixture.post(`/api/v1/checks/${checkId}/run`, { workItemId: fixture.workItemId });
    // A contract restored from an older backup sorts first.
    fixture.database.connection
      .prepare(
        `INSERT INTO acceptance_contracts (id, version, title, criteria_json, created_at)
         VALUES ('restored', 'restored-v9', 'Restored contract', '[]', '2000-01-01T00:00:00.000Z')`,
      )
      .run();

    const { packet } = await buildAcceptancePacket(fixture.database, fixture.workItemId);

    expect(packet.contract?.version).toBe(packet.evidence[0]?.contractVersion);
  }, 30_000);

  it('keeps its pseudonyms stable within a workspace and its key out of backups', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const first = await buildAcceptancePacket(fixture.database, fixture.workItemId);
    const second = await buildAcceptancePacket(fixture.database, fixture.workItemId);
    expect(second.packet.repository?.id).toBe(first.packet.repository?.id);

    const key = fixture.database.workspaceKey('packet-pseudonyms');
    const other = new VeriDoneDatabase(':memory:');
    try {
      expect(other.workspaceKey('packet-pseudonyms')).not.toBe(key);
    } finally {
      other.close();
    }
    expect(JSON.stringify(await exportWorkspace(fixture.database))).not.toContain(key);
  }, 30_000);
});
