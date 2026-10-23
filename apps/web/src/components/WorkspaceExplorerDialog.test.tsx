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
    },
  ],
  evidence: [],
  verdicts: [],
};

describe('workspace explorer checks', () => {
  it('shows the file it would pin and pins exactly that file', async () => {
    const user = userEvent.setup();
    const candidate = { path: '/opt/node-24/bin/node', sha256: 'c'.repeat(64) };
    const onReviewTool = vi.fn(async () => candidate);
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
    await user.click(
      screen.getByRole('button', {
        name: 'Review the tool for Unit tests before pinning it again',
      }),
    );
    expect(onReviewTool).toHaveBeenCalledWith('check');
    expect(await screen.findByText(candidate.path)).toBeTruthy();
    expect(screen.getByText(candidate.sha256)).toBeTruthy();
    expect(onPinTool).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Pin this file' }));
    expect(onPinTool).toHaveBeenCalledWith('check', candidate);
  });
});
