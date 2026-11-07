import { X } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import { removeWorkItem, type WorkItemDto } from '../api.js';
import { useDialogFocus } from './useDialogFocus.js';

/** Takes a work item out of the inbox, with a reason; what was recorded about it stays. */
export function RemoveWorkItemDialog({
  open,
  workItem,
  evidenceCount,
  verdictCount,
  csrfToken,
  onClose,
  onRemoved,
}: {
  open: boolean;
  workItem: Pick<WorkItemDto, 'id' | 'title' | 'claimHash'>;
  evidenceCount: number;
  verdictCount: number;
  csrfToken: string;
  onClose: () => void;
  onRemoved: () => Promise<void>;
}) {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useDialogFocus(open, onClose, dialog, closeButton);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await removeWorkItem(workItem, reason.trim(), csrfToken);
      await onRemoved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The work item could not be removed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialog}
        className="source-dialog verdict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="section-label">Work item</span>
            <h2 id={titleId}>Remove this work item</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} ref={closeButton}>
            <X aria-hidden="true" size={18} />
            <span className="sr-only">Close removal dialog</span>
          </button>
        </header>
        <section className="repository-link-summary" aria-label="Work item to remove">
          <div>
            <span>
              <strong>{workItem.title}</strong>
            </span>
          </div>
        </section>
        <p className="dialog-intro">
          It leaves the inbox. Its {evidenceCount} evidence{' '}
          {evidenceCount === 1 ? 'record' : 'records'} and {verdictCount}{' '}
          {verdictCount === 1 ? 'verdict' : 'verdicts'} stay on record. Packets show this removal
          and its reason, and you can put it back under Removed.
        </p>
        <form onSubmit={submit}>
          <label>
            <span className="field-label">Why it is removed</span>
            <textarea
              className="text-field verdict-note"
              value={reason}
              maxLength={2_000}
              onChange={(event) => setReason(event.currentTarget.value)}
              required
            />
          </label>
          <div className="dialog-message" aria-live="polite">
            {error && <span className="error-message">{error}</span>}
          </div>
          <footer>
            <button className="secondary-action" type="button" onClick={onClose}>
              Keep it
            </button>
            <button
              className="primary-action"
              type="submit"
              disabled={saving || reason.trim() === ''}
            >
              {saving ? 'Removing…' : 'Remove work item'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
