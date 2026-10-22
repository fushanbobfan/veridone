import { useId, useRef, useState } from 'react';
import {
  Check,
  GitBranch,
  GitCommitHorizontal,
  MessageSquareWarning,
  ShieldCheck,
  X,
} from 'lucide-react';

import { createVerdict } from '../api.js';
import { useDialogFocus } from './useDialogFocus.js';

export function VerdictDialog({
  open,
  workItemId,
  subject,
  decision,
  overrideRequired = false,
  csrfToken,
  onClose,
  onRecorded,
}: {
  open: boolean;
  workItemId: string;
  subject: { title: string; repository: string; head: string; fingerprint: string };
  decision: 'accepted' | 'changes-requested' | 'rejected';
  overrideRequired?: boolean;
  csrfToken: string;
  onClose: () => void;
  onRecorded: () => Promise<void>;
}) {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const [note, setNote] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useDialogFocus(open, onClose, dialog, closeButton);

  if (!open) return null;
  const accepting = decision === 'accepted';
  const rejecting = decision === 'rejected';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await createVerdict(
        workItemId,
        decision,
        note,
        csrfToken,
        overrideRequired ? overrideReason : null,
      );
      await onRecorded();
      setNote('');
      setOverrideReason('');
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
        ref={dialog}
        className="source-dialog verdict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="section-label">Human verdict</span>
            <h2 id={titleId}>
              {overrideRequired
                ? 'Accept with override'
                : accepting
                  ? 'Accept this work'
                  : rejecting
                    ? 'Reject this work'
                    : 'Request changes'}
            </h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} ref={closeButton}>
            <X aria-hidden="true" size={18} />
            <span className="sr-only">Close verdict dialog</span>
          </button>
        </header>
        <p className="dialog-intro">
          {overrideRequired
            ? 'Required gates are open. Record why you are accepting despite that evidence gap.'
            : accepting
              ? 'Your decision is bound to the current fingerprint and selected evidence.'
              : rejecting
                ? 'A rejection remains append-only and bound to the current repository state.'
                : 'Record what must change so the decision remains auditable.'}
        </p>
        <section className="repository-link-summary" aria-label="Verdict subject">
          <div>
            <GitBranch aria-hidden="true" size={15} />
            <span>
              <strong>{subject.title}</strong>
              <small>{subject.repository}</small>
            </span>
          </div>
          <div>
            <GitCommitHorizontal aria-hidden="true" size={15} />
            <span>
              <strong className="mono">{subject.head || 'Unbound'}</strong>
            </span>
          </div>
          <div>
            <ShieldCheck aria-hidden="true" size={15} />
            <span>
              <strong>Fingerprint</strong>
              <small className="mono">
                {subject.fingerprint ? `${subject.fingerprint.slice(0, 16)}…` : 'Unbound'}
              </small>
            </span>
          </div>
        </section>
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
                  : rejecting
                    ? 'Why should this work not be accepted?'
                    : 'What evidence or implementation must change?'
              }
              required
            />
          </label>
          {overrideRequired && (
            <label>
              <span className="field-label">Override reason</span>
              <textarea
                className="text-field verdict-note"
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.currentTarget.value)}
                placeholder="Why is accepting with open or stale gates justified?"
                required
              />
            </label>
          )}
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
              {saving
                ? 'Recording…'
                : overrideRequired
                  ? 'Record override acceptance'
                  : accepting
                    ? 'Record acceptance'
                    : rejecting
                      ? 'Record rejection'
                      : 'Record request'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
