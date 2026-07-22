import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { verifyAcceptancePacket } from './packet.js';

const directory = path.resolve(process.argv[2] ?? 'docs/evidence/dogfood');
const files = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
  .map((entry) => entry.name)
  .sort();

if (files.length === 0) {
  process.stderr.write(`No JSON evidence packets found in ${directory}\n`);
  process.exitCode = 1;
} else {
  let failed = false;
  for (const file of files) {
    try {
      const packet = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as unknown;
      const verification = await verifyAcceptancePacket(packet);
      if (!verification.valid) {
        failed = true;
        process.stderr.write(`${file}: ${verification.issues.join('; ')}\n`);
      } else {
        process.stdout.write(`${file}: verified ${verification.expectedPayloadHash}\n`);
      }
    } catch (error) {
      failed = true;
      process.stderr.write(
        `${file}: ${error instanceof Error ? error.message : 'invalid packet'}\n`,
      );
    }
  }
  if (failed) process.exitCode = 1;
  else process.stdout.write(`Verified ${files.length} published evidence packets.\n`);
}
