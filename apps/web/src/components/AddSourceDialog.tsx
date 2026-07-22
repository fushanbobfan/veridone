import { useEffect, useId, useRef, useState } from 'react';
import { FolderGit2, Import, Plus, X } from 'lucide-react';

import { addLocalSource, type SourceKind } from '../api.js';

const sourceOptions: Array<{ id: SourceKind; title: string; detail: string }> = [
  { id: 'root', title: 'Approved root', detail: 'Allow read-only discovery inside one directory.' },
  {
    id: 'repository',
    title: 'Git repository',
    detail: 'Capture HEAD, branch, and worktree state.',
  },
  {
    id: 'receipt',
    title: 'Harness receipt',
    detail: 'Import one validated JSON receipt as an untrusted claim.',
  },
];

export function AddSourceDialog({
  open,
  csrfToken,
  onClose,
  onAdded,
}: {
  open: boolean;
  csrfToken: string;
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const titleId = useId();
  const pathId = useId();
  const labelId = useId();
  const firstButton = useRef<HTMLButtonElement>(null);
  const [kind, setKind] = useState<SourceKind>('root');
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'success'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    firstButton.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose, open]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setState('saving');
    setError(null);
    try {
      await addLocalSource(kind, path, csrfToken, label);
      await onAdded();
      setState('success');
      window.setTimeout(() => {
        setPath('');
        setLabel('');
        setState('idle');
        onClose();
      }, 650);
    } catch (caught) {
      setState('idle');
      setError(caught instanceof Error ? caught.message : 'The source could not be added.');
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="source-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="section-label">Local workspace</span>
            <h2 id={titleId}>Connect evidence</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} ref={firstButton}>
            <X aria-hidden="true" size={18} />
            <span className="sr-only">Close source dialog</span>
          </button>
        </header>

        <p className="dialog-intro">
          VeriDone reads only approved roots. Imported text stays inert and never becomes a command.
        </p>

        <form onSubmit={submit}>
          <fieldset className="source-kind-group">
            <legend>Source type</legend>
            {sourceOptions.map((option) => (
              <label key={option.id} className={kind === option.id ? 'selected' : undefined}>
                <input
                  type="radio"
                  name="source-kind"
                  value={option.id}
                  checked={kind === option.id}
                  onChange={() => setKind(option.id)}
                />
                <span className="source-kind-icon">
                  {option.id === 'repository' ? (
                    <FolderGit2 aria-hidden="true" size={16} />
                  ) : option.id === 'receipt' ? (
                    <Import aria-hidden="true" size={16} />
                  ) : (
                    <Plus aria-hidden="true" size={16} />
                  )}
                </span>
                <span>
                  <strong>{option.title}</strong>
                  <small>{option.detail}</small>
                </span>
              </label>
            ))}
          </fieldset>

          <label className="field-label" htmlFor={pathId}>
            Absolute local path
          </label>
          <input
            className="text-field mono"
            id={pathId}
            value={path}
            onChange={(event) => setPath(event.currentTarget.value)}
            placeholder={kind === 'receipt' ? 'D:\\work\\runs\\receipt.json' : 'D:\\work\\project'}
            autoComplete="off"
            required
          />

          {kind === 'root' && (
            <>
              <label className="field-label" htmlFor={labelId}>
                Label <span>optional</span>
              </label>
              <input
                className="text-field"
                id={labelId}
                value={label}
                onChange={(event) => setLabel(event.currentTarget.value)}
                placeholder="Research projects"
                autoComplete="off"
              />
            </>
          )}

          <div className="dialog-message" aria-live="polite">
            {error && <span className="error-message">{error}</span>}
            {state === 'success' && <span className="success-message">Source connected.</span>}
          </div>

          <footer>
            <button className="secondary-action" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-action" type="submit" disabled={state !== 'idle'}>
              <Plus aria-hidden="true" size={15} />
              {state === 'saving' ? 'Connecting…' : 'Connect source'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
