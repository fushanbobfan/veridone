// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import { AddSourceDialog } from './components/AddSourceDialog.js';

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(cleanup);

describe('review desk', () => {
  it('keeps acceptance locked while required evidence is stale', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Harden workspace export bundles' })).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /accept work/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText('Acceptance is locked')).toBeTruthy();
  });

  it('allows a human decision only for a ready review', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /import harness run receipts/i }));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: /accept work/i }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    const accept = screen.getByRole('button', { name: /accept work/i });
    await user.click(accept);
    expect(screen.getByText('Accepted by you')).toBeTruthy();
  });

  it('persists the selected theme', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /switch to light theme/i }));
    expect(localStorage.getItem('veridone-theme')).toBe('light');
    await user.click(screen.getByRole('button', { name: /switch to dark theme/i }));
    await user.click(screen.getByRole('button', { name: /switch to light theme/i }));
    expect(localStorage.getItem('veridone-theme')).toBe('system');
  });

  it('persists search, filter, sort, and the selected review in the URL', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByRole('searchbox', { name: 'Search reviews' }), 'receipt');
    await user.click(screen.getByRole('button', { name: /import harness run receipts/i }));
    await user.click(screen.getByRole('button', { name: /^ready\s*1$/i }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort reviews' }), 'repository');

    expect(window.location.search).toContain('review=receipt-import');
    expect(window.location.search).toContain('filter=ready');
    expect(window.location.search).toContain('q=receipt');
    expect(window.location.search).toContain('sort=repository');
  });

  it('traps dialog focus and returns it to the trigger', async () => {
    const user = userEvent.setup();
    function DialogHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open source dialog
          </button>
          <AddSourceDialog
            open={open}
            csrfToken="test-token"
            roots={[]}
            onClose={() => setOpen(false)}
            onAdded={async () => undefined}
          />
        </>
      );
    }

    render(<DialogHarness />);
    const trigger = screen.getByRole('button', { name: 'Open source dialog' });
    await user.click(trigger);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Close source dialog' }),
      ),
    );
    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
