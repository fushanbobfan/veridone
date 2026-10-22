import { afterEach, describe, expect, it } from 'vitest';

import { boundWorkspace } from './test-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function workspace() {
  const fixture = await boundWorkspace();
  cleanups.push(fixture.cleanup);
  return fixture;
}

type VerdictResponse = { verdict: { overrideReason: string | null } };

describe('verdict recording', () => {
  it('records an override reason only when required gates are open', async () => {
    const { post, workItemId, approveCheck } = await workspace();
    const checkId = await approveCheck('process.stdout.write("verified")');

    const overridden = await post<VerdictResponse>(`/api/v1/work-items/${workItemId}/verdicts`, {
      decision: 'accepted',
      note: 'Accepted before the check ran.',
      overrideReason: 'The maintainer reviewed the diff by hand.',
    });
    expect(overridden.status).toBe(201);
    expect(overridden.body.verdict.overrideReason).toBe(
      'The maintainer reviewed the diff by hand.',
    );

    const run = await post<{ readiness: { ready: boolean } }>(`/api/v1/checks/${checkId}/run`, {
      workItemId,
    });
    expect(run.body.readiness.ready).toBe(true);

    const accepted = await post<VerdictResponse>(`/api/v1/work-items/${workItemId}/verdicts`, {
      decision: 'accepted',
      note: 'Accepted with fresh passing evidence.',
      overrideReason: 'Sent by a client that thought the gates were open.',
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.verdict.overrideReason).toBeNull();
  }, 30_000);
});
