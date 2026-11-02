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
  contracts: [],
  checks: [],
  evidence: [],
  verdicts: [],
  signingKey: { keyId: 'e'.repeat(64) },
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
});
