// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BootstrapDto } from '../api.js';
import { WorkspaceDialog } from './WorkspaceDialog.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bootstrap: BootstrapDto = {
  mode: 'local',
  csrfToken: 'token',
  sourceIssues: [],
  roots: [],
  repositories: [],
  receipts: [],
  workItems: [],
  removed: { roots: [], repositories: [], workItems: [] },
  contracts: [],
  checks: [],
  evidence: [],
  verdicts: [],
  signingKey: { keyId: 'e'.repeat(64) },
  readiness: {},
};

const counts = {
  approvedRoots: 1,
  repositories: 1,
  receipts: 1,
  workItems: 1,
  contracts: 0,
  checks: 1,
  evidence: 1,
  verdicts: 2,
};
const none = Object.fromEntries(Object.keys(counts).map((key) => [key, 0]));
const result = {
  imported: counts,
  unchanged: none,
  added: {
    roots: [{ path: '/work/restored', label: 'Restored work' }],
    repositories: [{ name: 'importer', path: '/work/restored/importer' }],
    checks: [{ label: 'Unit tests', executable: 'node' }],
    workItems: [{ title: 'Fix the importer' }],
    removed: [],
  },
};

describe('workspace restore', () => {
  it('shows what a backup adds and restores it only once confirmed', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(JSON.stringify(result), {
          status: String(input).endsWith('/import') ? 201 : 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onImported = vi.fn(async () => undefined);

    render(
      <WorkspaceDialog
        open
        bootstrap={bootstrap}
        onClose={() => undefined}
        onImported={onImported}
      />,
    );
    await user.upload(
      screen.getByLabelText('Choose a VeriDone workspace JSON backup'),
      new File(['{"schemaVersion":2}'], 'backup.json', { type: 'application/json' }),
    );

    expect(await screen.findByText('/work/restored')).toBeTruthy();
    expect(screen.getByText('Fix the importer')).toBeTruthy();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/v1/workspace/preview',
    ]);
    expect(onImported).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Restore these records' }));

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/v1/workspace/preview',
      '/api/v1/workspace/import',
    ]);
    expect(onImported).toHaveBeenCalled();
  });

  it('lists the records a backup holds as removed apart from the rest', async () => {
    const user = userEvent.setup();
    const withRemoved = {
      ...result,
      added: {
        roots: [],
        repositories: [],
        checks: [],
        workItems: [],
        removed: [{ kind: 'workItem', name: 'Fix the importer' }],
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(withRemoved), { status: 200 })),
    );
    render(
      <WorkspaceDialog
        open
        bootstrap={bootstrap}
        onClose={() => undefined}
        onImported={vi.fn(async () => undefined)}
      />,
    );
    await user.upload(
      screen.getByLabelText('Choose a VeriDone workspace JSON backup'),
      new File(['{"schemaVersion":2}'], 'backup.json', { type: 'application/json' }),
    );
    expect(await screen.findByText('Removed records, which stay removed')).toBeTruthy();
    expect(screen.getByText('Fix the importer')).toBeTruthy();
  });

  it('counts removed records among what a backup carries', () => {
    render(
      <WorkspaceDialog
        open
        bootstrap={{
          ...bootstrap,
          removed: {
            roots: [],
            repositories: [],
            workItems: [
              {
                id: 'item',
                repositoryId: null,
                sourceType: 'codex',
                sourceRef: 'codex:run',
                title: 'Fix the importer',
                claim: 'The importer is fixed.',
                sourceLabel: 'Codex',
                updatedAt: '2026-11-06T10:00:00.000Z',
                snapshotFingerprint: null,
                humanVerdict: null,
                claimHash: '9'.repeat(64),
                removedAt: '2026-11-06T11:00:00.000Z',
                removedReason: 'Added by mistake.',
              },
            ],
          },
        }}
        onClose={() => undefined}
        onImported={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getByText('1 records in this workspace')).toBeTruthy();
    expect(screen.getByText(/1 removed/u)).toBeTruthy();
  });

  // A second backup chosen while the first is read would race it: the later answer could show, and be restored,
  // for the other file.
  it('takes no other backup while one is being read', async () => {
    const user = userEvent.setup();
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ),
    );

    render(
      <WorkspaceDialog
        open
        bootstrap={bootstrap}
        onClose={() => undefined}
        onImported={vi.fn(async () => undefined)}
      />,
    );
    const input = screen.getByLabelText<HTMLInputElement>(
      'Choose a VeriDone workspace JSON backup',
    );
    await user.upload(
      input,
      new File(['{"schemaVersion":2}'], 'backup.json', { type: 'application/json' }),
    );

    expect(input.disabled).toBe(true);
    answer(new Response(JSON.stringify(result), { status: 200 }));
    expect(await screen.findByText('/work/restored')).toBeTruthy();
    expect(input.disabled).toBe(false);
  });
});
