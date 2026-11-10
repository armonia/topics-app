import { useId, useState, type KeyboardEvent } from 'react';
import { Check, Search, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { Count } from '../primitives/Chip';
import { focusOnMount, revealOnMount } from '../primitives/overlay';
import { plain } from './model';

export interface PickItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  count?: number;
  /** The current choice: drawn with a tick. */
  selected?: boolean;
}

/**
 * A list to pick one row from, with a search box on top when there are many.
 * The box keeps focus the whole time (a combobox over a listbox): arrows move
 * the highlight, Enter picks, Escape closes, Backspace on an empty box goes
 * back a step. Without `searchable` there is no box: the list itself takes
 * the focus and the same keys (a hidden box would be a control nobody can see
 * or press).
 */
export function PickList({ items, onPick, onBack, onClose, searchable, placeholder, ariaLabel, empty }: {
  items: PickItem[];
  onPick: (id: string) => void;
  onBack?: () => void;
  onClose: () => void;
  searchable?: boolean;
  placeholder: string;
  ariaLabel: string;
  empty: string;
}) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const needle = plain(query.trim());
  const rows = needle ? items.filter((it) => plain(it.label).includes(needle)) : items;
  const at = Math.min(cursor, rows.length - 1);
  const optionId = (id: string) => `${listId}-${id}`;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setCursor((at + step + rows.length) % rows.length);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (rows[at]) onPick(rows[at].id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Backspace' && query === '' && onBack) {
      e.preventDefault();
      onBack();
    }
  };

  return (
    <div className="flex min-h-0 flex-col">
      {searchable && (
      <div className="relative border-b border-app-border px-2 py-1.5">
        <Search size={14} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-app-text-tertiary" aria-hidden="true" />
        <input
          ref={focusOnMount}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows[at] ? optionId(rows[at].id) : undefined}
          aria-label={ariaLabel}
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
          className="h-7 w-full min-w-0 rounded-md border border-app-border-input bg-surface pl-7 pr-2 text-compact text-app-text placeholder:text-app-placeholder focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        />
      </div>
      )}
      <div
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        ref={searchable ? undefined : focusOnMount}
        tabIndex={searchable ? undefined : 0}
        aria-activedescendant={!searchable && rows[at] ? optionId(rows[at].id) : undefined}
        onKeyDown={searchable ? undefined : onKeyDown}
        className="max-h-[min(280px,50dvh)] overflow-y-auto py-1 focus-visible:outline-none"
      >
        {rows.length === 0 && <p className="px-3 py-2 text-compact text-app-text-tertiary">{empty}</p>}
        {rows.map((it, i) => {
          const Icon = it.icon;
          const on = i === at;
          return (
            <button
              key={it.id}
              ref={on ? revealOnMount : undefined}
              id={optionId(it.id)}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={it.selected ?? on}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setCursor(i)}
              onClick={() => onPick(it.id)}
              className={clsx(
                'mx-1 flex h-7 w-[calc(100%-8px)] items-center gap-2 rounded-md px-2 text-left text-compact text-app-text coarse:h-11 coarse:text-body-lg',
                on && 'bg-black/[0.06] dark:bg-white/[0.08]',
              )}
            >
              {Icon && <Icon size={14} className="shrink-0 text-app-text-secondary" aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.count !== undefined && <Count value={it.count} />}
              {it.selected && <Check size={14} className="shrink-0 text-primary" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
