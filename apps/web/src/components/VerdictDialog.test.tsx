// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VerdictDialog } from './VerdictDialog.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const subject = {
  title: 'Binding item B',
  repository: 'binding-b',
  head: 'b'.repeat(40),
  fingerprint: '2'.repeat(64),
};
const expected = { fingerprint: '2'.repeat(64), verdictId: null, claimHash: '3'.repeat(64) };

describe('verdict dialog', () => {
  it('names the work item it decides and records the verdict for the state it showed', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ verdict: {} }), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onRecorded = vi.fn(async () => undefined);

    render(
      <VerdictDialog
        open
        workItemId="work-b"
        subject={subject}
        expected={expected}
        decision="rejected"
        csrfToken="token"
        onClose={() => undefined}
        onRecorded={onRecorded}
      />,
    );

    const shown = screen.getByLabelText('Verdict subject').textContent ?? '';
    expect(shown).toContain('Binding item B');
    expect(shown).toContain('binding-b');
    expect(shown).toContain('b'.repeat(12));
    expect(shown).toContain('2'.repeat(12));

    await user.type(screen.getByLabelText('Decision note'), 'Rejecting item B after review.');
    await user.click(screen.getByRole('button', { name: 'Record rejection' }));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/work-items/work-b/verdicts');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      decision: 'rejected',
      expected,
    });
    expect(onRecorded).toHaveBeenCalledOnce();
  });

  it('will not record a verdict after the work item changed under it', () => {
    render(
      <VerdictDialog
        open
        workItemId="work-b"
        subject={subject}
        expected={expected}
        changedSinceOpened="The repository changed after this dialog opened."
        decision="accepted"
        csrfToken="token"
        onClose={() => undefined}
        onRecorded={async () => undefined}
      />,
    );

    expect(screen.getByText(/The repository changed after this dialog opened/u)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Record acceptance' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows the reason when the server refuses a verdict on a changed state', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'verdict_conflict',
              reason: 'verdict-changed',
              message: 'Another verdict was recorded for this work item after this one was opened.',
            }),
            { status: 409 },
          ),
      ),
    );
    const onRecorded = vi.fn(async () => undefined);

    render(
      <VerdictDialog
        open
        workItemId="work-b"
        subject={subject}
        expected={expected}
        decision="changes-requested"
        csrfToken="token"
        onClose={() => undefined}
        onRecorded={onRecorded}
      />,
    );
    await user.type(screen.getByLabelText('Decision note'), 'Add a regression test.');
    await user.click(screen.getByRole('button', { name: 'Record request' }));

    expect(await screen.findByText(/Another verdict was recorded/u)).toBeTruthy();
    expect(onRecorded).not.toHaveBeenCalled();
  });
});
