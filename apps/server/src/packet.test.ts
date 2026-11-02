import { afterEach, describe, expect, it } from 'vitest';

import { buildAcceptancePacket } from './packet.js';
import { boundWorkspace } from './test-fixtures.js';

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
});
