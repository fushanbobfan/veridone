import { useEffect, useMemo, useState } from 'react';

import {
  cancelCheck,
  fetchBootstrap,
  fetchToolCandidate,
  linkWorkItem,
  pinCheckTool,
  runCheck,
  type BootstrapDto,
  type ToolCandidate,
  type VerdictDto,
  type VerdictExpectation,
} from './api.js';
import { AddSourceDialog } from './components/AddSourceDialog.js';
import { CheckDialog } from './components/CheckDialog.js';
import { Navigation } from './components/Navigation.js';
import { RepositoryLinkDialog } from './components/RepositoryLinkDialog.js';
import type { WorkspaceSection } from './components/Navigation.js';
import { ReviewDetail } from './components/ReviewDetail.js';
import { ReviewInbox } from './components/ReviewInbox.js';
import { VerdictDialog } from './components/VerdictDialog.js';
import { WorkspaceDialog } from './components/WorkspaceDialog.js';
import { WorkspaceExplorerDialog } from './components/WorkspaceExplorerDialog.js';
import { demoReviews, type ReviewState } from './data.js';
import { latestVerdict, workItemToReview } from './local-data.js';

type Theme = 'light' | 'dark';
type ThemePreference = Theme | 'system';
type ReviewSort = 'priority' | 'newest' | 'repository';

function initialView(): {
  reviewId: string;
  filter: 'all' | ReviewState;
  query: string;
  sort: ReviewSort;
} {
  const parameters = new URLSearchParams(window.location.search);
  const requestedFilter = parameters.get('filter');
  const requestedSort = parameters.get('sort');
  return {
    reviewId: parameters.get('review') ?? demoReviews[0]?.id ?? '',
    filter:
      requestedFilter === 'stale' ||
      requestedFilter === 'blocked' ||
      requestedFilter === 'ready' ||
      requestedFilter === 'decided'
        ? requestedFilter
        : ('all' as const),
    query: parameters.get('q') ?? '',
    sort:
      requestedSort === 'newest' || requestedSort === 'repository'
        ? requestedSort
        : ('priority' as const),
  };
}

function initialTheme(): ThemePreference {
  const stored = localStorage.getItem('veridone-theme');
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

/** Keeps the reviewer's selection (or deep link) across refreshes while that work item exists. */
function selectionAfterRefresh(current: string, next: BootstrapDto): string {
  return next.workItems.some((item) => item.id === current)
    ? current
    : (next.workItems[0]?.id ?? '');
}

function verdictSubject(bootstrap: BootstrapDto, workItemId: string) {
  const workItem = bootstrap.workItems.find((item) => item.id === workItemId);
  const repository = bootstrap.repositories.find(
    (candidate) => candidate.id === workItem?.repositoryId,
  );
  return {
    title: workItem?.title ?? 'Unknown work item',
    repository: repository?.name ?? 'Unlinked',
    head: repository?.snapshot.head ?? '',
    fingerprint: repository?.snapshot.fingerprint ?? '',
  };
}

/** The state a verdict is decided on: repository fingerprint, latest verdict, and claim. */
function verdictExpectation(bootstrap: BootstrapDto, workItemId: string): VerdictExpectation {
  const workItem = bootstrap.workItems.find((item) => item.id === workItemId);
  const repository = bootstrap.repositories.find(
    (candidate) => candidate.id === workItem?.repositoryId,
  );
  return {
    fingerprint: repository?.snapshot.fingerprint ?? null,
    verdictId: latestVerdict(bootstrap.verdicts, workItemId)?.id ?? null,
    claimHash: workItem?.claimHash ?? '',
  };
}

function describeChange(opened: VerdictExpectation, now: VerdictExpectation): string | null {
  if (now.fingerprint !== opened.fingerprint) {
    return 'The repository changed after this dialog opened.';
  }
  if (now.verdictId !== opened.verdictId) {
    return 'Another verdict was recorded after this dialog opened.';
  }
  if (now.claimHash !== opened.claimHash) return 'The claim changed after this dialog opened.';
  return null;
}

function verdictLabel(verdict: VerdictDto, currentFingerprint: string | undefined): string {
  const override = verdict.overrideReason ? ` · override: ${verdict.overrideReason}` : '';
  const superseded =
    verdict.snapshotFingerprint === currentFingerprint
      ? ''
      : ' · superseded by a later repository state';
  return `${verdict.decision}${override}${superseded}`;
}

export function App() {
  const [initial] = useState(initialView);
  const [selectedId, setSelectedId] = useState(initial.reviewId);
  const [filter, setFilter] = useState<'all' | ReviewState>(initial.filter);
  const [query, setQuery] = useState(initial.query);
  const [sort, setSort] = useState<ReviewSort>(initial.sort);
  const [themePreference, setThemePreference] = useState<ThemePreference>(initialTheme);
  const [systemTheme, setSystemTheme] = useState<Theme>(() =>
    window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
  );
  const theme: Theme = themePreference === 'system' ? systemTheme : themePreference;
  const [mobilePane, setMobilePane] = useState<'inbox' | 'detail'>('inbox');
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [bootstrap, setBootstrap] = useState<BootstrapDto | null>(null);
  const [connectionState, setConnectionState] = useState<'loading' | 'ready' | 'demo'>(
    import.meta.env.MODE === 'test' ? 'demo' : 'loading',
  );
  const [serviceUnavailable, setServiceUnavailable] = useState(false);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [checkDialogOpen, setCheckDialogOpen] = useState(false);
  const [repositoryDialogOpen, setRepositoryDialogOpen] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection | null>(null);
  const [verdictIntent, setVerdictIntent] = useState<{
    decision: 'accepted' | 'changes-requested' | 'rejected';
    overrideRequired: boolean;
    workItemId: string;
    subject: ReturnType<typeof verdictSubject>;
    expected: VerdictExpectation;
  } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const reviews = useMemo(
    () =>
      bootstrap?.mode === 'local'
        ? bootstrap.workItems.map((item) => workItemToReview(item, bootstrap))
        : demoReviews,
    [bootstrap],
  );
  const selected = useMemo(
    () => reviews.find((item) => item.id === selectedId) ?? reviews[0],
    [reviews, selectedId],
  );

  const reloadWorkspace = async () => {
    const next = await fetchBootstrap();
    setBootstrap(next);
    setConnectionState(next.mode === 'local' ? 'ready' : 'demo');
    setSelectedId((current) => selectionAfterRefresh(current, next));
  };

  useEffect(() => {
    if (import.meta.env.MODE === 'test') return;
    const controller = new AbortController();
    const update = () =>
      fetchBootstrap(controller.signal)
        .then((next) => {
          setBootstrap(next);
          setConnectionState(next.mode === 'local' ? 'ready' : 'demo');
          setServiceUnavailable(false);
          if (next.mode === 'local') {
            setSelectedId((current) => selectionAfterRefresh(current, next));
          }
        })
        .catch(() => {
          // Static/public deployments intentionally fall back to the labeled synthetic demo.
          setConnectionState('demo');
          setServiceUnavailable(import.meta.env.VITE_PUBLIC_DEMO !== '1');
        });
    void update();
    const interval = window.setInterval(() => void update(), 15_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('veridone-theme', themePreference);
  }, [theme, themePreference]);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-color-scheme: light)');
    const update = () => setSystemTheme(preference.matches ? 'light' : 'dark');
    preference.addEventListener?.('change', update);
    return () => preference.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId) url.searchParams.set('review', selectedId);
    else url.searchParams.delete('review');
    if (filter === 'all') url.searchParams.delete('filter');
    else url.searchParams.set('filter', filter);
    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    if (sort === 'priority') url.searchParams.delete('sort');
    else url.searchParams.set('sort', sort);
    window.history.replaceState(null, '', url);
  }, [filter, query, selectedId, sort]);

  if (connectionState === 'loading') {
    return (
      <main className="loading-workspace" aria-busy="true" aria-live="polite">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            V
          </span>
          <span>VeriDone</span>
        </div>
        <span className="loading-line" />
        <span className="loading-line short" />
        <p>Refreshing repository fingerprints and local evidence…</p>
      </main>
    );
  }

  if (!selected) {
    return (
      <div className="empty-workspace">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            V
          </span>
          <span>VeriDone</span>
        </div>
        <span className="section-label">Local workspace</span>
        <h1>No evidence sources yet</h1>
        <p>Approve a root, then add a Git repository or agent receipt.</p>
        <button className="primary-action" type="button" onClick={() => setSourceDialogOpen(true)}>
          Add first source
        </button>
        {bootstrap && (
          <AddSourceDialog
            open={sourceDialogOpen}
            csrfToken={bootstrap.csrfToken}
            roots={bootstrap.roots}
            onClose={() => setSourceDialogOpen(false)}
            onAdded={reloadWorkspace}
          />
        )}
      </div>
    );
  }

  const localWorkItem = bootstrap?.workItems.find((item) => item.id === selected.id);
  const localVerdict = bootstrap ? latestVerdict(bootstrap.verdicts, selected.id) : undefined;
  const localRepository = localWorkItem?.repositoryId
    ? bootstrap?.repositories.find((repository) => repository.id === localWorkItem.repositoryId)
    : null;
  const localChecks = localRepository
    ? (bootstrap?.checks.filter((check) => check.repositoryId === localRepository.id) ?? [])
    : [];
  const isLocal = bootstrap?.mode === 'local' && Boolean(localWorkItem);

  // The dialog keeps the work item it was opened for, whatever the inbox selects meanwhile, and
  // the state it showed then, which the server compares before recording the verdict.
  const openVerdict = (
    decision: 'accepted' | 'changes-requested' | 'rejected',
    overrideRequired = false,
  ) => {
    if (!bootstrap || !localWorkItem) return;
    setVerdictIntent({
      decision,
      overrideRequired,
      workItemId: localWorkItem.id,
      subject: verdictSubject(bootstrap, localWorkItem.id),
      expected: verdictExpectation(bootstrap, localWorkItem.id),
    });
  };

  const performEvidenceAction = async () => {
    if (!bootstrap || !localWorkItem) return;
    setActionError(null);
    if (!localWorkItem.repositoryId) {
      if (bootstrap.repositories.length === 0) {
        setSourceDialogOpen(true);
        return;
      }
      setRepositoryDialogOpen(true);
      return;
    }
    if (localWorkItem.snapshotFingerprint !== localRepository?.snapshot.fingerprint) {
      setActionBusy(true);
      try {
        await linkWorkItem(localWorkItem.id, localWorkItem.repositoryId, bootstrap.csrfToken);
        await reloadWorkspace();
      } catch (caught) {
        setActionError(
          caught instanceof Error ? caught.message : 'The work item could not be rebound.',
        );
      } finally {
        setActionBusy(false);
      }
      return;
    }
    if (localChecks.length === 0) {
      setCheckDialogOpen(true);
      return;
    }

    setActionBusy(true);
    try {
      for (const check of localChecks) {
        const runId = crypto.randomUUID();
        setActiveRunId(runId);
        await runCheck(check.id, localWorkItem.id, bootstrap.csrfToken, runId);
      }
      await reloadWorkspace();
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : 'The checks could not be completed.',
      );
    } finally {
      setActiveRunId(null);
      setActionBusy(false);
    }
  };

  const cancelEvidenceAction = async () => {
    if (!bootstrap || !activeRunId) return;
    try {
      await cancelCheck(activeRunId, bootstrap.csrfToken);
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : 'The check could not be cancelled.',
      );
    }
  };

  const evidenceActionLabel =
    isLocal && bootstrap
      ? !localWorkItem?.repositoryId
        ? bootstrap.repositories.length > 0
          ? 'Link to repository'
          : 'Add a repository'
        : localWorkItem.snapshotFingerprint !== localRepository?.snapshot.fingerprint
          ? 'Rebind to current state'
          : localChecks.length === 0
            ? 'Approve a check'
            : selected.state === 'ready'
              ? 'Re-run approved checks'
              : 'Run approved checks'
      : selected.state === 'ready'
        ? undefined
        : 'Run open checks';

  const exportPacket = () => {
    const anchor = document.createElement('a');
    anchor.href = `/api/v1/work-items/${selected.id}/packet/html`;
    anchor.download = `veridone-${selected.id}.html`;
    anchor.click();
  };

  const selectReview = (id: string) => {
    setSelectedId(id);
    setMobilePane('detail');
    window.setTimeout(() => document.querySelector<HTMLElement>('#review-detail')?.focus(), 240);
  };

  return (
    <div className={`app-shell mobile-${mobilePane}`}>
      <a className="skip-link" href="#review-detail">
        Skip to selected review
      </a>
      <Navigation
        theme={theme}
        reviewCount={reviews.length}
        serviceMode={bootstrap?.mode ?? 'demo'}
        themePreference={themePreference}
        onToggleTheme={() =>
          setThemePreference((current) =>
            current === 'system'
              ? theme === 'dark'
                ? 'light'
                : 'dark'
              : current === 'light'
                ? 'dark'
                : 'system',
          )
        }
        {...(bootstrap?.mode === 'local'
          ? {
              onOpenWorkspace: () => setWorkspaceDialogOpen(true),
              onOpenSection: (section: WorkspaceSection) => setWorkspaceSection(section),
            }
          : {})}
      />
      <ReviewInbox
        items={reviews}
        selectedId={selected.id}
        filter={filter}
        query={query}
        sort={sort}
        dataLabel={
          bootstrap?.mode === 'local'
            ? 'Live local evidence'
            : serviceUnavailable
              ? 'Local service unavailable · synthetic demo'
              : 'Synthetic demo data'
        }
        sourceIssues={bootstrap?.sourceIssues ?? []}
        {...(bootstrap?.mode === 'local' ? { onAddSource: () => setSourceDialogOpen(true) } : {})}
        onFilter={setFilter}
        onQuery={setQuery}
        onSort={setSort}
        onSelect={selectReview}
      />
      {bootstrap && (
        <AddSourceDialog
          open={sourceDialogOpen}
          csrfToken={bootstrap.csrfToken}
          roots={bootstrap.roots}
          onClose={() => setSourceDialogOpen(false)}
          onAdded={reloadWorkspace}
        />
      )}
      <ReviewDetail
        item={selected}
        decision={
          localVerdict
            ? verdictLabel(localVerdict, localRepository?.snapshot.fingerprint)
            : (decisions[selected.id] ?? null)
        }
        {...(evidenceActionLabel ? { evidenceActionLabel } : {})}
        evidenceActionBusy={actionBusy}
        {...(activeRunId ? { onCancelEvidence: cancelEvidenceAction } : {})}
        onBack={() => setMobilePane('inbox')}
        {...(isLocal ? { onEvidenceAction: performEvidenceAction, onExport: exportPacket } : {})}
        onViewContract={() => setWorkspaceSection('contracts')}
        onAccept={() => {
          if (isLocal) {
            openVerdict('accepted');
          } else {
            setDecisions((current) => ({
              ...current,
              [selected.id]: 'Accepted by you',
            }));
          }
        }}
        onRequestChanges={() => {
          if (isLocal) {
            openVerdict('changes-requested');
          } else {
            setDecisions((current) => ({
              ...current,
              [selected.id]: 'Changes requested by you',
            }));
          }
        }}
        onReject={() => {
          if (isLocal) {
            openVerdict('rejected');
          } else {
            setDecisions((current) => ({
              ...current,
              [selected.id]: 'Rejected by you',
            }));
          }
        }}
        {...(isLocal
          ? {
              onOverride: () => openVerdict('accepted', true),
            }
          : {})}
      />
      {bootstrap && localRepository && (
        <CheckDialog
          open={checkDialogOpen}
          repositoryId={localRepository.id}
          csrfToken={bootstrap.csrfToken}
          onClose={() => setCheckDialogOpen(false)}
          onAdded={reloadWorkspace}
        />
      )}
      {bootstrap && localWorkItem && (
        <RepositoryLinkDialog
          open={repositoryDialogOpen}
          workItemTitle={localWorkItem.title}
          repositories={bootstrap.repositories}
          onClose={() => setRepositoryDialogOpen(false)}
          onLink={async (repositoryId) => {
            await linkWorkItem(localWorkItem.id, repositoryId, bootstrap.csrfToken);
            await reloadWorkspace();
          }}
        />
      )}
      {bootstrap && verdictIntent && (
        <VerdictDialog
          open
          workItemId={verdictIntent.workItemId}
          subject={verdictIntent.subject}
          expected={verdictIntent.expected}
          changedSinceOpened={describeChange(
            verdictIntent.expected,
            verdictExpectation(bootstrap, verdictIntent.workItemId),
          )}
          decision={verdictIntent.decision}
          overrideRequired={verdictIntent.overrideRequired}
          csrfToken={bootstrap.csrfToken}
          onClose={() => setVerdictIntent(null)}
          onRecorded={reloadWorkspace}
        />
      )}
      {bootstrap?.mode === 'local' && (
        <WorkspaceDialog
          open={workspaceDialogOpen}
          bootstrap={bootstrap}
          onClose={() => setWorkspaceDialogOpen(false)}
          onImported={reloadWorkspace}
        />
      )}
      {bootstrap && (
        <WorkspaceExplorerDialog
          open={workspaceSection !== null}
          section={workspaceSection ?? 'repositories'}
          bootstrap={bootstrap}
          onSection={setWorkspaceSection}
          onClose={() => setWorkspaceSection(null)}
          {...(bootstrap.mode === 'local'
            ? {
                onReviewTool: fetchToolCandidate,
                onPinTool: async (checkId: string, expected: ToolCandidate) => {
                  await pinCheckTool(checkId, expected, bootstrap.csrfToken);
                  await reloadWorkspace();
                },
              }
            : {})}
        />
      )}
      {actionError && (
        <div className="action-toast" role="alert">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
