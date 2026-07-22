import { useEffect, useMemo, useState } from 'react';

import { fetchBootstrap, linkWorkItem, runCheck, type BootstrapDto } from './api.js';
import { AddSourceDialog } from './components/AddSourceDialog.js';
import { CheckDialog } from './components/CheckDialog.js';
import { Navigation } from './components/Navigation.js';
import { ReviewDetail } from './components/ReviewDetail.js';
import { ReviewInbox } from './components/ReviewInbox.js';
import { VerdictDialog } from './components/VerdictDialog.js';
import { demoReviews, type ReviewState } from './data.js';
import { workItemToReview } from './local-data.js';

type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  const stored = localStorage.getItem('veridone-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function App() {
  const [selectedId, setSelectedId] = useState(demoReviews[0]?.id ?? '');
  const [filter, setFilter] = useState<'all' | ReviewState>('all');
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [mobilePane, setMobilePane] = useState<'inbox' | 'detail'>('inbox');
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [bootstrap, setBootstrap] = useState<BootstrapDto | null>(null);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [checkDialogOpen, setCheckDialogOpen] = useState(false);
  const [verdictDecision, setVerdictDecision] = useState<'accepted' | 'changes-requested' | null>(
    null,
  );
  const [actionBusy, setActionBusy] = useState(false);
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
    setSelectedId((current) =>
      next.workItems.some((item) => item.id === current) ? current : (next.workItems[0]?.id ?? ''),
    );
  };

  useEffect(() => {
    if (import.meta.env.MODE === 'test') return;
    const controller = new AbortController();
    fetchBootstrap(controller.signal)
      .then((next) => {
        setBootstrap(next);
        if (next.mode === 'local' && next.workItems[0]) setSelectedId(next.workItems[0].id);
      })
      .catch(() => {
        // Static/public deployments intentionally fall back to the labeled synthetic demo.
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('veridone-theme', theme);
  }, [theme]);

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
        <p>Approve a root, then add a Git repository or harness receipt.</p>
        <button className="primary-action" type="button" onClick={() => setSourceDialogOpen(true)}>
          Add first source
        </button>
        {bootstrap && (
          <AddSourceDialog
            open={sourceDialogOpen}
            csrfToken={bootstrap.csrfToken}
            onClose={() => setSourceDialogOpen(false)}
            onAdded={reloadWorkspace}
          />
        )}
      </div>
    );
  }

  const localWorkItem = bootstrap?.workItems.find((item) => item.id === selected.id);
  const localRepository = localWorkItem?.repositoryId
    ? bootstrap?.repositories.find((repository) => repository.id === localWorkItem.repositoryId)
    : null;
  const localChecks = localRepository
    ? (bootstrap?.checks.filter((check) => check.repositoryId === localRepository.id) ?? [])
    : [];
  const isLocal = bootstrap?.mode === 'local' && Boolean(localWorkItem);

  const performEvidenceAction = async () => {
    if (!bootstrap || !localWorkItem) return;
    setActionError(null);
    if (!localWorkItem.repositoryId) {
      const repository = bootstrap.repositories[0];
      if (!repository) {
        setSourceDialogOpen(true);
        return;
      }
      setActionBusy(true);
      try {
        await linkWorkItem(localWorkItem.id, repository.id, bootstrap.csrfToken);
        await reloadWorkspace();
      } catch (caught) {
        setActionError(
          caught instanceof Error ? caught.message : 'The repository could not be linked.',
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
        await runCheck(check.id, localWorkItem.id, bootstrap.csrfToken);
      }
      await reloadWorkspace();
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : 'The checks could not be completed.',
      );
    } finally {
      setActionBusy(false);
    }
  };

  const evidenceActionLabel =
    isLocal && bootstrap
      ? !localWorkItem?.repositoryId
        ? bootstrap.repositories.length > 0
          ? `Link to ${bootstrap.repositories[0]?.name ?? 'repository'}`
          : 'Add a repository'
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
        onToggleTheme={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
      />
      <ReviewInbox
        items={reviews}
        selectedId={selected.id}
        filter={filter}
        dataLabel={bootstrap?.mode === 'local' ? 'Live local evidence' : 'Synthetic demo data'}
        {...(bootstrap?.mode === 'local' ? { onAddSource: () => setSourceDialogOpen(true) } : {})}
        onFilter={setFilter}
        onSelect={selectReview}
      />
      {bootstrap && (
        <AddSourceDialog
          open={sourceDialogOpen}
          csrfToken={bootstrap.csrfToken}
          onClose={() => setSourceDialogOpen(false)}
          onAdded={reloadWorkspace}
        />
      )}
      <ReviewDetail
        item={selected}
        decision={
          localWorkItem?.humanVerdict
            ? `Human verdict: ${localWorkItem.humanVerdict}`
            : (decisions[selected.id] ?? null)
        }
        {...(evidenceActionLabel ? { evidenceActionLabel } : {})}
        evidenceActionBusy={actionBusy}
        onBack={() => setMobilePane('inbox')}
        {...(isLocal ? { onEvidenceAction: performEvidenceAction, onExport: exportPacket } : {})}
        onAccept={() => {
          if (isLocal) {
            setVerdictDecision('accepted');
          } else {
            setDecisions((current) => ({
              ...current,
              [selected.id]: 'Accepted by you',
            }));
          }
        }}
        onRequestChanges={() => {
          if (isLocal) {
            setVerdictDecision('changes-requested');
          } else {
            setDecisions((current) => ({
              ...current,
              [selected.id]: 'Changes requested by you',
            }));
          }
        }}
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
      {bootstrap && localWorkItem && verdictDecision && (
        <VerdictDialog
          open
          workItemId={localWorkItem.id}
          decision={verdictDecision}
          csrfToken={bootstrap.csrfToken}
          onClose={() => setVerdictDecision(null)}
          onRecorded={reloadWorkspace}
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
