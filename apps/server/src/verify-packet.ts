#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

import { verifyAcceptancePacket } from './packet.js';

const usage = 'Usage: pnpm verify:packet <packet.json> [--key <public-key.pem>]...\n';
const args = process.argv.slice(2);
let filename: string | undefined;
const keyFiles: string[] = [];
let malformed = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--key') {
    const keyFile = args[index + 1];
    if (keyFile) keyFiles.push(keyFile);
    else malformed = true;
    index += 1;
  } else if (arg && !filename) {
    filename = arg;
  } else {
    malformed = true;
  }
}

if (!filename || malformed) {
  process.stderr.write(usage);
  process.exitCode = 2;
} else {
  try {
    const input = JSON.parse(await readFile(filename, 'utf8')) as unknown;
    const trustedKeys = await Promise.all(keyFiles.map((file) => readFile(file, 'utf8')));
    const result = await verifyAcceptancePacket(
      input,
      trustedKeys.length > 0 ? { trustedKeys } : {},
    );
    if (result.valid) {
      process.stdout.write(`Verified SHA-256 payload: ${result.actualPayloadHash}\n`);
      process.stdout.write(
        !result.signed
          ? 'Unsigned schema-1 packet: its checksum detects accidental damage, and anyone can recompute it.\n'
          : result.trusted
            ? `Signed by the trusted key ${result.keyId}.\n`
            : `Signed by key ${result.keyId}. Pass --key with the operator's published public key to check that it is theirs.\n`,
      );
    } else {
      process.stderr.write(`Packet verification failed:\n- ${result.issues.join('\n- ')}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Packet verification failed.'}\n`,
    );
    process.exitCode = 1;
  }
}
