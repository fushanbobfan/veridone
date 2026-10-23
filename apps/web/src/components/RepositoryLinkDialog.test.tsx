// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RepositoryDto } from '../api.js';
import { RepositoryLinkDialog } from './RepositoryLinkDialog.js';

const repositories: RepositoryDto[] = [
  {
    id: 'repo-a',
    path: 'D:\\work\\alpha',
    name: 'alpha',
    snapshot: {
      repositoryId: 'repo-a',
      head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      branch: 'main',
      statusEntries: [],
      worktreeHash: 'worktree-a',
      diffStats: {
        changedFiles: 0,
        additions: 0,
        deletions: 0,
        binaryFiles: 0,
        untrackedFiles: 0,
      },
      fingerprint: '1111111111111111111111111111111111111111111111111111111111111111',
      contractVersion: 'default-v1',
      checkDefinitionVersion: 'default-v1',
      capturedAt: '2026-07-22T19:00:00.000Z',
    },
    updatedAt: '2026-07-22T19:00:00.000Z',
  },
  {
    id: 'repo-b',
    path: 'D:\\work\\beta',
    name: 'beta',
    snapshot: {
      repositoryId: 'repo-b',
      head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      branch: 'agent/review',
      statusEntries: [' M README.md'],
      worktreeHash: 'worktree-b',
      diffStats: {
        changedFiles: 1,
        additions: 1,
        deletions: 0,
        binaryFiles: 0,
        untrackedFiles: 0,
      },
      fingerprint: '2222222222222222222222222222222222222222222222222222222222222222',
      contractVersion: 'default-v1',
      checkDefinitionVersion: 'default-v1',
      capturedAt: '2026-07-22T19:00:00.000Z',
    },
    updatedAt: '2026-07-22T19:00:00.000Z',
  },
];

afterEach(cleanup);

describe('repository link dialog', () => {
  it('requires an explicit repository choice and submits the selected snapshot', async () => {
    const user = userEvent.setup();
    const onLink = vi.fn(async () => undefined);

    render(
      <RepositoryLinkDialog
        open
        workItemTitle="Verify the reported change"
        repositories={repositories}
        onClose={() => undefined}
        onLink={onLink}
      />,
    );

    const submit = screen.getByRole('button', { name: 'Link current snapshot' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Repository' }), 'repo-b');
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByLabelText('Selected repository snapshot').textContent).toContain(
      '1 worktree change',
    );
    expect(screen.getByLabelText('Selected repository snapshot').textContent).toContain(
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );

    await user.click(submit);
    expect(onLink).toHaveBeenCalledOnce();
    expect(onLink).toHaveBeenCalledWith('repo-b');
  });
});
