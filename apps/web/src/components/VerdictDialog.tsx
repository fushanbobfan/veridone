import { useEffect, useId, useRef, useState } from 'react';
import { Check, MessageSquareWarning, X } from 'lucide-react';

import { createVerdict } from '../api.js';

export function VerdictDialog({
  open,
  workItemId,
  decision,
  csrfToken,
  onClose,
  onRecorded,
}: {
  open: boolean;
  workItemId: string;
  decision: 'accepted' | 'changes-requested';
  csrfToken: string;
  onClose: () => void;
  onRecorded: () => Promise<void>;
}) {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose, open]);

  if (!open) return null;
  const accepting = decision === 'accepted';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await createVerdict(workItemId, decision, note, csrfToken);
      await onRecorded();
      setNote('');
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The verdict could not be recorded.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="source-dialog verdict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="section-label">Human verdict</span>
            <h2 id={titleId}>{accepting ? 'Accept this work' : 'Request changes'}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} ref={closeButton}>
            <X aria-hidden="true" size={18} />
            <span className="sr-only">Close verdict dialog</span>
          </button>
        </header>
        <p className="dialog-intro">
          {accepting
            ? 'Your decision is bound to the current fingerprint and selected evidence.'
            : 'Record what must change so the decision remains auditable.'}
        </p>
        <form onSubmit={submit}>
          <label>
            <span className="field-label">Decision note</span>
            <textarea
              className="text-field verdict-note"
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
              placeholder={
                accepting
                  ? 'What did you personally review?'
                  : 'What evidence or implementation must change?'
              }
              required
            />
          </label>
          <div className="dialog-message" aria-live="polite">
            {error && <span className="error-message">{error}</span>}
          </div>
          <footer>
            <button className="secondary-action" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-action" type="submit" disabled={saving}>
              {accepting ? (
                <Check aria-hidden="true" size={15} />
              ) : (
                <MessageSquareWarning aria-hidden="true" size={15} />
              )}
              {saving ? 'Recording…' : accepting ? 'Record acceptance' : 'Record request'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
