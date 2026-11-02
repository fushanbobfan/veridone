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
