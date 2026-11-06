import { useId, useRef, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';

import { createCheck, replaceCheck, type CheckDto, type NewCheckInput } from '../api.js';
import { useDialogFocus } from './useDialogFocus.js';

export function CheckDialog({
  open,
  repositoryId,
  csrfToken,
  replacing = null,
  onClose,
  onAdded,
}: {
  open: boolean;
  repositoryId: string;
  csrfToken: string;
  /** The check this one takes the place of; the dialog starts from its definition. */
  replacing?: CheckDto | null;
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const [label, setLabel] = useState(replacing?.label ?? 'Unit and integration tests');
  const [kind, setKind] = useState(replacing?.kind ?? 'test');
  const [executable, setExecutable] = useState(replacing?.executable ?? 'node');
  const [args, setArgs] = useState(JSON.stringify(replacing?.args ?? ['--test']));
  const [setupArgs, setSetupArgs] = useState(
    replacing?.setupArgs.length ? JSON.stringify(replacing.setupArgs) : '',
  );
  const [versionArgs, setVersionArgs] = useState(
    JSON.stringify(replacing?.versionArgs ?? ['--version']),
  );
  const [scopePaths, setScopePaths] = useState(replacing?.scopePaths.join('\n') ?? '');
  const [cwdRelative, setCwdRelative] = useState(replacing?.cwdRelative ?? '.');
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    String((replacing?.timeoutMs ?? 120_000) / 1_000),
  );
  const [outputLimitMegabytes, setOutputLimitMegabytes] = useState(
    String((replacing?.maxOutputBytes ?? 1_000_000) / 1_000_000),
  );
  const [setupTimeoutSeconds, setSetupTimeoutSeconds] = useState(
    String((replacing?.setupTimeoutMs ?? 600_000) / 1_000),
  );
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
      const parsedSetupArgs = setupArgs.trim() ? (JSON.parse(setupArgs) as unknown) : [];
      if (
        !Array.isArray(parsedSetupArgs) ||
        !parsedSetupArgs.every((value) => typeof value === 'string')
      ) {
        throw new Error('Setup arguments must be a JSON array of strings.');
      }
      const definition: NewCheckInput = {
        repositoryId,
        label,
        kind,
        executable,
        args: parsedArgs,
        setupArgs: parsedSetupArgs,
        versionArgs: parsedVersionArgs,
        scopePaths: scopePaths
          .split(/\r?\n/u)
          .map((value) => value.trim())
          .filter(Boolean),
        cwdRelative,
        timeoutMs: Math.round(Number(timeoutSeconds) * 1_000),
        maxOutputBytes: Math.round(Number(outputLimitMegabytes) * 1_000_000),
        setupTimeoutMs: Math.round(Number(setupTimeoutSeconds) * 1_000),
      };
      // A replacement is one step, so a refused tool or a stale view leaves the old check counting.
      if (replacing) await replaceCheck(replacing, definition, reason.trim(), csrfToken);
      else await createCheck(definition, csrfToken);
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
            <h2 id={titleId}>{replacing ? `Replace ${replacing.label}` : 'Approve a check'}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} ref={closeButton}>
            <X aria-hidden="true" size={18} />
            <span className="sr-only">Close check dialog</span>
          </button>
        </header>
        <p className="dialog-intro">
          {replacing
            ? 'This approves the definition below and retires the old check, whose record and evidence stay in the history.'
            : 'This definition is local policy. VeriDone never executes a command imported from a receipt.'}
        </p>

        <form onSubmit={submit}>
          {replacing && (
            <label>
              <span className="field-label">Why it changes</span>
              <textarea
                className="text-field compact-code-field"
                value={reason}
                maxLength={2_000}
                onChange={(event) => setReason(event.currentTarget.value)}
                placeholder="It needs a setup step in the clean checkout."
                required
              />
            </label>
          )}
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
            <span className="field-label">Setup argument array (optional)</span>
            <textarea
              className="text-field compact-code-field mono"
              value={setupArgs}
              onChange={(event) => setSetupArgs(event.currentTarget.value)}
              placeholder={'["path/to/pnpm.cjs", "install", "--frozen-lockfile"]'}
            />
          </label>
          <label>
            <span className="field-label">Setup timeout in seconds</span>
            <input
              className="text-field mono"
              type="number"
              min={1}
              max={3_600}
              step="any"
              value={setupTimeoutSeconds}
              onChange={(event) => setSetupTimeoutSeconds(event.currentTarget.value)}
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
          <div className="two-fields">
            <label>
              <span className="field-label">Timeout in seconds</span>
              <input
                className="text-field mono"
                type="number"
                min={0.1}
                max={1_800}
                step="any"
                value={timeoutSeconds}
                onChange={(event) => setTimeoutSeconds(event.currentTarget.value)}
                required
              />
            </label>
            <label>
              <span className="field-label">Output limit in MB</span>
              <input
                className="text-field mono"
                type="number"
                min={0.001024}
                max={10}
                step="any"
                value={outputLimitMegabytes}
                onChange={(event) => setOutputLimitMegabytes(event.currentTarget.value)}
                required
              />
            </label>
          </div>
          <div className="safety-callout">
            <CheckCircle2 aria-hidden="true" size={16} />
            <span>
              Runs without shell interpolation, within the timeout and output limit above. Setup
              arguments, when given, run first with the same tool in the checkout, within their own
              timeout.
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
              {saving
                ? 'Approving…'
                : replacing
                  ? 'Approve and retire the old'
                  : 'Approve definition'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
