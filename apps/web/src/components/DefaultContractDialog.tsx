import { defaultContract } from '@veridone/core/contract';
import { X } from 'lucide-react';
import { useId, useRef } from 'react';

import { useDialogFocus } from './useDialogFocus.js';

/** What "View contract" opens on a page with no workspace behind it, such as the public demo. */
export function DefaultContractDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useDialogFocus(true, onClose, dialog, closeButton);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="source-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="section-label">Demo workspace</span>
            <h2 id={titleId}>Acceptance contract</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} ref={closeButton}>
            <X aria-hidden="true" size={18} />
            <span className="sr-only">Close contract</span>
          </button>
        </header>
        <p className="dialog-intro">
          This is the contract VeriDone ships. You approve the commands that count as checks for
          each repository. Acceptance stays locked while any of them has not passed on the current
          code. Overriding the lock takes a written reason.
        </p>
        <div className="explorer-list">
          <article>
            <div>
              <strong>{defaultContract.title}</strong>
              <span className="mono">{defaultContract.version}</span>
            </div>
            <ul>
              {defaultContract.criteria.map((criterion) => (
                <li key={criterion.id}>
                  <span>{criterion.title}</span>
                  <small>{criterion.required ? 'Required' : 'Optional'}</small>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </section>
    </div>
  );
}
