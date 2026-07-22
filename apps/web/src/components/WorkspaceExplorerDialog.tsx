import { Archive, FileCheck2, FolderGit2, X } from 'lucide-react';
import { useId, useRef } from 'react';

import type { BootstrapDto } from '../api.js';
import type { WorkspaceSection } from './Navigation.js';
import { useDialogFocus } from './useDialogFocus.js';

const sections: Array<{
  id: WorkspaceSection;
  label: string;
  icon: typeof FolderGit2;
}> = [
  { id: 'repositories', label: 'Repositories', icon: FolderGit2 },
  { id: 'contracts', label: 'Contracts', icon: FileCheck2 },
  { id: 'exports', label: 'Exports', icon: Archive },
];

export function WorkspaceExplorerDialog({
  open,
  section,
  bootstrap,
  onSection,
  onClose,
}: {
  open: boolean;
  section: WorkspaceSection;
  bootstrap: BootstrapDto;
  onSection: (section: WorkspaceSection) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useDialogFocus(open, onClose, dialog, closeButton);
  if (!open) return null;

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
