/**
 * FilterTokenField — the board's ONE filter field: free text AND the four
 * closed vocabularies (priority, who-closes, kind, assignee) in a single
 * control, replacing a search box, two chip+`Menu` dropdowns and a token field
 * that only knew two of the four.
 *
 * THE TENSION, and how it is resolved. One input holding an OPEN vocabulary
 * (free text over task titles) and CLOSED ones (the tokens) is where this
 * design normally breaks: you type "auth", the board narrows to six cards, and
 * a panel lands on top of those six saying "no results" about a search that
 * produced six. Three rules, none of them a convention anyone has to learn:
 *
 *   1. the input's value IS `filters.text` - always, with no prefix syntax, so
 *      the board narrows as you type exactly as it did before;
 *   2. the panel is mounted only when there is at least one row, so the empty
 *      state cannot be reached and nothing floats over a board that answered;
 *   3. rows are always filtered by that same text, so a row is on screen only
 *      BECAUSE the query matched it - which is what makes consuming the query
 *      on pick correct by construction rather than a guess about intent.
 *
 * The PROJECT filter stays `ProjectFilterPicker`, untouched: it has its own
 * search box and its own inline chip strip, and three suites pin it.
 */
import { useMemo, useRef, useState } from 'react';
import { Check, Search, Tag } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { POPOVER_ITEM } from '../../lib/popoverStyles';
import { CLOSER_LABELS, KIND_LABELS, type TaskLabel } from '../../lib/board';
import { SuggestionMenu } from '../Shared/SuggestionMenu';
import { TokenPill } from '../Shared/TokenPill';
import { buildFilterRows, type FilterGroup, type FilterOption } from './filterRows';
import {
  filterFieldClass, filterInputClass, filterMenuCaptionClass, filterTokenPillClass,
  PRIORITY_DOT, PRIORITY_LABEL, PRIORITY_ORDER, type BoardFieldFilters,
} from './constants';

const LISTBOX_ID = 'board-filter-listbox';
const GROUP_KEY: Record<FilterGroup, string> = {
  priority: 'board.filter.priority',
  closer: 'board.filter.whoCloses',
  kind: 'board.filter.kind',
  assignee: 'board.filter.assignee',
};
const CAPTION_ID: Record<FilterGroup, string> = {
  priority: 'bff-cap-priority', closer: 'bff-cap-closer', kind: 'bff-cap-kind', assignee: 'bff-cap-assignee',
};
/** An assignee is free text, and an `id` has to be a valid token. */
const optionId = (o: FilterOption) => `bff-${o.group}-${String(o.value).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

export function FilterTokenField({ value, onChange, assignees }: {
  value: BoardFieldFilters;
  /**
   * ONE patch, ONE call - and the pane applies it as `{...filters, ...next}`.
   * Four separate callbacks would mean a pick that also clears the text fires
   * two `setFilters`, both built from the same `filters` captured in that
   * render: the second wins and the token that was just added is gone.
   */
  onChange: (next: BoardFieldFilters) => void;
  /** Assignees seen on the current task set - the only source of suggestions. */
  assignees: readonly string[];
}) {
  const tr = useT();
  const shellRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // -1 = NOTHING preselected. `text` is live, so Enter on a preselected first
  // row would silently turn what you typed into a token and drop your search;
  // and with the picked rows kept in the list (they carry the check), a blind
  // Enter could just as well REMOVE a filter that was already on. One extra
  // ArrowDown, and typing can never hijack anything.
  const [cursor, setCursor] = useState(-1);

  const closerTitle = (l: TaskLabel): string =>
    l === 'visibile' ? tr('board.filter.labelVisibleTitle')
      : l === 'decisione' ? tr('board.filter.labelDecisionTitle')
        : tr('board.filter.labelInvisibleTitle');

  const options = useMemo<FilterOption[]>(() => [
    ...PRIORITY_ORDER.map((p) => ({ group: 'priority' as const, value: p, label: PRIORITY_LABEL[p]! })),
    ...CLOSER_LABELS.map((l) => ({ group: 'closer' as const, value: l, label: l, title: closerTitle(l) })),
    ...KIND_LABELS.map((l) => ({ group: 'kind' as const, value: l, label: l })),
    ...assignees.map((a) => ({ group: 'assignee' as const, value: a, label: a })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [assignees, tr]);

  const rows = useMemo(() => buildFilterRows(options, value.text), [options, value.text]);

  const picked = (o: FilterOption) =>
    o.group === 'priority' ? value.priority.includes(o.value)
      : o.group === 'assignee' ? value.assignedTo.includes(o.value)
        : value.labels.includes(o.value as TaskLabel);

  // Rows TOGGLE. A picked row does not vanish (that was the old two-genre
  // rule): it stays with the check, so the panel is the COMPLETE picture of the
  // filter and untoggling is the same click that toggled.
  const toggle = (o: FilterOption) => {
    const on = picked(o);
    // `text: ''` is safe by rule 3 above: this row was on screen because the
    // query matched it, so the query WAS the reach for this token; leaving it
    // on would narrow twice with the same intent and usually empty the board.
    if (o.group === 'priority') {
      onChange({ ...value, text: '', priority: on ? value.priority.filter((x) => x !== o.value) : [...value.priority, o.value].sort((a, b) => b - a) });
    } else if (o.group === 'assignee') {
      onChange({ ...value, text: '', assignedTo: on ? value.assignedTo.filter((x) => x !== o.value) : [...value.assignedTo, o.value] });
    } else {
      const l = o.value as TaskLabel;
      onChange({ ...value, text: '', labels: on ? value.labels.filter((x) => x !== l) : [...value.labels, l] });
    }
    // Back to -1 so a second Enter cannot undo what the first just did.
    setCursor(-1);
    inputRef.current?.focus();
  };

  const pills = [
    ...value.priority.map((p) => ({ key: `priority-${p}`, icon: <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[p]}`} />, label: PRIORITY_LABEL[p]!, remove: () => onChange({ ...value, priority: value.priority.filter((x) => x !== p) }) })),
    ...value.labels.map((l) => ({ key: `label-${l}`, icon: <Tag className="h-2.5 w-2.5 shrink-0" />, label: l as string, remove: () => onChange({ ...value, labels: value.labels.filter((x) => x !== l) }) })),
    ...value.assignedTo.map((a) => ({ key: `assignee-${a}`, icon: undefined, label: `@${a}`, remove: () => onChange({ ...value, assignedTo: value.assignedTo.filter((x) => x !== a) }) })),
  ];
  // Backspace eats the pill the caret is sitting next to - the RIGHTMOST one
  // DRAWN, whatever kind it is. The old rule was "assignees first, then
  // priorities", which agreed with the eye only by accident of render order;
  // with three kinds it would stop agreeing.
  const removeLast = () => pills.at(-1)?.remove();

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setCursor((i) => (rows.length === 0 ? -1 : (i + 1) % rows.length)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setCursor((i) => (rows.length === 0 ? -1 : (i <= 0 ? rows.length - 1 : i - 1))); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter is never destructive on its own: with nothing on the cursor it
      // means "I am done typing" - the text keeps filtering, the list gets out
      // of the way. A row is applied only once the arrows (or the pointer) have
      // deliberately put the cursor on it.
      const row = cursor >= 0 ? rows[cursor] : undefined;
      if (row) toggle(row.opt); else setOpen(false);
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setCursor(-1); return; }
    // Tab leaves the field. The panel is on <body>, so leaving it open would
    // strand a floating list on screen with no owner and a combobox still
    // claiming an active descendant.
    if (e.key === 'Tab') { setOpen(false); setCursor(-1); return; }
    if (e.key === 'Backspace' && value.text === '') removeLast();
  };

  const active = value.text.length > 0 || pills.length > 0;
  const cursorRow = cursor >= 0 ? rows[cursor] : undefined;
  // Nothing to offer, nothing on screen: this is what makes the "no results"
  // state unreachable.
  const menuOpen = open && rows.length > 0;

  return (
    <div
      ref={shellRef}
      data-testid="filter-token-field"
      onMouseDown={(e) => {
        // Clicking the shell is clicking the field - except on a pill's remove
        // button, which has its own job.
        if ((e.target as HTMLElement).closest('button')) return;
        setOpen(true);
        if (e.target !== inputRef.current) { e.preventDefault(); inputRef.current?.focus(); }
      }}
      // No `grow`: the row's free space belongs to the project strip, as it did
      // when a fixed-width search box sat here. `max-w` so a run of tokens
      // cannot swallow the bar; the bar itself already scrolls.
      className={`${filterFieldClass(active)} min-w-[8rem] max-w-[24rem] sm:min-w-[15rem]`}
    >
      <Search className="pointer-events-none h-3 w-3 shrink-0 text-app-text-secondary" />
      {/* Every token is drawn, and every remove button stays a Tab stop. A `+N`
          counter would take the hidden tokens OUT of the DOM: a board narrowed
          on five conditions would announce itself as an empty search box. */}
      {pills.map((p) => (
        <TokenPill
          key={p.key} icon={p.icon} label={p.label} onRemove={p.remove}
          removeLabel={tr('board.filter.removeToken', { label: p.label })}
          className={filterTokenPillClass}
        />
      ))}
      <input
        ref={inputRef}
        value={value.text}
        onChange={(e) => { onChange({ ...value, text: e.target.value }); setOpen(true); setCursor(-1); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={menuOpen}
        aria-controls={LISTBOX_ID}
        aria-autocomplete="list"
        aria-activedescendant={cursorRow ? optionId(cursorRow.opt) : undefined}
        // The accessible name does NOT change: this is still the board's search
        // box, it just accepts more. Other suites address this control by that
        // name, and after the merge the name is still TRUE.
        aria-label={tr('board.filter.searchLabel')}
        placeholder={pills.length > 0 ? '' : tr('board.filter.allPlaceholder')}
        data-testid="filter-token-input"
        className={`${filterInputClass} min-w-[56px]`}
      />
      <SuggestionMenu
        visible={menuOpen}
        items={rows}
        getKey={(r) => optionId(r.opt)}
        selectedIndex={cursor}
        onClose={() => { setOpen(false); setCursor(-1); }}
        inputRef={shellRef}
        anchorRef={shellRef}
        listboxId={LISTBOX_ID}
        listboxLabel={tr('board.filter.header')}
        multiSelectable
        headerLabel={tr('board.filter.header')}
        filterBadge={value.text || undefined}
        hint={tr('board.filter.fieldHint')}
        position="below"
        className="w-64"
        maxHeightClass="max-h-[23rem]"
        renderItem={(r, idx, { selected }) => (
          <>
            {r.head && (
              // Decoration for the eye. The screen reader gets the group from
              // each option's `aria-describedby`, which points HERE: putting the
              // group into the option's NAME would make every row announce its
              // group twice and break every `getByRole("option", { name })`.
              <p role="presentation" id={CAPTION_ID[r.opt.group]} className={filterMenuCaptionClass}>
                {tr(GROUP_KEY[r.opt.group])}
                {r.more > 0 && <span className="ml-1 font-normal normal-case tracking-normal text-app-text-muted">+{r.more}</span>}
              </p>
            )}
            <button
              type="button"
              role="option"
              id={optionId(r.opt)}
              // `aria-selected` says PICKED - the meaning it has in a
              // multi-select listbox. The keyboard cursor travels on
              // `aria-activedescendant`, not here.
              aria-selected={picked(r.opt)}
              aria-describedby={CAPTION_ID[r.opt.group]}
              title={r.opt.group === 'closer' ? r.opt.title : undefined}
              // The rows live in a portal at the end of <body>: a Tab stop there
              // is a jump across the DOM away from the field that owns them.
              // The arrows drive this list, and the header hint says so.
              tabIndex={-1}
              // Keep the caret - and `aria-activedescendant` - on the input: a
              // click that stole focus would leave the combobox claiming an
              // active descendant it no longer owns.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggle(r.opt)}
              onMouseEnter={() => setCursor(idx)}
              className={`${POPOVER_ITEM} ${selected ? 'bg-primary/15' : ''}`}
            >
              {r.opt.group === 'priority'
                ? <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[r.opt.value]}`} />
                : r.opt.group === 'assignee'
                  ? <span className="w-1.5 shrink-0 text-center text-app-text-muted">@</span>
                  : <Tag className="h-3 w-3 shrink-0 text-app-text-muted" />}
              <span className="min-w-0 flex-1 truncate">{r.opt.label}</span>
              {picked(r.opt) && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
            </button>
          </>
        )}
      />
    </div>
  );
}
