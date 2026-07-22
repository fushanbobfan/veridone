import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  FileDiff,
  GitBranch,
  Play,
  ShieldAlert,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

import type { ReviewItem } from '../data.js';
import { StatusMark } from './StatusMark.js';

export function ReviewDetail({
  item,
  decision,
  evidenceActionLabel,
  evidenceActionBusy = false,
  onBack,
  onEvidenceAction,
  onAccept,
  onRequestChanges,
  onExport,
}: {
  item: ReviewItem;
  decision: string | null;
  evidenceActionLabel?: string;
  evidenceActionBusy?: boolean;
  onBack: () => void;
  onEvidenceAction?: () => void;
  onAccept: () => void;
  onRequestChanges: () => void;
  onExport?: () => void;
}) {
  const ready = item.state === 'ready';
  const percentage = Math.round((item.requiredSatisfied / item.requiredTotal) * 100);

  return (
    <main className="review-detail" id="review-detail" tabIndex={-1}>
      <AnimatePresence mode="wait">
        <motion.div
          className="detail-inner"
          key={item.id}
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -8 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
        >
          <button className="mobile-back" type="button" onClick={onBack}>
            <ArrowLeft aria-hidden="true" size={16} />
            Review inbox
          </button>

          <header className="detail-header">
            <div className="detail-kicker">
              <span>{item.repository}</span>
              <ChevronRight aria-hidden="true" size={13} />
              <span>{item.source}</span>
              <span aria-hidden="true">·</span>
              <span>{item.updatedLabel}</span>
            </div>
            <div className="title-line">
              <h2>{item.title}</h2>
              <StatusMark state={item.state} />
            </div>
            <p>{item.reason}</p>
          </header>

          <section className="readiness-band" aria-labelledby="readiness-title">
            <div className="readiness-score">
              <span className="score-number">{percentage}</span>
              <span className="score-unit">%</span>
            </div>
            <div className="readiness-copy">
              <span className="section-label" id="readiness-title">
                Decision readiness
              </span>
              <strong>
                {item.requiredSatisfied} of {item.requiredTotal} required gates are current
              </strong>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="Required gates satisfied"
                aria-valuemin={0}
                aria-valuemax={item.requiredTotal}
                aria-valuenow={item.requiredSatisfied}
              >
                <motion.span
                  initial={{ width: 0 }}
                  animate={{ width: `${percentage}%` }}
                  transition={{ duration: 0.45, ease: 'easeOut' }}
                />
              </div>
            </div>
            <dl className="snapshot-grid">
              <div>
                <dt>
                  <GitBranch aria-hidden="true" size={14} /> Branch
                </dt>
                <dd>{item.branch}</dd>
              </div>
              <div>
                <dt>HEAD</dt>
                <dd className="mono">{item.head}</dd>
              </div>
              <div>
                <dt>
                  <FileDiff aria-hidden="true" size={14} /> Scope
                </dt>
                <dd>
                  {item.changedFiles} files <span className="added">+{item.additions}</span>{' '}
                  <span className="deleted">−{item.deletions}</span>
                </dd>
              </div>
              <div>
                <dt>Worktree</dt>
                <dd>{item.dirty ? 'Modified after evidence' : 'Clean'}</dd>
              </div>
            </dl>
          </section>

          <div className="review-content">
            <section className="criteria-section" aria-labelledby="criteria-title">
              <div className="section-heading">
                <div>
                  <span className="section-label">Acceptance contract</span>
                  <h3 id="criteria-title">Required evidence</h3>
                </div>
                <div className="heading-actions">
                  <button className="text-button" type="button">
                    View contract <ArrowUpRight aria-hidden="true" size={14} />
                  </button>
                  {onExport && (
                    <button className="text-button" type="button" onClick={onExport}>
                      Export packet <ArrowUpRight aria-hidden="true" size={14} />
                    </button>
                  )}
                </div>
              </div>

              <div className="criteria-list">
                {item.criteria.map((criterion, index) => (
                  <motion.button
                    className="criterion-row"
                    type="button"
                    key={criterion.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, delay: index * 0.035 }}
                  >
                    <span className={`criterion-index criterion-${criterion.state}`}>
                      {criterion.state === 'passed' ? (
                        <Check aria-hidden="true" size={14} />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <span className="criterion-copy">
                      <strong>{criterion.title}</strong>
                      <small>{criterion.detail}</small>
                    </span>
                    <span className="criterion-evidence">{criterion.evidenceLabel}</span>
                    <StatusMark state={criterion.state} compact />
                    <ChevronRight className="criterion-arrow" aria-hidden="true" size={15} />
                  </motion.button>
                ))}
              </div>
            </section>

            <aside className="evidence-aside" aria-labelledby="evidence-title">
              <div className="section-heading">
                <div>
                  <span className="section-label">Evidence rail</span>
                  <h3 id="evidence-title">Why it is not done</h3>
                </div>
              </div>

              <ol className="evidence-rail">
                <li className="rail-step rail-claim">
                  <span className="rail-node">1</span>
                  <div>
                    <small>Agent claim</small>
                    <blockquote>“{item.claim}”</blockquote>
                    <span>{item.claimSource}</span>
                  </div>
                </li>
                <li className={`rail-step rail-evidence ${ready ? 'complete' : 'interrupted'}`}>
                  <span className="rail-node">2</span>
                  <div>
                    <small>Independent evidence</small>
                    <strong>{ready ? 'All required evidence is current' : item.reason}</strong>
                    <span>
                      A claim can explain intent. It cannot satisfy a required gate by itself.
                    </span>
                    {evidenceActionLabel && onEvidenceAction && (
                      <button
                        className="run-button"
                        type="button"
                        onClick={onEvidenceAction}
                        disabled={evidenceActionBusy}
                      >
                        <Play aria-hidden="true" size={14} fill="currentColor" />
                        {evidenceActionBusy ? 'Working…' : evidenceActionLabel}
                      </button>
                    )}
                  </div>
                </li>
                <li className={`rail-step rail-verdict ${ready ? 'available' : ''}`}>
                  <span className="rail-node">3</span>
                  <div>
                    <small>Human verdict</small>
                    <strong>
                      {decision ?? (ready ? 'Ready for your decision' : 'Locked by open gates')}
                    </strong>
                    <span>Automated checks never sign off on your behalf.</span>
                  </div>
                </li>
              </ol>

              {(item.sensitive || item.scopeDrift) && (
                <div className="risk-note">
                  <ShieldAlert aria-hidden="true" size={17} />
                  <div>
                    <strong>Review attention</strong>
                    <span>
                      {item.sensitive
                        ? 'This change touches export and path-boundary code.'
                        : 'The diff extends beyond the declared contract scope.'}
                    </span>
                  </div>
                </div>
              )}
            </aside>
          </div>

          <footer className="decision-dock">
            <div>
              <span className="section-label">Your decision</span>
              <strong>{ready ? 'Evidence is current' : 'Acceptance is locked'}</strong>
              <small>
                {ready
                  ? 'Review the evidence, then record a human verdict.'
                  : 'Re-run or resolve every required gate before accepting.'}
              </small>
            </div>
            <div className="decision-actions">
              <button type="button" className="secondary-action" onClick={onRequestChanges}>
                Request changes
              </button>
              <button type="button" className="primary-action" disabled={!ready} onClick={onAccept}>
                <Check aria-hidden="true" size={16} />
                Accept work
              </button>
            </div>
          </footer>
        </motion.div>
      </AnimatePresence>
    </main>
  );
}
