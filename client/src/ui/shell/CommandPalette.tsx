import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronRight, CornerDownLeft, Search, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { KeyHint } from '../primitives/Chip';
import { LAYER_MODAL, focusOnMount, revealOnMount } from '../primitives/overlay';
import { Marked } from './Marked';

/**
 * Darker and blurrier than the veil of a dialog (and than the one of Topics, 30% and 4px): the
 * page behind a search is not read, and where the box starts a row of filters or tabs is often
 * cut in half. At 60% the cut row sinks below the legible contrast even where the blur is not
 * drawn (a capture, a browser without backdrop filters), so no half word shows at the edge.
 */
const PALETTE_VEIL = 'absolute inset-0 bg-black/60 backdrop-blur-[8px] modal-backdrop-enter dark:bg-black/70';

const NO_WORDS: readonly string[] = [];

export interface PaletteItemModel {
  id: string;
  title: string;
  detail?: string;
  /** Why it matched when the words are in neither the title nor the line: shown after the line. */
  via?: string;
  icon: LucideIcon;
  /** The row that opens every result of its group: `Altri 12`, no icon tile. allow-italian: quotes the words on screen */
  more?: boolean;
}

export interface PaletteGroupModel {
  /** Names the group for tests and tools (`data-search-group`); the label when absent. */
  id?: string;
  label: string;
  icon?: LucideIcon;
  /** How many results the group holds in all, when the list shows only the first few. */
  total?: number;
  items: PaletteItemModel[];
}

/**
 * The search over everything (Cmd+K), centred near the top like Raycast or
 * Linear. The field keeps focus the whole time: ArrowDown and ArrowUp move the
 * highlight across groups (wrapping), Enter opens the highlighted result,
 * Escape or a click on the veil closes. The query, the results and the
 * highlight are the caller's; this only draws them and reports the keys.
 * Results come grouped by kind, each with the icon of its kind, and the words
 * searched for are set in `<mark>` in the title and the line under it.
 * A combobox over a listbox, the highlight through `aria-activedescendant`.
 */
export function CommandPalette({ query, onQuery, groups, words = NO_WORDS, activeId, onActive, onOpen, onClose, placeholder, empty, notice, footer, copy }: {
  query: string;
  onQuery: (q: string) => void;
  groups: PaletteGroupModel[];
  /** The words to set in `<mark>`, folded (no accents, lower case); none, no marks. */
  words?: readonly string[];
  activeId?: string;
  onActive: (id: string) => void;
  onOpen: (id: string) => void;
  onClose: () => void;
  placeholder: string;
  /** Shown instead of the list when no group has a result. */
  empty?: ReactNode;
  /** Shown above the groups, e.g. that nothing matched while suggestions still show. */
  notice?: ReactNode;
  /** Something for the right of the footer, e.g. how many results there are. */
  footer?: ReactNode;
  copy: UiCopy;
}) {
  const p = copy.kit.palette;
  const listId = useId();
  const flat = groups.flatMap((g) => g.items);
  const optionId = (id: string) => `${listId}-o-${id}`;
  const active = flat.some((it) => it.id === activeId) ? activeId : undefined;

  const move = (step: 1 | -1) => {
    if (!flat.length) return;
    const at = flat.findIndex((it) => it.id === active);
    const next = at < 0 ? (step === 1 ? 0 : flat.length - 1) : (at + step + flat.length) % flat.length;
    onActive(flat[next].id);
  };

  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (active) onOpen(active);
    }
  };

  const onLayerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
  };

  return (
    <div onKeyDown={onLayerKey} className={clsx('fixed inset-0 flex justify-center px-3 pt-3 sm:pt-[12vh]', LAYER_MODAL)}>
      <div aria-hidden="true" className={PALETTE_VEIL} onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={placeholder}
        data-global-search=""
        className="command-palette-enter relative flex max-h-[min(580px,80dvh)] w-full max-w-[640px] flex-col self-start overflow-hidden rounded-xl border border-app-border bg-surface shadow-2xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-app-border px-4">
          <Search size={16} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
          <input
            ref={focusOnMount}
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(active) : undefined}
            aria-label={placeholder}
            data-global-search-field=""
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onFieldKey}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent text-body-lg text-app-text outline-none placeholder:text-app-placeholder"
          />
        </div>
        <div id={listId} role="listbox" aria-label={p.results} className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {notice && flat.length > 0 && <div className="px-4 pb-1 pt-3 text-prose text-app-text-tertiary">{notice}</div>}
          {flat.length === 0
            ? empty && <div className="px-4 py-10 text-center text-prose text-app-text-tertiary">{empty}</div>
            : groups.map((g) => {
              if (!g.items.length) return null;
              const GroupIcon = g.icon;
              return (
                <div key={g.id ?? g.label} role="group" aria-label={g.label} data-search-group={g.id} className="pb-1">
                  <div aria-hidden="true" className="flex items-center gap-1.5 px-4 pb-1 pt-2 text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">
                    {GroupIcon && <GroupIcon size={12} className="shrink-0" aria-hidden="true" />}
                    <span className="min-w-0 flex-1 truncate">{g.label}</span>
                    {g.total !== undefined && <span className="font-medium tabular-nums tracking-normal">{g.total}</span>}
                  </div>
                  {g.items.map((it) => {
                    const on = it.id === active;
                    const Icon = it.icon;
                    return (
                      <button
                        key={it.id}
                        ref={on ? revealOnMount : undefined}
                        id={optionId(it.id)}
                        type="button"
                        role="option"
                        aria-selected={on}
                        tabIndex={-1}
                        data-search-result={g.id}
                        data-search-more={it.more ? g.id : undefined}
                        onMouseMove={on ? undefined : () => onActive(it.id)}
                        onClick={() => onOpen(it.id)}
                        className={clsx(
                          'mx-1.5 flex w-[calc(100%-12px)] scroll-mt-9 items-center gap-3 rounded-lg px-2.5 text-left coarse:min-h-12',
                          it.more ? 'min-h-8 py-1' : 'min-h-10 py-1.5',
                          on ? 'bg-black/[0.06] dark:bg-white/[0.08]' : 'bg-transparent',
                        )}
                      >
                        {it.more ? (
                          <>
                            <span className="w-7 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate text-compact font-medium text-app-text-secondary">{it.title}</span>
                            <ChevronRight size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                          </>
                        ) : (
                          <>
                            <span className={clsx('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md', on ? 'bg-primary text-white' : 'bg-black/[0.05] text-app-text-secondary dark:bg-white/[0.08]')}>
                              <Icon size={15} aria-hidden="true" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-prose leading-5 text-app-text"><Marked text={it.title} words={words} /></span>
                              {(it.detail || it.via) && (
                                <span className="block truncate text-mini leading-4 text-app-text-tertiary">
                                  {it.detail && <Marked text={it.detail} words={words} />}
                                  {it.via && <>{it.detail ? ' · ' : ''}<Marked text={it.via} words={words} /></>}
                                </span>
                              )}
                            </span>
                            {on && <CornerDownLeft size={13} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />}
                          </>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
        </div>
        <footer className="flex h-9 shrink-0 items-center gap-4 whitespace-nowrap border-t border-app-border px-4 text-mini text-app-text-tertiary">
          <span className="hidden items-center gap-1.5 sm:inline-flex"><KeyHint>{p.keyUp}</KeyHint><KeyHint>{p.keyDown}</KeyHint>{p.move}</span>
          <span className="hidden items-center gap-1.5 sm:inline-flex"><KeyHint>{p.keyEnter}</KeyHint>{p.open}</span>
          <span className="hidden items-center gap-1.5 sm:inline-flex"><KeyHint>{p.keyEscape}</KeyHint>{p.close}</span>
          {footer && <span className="ml-auto min-w-0 truncate tabular-nums">{footer}</span>}
        </footer>
      </div>
    </div>
  );
}
