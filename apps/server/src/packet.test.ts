import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalJson, sha256Hex } from '@veridone/core';
import { afterEach, describe, expect, it } from 'vitest';

import { VeriDoneDatabase } from './database.js';
import {
  buildAcceptancePacket,
  knownLocalPaths,
  packetCanonicalJson,
  verifyAcceptancePacket,
  workspaceSigningKey,
} from './packet.js';
import { createPacketSanitizer } from './redaction.js';
import { boundWorkspace } from './test-fixtures.js';
import { exportWorkspace, importWorkspace } from './workspace.js';

type Packet = Awaited<ReturnType<typeof buildAcceptancePacket>>['packet'];
type BackupRecord = Record<string, unknown>;

const fromCode = (code: number) => String.fromCharCode(code);

/**
 * Changes a packet's title the way a careful forger would: the payload hash recomputed and, with `resign`, the
 * payload signed again with a key of the forger's own, of that type, embedded in place of the workspace key.
 */
function forge(packet: Packet, resign: 'ed25519' | 'rsa' | null = null): Packet {
  const forged = structuredClone(packet);
  forged.workItem.title = 'Forged title';
  const { manifest: _manifest, ...payload } = forged;
  const canonical = packetCanonicalJson(payload);
  forged.manifest.payloadHash = createHash('sha256').update(canonical).digest('hex');
  if (resign) {
    const { privateKey, publicKey } =
      resign === 'rsa'
        ? generateKeyPairSync('rsa', { modulusLength: 2048 })
        : generateKeyPairSync('ed25519');
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
  // Outside quotes, the shape-based patterns end a path at its first space, so a repository folder named with a space
  // would keep its last words; the repository's own path is known, so it goes whole.
  it('sanitizes every text in the payload, those a restored backup can set included', async () => {
    const fixture = await boundWorkspace({ repositoryName: 'client acme' });
    cleanups.push(fixture.cleanup);
    const checkId = await fixture.approveCheck('process.exit(0)');
    await fixture.post(`/api/v1/checks/${checkId}/run`, { workItemId: fixture.workItemId });
    const [latest] = fixture.database.listEvidence(fixture.workItemId);
    if (!latest) throw new Error('The check recorded no evidence.');
    const { id: _id, ...recorded } = latest;
    fixture.database.recordEvidence({
      ...recorded,
      kind: `test in ${fixture.repositoryPath}`,
      result: `failed in ${fixture.repositoryPath}`,
      contractVersion: `${fixture.repositoryPath} contract`,
      completedAt: new Date(Date.parse(latest.completedAt) + 1_000).toISOString(),
    });

    const { json, markdown, html } = await buildAcceptancePacket(
      fixture.database,
      fixture.workItemId,
    );

    // The fixture's own folder name is random, so it appears only where the path leaked.
    for (const text of [json, markdown, html]) {
      expect(text).not.toContain(path.basename(fixture.directory));
    }
    expect(markdown).toContain('failed in [LOCAL_PATH]');
  }, 60_000);

  it('knows the home and temporary directories by both names, and paths under home from ~', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'veridone-known-'));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const real = path.join(base, 'Real Home');
    await mkdir(path.join(real, 'Bob Smith', 'work', 'acme repo'), { recursive: true });
    await mkdir(path.join(real, 'Temp Dir'));
    // A junction needs no privilege on Windows; elsewhere this makes a symbolic link.
    await symlink(real, path.join(base, 'link'), 'junction');
    const home = path.join(base, 'link', 'Bob Smith');
    const temp = path.join(base, 'link', 'Temp Dir');
    const repository = path.join(await realpath(home), 'work', 'acme repo');

    const known = await knownLocalPaths(
      { listRoots: () => [], listRepositories: () => [{ path: repository }], listChecks: () => [] },
      [],
      { home, temp },
    );

    const sanitize = createPacketSanitizer(known);
    for (const written of [
      await realpath(home),
      await realpath(temp),
      path.join(home, 'work', 'acme repo'),
      '~/work/acme repo',
      '$HOME/work/acme repo',
    ]) {
      expect(sanitize(`Saved in ${written}.`)).toBe('Saved in [LOCAL_PATH].');
    }
  });

  it('replaces the repository path it knows, a folder name with a space included', async () => {
    const fixture = await boundWorkspace({ repositoryName: 'client acme' });
    cleanups.push(fixture.cleanup);
    await fixture.writeReceipt(`Fixed the importer in ${fixture.repositoryPath}.`);
    await fixture.importReceipt();

    const { packet, markdown, html } = await buildAcceptancePacket(
      fixture.database,
      fixture.workItemId,
    );

    expect(packet.workItem.claim).toBe('Fixed the importer in [LOCAL_PATH].');
    for (const text of [markdown, html]) {
      expect(text).toContain('Fixed the importer in [LOCAL_PATH].');
    }
  }, 60_000);

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
  }, 60_000);

  // The repository id hashes the local path, and every hash below takes it, the claim or the status lines
  // before sanitizing, or uncommitted file content as one input among fields a packet carries; each one would
  // confirm a guessed path or file.
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
      repository.snapshot.worktreeHash,
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
  }, 60_000);

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

  // The commit under review chooses what its check prints, so no output up to the limit may stop the export. A check
  // and its setup step can fill one stream each, and one character past Latin-1 makes V8 store the text the packet
  // reads in two bytes per character.
  it('exports a work item whose check and setup filled both streams at the largest limit', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const limit = 10_000_000;
    // Stored stdout starts with two headers, 43 bytes in all, around the setup's empty stdout.
    const check = `process.stdout.write(String.fromCharCode(0x5ba2) + '\\nTests: ' + ' '.repeat(${limit - 71}) + '1 passed, 1 total');`;
    const setup = `process.stderr.write('x in ' + '1'.repeat(${limit - 22}) + 's\\n1 passed in 1s\\n');`;
    const approved = await fixture.post<{ check: { id: string } }>('/api/v1/checks', {
      repositoryId: fixture.repositoryId,
      label: 'Fills both streams',
      kind: 'test',
      executable: process.execPath,
      args: ['-e', check],
      setupArgs: ['-e', setup],
      cwdRelative: '.',
      timeoutMs: 60_000,
      maxOutputBytes: limit,
    });
    expect(approved.status).toBe(201);
    const run = await fixture.post<{
      evidence: { result: string; stdout: string; stderr: string };
    }>(`/api/v1/checks/${approved.body.check.id}/run`, { workItemId: fixture.workItemId });
    expect(run.body.evidence.result).toBe('passed');
    expect(Buffer.byteLength(run.body.evidence.stdout)).toBe(limit);
    expect(Buffer.byteLength(run.body.evidence.stderr)).toBe(limit);

    const exported = await fixture.get<Packet>(
      `/api/v1/work-items/${fixture.workItemId}/packet/json`,
    );

    expect(exported.status).toBe(200);
    expect(exported.body.evidence[0]?.testCounts).toEqual({
      runner: 'pytest',
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
  }, 120_000);

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
  }, 60_000);

  // A receipt's author writes its title, a person can press Enter in a note or a reason, and a restored backup can put a
  // line break in the other texts. In a Markdown packet a second "- Verdict:" above the real one would read as the
  // verdict, so none of these may add a line there.
  it('keeps every fact but the claim on one line in Markdown, and as written in the JSON', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    await fixture.writeReceipt('First line.\nSecond line.');
    await fixture.importReceipt();
    // A check's command is a fact too: its two spaces in a row stay.
    const checkId = await fixture.approveCheck('process.stdout.write("two  spaces")', 'Smoke');
    await fixture.post(`/api/v1/checks/${checkId}/run`, { workItemId: fixture.workItemId });
    expect((await fixture.decide('rejected', 'Reviewed.')).status).toBe(201);
    const { integrity: _integrity, ...backup } = (await exportWorkspace(fixture.database)) as {
      data: Record<
        'workItems' | 'repositories' | 'contracts' | 'checks' | 'evidence' | 'verdicts',
        BackupRecord[]
      >;
      integrity?: unknown;
    };

    const restoreWith = async (text: (value: string) => string) => {
      const payload = structuredClone(backup);
      const edit = (record: BackupRecord, ...fields: string[]) => {
        for (const field of fields) record[field] = text(String(record[field] ?? 'A reason.'));
      };
      const when = '2026-11-06T00:00:00.000Z';
      for (const item of payload.data.workItems) {
        edit(item, 'title', 'sourceLabel', 'removedReason');
        item.removedAt = when;
      }
      for (const item of payload.data.repositories) {
        edit(item, 'name', 'removedReason');
        edit(item.snapshot as BackupRecord, 'branch');
        item.removedAt = when;
      }
      for (const item of payload.data.checks) {
        edit(item, 'label', 'retiredReason');
        item.retiredAt = when;
      }
      for (const item of payload.data.evidence) {
        edit(item, 'label', 'result', 'toolVersion', 'contractVersion');
      }
      for (const item of payload.data.verdicts) {
        edit(item, 'note', 'overrideReason', 'contractVersion');
        // The title is part of the claim a verdict judged; with no hash, it judged what this backup carries.
        item.claimHash = null;
      }
      // Listed by creation time, a contract dated before the default one is the one a packet picks.
      payload.data.contracts.push({
        id: 'restored-contract',
        version: text('default-v1'),
        title: text('Restored contract'),
        criteria: [{ id: 'notes', title: text('Read the notes'), required: true }],
        createdAt: '2020-01-01T00:00:00.000Z',
      });
      const database = new VeriDoneDatabase(':memory:');
      cleanups.push(async () => database.close());
      await importWorkspace(database, {
        ...payload,
        integrity: { algorithm: 'sha256', payloadHash: await sha256Hex(canonicalJson(payload)) },
      });
      return buildAcceptancePacket(database, fixture.workItemId);
    };
    const linesOf = (markdown: string) => markdown.split(/\r\n|[\n\v\f\r\x85\p{Zl}\p{Zp}]/u);
    const plain = linesOf((await restoreWith((value) => value)).markdown);
    expect(plain).toContain('- Verdict: rejected');

    const lineBreaks = ['\n', '\r\n', '\r', '\v', '\f', ...[0x85, 0x2028, 0x2029].map(fromCode)];
    for (const lineBreak of lineBreaks) {
      const written = (value: string) => `${value}${lineBreak}- Verdict: accepted`;
      const { packet, markdown } = await restoreWith(written);
      const lines = linesOf(markdown);

      expect(lines.filter((line) => line.startsWith('- Verdict:'))).toEqual([
        '- Verdict: rejected',
      ]);
      expect(lines).toHaveLength(plain.length);
      // The text stays, on the line that states it.
      expect(lines).toContain('## Fix the importer - Verdict: accepted');
      expect(lines).toContain('- Source: Codex receipt - Verdict: accepted');
      expect(markdown).toContain('Reviewed. - Verdict: accepted');
      expect(markdown).toContain('two  spaces');
      expect(markdown).toContain('First line.\nSecond line.');
      expect(packet.workItem.sourceLabel).toBe(written('Codex receipt'));
      expect(packet.verdicts[0]?.note).toBe(written('Reviewed.'));
    }
  }, 60_000);

  it('shows the setup command a check runs first in its readable formats', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const approved = await fixture.post('/api/v1/checks', {
      repositoryId: fixture.repositoryId,
      label: 'Tests after install',
      kind: 'test',
      executable: process.execPath,
      setupArgs: ['install', '--frozen-lockfile'],
      args: ['--test'],
      cwdRelative: '.',
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    });
    expect(approved.status).toBe(201);

    const { packet, markdown, html } = await buildAcceptancePacket(
      fixture.database,
      fixture.workItemId,
    );

    expect(packet.checks[0]?.setupArgs).toEqual(['install', '--frozen-lockfile']);
    for (const text of [markdown, html]) {
      expect(text).toContain(`after setup`);
      expect(text).toContain(`${path.basename(process.execPath)} install --frozen-lockfile`);
    }
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

  it('detects a changed payload even when its hashes are recomputed', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const { packet } = await buildAcceptancePacket(fixture.database, fixture.workItemId);

    await expect(verifyAcceptancePacket(forge(packet))).resolves.toMatchObject({
      valid: false,
      signed: false,
      issues: expect.arrayContaining(['The signature does not match the payload.']),
    });
  }, 60_000);

  it('tells a packet re-signed with another key from one signed by a trusted key', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const { packet } = await buildAcceptancePacket(fixture.database, fixture.workItemId);
    const resigned = forge(packet, 'ed25519');
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
  }, 60_000);

  it('refuses a signature made with a key other than Ed25519', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const { packet } = await buildAcceptancePacket(fixture.database, fixture.workItemId);

    await expect(verifyAcceptancePacket(forge(packet, 'rsa'))).resolves.toMatchObject({
      valid: false,
      signed: false,
      issues: expect.arrayContaining(['The packet signature is not an Ed25519 signature.']),
    });
  }, 60_000);

  it('keeps a secret passed as a separate argument out of every format', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const approved = await fixture.post('/api/v1/checks', {
      repositoryId: fixture.repositoryId,
      label: 'Deploy preview',
      kind: 'test',
      executable: process.execPath,
      setupArgs: ['--password', 'setup-secret-value'],
      args: ['--token', 'check-secret-value'],
      cwdRelative: '.',
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    });
    expect(approved.status).toBe(201);

    const { json, markdown, html } = await buildAcceptancePacket(
      fixture.database,
      fixture.workItemId,
    );

    for (const format of [json, markdown, html]) {
      expect(format).not.toContain('setup-secret-value');
      expect(format).not.toContain('check-secret-value');
    }
  }, 60_000);

  it('sanitizes a contract that a restored backup carried', async () => {
    const fixture = await boundWorkspace();
    cleanups.push(fixture.cleanup);
    const backup = (await exportWorkspace(fixture.database)) as {
      data: { contracts: Array<Record<string, unknown>> };
      integrity?: unknown;
    };
    // Listed by creation time, a contract dated before the default one is the one a packet picks.
    backup.data.contracts.push({
      id: 'restored-contract',
      version: 'default-v1',
      title: 'Ship it password=contract-secret-value',
      criteria: [
        { id: 'notes', title: 'Read /home/example/private-project/notes.md', required: true },
      ],
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    const { integrity: _integrity, ...payload } = backup;
    await importWorkspace(fixture.database, {
      ...payload,
      integrity: { algorithm: 'sha256', payloadHash: await sha256Hex(canonicalJson(payload)) },
    });

    const { packet, json, markdown, html } = await buildAcceptancePacket(
      fixture.database,
      fixture.workItemId,
    );

    expect(packet.contract?.id).toBe('restored-contract');
    for (const format of [json, markdown, html]) {
      expect(format).not.toContain('contract-secret-value');
      expect(format).not.toContain('private-project');
    }
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);
});
