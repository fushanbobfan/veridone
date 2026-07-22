import { useEffect, useId, useRef, useState } from 'react';
import { GitBranch, GitCommitHorizontal, ShieldCheck, X } from 'lucide-react';

import type { RepositoryDto } from '../api.js';
import { useDialogFocus } from './useDialogFocus.js';

export function RepositoryLinkDialog({
  open,
  workItemTitle,
  repositories,
  onClose,
  onLink,
}: {
  open: boolean;
  workItemTitle: string;
  repositories: RepositoryDto[];
  onClose: () => void;
  onLink: (repositoryId: string) => Promise<void>;
}) {
  const titleId = useId();
  const repositoryId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const [selectedId, setSelectedId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useDialogFocus(open, onClose, dialog, closeButton);

  useEffect(() => {
    if (!open) {
      setSelectedId('');
      setSaving(false);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const selected = repositories.find((repository) => repository.id === selectedId) ?? null;
  const orderedRepositories = [...repositories].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) {
      setError('Choose the repository whose current snapshot belongs to this claim.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onLink(selected.id);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The repository could not be linked.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialog}
        className="source-dialog repository-link-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="section-label">Provenance binding</span>
            <h2 id={titleId}>Link to a repository</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            ref={closeButton}
            disabled={saving}
          >
            <X aria-hidden="true" size={18} />
            <span className="sr-only">Close repository dialog</span>
          </button>
        </header>

        <p className="dialog-intro">
          Choose deliberately. VeriDone will bind “{workItemTitle}” to the selected commit and
          byte-sensitive worktree fingerprint; it will not infer a repository from receipt text.
        </p>

        <form onSubmit={submit}>
          <label htmlFor={repositoryId}>
            <span className="field-label">Repository</span>
            <select
              id={repositoryId}
              className="text-field"
              value={selectedId}
              onChange={(event) => setSelectedId(event.currentTarget.value)}
              required
            >
              <option value="" disabled>
                Choose a repository…
              </option>
              {orderedRepositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.name} — {repository.snapshot.branch ?? 'detached'} @{' '}
                  {repository.snapshot.head.slice(0, 12)}
                </option>
              ))}
            </select>
          </label>

          {selected && (
            <section className="repository-link-summary" aria-label="Selected repository snapshot">
              <div>
                <GitBranch aria-hidden="true" size={15} />
                <span>
                  <strong>{selected.name}</strong>
                  <small>{selected.snapshot.branch ?? 'Detached HEAD'}</small>
                </span>
              </div>
              <div>
                <GitCommitHorizontal aria-hidden="true" size={15} />
                <span>
                  <strong className="mono">{selected.snapshot.head}</strong>
                  <small className="mono">{selected.path}</small>
                </span>
              </div>
              <div>
                <ShieldCheck aria-hidden="true" size={15} />
                <span>
                  <strong>
                    {selected.snapshot.statusEntries.length === 0
                      ? 'Clean worktree'
                      : `${selected.snapshot.statusEntries.length} worktree change${selected.snapshot.statusEntries.length === 1 ? '' : 's'}`}
                  </strong>
                  <small className="mono">
                    fingerprint {selected.snapshot.fingerprint.slice(0, 16)}…
                  </small>
                </span>
              </div>
            </section>
          )}

          <div className="safety-callout">
            <ShieldCheck aria-hidden="true" size={16} />
            <span>
              The imported claim stays untrusted; this action records identity, not proof.
            </span>
          </div>

          <div className="dialog-message" aria-live="polite">
            {error && <span className="error-message">{error}</span>}
          </div>

          <footer>
            <button className="secondary-action" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button className="primary-action" type="submit" disabled={saving || !selected}>
              {saving ? 'Linking snapshot…' : 'Link current snapshot'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
