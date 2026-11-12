import { X } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { BoardTask } from '../../lib/board';
import { filterFocusRingClass, TOOLBAR_CONTROL_H, TOOLBAR_ICON_W, type BoardFilters } from './constants';
import { runInitiatorName } from './taskFilter';
import { FilterTokenField } from './FilterTokenField';
import { ProjectFilterPicker } from './ProjectFilterPicker';

interface FilterPanelProps {
  filters: BoardFilters;
  onFiltersChange: (filters: BoardFilters) => void;
  tasks: readonly BoardTask[];
  mode: 'project' | 'all';
}

/** Filters shown INLINE in the board header. Built from the SAME picker primitive
 *  as the task composer (`Menu` chip + dropdown), just multi-select - no separate
 *  bespoke widgets. Priority/assignee/project have no "auto" entry: filtering by
 *  "let the agent decide" makes no sense, so it's dropped. */
export function InlineFilters({ filters, onFiltersChange, tasks, mode }: FilterPanelProps) {
  const tr = useT();
  const reset = () => onFiltersChange({ priority: [], assignedTo: [], text: '', projectId: [], labels: [], person: [], computer: [], initiator: [], runComputer: [], creator: 'all' });

  const assignees = Array.from(new Set(tasks.map((t) => t.assignedTo).filter(Boolean) as string[])).sort();
  // Built from `lastActorPersonName`/`lastActorDeviceName` - the same
  // "options come from what is currently on the board" rule `assignees`
  // already follows. Empty on a board with no collaborator activity yet: the
  // catalogue simply does not offer a group with nothing in it (see
  // `buildFilterRows`, which drops an empty group by construction).
  const persons = Array.from(new Set(tasks.map((t) => t.lastActorPersonName).filter(Boolean) as string[])).sort();
  const computers = Array.from(new Set(tasks.map((t) => t.lastActorDeviceName).filter(Boolean) as string[])).sort();
  const initiators = Array.from(new Set(tasks.map(runInitiatorName).filter(Boolean))).sort();
  const runComputers = Array.from(new Set(tasks.map((t) => t.runComputerName).filter(Boolean) as string[])).sort();

  const anyActive = filters.priority.length + filters.assignedTo.length + filters.projectId.length + filters.labels.length + filters.person.length + filters.computer.length + filters.initiator.length + filters.runComputer.length + (filters.text ? 1 : 0) + (filters.creator && filters.creator !== 'all' ? 1 : 0) > 0;

  // The shell of every filter control lives in `constants.ts`: the search box
  // here, the labels chip below, the token field and the project picker all
  // wear it, and they name it - no local alias, so a grep for the shell finds
  // every control that wears it.

  return (
    /* `grow` and NOT `flex-1`: the filter row must reach the right-hand group
       when there is room, but its basis stays the CONTENT. With `flex-1`
       (basis 0) a crowded bar computed it as zero wide and its own chips ended
       up drawn over the neighbouring controls - the project strip gained space
       by taking it from the real filters. */
    <div className="flex min-w-0 grow items-center gap-1.5">
      {/* ONE field: text, priority, who-closes, kind and assignee, with the
          catalogue in its own dropdown. See `FilterTokenField.tsx`. The project
          keeps its own picker (it already has a search box and an inline chip
          strip), and the reset keeps its own button. */}
      <FilterTokenField
        value={{ priority: filters.priority, assignedTo: filters.assignedTo, text: filters.text, labels: filters.labels, person: filters.person, computer: filters.computer, initiator: filters.initiator, runComputer: filters.runComputer }}
        onChange={(next) => onFiltersChange({ ...filters, ...next })}
        assignees={assignees}
        persons={persons}
        computers={computers}
        initiators={initiators}
        runComputers={runComputers}
      />

      {/* WHO OPENED THE CARDS: one button that cycles all, mine, others. The
          margin keeps it off the search field when the row is narrow. With a
          finger it is 44 wide at least: the shortest label alone measured 41. */}
      <button
        type="button"
        data-testid="filter-creator"
        data-creator={filters.creator ?? 'all'}
        title={tr('board.filter.creatorTitle')}
        onClick={() => onFiltersChange({ ...filters, creator: (filters.creator ?? 'all') === 'all' ? 'mine' : filters.creator === 'mine' ? 'others' : 'all' })}
        className={`ml-1 flex ${TOOLBAR_CONTROL_H} shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded px-2 text-mini coarse:min-w-11 ${filterFocusRingClass} ${(filters.creator ?? 'all') === 'all' ? 'text-app-text-muted' : 'bg-white/10 text-app-text'} hover:bg-white/10 hover:text-app-text`}
      >{tr(`board.filter.creator.${filters.creator ?? 'all'}`)}</button>

      {/* Reset - only when something is active */}
      {anyActive && (
        <button
          onClick={reset}
          title={tr('board.filter.reset')}
          data-testid="filter-reset"
          // `h-6 w-6` and not `p-0.5`: a 12px icon with 2px of padding is a
          // 16px target, the smallest on the row. Same inset ring as the
          // shells: being the smallest target, it is also the one the global
          // offset outline overflows worst.
          className={`grid ${TOOLBAR_CONTROL_H} ${TOOLBAR_ICON_W} shrink-0 place-items-center rounded ${filterFocusRingClass} text-app-text-muted hover:bg-white/10 hover:text-app-text`}
        >
          <X className="h-3 w-3" />
        </button>
      )}

      {/* PROJECT: the chip with the menu AND its suggestions, a single block.
          See `ProjectFilterPicker.tsx`. It sits at the end of the row because it
          is the only filter that grows: it takes the width that is left to push
          projects out of the menu, and when none is left the chip remains. */}
      <ProjectFilterPicker
        tasks={tasks}
        mode={mode}
        selectedIds={filters.projectId}
        onChange={(projectId) => onFiltersChange({ ...filters, projectId })}
      />
    </div>
  );
}
