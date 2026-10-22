import { writeFile } from 'node:fs/promises';
import path from 'node:path';

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

interface VerdictResponse {
  verdict: {
    id: string;
    overrideReason: string | null;
    sequence: number;
    previousVerdictId: string | null;
    claimHash: string | null;
  };
}

interface ConflictResponse {
  error: string;
  reason: string;
  message: string;
}

describe('verdict recording', () => {
  it('records an override reason only when required gates are open', async () => {
    const { post, workItemId, approveCheck, decide } = await workspace();
    const checkId = await approveCheck('process.stdout.write("verified")');

    const overridden = await decide<VerdictResponse>('accepted', 'Accepted before the check ran.', {
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

    const accepted = await decide<VerdictResponse>(
      'accepted',
      'Accepted with fresh passing evidence.',
      { overrideReason: 'Sent by a client that thought the gates were open.' },
    );
    expect(accepted.status).toBe(201);
    expect(accepted.body.verdict.overrideReason).toBeNull();
  }, 30_000);

  it('records the claim it judged and the verdict it supersedes', async () => {
    const { decide, expectedState } = await workspace();

    const first = await decide<VerdictResponse>('changes-requested', 'Add a regression test.');
    const second = await decide<VerdictResponse>('rejected', 'The test is still missing.');

    expect(first.body.verdict).toMatchObject({ sequence: 1, previousVerdictId: null });
    expect(second.body.verdict).toMatchObject({
      sequence: 2,
      previousVerdictId: first.body.verdict.id,
      claimHash: (await expectedState()).claimHash,
    });
  }, 30_000);
});

describe('verdicts are compare-and-swap writes', () => {
  it('refuses a verdict on a repository state the reviewer did not see', async () => {
    const fixture = await workspace();
    const expected = await fixture.expectedState();
    // No refresh runs between the change and the decision; the verdict request captures it.
    await writeFile(path.join(fixture.repositoryPath, 'later.txt'), 'written after review\n');

    const response = await fixture.decide<ConflictResponse>('rejected', 'Rejecting what I saw.', {
      expected,
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: 'verdict_conflict',
      reason: 'repository-changed',
    });
    expect(fixture.database.listVerdicts(fixture.workItemId)).toEqual([]);
  }, 30_000);

  it('refuses a verdict when another one was recorded after the reviewer looked', async () => {
    const fixture = await workspace();
    const expected = await fixture.expectedState();

    const first = await fixture.decide('changes-requested', 'First reviewer.', { expected });
    const late = await fixture.decide<ConflictResponse>('rejected', 'Second reviewer.', {
      expected,
    });

    expect(first.status).toBe(201);
    expect(late.status).toBe(409);
    expect(late.body.reason).toBe('verdict-changed');
    expect(fixture.database.listVerdicts(fixture.workItemId)).toHaveLength(1);
  }, 30_000);

  it('refuses a verdict when the claim changed after the reviewer read it', async () => {
    const fixture = await workspace();
    const expected = await fixture.expectedState();
    await fixture.writeReceipt('The importer is fixed and also faster.');
    expect((await fixture.importReceipt()).status).toBe(201);

    const response = await fixture.decide<ConflictResponse>('rejected', 'Judged the old claim.', {
      expected,
    });

    expect(response.status).toBe(409);
    expect(response.body.reason).toBe('claim-changed');
  }, 30_000);

  it('records exactly one of two verdicts sent against the same state', async () => {
    const fixture = await workspace();
    const expected = await fixture.expectedState();

    const responses = await Promise.all([
      fixture.decide('rejected', 'Reviewer A.', { expected }),
      fixture.decide('changes-requested', 'Reviewer B.', { expected }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(fixture.database.listVerdicts(fixture.workItemId)).toHaveLength(1);
  }, 30_000);

  it('keeps the claim of a work item that already has a verdict', async () => {
    const fixture = await workspace();
    await fixture.decide('changes-requested', 'Needs a regression test.');
    await fixture.writeReceipt('A different claim under the same run.');

    const reimport = await fixture.importReceipt();

    expect(reimport.status).toBe(400);
    expect(reimport.body).toMatchObject({
      message: expect.stringMatching(/already has a verdict/u),
    });
    expect(fixture.database.getWorkItem(fixture.workItemId)?.claim).toBe('The importer is fixed.');
  }, 30_000);
});
