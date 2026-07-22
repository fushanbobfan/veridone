import { useEffect, useId, useRef, useState } from 'react';
import { FolderGit2, Import, Plus, X } from 'lucide-react';

import {
  addLocalSource,
  discoverRepositories,
  previewReceipts,
  type ApprovedRootDto,
  type ReceiptPreviewDto,
  type SourceKind,
} from '../api.js';
import { useDialogFocus } from './useDialogFocus.js';

const sourceOptions: Array<{ id: SourceKind; title: string; detail: string }> = [
  { id: 'root', title: 'Approved root', detail: 'Allow read-only discovery inside one directory.' },
  {
    id: 'repository',
    title: 'Git repository',
    detail: 'Capture HEAD, branch, and worktree state.',
  },
  {
    id: 'receipt',
    title: 'Agent receipt',
    detail: 'Import one JSON file or an atomic directory batch.',
  },
];

export function AddSourceDialog({
  open,
  csrfToken,
  roots,
  onClose,
  onAdded,
}: {
  open: boolean;
  csrfToken: string;
  roots: ApprovedRootDto[];
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const titleId = useId();
  const pathId = useId();
  const labelId = useId();
  const firstButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const [kind, setKind] = useState<SourceKind>('root');
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [discoveryRootId, setDiscoveryRootId] = useState(roots[0]?.id ?? '');
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [receiptPreview, setReceiptPreview] = useState<{
    path: string;
    receipts: ReceiptPreviewDto[];
  } | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'success'>('idle');
  const [error, setError] = useState<string | null>(null);

  useDialogFocus(open, onClose, dialog, firstButton);

  useEffect(() => {
    if (!discoveryRootId && roots[0]) setDiscoveryRootId(roots[0].id);
  }, [discoveryRootId, roots]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setState('saving');
    setError(null);
    try {
      if (kind === 'receipt' && receiptPreview?.path !== path) {
        const receipts = await previewReceipts(path, csrfToken);
        setReceiptPreview({ path, receipts });
        setState('idle');
        return;
      }
      await addLocalSource(kind, path, csrfToken, label);
      await onAdded();
      setState('success');
      window.setTimeout(() => {
        setPath('');
        setLabel('');
        setReceiptPreview(null);
        setState('idle');
        onClose();
      }, 650);
    } catch (caught) {
      setState('idle');
      setError(caught instanceof Error ? caught.message : 'The source could not be added.');
    }
  };

  const discover = async () => {
    if (!discoveryRootId) return;
    setDiscovering(true);
    setError(null);
    try {
      const repositories = await discoverRepositories(discoveryRootId, csrfToken);
      setDiscovered(repositories);
      if (repositories[0]) setPath(repositories[0]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Repository discovery failed.');
    } finally {
      setDiscovering(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialog}
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
            onChange={(event) => {
              setPath(event.currentTarget.value);
              setReceiptPreview(null);
            }}
            placeholder={
              kind === 'receipt' ? 'D:\\work\\runs or receipt.json' : 'D:\\work\\project'
            }
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

          {kind === 'repository' && roots.length > 0 && (
            <div className="discovery-box">
              <label>
                <span className="field-label">Discover inside approved root</span>
                <select
                  className="text-field"
                  value={discoveryRootId}
                  onChange={(event) => setDiscoveryRootId(event.currentTarget.value)}
                >
                  {roots.map((root) => (
                    <option key={root.id} value={root.id}>
                      {root.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="discovery-button" type="button" onClick={discover}>
                {discovering ? 'Discovering…' : 'Discover repositories'}
              </button>
              {discovered.length > 0 && (
                <label>
                  <span className="field-label">Discovered repository</span>
                  <select
                    className="text-field mono"
                    value={path}
                    onChange={(event) => setPath(event.currentTarget.value)}
                  >
                    {discovered.map((repository) => (
                      <option key={repository} value={repository}>
                        {repository}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}

          {kind === 'receipt' && receiptPreview?.path === path && (
            <section className="receipt-preview" aria-label="Validated receipt preview">
              <strong>
                {receiptPreview.receipts.length}{' '}
                {receiptPreview.receipts.length === 1 ? 'receipt' : 'receipts'} validated
              </strong>
              <ul>
                {receiptPreview.receipts.slice(0, 5).map((receipt) => (
                  <li key={`${receipt.sourceType}:${receipt.runId}`}>
                    <span>{receipt.title}</span>
                    <small className={receipt.degraded ? 'preview-degraded' : undefined}>
                      {receipt.sourceLabel} · {receipt.status}
                    </small>
                  </li>
                ))}
              </ul>
              {receiptPreview.receipts.length > 5 && (
                <small>+ {receiptPreview.receipts.length - 5} more validated receipts</small>
              )}
            </section>
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
              {state === 'saving'
                ? kind === 'receipt' && receiptPreview?.path !== path
                  ? 'Validating…'
                  : 'Connecting…'
                : kind === 'receipt'
                  ? receiptPreview?.path === path
                    ? `Import ${receiptPreview.receipts.length}`
                    : 'Preview import'
                  : 'Connect source'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
