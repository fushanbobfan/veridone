// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AddSourceDialog } from './AddSourceDialog.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const roots = [
  { id: 'root-1', path: 'D:\\work', label: 'Work', createdAt: '2026-10-22T00:00:00.000Z' },
];
const repositories = ['D:\\work\\alpha', 'D:\\work\\beta'];

describe('add source dialog', () => {
  it('keeps the chosen repository when a later discovery returns', async () => {
    const user = userEvent.setup();
    let releaseSecondDiscovery: (() => void) | undefined;
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length > 1) {
        await new Promise<void>((resolve) => {
          releaseSecondDiscovery = resolve;
        });
      }
      return new Response(JSON.stringify({ repositories }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AddSourceDialog
        open
        csrfToken="token"
        roots={roots}
        onClose={() => undefined}
        onAdded={async () => undefined}
      />,
    );
    await user.click(screen.getByText('Git repository'));
    await user.click(screen.getByRole('button', { name: 'Discover repositories' }));
    await user.selectOptions(
      await screen.findByLabelText('Discovered repository'),
      repositories[1]!,
    );

    // While the next discovery runs, the earlier list cannot be chosen from.
    await user.click(screen.getByRole('button', { name: 'Discover repositories' }));
    expect(screen.queryByLabelText('Discovered repository')).toBeNull();

    releaseSecondDiscovery?.();
    await screen.findByLabelText('Discovered repository');
    expect((screen.getByLabelText('Absolute local path') as HTMLInputElement).value).toBe(
      repositories[1],
    );
  });

  it('drops a discovery answer that a newer discovery replaced', async () => {
    const user = userEvent.setup();
    let releaseFirstDiscovery: (() => void) | undefined;
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstDiscovery = resolve;
        });
        return new Response(JSON.stringify({ repositories: ['D:\\work\\stale'] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ repositories }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AddSourceDialog
        open
        csrfToken="token"
        roots={roots}
        onClose={() => undefined}
        onAdded={async () => undefined}
      />,
    );
    await user.click(screen.getByText('Git repository'));
    await user.click(screen.getByRole('button', { name: 'Discover repositories' }));
    await user.click(screen.getByRole('button', { name: 'Discovering…' }));
    await screen.findByLabelText('Discovered repository');

    // The first, slower answer arrives after the second one.
    await act(async () => {
      releaseFirstDiscovery?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const select = screen.getByLabelText('Discovered repository') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(repositories);
    expect((screen.getByLabelText('Absolute local path') as HTMLInputElement).value).toBe(
      repositories[0],
    );
  });
});
