// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BootstrapDto, RepositoryDto, WorkItemDto } from '../api.js';
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
  removed: { roots: [], repositories: [], workItems: [] },
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
      retiredAt: null,
      retiredReason: null,
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

  it('retires a check only with a reason, and offers to replace it', async () => {
    const user = userEvent.setup();
    const onRetireCheck = vi.fn(async () => undefined);
    const onReplaceCheck = vi.fn();
    render(
      <WorkspaceExplorerDialog
        open
        section="checks"
        bootstrap={bootstrap}
        onSection={() => undefined}
        onClose={() => undefined}
        onRetireCheck={onRetireCheck}
        onReplaceCheck={onReplaceCheck}
        onReviewTool={vi.fn()}
        onPinTool={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Replace Unit tests' }));
    expect(onReplaceCheck).toHaveBeenCalledWith(bootstrap.checks[0]);

    await user.click(screen.getByRole('button', { name: 'Retire Unit tests' }));
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Retire this check' });
    expect(confirm.disabled).toBe(true);
    await user.type(screen.getByLabelText('Why it retires'), '  It had a typo.  ');
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);
    expect(onRetireCheck).toHaveBeenCalledWith(bootstrap.checks[0], 'It had a typo.');
  });

  it('shows why a check could not retire', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceExplorerDialog
        open
        section="checks"
        bootstrap={bootstrap}
        onSection={() => undefined}
        onClose={() => undefined}
        onRetireCheck={vi.fn(async () => {
          throw new Error('The check changed after you opened it.');
        })}
        onReviewTool={vi.fn()}
        onPinTool={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Retire Unit tests' }));
    await user.type(screen.getByLabelText('Why it retires'), 'A reason.');
    await user.click(screen.getByRole('button', { name: 'Retire this check' }));
    expect(await screen.findByText('The check changed after you opened it.')).toBeTruthy();
  });

  it('lists a retired check with its reason and offers nothing on it', () => {
    const retired: BootstrapDto = {
      ...bootstrap,
      checks: bootstrap.checks.map((check) => ({
        ...check,
        retiredAt: '2026-11-05T10:00:00.000Z',
        retiredReason: 'It had a typo.',
      })),
    };
    render(
      <WorkspaceExplorerDialog
        open
        section="checks"
        bootstrap={retired}
        onSection={() => undefined}
        onClose={() => undefined}
        onRetireCheck={vi.fn()}
        onReplaceCheck={vi.fn()}
        onReviewTool={vi.fn()}
        onPinTool={vi.fn()}
      />,
    );
    expect(screen.getByText('It had a typo.')).toBeTruthy();
    expect(screen.getByText('Retired 2026-11-05')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retire Unit tests' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace Unit tests' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pin tool again for Unit tests' })).toBeNull();
  });
});

describe('workspace explorer folders that are gone', () => {
  it('marks a missing root and shows a repository that cannot be read', async () => {
    const user = userEvent.setup();
    const withMissing: BootstrapDto = {
      ...bootstrap,
      sourceIssues: [{ repositoryId: 'repo', message: 'VeriDone cannot read the repository app.' }],
      roots: [
        {
          id: 'gone',
          path: '/work/gone',
          label: 'Gone',
          createdAt: '2026-10-22T10:00:00.000Z',
          status: 'approved',
          missing: true,
          removedAt: null,
          removedReason: null,
        },
      ],
      repositories: [
        {
          id: 'repo',
          path: '/work/gone/app',
          name: 'app',
          snapshot: {
            repositoryId: 'repo',
            head: 'c'.repeat(40),
            branch: 'main',
            statusEntries: [],
            worktreeHash: 'd'.repeat(64),
            diffStats: {
              changedFiles: 0,
              additions: 0,
              deletions: 0,
              binaryFiles: 0,
              untrackedFiles: 0,
            },
            fingerprint: 'a'.repeat(64),
            contractVersion: 'default-v1',
            checkDefinitionVersion: 'checks-v1',
            capturedAt: '2026-10-22T10:00:00.000Z',
          },
          updatedAt: '2026-10-22T10:00:00.000Z',
          removedAt: null,
          removedReason: null,
        },
      ],
    };
    const onSection = vi.fn();
    const { rerender } = render(
      <WorkspaceExplorerDialog
        open
        section="roots"
        bootstrap={withMissing}
        onSection={onSection}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('Approved · folder missing')).toBeTruthy();
    expect(screen.getByText(/add the new location as a new root/u)).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: 'Repositories' }));
    expect(onSection).toHaveBeenCalledWith('repositories');
    rerender(
      <WorkspaceExplorerDialog
        open
        section="repositories"
        bootstrap={withMissing}
        onSection={onSection}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('VeriDone cannot read the repository app.')).toBeTruthy();
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
        removedAt: null,
        removedReason: null,
      },
      {
        id: 'restored',
        path: '/work/restored',
        label: 'Restored work',
        createdAt: '2026-10-22T10:00:00.000Z',
        status: 'pending',
        removedAt: null,
        removedReason: null,
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

describe('workspace explorer removal', () => {
  const repository = (id: string, name: string, removedReason: string | null = null) =>
    ({
      id,
      path: `/work/local/${name}`,
      name,
      snapshot: {
        repositoryId: id,
        head: 'c'.repeat(40),
        branch: 'main',
        statusEntries: [],
        worktreeHash: 'd'.repeat(64),
        diffStats: {
          changedFiles: 0,
          additions: 0,
          deletions: 0,
          binaryFiles: 0,
          untrackedFiles: 0,
        },
        fingerprint: 'a'.repeat(64),
        contractVersion: 'default-v1',
        checkDefinitionVersion: 'checks-v1',
        capturedAt: '2026-10-22T10:00:00.000Z',
      },
      updatedAt: '2026-10-22T10:00:00.000Z',
      removedAt: removedReason ? '2026-11-06T10:00:00.000Z' : null,
      removedReason,
    }) satisfies RepositoryDto;
  const workItem = (removedReason: string | null = null) =>
    ({
      id: 'item',
      repositoryId: 'repo',
      sourceType: 'codex',
      sourceRef: 'codex:run',
      title: 'Fix the importer',
      claim: 'The importer is fixed.',
      sourceLabel: 'Codex receipt',
      updatedAt: '2026-10-22T10:00:00.000Z',
      snapshotFingerprint: 'a'.repeat(64),
      humanVerdict: null,
      claimHash: '9'.repeat(64),
      removedAt: removedReason ? '2026-11-06T10:00:00.000Z' : null,
      removedReason,
    }) satisfies WorkItemDto;
  const root = {
    id: 'local',
    path: '/work/local',
    label: 'Local work',
    createdAt: '2026-10-22T10:00:00.000Z',
    status: 'approved' as const,
    missing: false,
    onlyCovers: ['repo', 'other'],
    removedAt: null,
    removedReason: null,
  };
  const inWorkspace: BootstrapDto = {
    ...bootstrap,
    roots: [root],
    repositories: [repository('repo', 'app'), repository('other', 'lib')],
    workItems: [workItem()],
  };
  const withRemovals: BootstrapDto = {
    ...bootstrap,
    removed: {
      roots: [
        {
          ...root,
          label: 'Old drive',
          removedAt: '2026-11-06T10:00:00.000Z',
          removedReason: 'The disk is gone.',
        },
      ],
      repositories: [repository('repo', 'app', 'Moved to another disk.')],
      workItems: [workItem('Added by mistake.')],
    },
    verdicts: [
      {
        id: 'verdict',
        workItemId: 'item',
        decision: 'rejected',
        note: 'No.',
        decidedAt: '2026-10-22T10:06:00.000Z',
        snapshotFingerprint: 'a'.repeat(64),
        overrideReason: null,
        sequence: 1,
        previousVerdictId: null,
        claimHash: '9'.repeat(64),
      },
    ],
  };
  const explorer = {
    open: true,
    onSection: () => undefined,
    onClose: () => undefined,
  };

  it('removes a root with a reason and the repositories left ticked', async () => {
    const user = userEvent.setup();
    const onRemoveRoot = vi.fn(async () => undefined);
    render(
      <WorkspaceExplorerDialog
        {...explorer}
        section="roots"
        bootstrap={inWorkspace}
        onRemoveRoot={onRemoveRoot}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Remove Local work' }));
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'app' }).checked).toBe(true);
    const lib = screen.getByRole<HTMLInputElement>('checkbox', { name: 'lib' });
    expect(lib.checked).toBe(true);
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove this root' });
    expect(confirm.disabled).toBe(true);

    await user.click(lib);
    await user.type(screen.getByLabelText('Why it is removed'), '  The disk is gone.  ');
    await user.click(confirm);
    expect(onRemoveRoot).toHaveBeenCalledWith('local', 'The disk is gone.', ['repo']);
    expect(await screen.findByText(/listed under Removed/u)).toBeTruthy();
  });

  it('removes a repository, and says what becomes of its work items', async () => {
    const user = userEvent.setup();
    const onRemoveRepository = vi.fn(async () => undefined);
    render(
      <WorkspaceExplorerDialog
        {...explorer}
        section="repositories"
        bootstrap={inWorkspace}
        onRemoveRepository={onRemoveRepository}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Remove app' }));
    expect(screen.getByText(/1 work item bound to it stays in the inbox/u)).toBeTruthy();
    await user.type(screen.getByLabelText('Why it is removed'), 'Moved to another disk.');
    await user.click(screen.getByRole('button', { name: 'Remove this repository' }));
    expect(onRemoveRepository).toHaveBeenCalledWith('repo', 'Moved to another disk.');
    expect(await screen.findByText(/listed under Removed/u)).toBeTruthy();
  });

  it('leaves the message of the last change behind when it closes', async () => {
    const user = userEvent.setup();
    const props = {
      ...explorer,
      section: 'repositories' as const,
      bootstrap: inWorkspace,
      onRemoveRepository: vi.fn(async () => undefined),
    };
    const { rerender } = render(<WorkspaceExplorerDialog {...props} />);
    await user.click(screen.getByRole('button', { name: 'Remove app' }));
    await user.type(screen.getByLabelText('Why it is removed'), 'Moved to another disk.');
    await user.click(screen.getByRole('button', { name: 'Remove this repository' }));
    expect(await screen.findByText(/listed under Removed/u)).toBeTruthy();

    rerender(<WorkspaceExplorerDialog {...props} open={false} />);
    rerender(<WorkspaceExplorerDialog {...props} />);
    expect(screen.queryByText(/listed under Removed/u)).toBeNull();
  });

  it('keeps focus inside the dialog when the operator keeps the record', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceExplorerDialog
        {...explorer}
        section="repositories"
        bootstrap={inWorkspace}
        onRemoveRepository={vi.fn(async () => undefined)}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove app' }));
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(document.activeElement).toBe(screen.getByRole('tabpanel'));
  });

  it('says why a repository put back cannot be read', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceExplorerDialog
        {...explorer}
        section="removed"
        bootstrap={withRemovals}
        onPutBackRepository={vi.fn(async () => 'VeriDone cannot read the repository app.')}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Put back app' }));
    expect(
      await screen.findByText('app is back. VeriDone cannot read the repository app.'),
    ).toBeTruthy();
  });

  it('shows why a removal was refused, and keeps what the operator wrote', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceExplorerDialog
        {...explorer}
        section="repositories"
        bootstrap={inWorkspace}
        onRemoveRepository={vi.fn(async () => {
          throw new Error('The repository app is already removed.');
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove app' }));
    await user.type(screen.getByLabelText('Why it is removed'), 'A reason.');
    await user.click(screen.getByRole('button', { name: 'Remove this repository' }));
    expect(await screen.findByText('The repository app is already removed.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Why it is removed').value).toBe('A reason.');
  });

  it('lists what was removed with its reason, and puts each record back', async () => {
    const user = userEvent.setup();
    const onApproveRoot = vi.fn(async () => undefined);
    const onPutBackRepository = vi.fn(async () => null);
    const onPutBackWorkItem = vi.fn(async () => undefined);
    render(
      <WorkspaceExplorerDialog
        {...explorer}
        section="removed"
        bootstrap={withRemovals}
        onApproveRoot={onApproveRoot}
        onPutBackRepository={onPutBackRepository}
        onPutBackWorkItem={onPutBackWorkItem}
      />,
    );

    expect(screen.getByText('The disk is gone.')).toBeTruthy();
    expect(screen.getByText('Moved to another disk.')).toBeTruthy();
    expect(screen.getByText('Added by mistake.')).toBeTruthy();
    expect(screen.getByText('Work item · removed 2026-11-06')).toBeTruthy();
    expect(screen.getByText(/1 verdict and 0 evidence records stay on record/u)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'JSON' }).getAttribute('href')).toBe(
      '/api/v1/work-items/item/packet/json',
    );

    await user.click(screen.getByRole('button', { name: 'Put back Old drive' }));
    expect(onApproveRoot).toHaveBeenCalledWith('local');
    await user.click(screen.getByRole('button', { name: 'Put back app' }));
    expect(onPutBackRepository).toHaveBeenCalledWith('repo');
    await user.click(screen.getByRole('button', { name: 'Put back Fix the importer' }));
    expect(onPutBackWorkItem).toHaveBeenCalledWith('item');
  });

  it('shows why a record could not go back', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceExplorerDialog
        {...explorer}
        section="removed"
        bootstrap={withRemovals}
        onApproveRoot={vi.fn(async () => {
          throw new Error('/work/local does not exist on this machine.');
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Put back Old drive' }));
    expect(await screen.findByText('/work/local does not exist on this machine.')).toBeTruthy();
  });

  it('says when nothing was removed', () => {
    render(<WorkspaceExplorerDialog {...explorer} section="removed" bootstrap={bootstrap} />);
    expect(screen.getByText('Nothing has been removed.')).toBeTruthy();
  });

  it('offers no removal where the workspace cannot act on it', () => {
    const { rerender } = render(
      <WorkspaceExplorerDialog {...explorer} section="roots" bootstrap={inWorkspace} />,
    );
    expect(screen.queryByRole('button', { name: /^Remove/u })).toBeNull();
    rerender(
      <WorkspaceExplorerDialog {...explorer} section="repositories" bootstrap={inWorkspace} />,
    );
    expect(screen.queryByRole('button', { name: /^Remove/u })).toBeNull();
    rerender(<WorkspaceExplorerDialog {...explorer} section="removed" bootstrap={withRemovals} />);
    expect(screen.queryByRole('button', { name: /^Put back/u })).toBeNull();
  });

  it("keeps a removed repository's checks on record, with no way to change them", () => {
    render(
      <WorkspaceExplorerDialog
        {...explorer}
        section="checks"
        bootstrap={withRemovals}
        onRetireCheck={vi.fn()}
        onReplaceCheck={vi.fn()}
        onReviewTool={vi.fn()}
        onPinTool={vi.fn()}
      />,
    );
    expect(screen.getByText('Repository removed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retire Unit tests' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace Unit tests' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pin tool again for Unit tests' })).toBeNull();
  });

  it('names a removed work item under Exports', () => {
    render(<WorkspaceExplorerDialog {...explorer} section="exports" bootstrap={withRemovals} />);
    expect(screen.getByText('Fix the importer')).toBeTruthy();
    expect(screen.getByText('rejected · work item removed')).toBeTruthy();
  });
});
