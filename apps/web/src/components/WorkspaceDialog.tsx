import { ArchiveRestore, Download, ShieldCheck, Upload, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import { importWorkspaceDocument, type BootstrapDto } from '../api.js';
import { useDialogFocus } from './useDialogFocus.js';

export function WorkspaceDialog({
  open,
  bootstrap,
  onClose,
  onImported,
}: {
  open: boolean;
  bootstrap: BootstrapDto;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useDialogFocus(open, onClose, dialog, closeButton);

  if (!open) return null;

  const importFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      if (file.size > 25_000_000) throw new Error('Workspace backups must be smaller than 25 MB.');
      const document = JSON.parse(await file.text()) as unknown;
      const result = await importWorkspaceDocument(document, bootstrap.csrfToken);
      await onImported();
      const count = Object.values(result.imported).reduce((sum, value) => sum + value, 0);
      setMessage(`Verified and merged ${count} records transactionally.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The workspace could not be imported.');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const totalRecords =
    bootstrap.roots.length +
    bootstrap.repositories.length +
    bootstrap.receipts.length +
    bootstrap.workItems.length +
    bootstrap.checks.length +
    bootstrap.evidence.length +
    bootstrap.verdicts.length;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialog}
        className="source-dialog workspace-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="section-label">Portable workspace</span>
            <h2 id={titleId}>Backup & restore</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} ref={closeButton}>
            <X aria-hidden="true" size={18} />
            <span className="sr-only">Close workspace dialog</span>
          </button>
        </header>
        <p className="dialog-intro">
          Move your review history without a cloud account. Every backup is schema-validated and
          carries a SHA-256 integrity hash.
        </p>

        <div className="workspace-stat" aria-label={`${totalRecords} portable records`}>
          <ArchiveRestore aria-hidden="true" size={22} />
          <div>
            <strong>{totalRecords} records in this workspace</strong>
            <span>
              {bootstrap.repositories.length} repositories · {bootstrap.workItems.length} work items
              · {bootstrap.evidence.length} evidence records
            </span>
          </div>
        </div>

        <div className="workspace-actions">
          <a className="workspace-action" href="/api/v1/workspace/export" download>
            <Download aria-hidden="true" size={18} />
            <span>
              <strong>Export verified JSON</strong>
              <small>Includes local paths and approved check definitions.</small>
            </span>
          </a>
          <button
            className="workspace-action"
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            <Upload aria-hidden="true" size={18} />
            <span>
              <strong>{busy ? 'Verifying backup…' : 'Import and merge'}</strong>
              <small>Invalid or tampered files roll back without a partial import.</small>
            </span>
          </button>
          <input
            className="sr-only"
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            aria-label="Choose a VeriDone workspace JSON backup"
            onChange={importFile}
          />
        </div>

        <div className="safety-callout">
          <ShieldCheck aria-hidden="true" size={16} />
          <span>Import merges by stable IDs. It never deletes existing workspace data.</span>
        </div>
        <div className="dialog-message" aria-live="polite">
          {error && <span className="error-message">{error}</span>}
          {message && <span className="success-message">{message}</span>}
        </div>
        <footer>
          <button className="primary-action" type="button" onClick={onClose}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}
