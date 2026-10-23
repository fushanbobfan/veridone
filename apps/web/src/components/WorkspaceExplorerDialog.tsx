import { Archive, FileCheck2, FolderGit2, ListChecks, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import type { BootstrapDto, ToolCandidate } from '../api.js';
import type { WorkspaceSection } from './Navigation.js';
import { useDialogFocus } from './useDialogFocus.js';

const sections: Array<{
  id: WorkspaceSection;
  label: string;
  icon: typeof FolderGit2;
}> = [
  { id: 'repositories', label: 'Repositories', icon: FolderGit2 },
  { id: 'checks', label: 'Checks', icon: ListChecks },
  { id: 'contracts', label: 'Contracts', icon: FileCheck2 },
  { id: 'exports', label: 'Exports', icon: Archive },
];

export function WorkspaceExplorerDialog({
  open,
  section,
  bootstrap,
  onSection,
  onClose,
  onReviewTool,
  onPinTool,
}: {
  open: boolean;
  section: WorkspaceSection;
  bootstrap: BootstrapDto;
  onSection: (section: WorkspaceSection) => void;
  onClose: () => void;
  /** Reads the tool file that pinning would record now. */
  onReviewTool?: (checkId: string) => Promise<ToolCandidate>;
  /** Pins the reviewed file; the service refuses if another file resolves by then. */
  onPinTool?: (checkId: string, expected: ToolCandidate) => Promise<void>;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<(ToolCandidate & { checkId: string }) | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  useDialogFocus(open, onClose, dialog, closeButton);
  if (!open) return null;

  const attempt = async (checkId: string, action: () => Promise<void>) => {
    setBusy(checkId);
    setPinError(null);
    try {
      await action();
    } catch (caught) {
      setPinError(caught instanceof Error ? caught.message : 'The tool could not be pinned.');
    } finally {
      setBusy(null);
    }
  };
  const reviewTool = (checkId: string) =>
    attempt(checkId, async () => {
      if (!onReviewTool) return;
      setCandidate({ ...(await onReviewTool(checkId)), checkId });
    });
  const pinTool = (checkId: string, reviewed: ToolCandidate) =>
    attempt(checkId, async () => {
      if (!onPinTool) return;
      await onPinTool(checkId, { path: reviewed.path, sha256: reviewed.sha256 });
      setCandidate(null);
    });

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="source-dialog explorer-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="section-label">Workspace explorer</span>
            <h2 id={titleId}>Inspect local review policy</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} ref={closeButton}>
            <X aria-hidden="true" size={18} />
            <span className="sr-only">Close workspace explorer</span>
          </button>
        </header>

        <div className="explorer-tabs" role="tablist" aria-label="Workspace sections">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={section === id}
              className={section === id ? 'selected' : undefined}
              onClick={() => onSection(id)}
            >
              <Icon aria-hidden="true" size={15} />
              {label}
            </button>
          ))}
        </div>

        <div className="explorer-panel" role="tabpanel" tabIndex={0}>
          {section === 'repositories' && (
            <div className="explorer-list">
              {bootstrap.repositories.length === 0 ? (
                <p>No repositories are connected.</p>
              ) : (
                bootstrap.repositories.map((repository) => (
                  <article key={repository.id}>
                    <div>
                      <strong>{repository.name}</strong>
                      <span>{repository.snapshot.branch ?? 'detached HEAD'}</span>
                    </div>
                    <dl>
                      <div>
                        <dt>HEAD</dt>
                        <dd className="mono">{repository.snapshot.head.slice(0, 12)}</dd>
                      </div>
                      <div>
                        <dt>Changed</dt>
                        <dd>{repository.snapshot.diffStats.changedFiles} files</dd>
                      </div>
                      <div>
                        <dt>Fingerprint</dt>
                        <dd className="mono">{repository.snapshot.fingerprint.slice(0, 12)}…</dd>
                      </div>
                    </dl>
                  </article>
                ))
              )}
            </div>
          )}

          {section === 'checks' && (
            <div className="explorer-list">
              {bootstrap.checks.length === 0 ? (
                <p>No checks are approved.</p>
              ) : (
                bootstrap.checks.map((check) => (
                  <article key={check.id}>
                    <div>
                      <strong>{check.label}</strong>
                      <span>{check.kind}</span>
                    </div>
                    <dl>
                      <div className="wide">
                        <dt>Pinned tool</dt>
                        <dd className="mono tool-path">
                          {check.resolvedExecutable ?? `${check.executable} · not pinned`}
                        </dd>
                      </div>
                      <div className="wide">
                        <dt>Arguments</dt>
                        <dd className="mono tool-path">{JSON.stringify(check.args)}</dd>
                      </div>
                      <div>
                        <dt>SHA-256</dt>
                        <dd className="mono">
                          {check.executableSha256 ? `${check.executableSha256.slice(0, 12)}…` : '—'}
                        </dd>
                      </div>
                      <div>
                        <dt>Directory</dt>
                        <dd className="mono">{check.cwdRelative}</dd>
                      </div>
                      <div>
                        <dt>Approved</dt>
                        <dd>{check.approvedAt.slice(0, 10)}</dd>
                      </div>
                    </dl>
                    {onReviewTool &&
                      onPinTool &&
                      (candidate?.checkId === check.id ? (
                        <div className="pin-review" aria-label={`Tool to pin for ${check.label}`}>
                          <dl>
                            <div className="wide">
                              <dt>File to pin</dt>
                              <dd className="mono tool-path">{candidate.path}</dd>
                            </div>
                            <div className="wide">
                              <dt>Its SHA-256</dt>
                              <dd className="mono tool-path">{candidate.sha256}</dd>
                            </div>
                          </dl>
                          <div className="pin-actions">
                            <button
                              className="primary-action"
                              type="button"
                              onClick={() => void pinTool(check.id, candidate)}
                              disabled={busy !== null}
                            >
                              {busy === check.id ? 'Pinning…' : 'Pin this file'}
                            </button>
                            <button
                              className="secondary-action"
                              type="button"
                              onClick={() => setCandidate(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          className="secondary-action pin-action"
                          type="button"
                          onClick={() => void reviewTool(check.id)}
                          disabled={busy !== null}
                          aria-label={`Review the tool for ${check.label} before pinning it again`}
                        >
                          {busy === check.id ? 'Reading the tool…' : 'Pin tool again'}
                        </button>
                      ))}
                  </article>
                ))
              )}
              <div className="dialog-message" aria-live="polite">
                {pinError && <span className="error-message">{pinError}</span>}
              </div>
            </div>
          )}

          {section === 'contracts' && (
            <div className="explorer-list">
              {bootstrap.contracts.map((contract) => (
                <article key={contract.id}>
                  <div>
                    <strong>{contract.title}</strong>
                    <span className="mono">{contract.version}</span>
                  </div>
                  <ul>
                    {contract.criteria.map((criterion, index) => (
                      <li key={criterion.id ?? `${contract.id}-${index}`}>
                        <span>{criterion.title ?? criterion.id ?? `Criterion ${index + 1}`}</span>
                        <small>{criterion.required === false ? 'Optional' : 'Required'}</small>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          )}

          {section === 'exports' && (
            <div className="explorer-list">
              {bootstrap.verdicts.length === 0 ? (
                <p>No verdicts are ready to export.</p>
              ) : (
                bootstrap.verdicts.map((verdict) => {
                  const item = bootstrap.workItems.find(
                    (candidate) => candidate.id === verdict.workItemId,
                  );
                  return (
                    <article key={verdict.id}>
                      <div>
                        <strong>{item?.title ?? 'Unknown work item'}</strong>
                        <span>{verdict.decision}</span>
                      </div>
                      <div className="export-links" aria-label="Acceptance packet formats">
                        {(['html', 'md', 'json'] as const).map((format) => (
                          <a
                            key={format}
                            href={`/api/v1/work-items/${verdict.workItemId}/packet/${format}`}
                            download
                          >
                            {format.toUpperCase()}
                          </a>
                        ))}
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
