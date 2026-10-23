import { useId, useRef, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';

import { createCheck } from '../api.js';
import { useDialogFocus } from './useDialogFocus.js';

export function CheckDialog({
  open,
  repositoryId,
  csrfToken,
  onClose,
  onAdded,
}: {
  open: boolean;
  repositoryId: string;
  csrfToken: string;
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const [label, setLabel] = useState('Unit and integration tests');
  const [kind, setKind] = useState('test');
  const [executable, setExecutable] = useState('node');
  const [args, setArgs] = useState('["--test"]');
  const [versionArgs, setVersionArgs] = useState('["--version"]');
  const [scopePaths, setScopePaths] = useState('');
  const [cwdRelative, setCwdRelative] = useState('.');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useDialogFocus(open, onClose, dialog, closeButton);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const parsedArgs = JSON.parse(args) as unknown;
      if (!Array.isArray(parsedArgs) || !parsedArgs.every((value) => typeof value === 'string')) {
        throw new Error('Arguments must be a JSON array of strings.');
      }
      const parsedVersionArgs = JSON.parse(versionArgs) as unknown;
      if (
        !Array.isArray(parsedVersionArgs) ||
        !parsedVersionArgs.every((value) => typeof value === 'string')
      ) {
        throw new Error('Version arguments must be a JSON array of strings.');
      }
      await createCheck(
        {
          repositoryId,
          label,
          kind,
          executable,
          args: parsedArgs,
          versionArgs: parsedVersionArgs,
          scopePaths: scopePaths
            .split(/\r?\n/u)
            .map((value) => value.trim())
            .filter(Boolean),
          cwdRelative,
          timeoutMs: 120_000,
          maxOutputBytes: 1_000_000,
        },
        csrfToken,
      );
      await onAdded();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The check could not be approved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialog}
        className="source-dialog check-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="section-label">Execution approval</span>
            <h2 id={titleId}>Approve a check</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} ref={closeButton}>
            <X aria-hidden="true" size={18} />
            <span className="sr-only">Close check dialog</span>
          </button>
        </header>
        <p className="dialog-intro">
          This definition is local policy. VeriDone never executes a command imported from a
          receipt.
        </p>

        <form onSubmit={submit}>
          <div className="two-fields">
            <label>
              <span className="field-label">Label</span>
              <input
                className="text-field"
                value={label}
                onChange={(event) => setLabel(event.currentTarget.value)}
                required
              />
            </label>
            <label>
              <span className="field-label">Evidence kind</span>
              <select
                className="text-field"
                value={kind}
                onChange={(event) => setKind(event.currentTarget.value)}
              >
                <option value="test">Test</option>
                <option value="lint">Lint</option>
                <option value="typecheck">Typecheck</option>
                <option value="build">Build</option>
                <option value="security">Security</option>
                <option value="accessibility">Accessibility</option>
                <option value="browser">Browser</option>
              </select>
            </label>
          </div>
          <label>
            <span className="field-label">Executable</span>
            <input
              className="text-field mono"
              value={executable}
              onChange={(event) => setExecutable(event.currentTarget.value)}
              required
            />
          </label>
          <label>
            <span className="field-label">Literal argument array</span>
            <textarea
              className="text-field code-field mono"
              value={args}
              onChange={(event) => setArgs(event.currentTarget.value)}
              required
            />
          </label>
          <label>
            <span className="field-label">Working directory inside repository</span>
            <input
              className="text-field mono"
              value={cwdRelative}
              onChange={(event) => setCwdRelative(event.currentTarget.value)}
              required
            />
          </label>
          <div className="two-fields">
            <label>
              <span className="field-label">Tool version argument array</span>
              <input
                className="text-field mono"
                value={versionArgs}
                onChange={(event) => setVersionArgs(event.currentTarget.value)}
                required
              />
            </label>
            <label>
              <span className="field-label">Declared scope prefixes (optional)</span>
              <textarea
                className="text-field compact-code-field mono"
                value={scopePaths}
                onChange={(event) => setScopePaths(event.currentTarget.value)}
                placeholder={'apps/web\ndocs'}
              />
            </label>
          </div>
          <div className="safety-callout">
            <CheckCircle2 aria-hidden="true" size={16} />
            <span>
              Runs without shell interpolation, with a 2-minute timeout and 1 MB output cap.
            </span>
          </div>
          <div className="dialog-message" aria-live="polite">
            {error && <span className="error-message">{error}</span>}
          </div>
          <footer>
            <button className="secondary-action" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-action" type="submit" disabled={saving}>
              {saving ? 'Approving…' : 'Approve definition'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
