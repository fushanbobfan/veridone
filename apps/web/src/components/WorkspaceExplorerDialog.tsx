import { Archive, ArchiveX, FileCheck2, FolderGit2, FolderTree, ListChecks, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import type { BootstrapDto, CheckDto, ToolCandidate } from '../api.js';
import type { WorkspaceSection } from './Navigation.js';
import { useDialogFocus } from './useDialogFocus.js';

const sections: Array<{
  id: WorkspaceSection;
  label: string;
  icon: typeof FolderGit2;
}> = [
  { id: 'roots', label: 'Roots', icon: FolderTree },
  { id: 'repositories', label: 'Repositories', icon: FolderGit2 },
  { id: 'checks', label: 'Checks', icon: ListChecks },
  { id: 'contracts', label: 'Contracts', icon: FileCheck2 },
  { id: 'exports', label: 'Exports', icon: Archive },
  { id: 'removed', label: 'Removed', icon: ArchiveX },
];

const packetFormats = ['html', 'md', 'json'] as const;

/** Asks for the reason a record leaves, under text that says what its removal does. */
function RemovalForm({
  label,
  confirmLabel,
  reason,
  removing,
  disabled,
  children,
  onReason,
  onSubmit,
  onCancel,
}: {
  label: string;
  confirmLabel: string;
  reason: string;
  removing: boolean;
  disabled: boolean;
  children: ReactNode;
  onReason: (reason: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="retire-review"
      aria-label={`Remove ${label}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {children}
      <label>
        <span className="field-label">Why it is removed</span>
        <textarea
          className="text-field"
          value={reason}
          maxLength={2_000}
          onChange={(event) => onReason(event.currentTarget.value)}
          required
        />
      </label>
      <div className="pin-actions">
        <button
          className="primary-action"
          type="submit"
          disabled={disabled || reason.trim() === ''}
        >
          {removing ? 'Removing…' : confirmLabel}
        </button>
        <button className="secondary-action" type="button" onClick={onCancel}>
          Keep it
        </button>
      </div>
    </form>
  );
}

/** What becomes of a repository's work items when it leaves. */
function boundWorkItems(workItems: BootstrapDto['workItems'], repositoryId: string): string {
  const bound = workItems.filter((item) => item.repositoryId === repositoryId).length;
  if (bound === 0) return 'No work item in the inbox is bound to it.';
  return bound === 1
    ? '1 work item bound to it stays in the inbox on its last captured state, where you can link it elsewhere or decide it.'
    : `${bound} work items bound to it stay in the inbox on its last captured state, where you can link them elsewhere or decide them.`;
}

export function WorkspaceExplorerDialog({
  open,
  section,
  bootstrap,
  onSection,
  onClose,
  onReviewTool,
  onPinTool,
  onApproveRoot,
  onReplaceCheck,
  onRetireCheck,
  onRemoveRoot,
  onRemoveRepository,
  onPutBackRepository,
  onPutBackWorkItem,
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
  /** Approves a root restored from a backup, or puts a removed one back; the service checks the directory again first. */
  onApproveRoot?: (rootId: string) => Promise<void>;
  /** Opens the approval dialog filled in from this check, to approve a corrected one in its place. */
  onReplaceCheck?: (check: CheckDto) => void;
  /** Takes the check out of the gate; its record and evidence stay in the history. */
  onRetireCheck?: (check: CheckDto, reason: string) => Promise<void>;
  /** Takes a root out of what VeriDone reads, with the repositories the operator left ticked. */
  onRemoveRoot?: (rootId: string, reason: string, repositoryIds: string[]) => Promise<void>;
  /** Stops reading a repository; its checks and work items stay on record. */
  onRemoveRepository?: (repositoryId: string, reason: string) => Promise<void>;
  /** Puts a repository back; the answer says why when it cannot be read. */
  onPutBackRepository?: (repositoryId: string) => Promise<string | null>;
  onPutBackWorkItem?: (workItemId: string) => Promise<void>;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<(ToolCandidate & { checkId: string }) | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<string | null>(null);
  const [retireReason, setRetireReason] = useState('');
  // The record whose removal form is open, and what it holds so far.
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState('');
  const [unticked, setUnticked] = useState<string[]>([]);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordNotice, setRecordNotice] = useState<string | null>(null);
  useDialogFocus(open, onClose, dialog, closeButton);

  // A message about the last change stays with the opening that made it.
  useEffect(() => {
    if (open) return;
    setRemoving(null);
    setRecordError(null);
    setRecordNotice(null);
  }, [open]);

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
  const retireCheck = (check: CheckDto) =>
    attempt(check.id, async () => {
      if (!onRetireCheck) return;
      await onRetireCheck(check, retireReason.trim());
      setRetiring(null);
      setRetireReason('');
    });
  const startRemoving = (id: string) => {
    setRemoving(id);
    setRemoveReason('');
    setUnticked([]);
    setRecordError(null);
    setRecordNotice(null);
  };
  /** Removes or puts back a record. Its button leaves with it, so focus moves to the panel, inside the dialog. */
  const changeRecord = async (
    id: string,
    done: string,
    action: () => Promise<string | null | void>,
  ) => {
    setBusy(id);
    setRecordError(null);
    setRecordNotice(null);
    try {
      const more = await action();
      setRemoving(null);
      setRecordNotice(more ? `${done} ${more}` : done);
      panel.current?.focus();
    } catch (caught) {
      setRecordError(caught instanceof Error ? caught.message : 'The record could not change.');
    } finally {
      setBusy(null);
    }
  };
  // The button that was focused leaves with the form, so focus moves to the panel, inside the dialog.
  const keepRecord = () => {
    setRemoving(null);
    setRetiring(null);
    panel.current?.focus();
  };
  const removedNotice = (name: string) =>
    `Removed ${name}. It is listed under Removed, where you can put it back.`;
  const putBackNotice = (name: string) => `${name} is back.`;
  const reasonGiven = removeReason.trim();
  const noneRemoved =
    bootstrap.removed.roots.length === 0 &&
    bootstrap.removed.repositories.length === 0 &&
    bootstrap.removed.workItems.length === 0;
  const allWorkItems = [...bootstrap.workItems, ...bootstrap.removed.workItems];
  const removedRepository = (repositoryId: string) =>
    bootstrap.removed.repositories.some((repository) => repository.id === repositoryId);
  const approveRoot = async (rootId: string) => {
    if (!onApproveRoot) return;
    setBusy(rootId);
    setRootError(null);
    try {
      await onApproveRoot(rootId);
    } catch (caught) {
      setRootError(caught instanceof Error ? caught.message : 'The root could not be approved.');
    } finally {
      setBusy(null);
    }
  };

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

        <div className="explorer-panel" role="tabpanel" tabIndex={0} ref={panel}>
          {section === 'roots' && (
            <div className="explorer-list">
              {bootstrap.roots.length === 0 ? (
                <p>No roots are approved.</p>
              ) : (
                bootstrap.roots.map((root) => (
                  <article key={root.id}>
                    <div>
                      <strong>{root.label}</strong>
                      <span>
                        {root.status === 'pending' ? 'Restored · waiting for approval' : 'Approved'}
                        {root.missing ? ' · folder missing' : ''}
                      </span>
                    </div>
                    <dl>
                      <div className="wide">
                        <dt>Directory</dt>
                        <dd className="mono tool-path">{root.path}</dd>
                      </div>
                    </dl>
                    {root.missing && (
                      <p>
                        This folder is not on this machine right now. Repositories under it wait
                        until it is back, and everything else keeps working. If it moved, add the
                        new location as a new root. If it is gone for good, remove this root.
                      </p>
                    )}
                    {root.status === 'pending' && (
                      <p>
                        Restored from a backup. VeriDone reads nothing under it until you approve it
                        on this machine.
                      </p>
                    )}
                    <div className="pin-actions">
                      {root.status === 'pending' && onApproveRoot && (
                        <button
                          className="secondary-action pin-action"
                          type="button"
                          onClick={() => void approveRoot(root.id)}
                          disabled={busy !== null}
                          // The accessible name starts with the visible text, so none while it reads "Approving…".
                          aria-label={busy === root.id ? undefined : `Approve ${root.label}`}
                        >
                          {busy === root.id ? 'Approving…' : 'Approve'}
                        </button>
                      )}
                      {onRemoveRoot && (
                        <button
                          className="secondary-action pin-action"
                          type="button"
                          onClick={() => startRemoving(root.id)}
                          disabled={busy !== null}
                          aria-label={`Remove ${root.label}`}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    {removing === root.id && onRemoveRoot && (
                      <RemovalForm
                        label={root.label}
                        confirmLabel="Remove this root"
                        reason={removeReason}
                        removing={busy === root.id}
                        disabled={busy !== null}
                        onReason={setRemoveReason}
                        onCancel={keepRecord}
                        onSubmit={() =>
                          void changeRecord(root.id, removedNotice(root.label), () =>
                            onRemoveRoot(
                              root.id,
                              reasonGiven,
                              (root.onlyCovers ?? []).filter((id) => !unticked.includes(id)),
                            ),
                          )
                        }
                      >
                        <p>
                          VeriDone stops reading the repositories and receipts only this root
                          covers, and checks running on those repositories stop. Packets keep hiding
                          its path, and you can put it back under Removed.
                        </p>
                        {(root.onlyCovers ?? []).length > 0 && (
                          <fieldset className="removal-repositories">
                            <legend className="field-label">
                              Repositories only this root covers, removed with it
                            </legend>
                            {(root.onlyCovers ?? []).map((id) => (
                              <label key={id}>
                                <input
                                  type="checkbox"
                                  checked={!unticked.includes(id)}
                                  onChange={(event) => {
                                    const tick = event.currentTarget.checked;
                                    setUnticked((current) =>
                                      tick
                                        ? current.filter((entry) => entry !== id)
                                        : [...current, id],
                                    );
                                  }}
                                />
                                <span>
                                  {bootstrap.repositories.find((item) => item.id === id)?.name ??
                                    id}
                                </span>
                              </label>
                            ))}
                            <small>
                              Packets of their work items show this reason. One you untick stays
                              listed and says it cannot be read.
                            </small>
                          </fieldset>
                        )}
                      </RemovalForm>
                    )}
                  </article>
                ))
              )}
              <div className="dialog-message" aria-live="polite">
                {rootError && <span className="error-message">{rootError}</span>}
              </div>
            </div>
          )}

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
                    {bootstrap.sourceIssues
                      .filter((issue) => issue.repositoryId === repository.id)
                      .map((issue) => (
                        <p className="error-message" key={issue.repositoryId}>
                          {issue.message}
                        </p>
                      ))}
                    {onRemoveRepository && (
                      <div className="pin-actions">
                        <button
                          className="secondary-action pin-action"
                          type="button"
                          onClick={() => startRemoving(repository.id)}
                          disabled={busy !== null}
                          aria-label={`Remove ${repository.name}`}
                        >
                          Remove
                        </button>
                      </div>
                    )}
                    {removing === repository.id && onRemoveRepository && (
                      <RemovalForm
                        label={repository.name}
                        confirmLabel="Remove this repository"
                        reason={removeReason}
                        removing={busy === repository.id}
                        disabled={busy !== null}
                        onReason={setRemoveReason}
                        onCancel={keepRecord}
                        onSubmit={() =>
                          void changeRecord(repository.id, removedNotice(repository.name), () =>
                            onRemoveRepository(repository.id, reasonGiven),
                          )
                        }
                      >
                        <p>
                          VeriDone stops reading it, and checks running on it stop.{' '}
                          {boundWorkItems(bootstrap.workItems, repository.id)} Its checks and
                          evidence stay on record. Packets of work items bound to it show this
                          removal and its reason, and you can put it back under Removed.
                        </p>
                      </RemovalForm>
                    )}
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
                      <span>
                        {check.retiredAt
                          ? 'Retired'
                          : removedRepository(check.repositoryId)
                            ? 'Repository removed'
                            : check.kind}
                      </span>
                    </div>
                    <dl>
                      {check.retiredAt && (
                        <div className="wide">
                          <dt>Retired {check.retiredAt.slice(0, 10)}</dt>
                          <dd>{check.retiredReason}</dd>
                        </div>
                      )}
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
                      {check.setupArgs.length > 0 && (
                        <div className="wide">
                          <dt>Setup arguments</dt>
                          <dd className="mono tool-path">{JSON.stringify(check.setupArgs)}</dd>
                        </div>
                      )}
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
                    {!check.retiredAt &&
                      !removedRepository(check.repositoryId) &&
                      onReviewTool &&
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
                        <div className="pin-actions">
                          <button
                            className="secondary-action pin-action"
                            type="button"
                            onClick={() => void reviewTool(check.id)}
                            disabled={busy !== null}
                            aria-label={
                              busy === check.id ? undefined : `Pin tool again for ${check.label}`
                            }
                          >
                            {busy === check.id ? 'Reading the tool…' : 'Pin tool again'}
                          </button>
                          {onReplaceCheck && (
                            <button
                              className="secondary-action pin-action"
                              type="button"
                              onClick={() => onReplaceCheck(check)}
                              disabled={busy !== null}
                              aria-label={`Replace ${check.label}`}
                            >
                              Replace
                            </button>
                          )}
                          {onRetireCheck && (
                            <button
                              className="secondary-action pin-action"
                              type="button"
                              onClick={() => {
                                setRetiring(check.id);
                                setRetireReason('');
                              }}
                              disabled={busy !== null}
                              aria-label={`Retire ${check.label}`}
                            >
                              Retire
                            </button>
                          )}
                        </div>
                      ))}
                    {retiring === check.id && !check.retiredAt && (
                      <form
                        className="retire-review"
                        aria-label={`Retire ${check.label}`}
                        onSubmit={(event) => {
                          event.preventDefault();
                          void retireCheck(check);
                        }}
                      >
                        <p>
                          A retired check leaves the gate, and its record and evidence stay in the
                          history. Evidence counts only under the set of checks it ran with, so the
                          other checks may need to run again. Packets show this retirement and its
                          reason.
                        </p>
                        <label>
                          <span className="field-label">Why it retires</span>
                          <textarea
                            className="text-field"
                            value={retireReason}
                            maxLength={2_000}
                            onChange={(event) => setRetireReason(event.currentTarget.value)}
                            required
                          />
                        </label>
                        <div className="pin-actions">
                          <button
                            className="primary-action"
                            type="submit"
                            disabled={busy !== null || retireReason.trim() === ''}
                          >
                            {busy === check.id ? 'Retiring…' : 'Retire this check'}
                          </button>
                          <button className="secondary-action" type="button" onClick={keepRecord}>
                            Keep it
                          </button>
                        </div>
                      </form>
                    )}
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
                  const item = allWorkItems.find(
                    (candidate) => candidate.id === verdict.workItemId,
                  );
                  return (
                    <article key={verdict.id}>
                      <div>
                        <strong>{item?.title ?? 'Unknown work item'}</strong>
                        <span>
                          {verdict.decision}
                          {item?.removedAt ? ' · work item removed' : ''}
                        </span>
                      </div>
                      <div className="export-links" aria-label="Acceptance packet formats">
                        {packetFormats.map((format) => (
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

          {section === 'removed' && (
            <div className="explorer-list">
              {noneRemoved && <p>Nothing has been removed.</p>}
              {bootstrap.removed.roots.map((root) => (
                <article key={root.id}>
                  <div>
                    <strong>{root.label}</strong>
                    <span>Root · removed {root.removedAt?.slice(0, 10)}</span>
                  </div>
                  <dl>
                    <div className="wide">
                      <dt>Why</dt>
                      <dd>{root.removedReason}</dd>
                    </div>
                    <div className="wide">
                      <dt>Directory</dt>
                      <dd className="mono tool-path">{root.path}</dd>
                    </div>
                  </dl>
                  {onApproveRoot && (
                    <div className="pin-actions">
                      <button
                        className="secondary-action pin-action"
                        type="button"
                        onClick={() =>
                          void changeRecord(root.id, putBackNotice(root.label), () =>
                            onApproveRoot(root.id),
                          )
                        }
                        disabled={busy !== null}
                        aria-label={busy === root.id ? undefined : `Put back ${root.label}`}
                      >
                        {busy === root.id ? 'Putting back…' : 'Put back'}
                      </button>
                    </div>
                  )}
                </article>
              ))}
              {bootstrap.removed.repositories.map((repository) => (
                <article key={repository.id}>
                  <div>
                    <strong>{repository.name}</strong>
                    <span>Repository · removed {repository.removedAt?.slice(0, 10)}</span>
                  </div>
                  <dl>
                    <div className="wide">
                      <dt>Why</dt>
                      <dd>{repository.removedReason}</dd>
                    </div>
                    <div className="wide">
                      <dt>Directory</dt>
                      <dd className="mono tool-path">{repository.path}</dd>
                    </div>
                  </dl>
                  {onPutBackRepository && (
                    <div className="pin-actions">
                      <button
                        className="secondary-action pin-action"
                        type="button"
                        onClick={() =>
                          void changeRecord(repository.id, putBackNotice(repository.name), () =>
                            onPutBackRepository(repository.id),
                          )
                        }
                        disabled={busy !== null}
                        aria-label={
                          busy === repository.id ? undefined : `Put back ${repository.name}`
                        }
                      >
                        {busy === repository.id ? 'Putting back…' : 'Put back'}
                      </button>
                    </div>
                  )}
                </article>
              ))}
              {bootstrap.removed.workItems.map((item) => {
                const verdicts = bootstrap.verdicts.filter(
                  (verdict) => verdict.workItemId === item.id,
                ).length;
                const evidence = bootstrap.evidence.filter(
                  (record) => record.workItemId === item.id,
                ).length;
                return (
                  <article key={item.id}>
                    <div>
                      <strong>{item.title}</strong>
                      <span>Work item · removed {item.removedAt?.slice(0, 10)}</span>
                    </div>
                    <dl>
                      <div className="wide">
                        <dt>Why</dt>
                        <dd>{item.removedReason}</dd>
                      </div>
                    </dl>
                    <p>
                      {verdicts} {verdicts === 1 ? 'verdict' : 'verdicts'} and {evidence} evidence{' '}
                      {evidence === 1 ? 'record' : 'records'} stay on record.
                    </p>
                    <div className="export-links" aria-label="Acceptance packet formats">
                      {packetFormats.map((format) => (
                        <a
                          key={format}
                          href={`/api/v1/work-items/${item.id}/packet/${format}`}
                          download
                        >
                          {format.toUpperCase()}
                        </a>
                      ))}
                    </div>
                    {onPutBackWorkItem && (
                      <div className="pin-actions">
                        <button
                          className="secondary-action pin-action"
                          type="button"
                          onClick={() =>
                            void changeRecord(item.id, putBackNotice(item.title), () =>
                              onPutBackWorkItem(item.id),
                            )
                          }
                          disabled={busy !== null}
                          aria-label={busy === item.id ? undefined : `Put back ${item.title}`}
                        >
                          {busy === item.id ? 'Putting back…' : 'Put back'}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}

          <div className="dialog-message" aria-live="polite">
            {recordError && <span className="error-message">{recordError}</span>}
            {recordNotice && <span className="success-message">{recordNotice}</span>}
          </div>
        </div>
      </section>
    </div>
  );
}
