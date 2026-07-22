import { Plus } from 'lucide-react';
import { motion } from 'motion/react';

import type { ReviewItem, ReviewState } from '../data.js';
import { StatusMark } from './StatusMark.js';

const filters: Array<{ id: 'all' | ReviewState; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'stale', label: 'Stale' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'ready', label: 'Ready' },
];

export function ReviewInbox({
  items,
  selectedId,
  filter,
  dataLabel,
  onAddSource,
  onFilter,
  onSelect,
}: {
  items: ReviewItem[];
  selectedId: string;
  filter: 'all' | ReviewState;
  dataLabel: string;
  onAddSource?: () => void;
  onFilter: (filter: 'all' | ReviewState) => void;
  onSelect: (id: string) => void;
}) {
  const visible = filter === 'all' ? items : items.filter((item) => item.state === filter);

  return (
    <section className="inbox-panel" id="inbox" aria-labelledby="inbox-title">
      <header className="inbox-header">
        <div className="eyebrow-line">
          <span>{dataLabel}</span>
          <span aria-hidden="true">·</span>
          <span>Updated now</span>
        </div>
        <div className="inbox-title-line">
          <h1 id="inbox-title">Review inbox</h1>
          {onAddSource && (
            <button className="add-source-button" type="button" onClick={onAddSource}>
              <Plus aria-hidden="true" size={14} />
              Add source
            </button>
          )}
        </div>
        <p>Work that looks complete, ordered by what still needs proof.</p>
      </header>

      <div className="filter-strip" aria-label="Filter reviews">
        {filters.map((item) => (
          <button
            className={filter === item.id ? 'selected' : undefined}
            type="button"
            key={item.id}
            aria-pressed={filter === item.id}
            onClick={() => onFilter(item.id)}
          >
            {item.label}
            <span>
              {item.id === 'all'
                ? items.length
                : items.filter((review) => review.state === item.id).length}
            </span>
          </button>
        ))}
      </div>

      <div className="review-list" aria-live="polite">
        {visible.length === 0 ? (
          <div className="empty-state">
            <span>Nothing in this view.</span>
            <button type="button" onClick={() => onFilter('all')}>
              Show all reviews
            </button>
          </div>
        ) : (
          visible.map((item, index) => (
            <motion.button
              className={`review-row ${selectedId === item.id ? 'selected' : ''}`}
              type="button"
              key={item.id}
              onClick={() => onSelect(item.id)}
              aria-pressed={selectedId === item.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, delay: index * 0.045 }}
            >
              <div className="row-topline">
                <StatusMark state={item.state} compact />
                <span>{item.updatedLabel}</span>
              </div>
              <strong>{item.title}</strong>
              <div className="repo-line">
                <span>{item.repository}</span>
                <span aria-hidden="true">/</span>
                <span>{item.branch}</span>
              </div>
              <p>{item.reason}</p>
              <div className="row-footer">
                <span>
                  {item.requiredSatisfied}/{item.requiredTotal} gates
                </span>
                <span>{item.source}</span>
              </div>
            </motion.button>
          ))
        )}
      </div>
    </section>
  );
}
