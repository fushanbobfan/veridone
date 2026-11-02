import { ArchiveRestore, Download, KeyRound, ShieldCheck, Upload, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import {
  importWorkspaceDocument,
  previewWorkspaceDocument,
  type BootstrapDto,
  type RestoreResultDto,
} from '../api.js';
import { useDialogFocus } from './useDialogFocus.js';

const total = (counts: Record<string, number>) =>
  Object.values(counts).reduce((sum, value) => sum + value, 0);

/** Up to five names of one kind of record a restore adds, with a count of the rest. */
function PreviewList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <span className="field-label">{title}</span>
      <ul>
        {items.slice(0, 5).map((item, index) => (
          <li key={`${index}:${item}`}>
            <span className="mono">{item}</span>
          </li>
        ))}
      </ul>
      {items.length > 5 && <small>+ {items.length - 5} more</small>}
    </div>
  );
}

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
  // A chosen backup and what restoring it would add; nothing is written until the operator confirms.
  const [pending, setPending] = useState<{ document: unknown; preview: RestoreResultDto } | null>(
    null,
  );

  useDialogFocus(open, onClose, dialog, closeButton);

  if (!open) return null;

  const chooseFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    setPending(null);
    try {
      if (file.size > 25_000_000) throw new Error('Workspace backups must be smaller than 25 MB.');
      const document = JSON.parse(await file.text()) as unknown;
      setPending({
        document,
        preview: await previewWorkspaceDocument(document, bootstrap.csrfToken),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The workspace could not be read.');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const restore = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importWorkspaceDocument(pending.document, bootstrap.csrfToken);
      setPending(null);
      await onImported();
      setMessage(
        `Added ${total(result.imported)} records; ${total(result.unchanged)} were already here. Restored evidence is history and passes no gate; approve restored roots under Roots and pin restored checks before they run.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The workspace could not be imported.');
    } finally {
      setBusy(false);
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
              <strong>{busy ? 'Verifying backup…' : 'Restore missing records'}</strong>
              <small>
                Invalid files, checksum mismatches, and conflicting history roll back without a
                partial import.
              </small>
            </span>
          </button>
          <input
            className="sr-only"
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            aria-label="Choose a VeriDone workspace JSON backup"
            onChange={chooseFile}
          />
          <a className="workspace-action" href="/api/v1/workspace/signing-key" download>
            <KeyRound aria-hidden="true" size={18} />
            <span>
              <strong>Download the packet signing key</strong>
              <small>
                Key {bootstrap.signingKey.keyId.slice(0, 12)}… signs every packet. Publish this
                public key so readers can check packets with it; backups leave the key out.
              </small>
            </span>
          </a>
        </div>

        {pending && (
          <section className="receipt-preview" aria-label="Restore preview">
            <strong>
              {total(pending.preview.imported) === 0
                ? 'This backup adds nothing this workspace lacks.'
                : `This backup adds ${total(pending.preview.imported)} records`}
            </strong>
            <small>
              {pending.preview.imported.evidence ?? 0} evidence records and{' '}
              {pending.preview.imported.verdicts ?? 0} verdicts join the history; restored evidence
              passes no gate.
            </small>
            <PreviewList
              title="Roots, which wait for your approval"
              items={pending.preview.added.roots.map((root) => root.path)}
            />
            <PreviewList
              title="Repositories"
              items={pending.preview.added.repositories.map((repository) => repository.name)}
            />
            <PreviewList
              title="Checks, to pin before they run"
              items={pending.preview.added.checks.map((check) => check.label)}
            />
            <PreviewList
              title="Work items"
              items={pending.preview.added.workItems.map((item) => item.title)}
            />
            <div className="pin-actions">
              <button
                className="primary-action"
                type="button"
                onClick={() => void restore()}
                disabled={busy}
              >
                {busy ? 'Restoring…' : 'Restore these records'}
              </button>
              <button
                className="secondary-action"
                type="button"
                onClick={() => setPending(null)}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </section>
        )}

        <div className="safety-callout">
          <ShieldCheck aria-hidden="true" size={16} />
          <span>
            Restore adds the records this workspace lacks. Existing records, recorded evidence, and
            verdicts keep their content.
          </span>
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
