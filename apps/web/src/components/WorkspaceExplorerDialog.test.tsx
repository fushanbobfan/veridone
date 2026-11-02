// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BootstrapDto } from '../api.js';
import { WorkspaceExplorerDialog } from './WorkspaceExplorerDialog.js';

afterEach(cleanup);

const bootstrap: BootstrapDto = {
  mode: 'local',
  csrfToken: 'token',
  sourceIssues: [],
  roots: [],
  repositories: [],
  receipts: [],
  workItems: [],
  contracts: [],
  checks: [
    {
      id: 'check',
      repositoryId: 'repo',
      label: 'Unit tests',
      kind: 'test',
      executable: 'node',
      args: ['--test'],
      versionArgs: ['--version'],
      scopePaths: [],
      cwdRelative: '.',
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
      resolvedExecutable: '/opt/node/bin/node',
      executableSha256: 'a'.repeat(64),
      definitionHash: 'b'.repeat(64),
      approvedAt: '2026-10-22T10:00:00.000Z',
      setupArgs: [],
      setupTimeoutMs: 600_000,
    },
  ],
  evidence: [],
  verdicts: [],
  signingKey: { keyId: 'e'.repeat(64) },
  readiness: {},
};

describe('workspace explorer checks', () => {
  it('shows the file it would pin and pins exactly that file', async () => {
    const user = userEvent.setup();
    const candidate = { path: '/opt/node-24/bin/node', sha256: 'c'.repeat(64) };
    let answerReview: (value: typeof candidate) => void = () => undefined;
    const onReviewTool = vi.fn(
      () =>
        new Promise<typeof candidate>((resolve) => {
          answerReview = resolve;
        }),
    );
    const onPinTool = vi.fn(async () => undefined);

    render(
      <WorkspaceExplorerDialog
        open
        section="checks"
        bootstrap={bootstrap}
        onSection={() => undefined}
        onClose={() => undefined}
        onReviewTool={onReviewTool}
        onPinTool={onPinTool}
      />,
    );

    expect(screen.getByText('/opt/node/bin/node')).toBeTruthy();
    // The accessible name starts with the visible text, as WCAG 2.5.3 asks, in both states.
    await user.click(screen.getByRole('button', { name: 'Pin tool again for Unit tests' }));
    expect(onReviewTool).toHaveBeenCalledWith('check');
    expect(screen.getByRole('button', { name: 'Reading the tool…' })).toBeTruthy();
    answerReview(candidate);
    expect(await screen.findByText(candidate.path)).toBeTruthy();
    expect(screen.getByText(candidate.sha256)).toBeTruthy();
    expect(onPinTool).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Pin this file' }));
    expect(onPinTool).toHaveBeenCalledWith('check', candidate);
  });
});

describe('workspace explorer roots', () => {
  const withRoots: BootstrapDto = {
    ...bootstrap,
    roots: [
      {
        id: 'local',
        path: '/work/local',
        label: 'Local work',
        createdAt: '2026-10-22T10:00:00.000Z',
        status: 'approved',
      },
      {
        id: 'restored',
        path: '/work/restored',
        label: 'Restored work',
        createdAt: '2026-10-22T10:00:00.000Z',
        status: 'pending',
      },
    ],
  };

  it('offers approval for a restored root and none for an approved one', async () => {
    const user = userEvent.setup();
    const onApproveRoot = vi.fn(async () => undefined);

    render(
      <WorkspaceExplorerDialog
        open
        section="roots"
        bootstrap={withRoots}
        onSection={() => undefined}
        onClose={() => undefined}
        onApproveRoot={onApproveRoot}
      />,
    );

    expect(screen.getByText('/work/local')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Approve/u })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Approve Restored work' }));
    expect(onApproveRoot).toHaveBeenCalledWith('restored');
  });

  // An accessible name that leaves out the visible text fails WCAG 2.5.3 (axe: label-content-name-mismatch).
  it('names the approval button by the text it shows while the approval runs', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    const onApproveRoot = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    render(
      <WorkspaceExplorerDialog
        open
        section="roots"
        bootstrap={withRoots}
        onSection={() => undefined}
        onClose={() => undefined}
        onApproveRoot={onApproveRoot}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Approve Restored work' }));
    expect(screen.getByRole('button', { name: 'Approving…' })).toBeTruthy();
    finish();
    expect(await screen.findByRole('button', { name: 'Approve Restored work' })).toBeTruthy();
  });
});
