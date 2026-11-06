// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoveWorkItemDialog } from './RemoveWorkItemDialog.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const workItem = { id: 'item', title: 'Fix the importer', claimHash: '9'.repeat(64) };
const props = {
  open: true,
  workItem,
  evidenceCount: 3,
  verdictCount: 1,
  csrfToken: 'token',
  onClose: () => undefined,
};

describe('removing a work item', () => {
  it('asks for a reason, says what stays, and sends the claim the operator saw', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ workItem: { id: 'item' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onRemoved = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(<RemoveWorkItemDialog {...props} onClose={onClose} onRemoved={onRemoved} />);

    expect(screen.getByText('Fix the importer')).toBeTruthy();
    expect(screen.getByText(/3 evidence records and 1 verdict stay on record/u)).toBeTruthy();
    expect(screen.getByText(/put it back under Removed/u)).toBeTruthy();
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove work item' });
    expect(confirm.disabled).toBe(true);

    await user.type(screen.getByLabelText('Why it is removed'), '  Added by mistake.  ');
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);

    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/work-items/item/remove');
    expect(JSON.parse(String(init.body))).toEqual({
      reason: 'Added by mistake.',
      expected: { claimHash: workItem.claimHash },
    });
  });

  it('shows why it was refused and stays open', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: 'work_item_changed', message: 'The claim changed.' }),
            { status: 409 },
          ),
      ),
    );
    const onRemoved = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(<RemoveWorkItemDialog {...props} onClose={onClose} onRemoved={onRemoved} />);
    await user.type(screen.getByLabelText('Why it is removed'), 'A reason.');
    await user.click(screen.getByRole('button', { name: 'Remove work item' }));
    expect(await screen.findByText('The claim changed.')).toBeTruthy();
    expect(onRemoved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes without removing when the operator keeps it', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    render(<RemoveWorkItemDialog {...props} onClose={onClose} onRemoved={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(onClose).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
