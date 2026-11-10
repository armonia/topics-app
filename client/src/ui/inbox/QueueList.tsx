import type { ReactNode } from 'react';
import clsx from 'clsx';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import { Chip } from '../primitives/Chip';
import type { QueueFilter, QueueItemModel } from './model';

/**
 * One input in the queue: title, proposal, the tag that explains why a person
 * sees it. With `onSelect` the whole row is a button (pointer, hover, focus
 * ring); without it the row is a plain picture of an item.
 */
export function QueueItem({ item, selected, copy, onSelect }: {
  item: QueueItemModel;
  selected?: boolean;
  copy: UiCopy;
  onSelect?: (id: string) => void;
}) {
  const content = (
    <>
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1 text-prose font-semibold leading-5 text-app-text">{item.title}</span>
        <span className={clsx('shrink-0 text-compact leading-5 tabular-nums', item.urgent ? 'font-medium text-rose-600 dark:text-rose-400' : 'text-app-text-tertiary')}>{item.when}</span>
      </div>
      <div className="mt-0.5 text-compact leading-5 text-app-text-secondary">{copy.inbox.proposal(item.proposal)}</div>
      {item.tag && <Chip tone={item.tag.tone} className="mt-1.5">{item.tag.text}</Chip>}
    </>
  );
  return (
    <li
      aria-selected={selected || undefined}
      className={clsx(
        'relative border-b border-app-border',
        !onSelect && 'px-4 py-3',
        selected ? 'bg-sky-500/[0.08] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary' : onSelect && 'hover:bg-app-hover',
      )}
    >
      {onSelect ? (
        <button
          type="button"
          onClick={() => onSelect(item.id)}
          aria-current={selected ? 'true' : undefined}
          className="block w-full cursor-pointer px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60"
        >
          {content}
        </button>
      ) : content}
    </li>
  );
}

/** The queue column: a filter on top, the inputs below, the selected one marked; `onSelect` makes the inputs selectable. */
export function QueueList({ items, selectedId, counts, filter = 'all', onFilterChange, onSelect, copy, toolbar, empty }: {
  items: QueueItemModel[];
  selectedId?: string;
  counts: { all: number; overdue: number };
  filter?: QueueFilter;
  onFilterChange?: (filter: QueueFilter) => void;
  onSelect?: (id: string) => void;
  copy: UiCopy;
  /** A row under the filter: the office filter and the search of the queue. */
  toolbar?: ReactNode;
  /** What the list says when no input matches the filters. */
  empty?: ReactNode;
}) {
  return (
    <section className="flex h-full w-[400px] shrink-0 flex-col border-r border-app-border">
      <div className="flex h-11 shrink-0 items-center border-b border-app-border px-4">
        <SegmentedControl
          value={filter}
          onChange={(v) => onFilterChange?.(v)}
          ariaLabel={copy.inbox.filterLabel}
          options={[
            { value: 'all', label: `${copy.inbox.all} ${counts.all}` },
            { value: 'overdue', label: `${copy.inbox.overdue} ${counts.overdue}` },
          ]}
        />
      </div>
      {toolbar && <div className="flex shrink-0 items-center gap-2 border-b border-app-border px-3 py-2">{toolbar}</div>}
      {items.length === 0 && empty ? (
        <div className="flex min-h-0 flex-1 flex-col">{empty}</div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {items.map((it) => <QueueItem key={it.id} item={it} selected={it.id === selectedId} copy={copy} onSelect={onSelect} />)}
        </ul>
      )}
    </section>
  );
}
