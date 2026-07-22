// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

beforeEach(() => {
  localStorage.clear();
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
  });
});
