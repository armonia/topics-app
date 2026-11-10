import { Fragment, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { BookmarkPlus, ListFilter, Plus, X } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Count } from '../primitives/Chip';
import { TextField } from '../primitives/Field';
import { Popover } from '../primitives/Popover';
import { FLOAT_SURFACE, LAYER_FLOAT, revealOnMount } from '../primitives/overlay';
import { FOCUS_RING } from '../shell/pressable';
import { FilterEditor, DROP, SHEET } from './FilterEditor';
import { BAR_SIZE, FilterToken, type BarSize } from './FilterToken';
import { plain, type FilterBarModel, type FilterSuggestion, type SavedFilterModel } from './model';

export type FilterBarProps = FilterBarModel & {
  copy: UiCopy;
  size?: BarSize;
  /** The phone layout: the pickers open as a sheet at the foot of the screen. */
  phone?: boolean;
  /** The right of the bar: the view switch (list, kanban) or the order. */
  trailing?: ReactNode;
  className?: string;
};

/**
 * The one filter bar of every list. A search that filters as it is typed and
 * suggests while it does (grouped by the kind of thing: arrows move, Enter
 * picks, Escape closes; Enter with nothing picked leaves the text as the
 * search); the filters as tokens, each changeable; the add button, which
 * builds one a step at a time; the saved filters as pills with their count;
 * the save button when there are tokens; the clear button when there is
 * anything; the number of results; a place on the right for the view. It holds
 * only what is open; the filters, the text and the saved ones are the
 * caller's.
 */
export function FilterBar({
  copy, size = 'md', phone, trailing, className,
  query, placeholder, onQuery, suggestions, onPickSuggestion, fields, valuesOf, tokens, onAddToken, onChangeToken, onRemoveToken,
  saved, onApplySaved, onRemoveSaved, onSave, onClear, shown, total,
}: FilterBarProps) {
  const c = copy.filters;
  const s = BAR_SIZE[size];
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const canSave = Boolean(onSave) && tokens.length > 0 && !saved.some((x) => x.active);
  const anything = query !== '' || tokens.length > 0;
  const savedGroup = saved.length > 0 && (
    <div role="group" aria-label={c.savedLabel} className="flex min-w-0 flex-wrap items-center gap-1.5">
      {saved.map((f) => <SavedPill key={f.id} filter={f} copy={copy} size={size} onApply={onApplySaved} onRemove={onRemoveSaved} />)}
    </div>
  );
  /* The count, Azzera and the list's own controls may wrap: on a phone they would push the page sideways. */
  const hasCount = shown !== undefined && total !== undefined;
  const tail = (hasCount || anything || trailing) ? (
    <span className={clsx('flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1', phone ? 'w-full justify-between' : 'ml-auto justify-end')}>
      {hasCount && (
        <span role="status" aria-live="polite" className="whitespace-nowrap text-mini tabular-nums text-app-text-tertiary">{c.results(shown, total)}</span>
      )}
      {anything && (
        <button
          type="button"
          onClick={onClear}
          className={clsx('inline-flex shrink-0 items-center whitespace-nowrap rounded-lg px-2 font-medium text-app-text-secondary transition-colors hover:bg-black/[0.05] hover:text-app-text dark:hover:bg-white/[0.08]', FOCUS_RING, s.row)}
        >
          {c.clear}
        </button>
      )}
      {trailing}
    </span>
  ) : null;

  return (
    <div role="search" aria-label={c.label} className={clsx('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <SearchBox
          copy={copy}
          size={size}
          phone={phone}
          query={query}
          placeholder={placeholder ?? c.search}
          onQuery={onQuery}
          suggestions={suggestions}
          onPick={onPickSuggestion}
          onBackspaceEmpty={() => {
            const last = tokens.at(-1);
            if (last) onRemoveToken(last.id);
          }}
        />
        <span className="relative inline-flex shrink-0">
          <button
            ref={addButton}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={adding}
            aria-label={c.addFilterLabel}
            data-tip={phone ? c.addFilter : undefined}
            onClick={() => setAdding(!adding)}
            className={clsx(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 font-medium text-app-text-secondary transition-colors hover:bg-black/[0.05] hover:text-app-text dark:hover:bg-white/[0.08]',
              adding && 'bg-black/[0.05] text-app-text dark:bg-white/[0.08]', FOCUS_RING, s.row,
            )}
          >
            <Plus size={s.icon} aria-hidden="true" />
            {!phone && c.addFilter}
          </button>
          {adding && (
            <FilterEditor
              copy={c}
              fields={fields}
              valuesOf={valuesOf}
              step="field"
              phone={phone}
              onCommit={(draft) => {
                onAddToken(draft);
                setAdding(false);
                addButton.current?.focus({ preventScroll: true });
              }}
              onClose={() => {
                setAdding(false);
                addButton.current?.focus({ preventScroll: true });
              }}
            />
          )}
        </span>
        {phone ? (
          /* On a phone the saved filters wrap whole (a pill is never cut), and the count and Azzera sit on a row of their own under them: they never cover the last pill. */
          (saved.length > 0 || tail) && (
            <div className="flex min-w-0 basis-full flex-col gap-1.5">
              {savedGroup}
              {tail}
            </div>
          )
        ) : (
          <>
            {savedGroup}
            {tail}
          </>
        )}
      </div>
      {tokens.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {tokens.map((t) => (
            <FilterToken
              key={t.id}
              token={t}
              copy={c}
              fields={fields}
              valuesOf={valuesOf}
              size={size}
              phone={phone}
              onChange={(draft) => onChangeToken(t.id, draft)}
              onRemove={() => onRemoveToken(t.id)}
            />
          ))}
          {canSave && onSave && <SaveFilter copy={copy} size={size} phone={phone} onSave={onSave} />}
        </div>
      )}
    </div>
  );
}

/** A saved filter as a pill with its count; a cross deletes the ones the person made. */
function SavedPill({ filter, copy, size, onApply, onRemove }: {
  filter: SavedFilterModel;
  copy: UiCopy;
  size: BarSize;
  onApply: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  const s = BAR_SIZE[size];
  const removable = filter.removable && onRemove;
  return (
    <span className="group relative inline-flex min-w-0 max-w-full items-center">
      <button
        type="button"
        aria-pressed={filter.active}
        onClick={() => onApply(filter.id)}
        className={clsx(
          'inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap rounded-full bg-black/[0.05] px-3 font-medium text-app-text transition-shadow dark:bg-white/10',
          filter.active ? 'ring-2 ring-primary/70' : 'hover:ring-1 hover:ring-black/15 dark:hover:ring-white/20',
          removable && 'group-focus-within:pr-6 group-hover:pr-6 coarse:pr-8',
          FOCUS_RING, s.row,
        )}
      >
        <span className="min-w-0 truncate">{filter.name}</span>
        <Count value={filter.count} tone={filter.active ? 'blue' : 'neutral'} />
      </button>
      {removable && (
        <button
          type="button"
          aria-label={copy.filters.removeSaved(filter.name)}
          data-tip={copy.filters.removeSaved(filter.name)}
          onClick={() => onRemove(filter.id)}
          className={clsx(
            'absolute right-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-app-text-tertiary opacity-0 transition-opacity hover:text-app-text focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 coarse:opacity-100',
            FOCUS_RING,
          )}
        >
          <X size={10} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

/** The save button: a small popover with a name and the button that saves it. */
function SaveFilter({ copy, size, phone, onSave }: { copy: UiCopy; size: BarSize; phone?: boolean; onSave: (name: string) => void }) {
  const c = copy.filters;
  const s = BAR_SIZE[size];
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  const save = () => {
    const clean = name.trim();
    if (!clean) return;
    onSave(clean);
    setName('');
    close();
  };
  return (
    <span className="relative inline-flex shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={clsx(
          'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 font-medium text-app-text-secondary transition-colors hover:bg-black/[0.05] hover:text-app-text dark:hover:bg-white/[0.08]',
          open && 'bg-black/[0.05] text-app-text dark:bg-white/[0.08]', FOCUS_RING, s.row,
        )}
      >
        <BookmarkPlus size={s.icon} aria-hidden="true" />
        {c.save}
      </button>
      {open && (
        <Popover ariaLabel={c.saveTitle} onClose={close} fixed={phone} className={clsx(phone ? SHEET : DROP, 'p-2')}>
          <div className="flex flex-col gap-2">
            <TextField autoFocus size="sm" label={c.saveName} placeholder={c.saveNamePlaceholder} value={name} onChange={setName} onEnter={save} />
            <Button size="sm" variant="primary" onClick={name.trim() ? save : false} className="self-end">{c.saveConfirm}</Button>
          </div>
        </Popover>
      )}
    </span>
  );
}

/**
 * The search box: its text IS the text filter (the list narrows as you type),
 * and a list of suggestions, by kind, hangs under it. The cursor opens on the
 * first suggestion (marked, and the one Enter takes); the arrows and the
 * pointer move it. The part of a label that matches the text is bold.
 * Escape closes the list and keeps the text as the search. Backspace on an
 * empty box takes off the last filter.
 */
function SearchBox({ copy, size, phone, query, placeholder, onQuery, suggestions, onPick, onBackspaceEmpty }: {
  copy: UiCopy;
  size: BarSize;
  phone?: boolean;
  query: string;
  placeholder: string;
  onQuery: (q: string) => void;
  suggestions: FilterSuggestion[];
  onPick: (s: FilterSuggestion) => void;
  onBackspaceEmpty: () => void;
}) {
  const c = copy.filters;
  const s = BAR_SIZE[size];
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [cursor, setCursor] = useState(0);
  const open = focused && !dismissed && query.trim() !== '' && suggestions.length > 0;
  /* Open, the cursor is always on a row (the first until the person moves it); closed, on none. */
  const at = open ? Math.min(cursor, suggestions.length - 1) : -1;
  const optionId = (i: number) => `${listId}-${i}`;

  const pick = (sug: FilterSuggestion) => {
    onPick(sug);
    setCursor(0);
    input.current?.focus({ preventScroll: true });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggestions.length) return;
      e.preventDefault();
      setDismissed(false);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setCursor(at < 0 ? (step === 1 ? 0 : suggestions.length - 1) : (at + step + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (at >= 0) pick(suggestions[at]);
      else setDismissed(true);
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        setCursor(0);
      } else if (query) {
        e.preventDefault();
        e.stopPropagation();
        onQuery('');
      }
    } else if (e.key === 'Backspace' && !e.repeat && query === '') {
      onBackspaceEmpty();
    }
  };

  return (
    <div className={clsx('relative flex min-w-0 items-center', phone ? 'flex-1' : 'w-[15rem] max-w-full shrink')}>
      <ListFilter size={s.icon} className="pointer-events-none absolute left-2.5 text-app-text-tertiary" aria-hidden="true" />
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={at >= 0 ? optionId(at) : undefined}
        aria-label={c.searchLabel}
        placeholder={placeholder}
        data-local-filter=""
        value={query}
        onChange={(e) => {
          onQuery(e.target.value);
          setDismissed(false);
          setCursor(0);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setCursor(0);
        }}
        onKeyDown={onKeyDown}
        className={clsx(
          'w-full min-w-0 rounded-lg border border-app-border-input bg-surface pl-8 text-app-text placeholder:text-app-placeholder transition-colors hover:border-black/20 dark:hover:border-white/20',
          query ? 'pr-7' : 'pr-2.5', FOCUS_RING, s.row,
        )}
      />
      {query !== '' && (
        <button
          type="button"
          aria-label={c.clearSearch}
          data-tip={c.clearSearch}
          onClick={() => {
            onQuery('');
            input.current?.focus({ preventScroll: true });
          }}
          className={clsx('absolute right-1 inline-flex h-5 w-5 items-center justify-center rounded-md text-app-text-tertiary hover:text-app-text', FOCUS_RING)}
        >
          <X size={s.icon - 2} aria-hidden="true" />
        </button>
      )}
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={c.suggestionsLabel}
          className={clsx(FLOAT_SURFACE, LAYER_FLOAT, 'absolute left-0 top-full mt-1 max-h-[min(360px,50dvh)] w-max min-w-[22rem] max-w-[min(32rem,calc(100vw-16px))] overflow-y-auto py-1')}
        >
          {suggestions.map((sug, i) => {
            const head = i === 0 || suggestions[i - 1].group !== sug.group;
            const Icon = sug.icon;
            return (
              <div key={sug.id} role="presentation">
                {head && <p role="presentation" className="px-3 pb-0.5 pt-1.5 text-nano font-semibold uppercase tracking-wide text-app-text-tertiary">{sug.group}</p>}
                <button
                  ref={i === at ? revealOnMount : undefined}
                  id={optionId(i)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === at}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(sug)}
                  className={clsx(
                    'mx-1 flex h-7 w-[calc(100%-8px)] items-center gap-2 rounded-md px-2 text-left text-compact text-app-text coarse:h-11 coarse:text-body-lg',
                    i === at && 'bg-black/[0.06] dark:bg-white/[0.08]',
                  )}
                >
                  <Icon size={14} className="shrink-0 text-app-text-secondary" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{markMatch(sug.label, query)}</span>
                  {sug.detail && <span className="shrink-0 pl-3 text-mini text-app-text-tertiary">{sug.detail}</span>}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A label with the part that matches the text typed in bold: accents and case
 * are ignored the way the search ignores them, and each word of the text is
 * marked where it first appears.
 */
function markMatch(label: string, query: string): ReactNode {
  const words = plain(query).split(/\s+/).filter(Boolean);
  if (!words.length) return label;
  /* `flat` is the label as the search reads it; `from[i]` is where its character i stands in the label. */
  let flat = '';
  const from: number[] = [];
  for (let i = 0; i < label.length; i++) {
    for (const ch of plain(label[i])) {
      flat += ch;
      from.push(i);
    }
  }
  const spans: Array<[number, number]> = [];
  for (const w of words) {
    const hit = flat.indexOf(w);
    if (hit >= 0) spans.push([from[hit], from[hit + w.length - 1] + 1]);
  }
  if (!spans.length) return label;
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else merged.push([sp[0], sp[1]]);
  }
  const out: ReactNode[] = [];
  let pos = 0;
  merged.forEach(([a, b], i) => {
    if (a > pos) out.push(label.slice(pos, a));
    out.push(<span key={i} className="font-semibold">{label.slice(a, b)}</span>);
    pos = b;
  });
  if (pos < label.length) out.push(label.slice(pos));
  return out.map((node, i) => <Fragment key={i}>{node}</Fragment>);
}
