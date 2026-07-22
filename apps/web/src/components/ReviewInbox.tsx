import { ArrowDownWideNarrow, Plus, Search } from 'lucide-react';
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
  query,
  sort,
  dataLabel,
  sourceIssues,
  onAddSource,
  onFilter,
  onQuery,
  onSort,
  onSelect,
}: {
  items: ReviewItem[];
  selectedId: string;
  filter: 'all' | ReviewState;
  query: string;
  sort: 'priority' | 'newest' | 'repository';
  dataLabel: string;
  sourceIssues: Array<{ repositoryId: string; message: string }>;
  onAddSource?: () => void;
  onFilter: (filter: 'all' | ReviewState) => void;
  onQuery: (query: string) => void;
  onSort: (sort: 'priority' | 'newest' | 'repository') => void;
  onSelect: (id: string) => void;
}) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const stateRank: Record<ReviewState, number> = { stale: 0, blocked: 1, ready: 2, decided: 3 };
  const visible = items
    .filter((item) => filter === 'all' || item.state === filter)
    .filter((item) =>
      normalizedQuery
        ? [item.title, item.repository, item.branch, item.source, item.reason].some((value) =>
            value.toLocaleLowerCase().includes(normalizedQuery),
          )
        : true,
    )
    .toSorted((left, right) => {
      if (sort === 'repository') {
        return (
          left.repository.localeCompare(right.repository) || left.title.localeCompare(right.title)
        );
      }
      if (sort === 'newest') return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      return (
        stateRank[left.state] - stateRank[right.state] ||
        left.requiredSatisfied / left.requiredTotal - right.requiredSatisfied / right.requiredTotal
      );
    });

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
        {sourceIssues.length > 0 && (
          <div className="source-issue" role="status">
            <strong>
              {sourceIssues.length} repository{' '}
              {sourceIssues.length === 1 ? 'source is' : 'sources are'}
              unavailable
            </strong>
            <span>{sourceIssues[0]?.message}</span>
          </div>
        )}
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

      <div className="inbox-tools">
        <label className="search-control">
          <Search aria-hidden="true" size={14} />
          <span className="sr-only">Search reviews</span>
          <input
            type="search"
            value={query}
            onChange={(event) => onQuery(event.currentTarget.value)}
            placeholder="Search claims, repositories, sources…"
          />
        </label>
        <label className="sort-control">
          <ArrowDownWideNarrow aria-hidden="true" size={14} />
          <span className="sr-only">Sort reviews</span>
          <select
            value={sort}
            onChange={(event) => onSort(event.currentTarget.value as typeof sort)}
          >
            <option value="priority">Needs proof</option>
            <option value="newest">Recently updated</option>
            <option value="repository">Repository</option>
          </select>
        </label>
      </div>

      <div className="review-list" aria-live="polite">
        {visible.length === 0 ? (
          <div className="empty-state">
            <span>
              {normalizedQuery ? 'No reviews match this search.' : 'Nothing in this view.'}
            </span>
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
