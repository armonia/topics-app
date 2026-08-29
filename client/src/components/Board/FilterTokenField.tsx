/**
 * FilterTokenField — priority + assignee, as ONE token field with autocomplete.
 *
 * Before, these were two independent chip+`Menu` pickers: click a chip, a
 * dropdown opens with a static option list, click a row. Fine for four
 * priorities, but the same shape does not scale to assignees on a board with
 * a dozen agents, and it is a different gesture from every OTHER "pick one of
 * many" field in the app — the composer's @-file mention, which you type into
 * and see matches as you go.
 *
 * So this is that gesture, replicated: a controlled input, trigger detection
 * (here trivial — the whole field IS the trigger, there is no textarea sharing
 * it with prose) and an array of tokens, exactly ChatInput's `message` +
 * `mentionedFiles` shape. The chrome is not reinvented: `SuggestionMenu` is
 * the shell extracted from `FileMentionMenu`, `TokenPill` is `FilePill`
 * generalised past "a file", and dismissal is the same `useDismissable`
 * (inside `SuggestionMenu`) every other menu in the app uses.
 *
 * The PROJECT filter stays `ProjectFilterPicker`, untouched: it already has a
 * search box (`ProjectPickerBody`) and its own suggestion strip, and three
 * regression suites (`kanbanChipMetrics.test.ts`, `ProjectFilterPicker.test.ts`,
 * `kanbanTopbar.test.ts`, all `@covers KANBAN-12`) pin that it exists and is
 * used exactly as it is.
 */
import { useMemo, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { fuzzyScore } from '../../lib/fuzzyScore';
import { SuggestionMenu } from '../Shared/SuggestionMenu';
import { TokenPill } from '../Shared/TokenPill';
import { filterFieldClass, filterInputClass, filterTokenPillClass, PRIORITY_DOT, PRIORITY_LABEL, PRIORITY_ORDER } from './constants';

type Token =
  | { kind: 'priority'; value: number; label: string }
  | { kind: 'assignee'; value: string; label: string };

export function FilterTokenField({
  priority, assignedTo, assignees, onPriorityChange, onAssignedToChange,
}: {
  priority: readonly number[];
  assignedTo: readonly string[];
  /** Assignees seen on the current task set — the ONLY source of assignee
   *  suggestions, same as the dropdown it replaces. */
  assignees: readonly string[];
  onPriorityChange: (p: number[]) => void;
  onAssignedToChange: (a: string[]) => void;
}) {
  const tr = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Suggestions never repeat a token already picked — same rule the old
  // dropdowns followed by ticking a check mark instead of hiding the row; a
  // TEXT field has no room for a disabled-but-visible option.
  const options = useMemo<Token[]>(() => [
    ...PRIORITY_ORDER.filter((p) => !priority.includes(p)).map((p) => ({ kind: 'priority' as const, value: p, label: PRIORITY_LABEL[p] })),
    ...assignees.filter((a) => !assignedTo.includes(a)).map((a) => ({ kind: 'assignee' as const, value: a, label: a })),
  ], [priority, assignedTo, assignees]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return options;
    return options
      .map((o) => ({ o, score: fuzzyScore(q, o.label) }))
      .filter((r) => r.score.match)
      .sort((a, b) => b.score.score - a.score.score)
      .map((r) => r.o);
  }, [options, query]);

  const addToken = (t: Token) => {
    if (t.kind === 'priority') onPriorityChange([...priority, t.value].sort((a, b) => b - a));
    else onAssignedToChange([...assignedTo, t.value]);
    setQuery('');
    setSelectedIndex(0);
    // Multi-select is a run of picks (chat's @mention only ever inserts one,
    // this field routinely wants three): keep the field focused and the menu
    // open on the now-shorter list instead of forcing a re-click per token.
    inputRef.current?.focus();
  };

  // Backspace on an EMPTY field removes the most recently added token — the
  // same affordance a browser's tag input gives, and the reason `Token[]`
  // instead of two independent arrays would have been the wrong shape: "the
  // last one" has to mean something across both kinds.
  const removeLast = () => {
    if (assignedTo.length > 0) onAssignedToChange(assignedTo.slice(0, -1));
    else if (priority.length > 0) onPriorityChange(priority.slice(0, -1));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (open && filtered.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex((i) => (i + 1) % filtered.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length); return; }
      if (e.key === 'Enter') { e.preventDefault(); addToken(filtered[selectedIndex]!); return; }
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
    if (e.key === 'Backspace' && query === '') { removeLast(); }
  };

  const hasTokens = priority.length > 0 || assignedTo.length > 0;

  return (
    // The shell is `filterFieldClass`, like every other filter on the row, and
    // `active` says the same thing here as on a chip: this control is narrowing
    // the board. Before, a field holding three tokens looked as idle as an
    // empty one.
    <div
      className={`${filterFieldClass(hasTokens)} relative`}
      data-testid="filter-token-field"
    >
      {priority.map((p) => (
        <TokenPill
          key={`priority-${p}`}
          icon={<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[p]}`} />}
          label={PRIORITY_LABEL[p]}
          onRemove={() => onPriorityChange(priority.filter((x) => x !== p))}
          removeLabel={tr('board.filter.removeToken', { label: PRIORITY_LABEL[p] })}
          className={filterTokenPillClass}
        />
      ))}
      {assignedTo.map((a) => (
        <TokenPill
          key={`assignee-${a}`}
          label={`@${a}`}
          onRemove={() => onAssignedToChange(assignedTo.filter((x) => x !== a))}
          removeLabel={tr('board.filter.removeToken', { label: a })}
          className={filterTokenPillClass}
        />
      ))}
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setSelectedIndex(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={hasTokens ? '' : tr('board.filter.priorityAssigneePlaceholder')}
        aria-label={tr('board.filter.priorityAssigneeLabel')}
        data-testid="filter-token-input"
        className={`${filterInputClass} min-w-[56px]`}
      />
      <SuggestionMenu
        visible={open}
        items={filtered}
        getKey={(t) => `${t.kind}-${t.value}`}
        selectedIndex={selectedIndex}
        onClose={() => setOpen(false)}
        inputRef={inputRef}
        headerLabel={tr('board.filter.priorityAssignee')}
        filterBadge={query || undefined}
        emptyLabel={tr('palette.noResults')}
        position="below"
        className="w-48"
        renderItem={(t, idx, { selected }) => (
          <button
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => addToken(t)}
            onMouseEnter={() => setSelectedIndex(idx)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${
              selected ? 'bg-primary/15 text-app-text' : 'text-app-text hover:bg-app-hover'
            }`}
          >
            {t.kind === 'priority'
              ? <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[t.value]}`} />
              : <span className="w-1.5 shrink-0 text-center text-app-text-muted">@</span>}
            <span className="truncate">{t.label}</span>
          </button>
        )}
      />
    </div>
  );
}
