// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AddSourceDialog } from './AddSourceDialog.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const roots = [
  {
    id: 'root-1',
    path: 'D:\\work',
    label: 'Work',
    createdAt: '2026-10-22T00:00:00.000Z',
    status: 'approved' as const,
    removedAt: null,
    removedReason: null,
  },
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

  it('leaves a root that left for one that is still there', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ repositories }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const props = {
      open: true,
      csrfToken: 'token',
      onClose: () => undefined,
      onAdded: async () => undefined,
    };
    const { rerender } = render(<AddSourceDialog {...props} roots={roots} />);
    const moved = [{ ...roots[0]!, id: 'root-2', path: 'D:\\moved', label: 'Moved' }];
    rerender(<AddSourceDialog {...props} roots={moved} />);

    await user.click(screen.getByText('Git repository'));
    await user.click(screen.getByRole('button', { name: 'Discover repositories' }));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ rootId: 'root-2' });
  });

  it('says which runs stay removed, in the preview and after the import', async () => {
    const user = userEvent.setup();
    const preview = {
      runId: 'run',
      taskType: 'implementation',
      status: 'complete',
      startedAt: '2026-11-06T10:00:00.000Z',
      completedAt: null,
      stageCount: 0,
      degraded: false,
      sourcePath: 'D:\\work\\receipt.json',
      sourceType: 'codex',
      sourceLabel: 'Codex',
      title: 'Fix the importer',
      claim: 'The importer is fixed.',
      removedAt: '2026-11-06T11:00:00.000Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/preview')
          ? new Response(JSON.stringify({ preview, previews: [preview] }), { status: 200 })
          : new Response(
              JSON.stringify({
                imported: [{ workItem: { id: 'item', removedAt: '2026-11-06T11:00:00.000Z' } }],
              }),
              { status: 201 },
            ),
      ),
    );
    const onClose = vi.fn();
    const onAdded = vi.fn(async () => undefined);
    render(
      <AddSourceDialog open csrfToken="token" roots={roots} onClose={onClose} onAdded={onAdded} />,
    );
    await user.click(screen.getByText('Agent receipt'));
    await user.type(screen.getByLabelText('Absolute local path'), 'D:\\work\\receipt.json');
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    expect(await screen.findByText(/removed earlier/u)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Import 1' }));
    expect(await screen.findByText(/Put it back under Removed/u)).toBeTruthy();
    expect(onAdded).toHaveBeenCalled();
    // The dialog stays open, since the inbox shows nothing new.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows discovery as idle when the dialog opens again after an add', async () => {
    const user = userEvent.setup();
    // The discovery never answers; adding a typed path succeeds meanwhile.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/repositories/discover')
        ? new Promise<Response>(() => undefined)
        : new Response(JSON.stringify({ repository: { id: 'repository-1' } }), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    const props = { csrfToken: 'token', roots, onClose, onAdded: async () => undefined };

    const { rerender } = render(<AddSourceDialog open {...props} />);
    await user.click(screen.getByText('Git repository'));
    await user.click(screen.getByRole('button', { name: 'Discover repositories' }));
    await user.type(screen.getByLabelText('Absolute local path'), '/work/alpha');
    await user.click(screen.getByRole('button', { name: 'Connect source' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2_000 });

    rerender(<AddSourceDialog open={false} {...props} />);
    rerender(<AddSourceDialog open {...props} />);
    expect(screen.getByRole('button', { name: 'Discover repositories' })).toBeTruthy();
  });
});
