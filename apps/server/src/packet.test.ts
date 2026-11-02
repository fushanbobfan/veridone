import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { VeriDoneDatabase } from './database.js';
import {
  buildAcceptancePacket,
  packetCanonicalJson,
  verifyAcceptancePacket,
  workspaceSigningKey,
} from './packet.js';
import { boundWorkspace } from './test-fixtures.js';
import { exportWorkspace } from './workspace.js';

type Packet = Awaited<ReturnType<typeof buildAcceptancePacket>>['packet'];

/**
 * Changes a packet's title the way a careful forger would: the payload hash recomputed and, with `resign`, the
 * payload signed again with a key of the forger's own, embedded in place of the workspace key.
 */
function forge(packet: Packet, resign = false): Packet {
  const forged = structuredClone(packet);
  forged.workItem.title = 'Forged title';
  const { manifest: _manifest, ...payload } = forged;
  const canonical = packetCanonicalJson(payload);
  forged.manifest.payloadHash = createHash('sha256').update(canonical).digest('hex');
  if (resign) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    forged.manifest.signature = {
      algorithm: 'ed25519',
      keyId: createHash('sha256')
        .update(publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex'),
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      value: sign(null, Buffer.from(canonical), privateKey).toString('base64'),
    };
  }
  return forged;
}

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

  it('signs its payload with the workspace key', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const { packet, markdown, html } = await buildAcceptancePacket(
      fixture.database,
      fixture.workItemId,
    );
    const key = workspaceSigningKey(fixture.database);

    expect(packet.manifest.signature).toMatchObject({
      algorithm: 'ed25519',
      keyId: key.keyId,
      publicKey: key.publicKey,
    });
    for (const text of [markdown, html]) expect(text).toContain(key.keyId);
    await expect(verifyAcceptancePacket(packet)).resolves.toMatchObject({
      valid: true,
      signed: true,
      keyId: key.keyId,
      trusted: null,
    });
    await expect(
      verifyAcceptancePacket(packet, { trustedKeys: [key.publicKey] }),
    ).resolves.toMatchObject({ valid: true, signed: true, trusted: true });
  }, 30_000);

  it('detects a changed payload even when its hashes are recomputed', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const { packet } = await buildAcceptancePacket(fixture.database, fixture.workItemId);

    await expect(verifyAcceptancePacket(forge(packet))).resolves.toMatchObject({
      valid: false,
      signed: false,
      issues: expect.arrayContaining(['The signature does not match the payload.']),
    });
  }, 30_000);

  it('tells a packet re-signed with another key from one signed by a trusted key', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const { packet } = await buildAcceptancePacket(fixture.database, fixture.workItemId);
    const resigned = forge(packet, true);
    const key = workspaceSigningKey(fixture.database);

    // The forger's own signature is sound; only a key the reader trusts tells the two apart.
    await expect(verifyAcceptancePacket(resigned)).resolves.toMatchObject({
      valid: true,
      signed: true,
      trusted: null,
    });
    await expect(
      verifyAcceptancePacket(resigned, { trustedKeys: [key.publicKey] }),
    ).resolves.toMatchObject({
      valid: false,
      trusted: false,
      issues: expect.arrayContaining(['The packet is not signed by a trusted key.']),
    });
  }, 30_000);

  it('refuses a schema-2 packet whose signature was removed', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const { packet } = await buildAcceptancePacket(fixture.database, fixture.workItemId);
    const stripped = structuredClone(packet) as { manifest: Record<string, unknown> };
    delete stripped.manifest.signature;

    await expect(verifyAcceptancePacket(stripped)).resolves.toMatchObject({
      valid: false,
      signed: false,
      issues: expect.arrayContaining(['The packet is not signed.']),
    });
  }, 30_000);

  it('still verifies the published schema-1 packets, as unsigned', async () => {
    const directory = path.resolve(import.meta.dirname, '../../../docs/evidence/dogfood');
    const files = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const packet = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as unknown;
      await expect(verifyAcceptancePacket(packet)).resolves.toMatchObject({
        valid: true,
        signed: false,
      });
    }
  });

  it('hands out the public key of the workspace signing key', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const key = workspaceSigningKey(fixture.database);

    const response = await fixture.app.request(
      'http://127.0.0.1:4317/api/v1/workspace/signing-key',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-VeriDone-Key-Id')).toBe(key.keyId);
    expect(await response.text()).toBe(key.publicKey);
    const bootstrap = await fixture.get<{ signingKey: { keyId: string } }>('/api/v1/bootstrap');
    expect(bootstrap.body.signingKey).toEqual({ keyId: key.keyId });
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
    const backup = JSON.stringify(await exportWorkspace(fixture.database));
    expect(backup).not.toContain(key);
    // The signing key's private half stays out as well.
    const signingMaterial = fixture.database.workspaceKey('packet-signing');
    expect(signingMaterial).toContain('PRIVATE KEY');
    expect(backup).not.toContain(signingMaterial.split('\n')[1]);
  }, 30_000);
});
