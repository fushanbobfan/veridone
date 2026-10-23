// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VerdictDialog } from './VerdictDialog.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('verdict dialog', () => {
  it('names the work item it decides and records the verdict for that item', async () => {
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
        subject={{
          title: 'Binding item B',
          repository: 'binding-b',
          head: 'b'.repeat(40),
          fingerprint: '2'.repeat(64),
        }}
        decision="rejected"
        csrfToken="token"
        onClose={() => undefined}
        onRecorded={onRecorded}
      />,
    );

    const subject = screen.getByLabelText('Verdict subject').textContent ?? '';
    expect(subject).toContain('Binding item B');
    expect(subject).toContain('binding-b');
    expect(subject).toContain('b'.repeat(12));
    expect(subject).toContain('2'.repeat(12));

    await user.type(screen.getByLabelText('Decision note'), 'Rejecting item B after review.');
    await user.click(screen.getByRole('button', { name: 'Record rejection' }));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/work-items/work-b/verdicts');
    expect(onRecorded).toHaveBeenCalledOnce();
  });
});
