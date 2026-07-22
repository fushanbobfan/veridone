#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

import { verifyAcceptancePacket } from './packet.js';

const filename = process.argv[2];
if (!filename) {
  process.stderr.write('Usage: pnpm verify:packet <packet.json>\n');
  process.exitCode = 2;
} else {
  try {
    const input = JSON.parse(await readFile(filename, 'utf8')) as unknown;
    const result = await verifyAcceptancePacket(input);
    if (result.valid) {
      process.stdout.write(`Verified SHA-256 payload: ${result.actualPayloadHash}\n`);
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
