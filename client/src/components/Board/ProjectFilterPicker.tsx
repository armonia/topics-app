/**
 * THE BOARD'S «PROJECT» FILTER, chip and suggestions in a single piece.
 *
 * The bar held TWO objects that talked about the same filter, and at two
 * far-apart points of the row: the «Project» chip (with its search menu) among
 * the other filters, and at the tail of the bar a strip of suggestion chips,
 * one per project, that appeared when there was space to spare. Whoever looked
 * at the bar saw two different controls; whoever read it in the code found the
 * same state computed for both, in the middle of the other filters.
 *
 * Here they stand together: the chip opens the full list (search, a hundred
 * projects), the suggestions are that same list leaned out as long as there is
 * width. One single component, one single place where what is selected is
 * decided.
 *
 * THE STRIP'S RULE, unchanged: the bar never deforms itself to make the
 * suggestions fit. No wrapping (it would push the board down), no compression
 * down to the unreadable; whatever does not fit stays behind the chip.
 * The count is done on the real geometry, not on an estimate of characters: the
 * chips are ALL rendered in one `nowrap` row inside a container that occupies
 * the leftover space, and the ones whose right edge falls beyond the
 * container's edge become `invisible`. Three properties, and this is why the
 * way is this one:
 *   · `visibility:hidden` keeps the position, so the measurements of the
 *     preceding chips do not change when the last one disappears: no loop in
 *     which hiding a chip frees the space that makes it appear again.
 *   · the container has `min-w-0` + `overflow-hidden`, so its MINIMUM width is
 *     zero: when the row is crowded it collapses to 0, no chip fits in, and it
 *     does not widen the bar by a pixel. It is the same reason why a half chip
 *     is never seen: below the cut it is invisible, not clipped.
 *   · the chip row is ABSOLUTE (`w-max`), and this is not a styling detail: a
 *     child in flow with `basis-0` still contributes its MAX-CONTENT width to
 *     the parent's intrinsic calculation, and the parent here sits inside a bar
 *     that scrolls. Measured: with the row in flow, at 1000px the bar exceeded
 *     by 243px, that is, the chips took the space for themselves instead of
 *     waiting for what is left over. Out of flow it contributes zero, and the
 *     strip receives ONLY what remains.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { Menu } from '../Shared/Menu';
import { Tooltip } from '../Shared/Tooltip';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { homeTilde } from '../../lib/homeTilde';
import { isProjectlessId, STATUS_LABEL, UNASSIGNED_PROJECT_ID, type BoardProjectRef, type BoardTask } from '../../lib/board';
import { resolveProjectRefs, useBoardProjects } from '../../lib/boardProjectsStore';
import { countsSummary, projectTaskCounts } from '../../lib/projectTaskCounts';
import { ProjectPickerBody } from './ProjectPicker';
import { ProjectTaskCounts } from './atoms';
import { filterFieldClass } from './constants';

/**
 * The breathing room between the content and the shell's edge, per side (px).
 *
 * ONE SINGLE ONE, and it holds on all four sides: the 4px on the right are
 * added by the measurement below, the 4px on the left are the host's `px-1`,
 * the 4px above and below are the shell's `-inset-y-1`. Before, the vertical
 * one was ZERO (`inset-y-0` on a host as tall as the chips): the border ran
 * flush against the chip, and a box that touches its own content reads as an
 * alignment mistake, not as a grouping.
 */
const SHELL_PAD = 4;

/**
 * THE ICON'S BOX, the same one for every chip.
 *
 * `ProjectFavicon` draws the `fallback` BARE, without reserving width for it
 * (it is declared: «no path → no element, no reserved width»). The fallback
 * here was a 6px dot against a 12px icon: the chips of a project with an icon
 * and of one without were indented differently, and in a row the names were not
 * lined up. The box sits OUTSIDE the favicon, so the chip's width no longer
 * depends on which projects happen to have an icon on disk.
 */
const ICON_BOX = 12;

/**
 * The maximum width of a chip, the same for the chip that opens the menu and
 * for the suggestions: they were `11rem` and `13rem`, that is, the same object
 * truncated at two different measures in the same row.
 */
const CHIP_MAX = 'max-w-[12rem]';

function ChipIcon({ path }: { path: string }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center"
      style={{ width: ICON_BOX, height: ICON_BOX }}
    >
      <ProjectFavicon
        path={path}
        size={ICON_BOX}
        fallback={<span className="h-1.5 w-1.5 rounded-full border border-app-text-faint" />}
      />
    </span>
  );
}

export function ProjectFilterPicker({ tasks, mode, selectedIds: selectedFilterIds, onChange }: {
  tasks: readonly BoardTask[];
  /** Projects are filtered only where there is more than one: the «all» board. */
  mode: 'project' | 'all';
  /** The ids switched on in the filter (the real ones, not the synthetic rows). */
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const tr = useT();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  // THE SAME project index as the composer. Before, this filter was a widget of
  // its own that knew nothing about the index: no search, no icons, and for a
  // name the board id with the hash cut away (`topics-app-4f2c` →
  // «topics-app»), which looks like the real name but is not it. Now the list
  // goes through `resolveProjectRefs`, which resolves name and `path` (and with
  // no `path` there is no icon) from the same index that feeds the composer's
  // chip and the drawer's «Move to…».
  const projectIndex = useBoardProjects(mode === 'all');
  const taskProjectIds = useMemo(() => Array.from(new Set(tasks.map((t) => t.projectId))), [tasks]);
  // The «no project» tasks come in TWO species (`_none` and the catch-all board
  // `generale-<hash>`), but for whoever filters they are one single thing: one
  // row, which switches both ids on and off.
  const unassignedIds = useMemo(() => taskProjectIds.filter(isProjectlessId), [taskProjectIds]);
  // How many tasks, and in what state. The name on its own does not say whether
  // that project is waiting for somebody or has nothing open, and that is the
  // question asked by whoever looks at a general board with twelve projects.
  const projectCounts = useMemo(
    () => projectTaskCounts(tasks, (t) => (isProjectlessId(t.projectId) ? UNASSIGNED_PROJECT_ID : t.projectId)),
    [tasks],
  );
  const projectOptions = useMemo(() => {
    const refs = resolveProjectRefs(taskProjectIds.filter((id) => !isProjectlessId(id)), projectIndex);
    return unassignedIds.length
      ? [{ projectId: UNASSIGNED_PROJECT_ID, name: 'Senza progetto', path: '' }, ...refs]
      : refs;
  }, [taskProjectIds, unassignedIds, projectIndex]);
  const showProjects = mode === 'all' && projectOptions.length > 0;

  // The ids the «No project» row really stands for.
  const idsFor = (p: BoardProjectRef) =>
    (p.projectId === UNASSIGNED_PROJECT_ID && unassignedIds.length ? unassignedIds : [p.projectId]);
  const selectedRowIds = useMemo(() => {
    const selected = new Set(selectedFilterIds);
    // The synthetic row switches on if ANY ONE of its ids is on.
    if (unassignedIds.some((id) => selected.has(id))) selected.add(UNASSIGNED_PROJECT_ID);
    return Array.from(selected);
  }, [selectedFilterIds, unassignedIds]);
  const toggleProject = (p: BoardProjectRef) => {
    const ids = idsFor(p);
    const on = ids.some((id) => selectedFilterIds.includes(id));
    onChange(on
      ? selectedFilterIds.filter((x) => !ids.includes(x))
      : [...selectedFilterIds, ...ids.filter((id) => !selectedFilterIds.includes(id))]);
  };
  // The ROWS switched on (not the ids: «No project» stands for two of them). A
  // single project filtered → the chip SHOWS it (icon + name), instead of saying
  // «Project ·1» and forcing you to open the menu to find out which one.
  const pickedProjects = useMemo(
    () => projectOptions.filter((p) => selectedRowIds.includes(p.projectId)),
    [projectOptions, selectedRowIds],
  );
  const soleProject = pickedProjects.length === 1 ? pickedProjects[0]! : null;

  const hostRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const stripRowRef = useRef<HTMLDivElement>(null);
  const [inlineProjects, setInlineProjects] = useState(0);
  /* THE SHELL, in pixels. The block occupies all the width left over in the
     row, but the suggestions end where the last chip that fits ends: drawing
     the border on the container would give an empty box running all the way to
     the end of the bar. Here the right edge of what is really seen gets
     measured, and the shell stops there. */
  const [shellWidth, setShellWidth] = useState(0);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!showProjects || !strip) { setInlineProjects(0); setShellWidth(0); return; }
    const measure = () => {
      const row = stripRowRef.current;
      if (!row) return;
      const avail = strip.clientWidth;
      let fit = 0;
      // THE CHIPS, not the row's children. Ever since every chip is wrapped in
      // the `Tooltip`, the direct children are `display: contents` wrappers: for
      // the layout they do not exist (and that is the reason `contents` is
      // used), but in the DOM they are there and their `offsetWidth` is ZERO.
      // The measurement saw them as no wider than nothing, concluded they all
      // fitted, and the chips in excess ended up beyond the right edge instead
      // of inside the menu. `querySelectorAll` on the testid skips the wrappers
      // and measures what is really seen.
      const chips = Array.from(row.querySelectorAll<HTMLElement>('[data-testid^="project-filter-chip-"]'));
      for (const chipEl of chips) {
        // +0.5: the widths are fractional, and half a pixel of rounding is not
        // a chip that does not fit.
        if (chipEl.offsetLeft + chipEl.offsetWidth <= avail + 0.5) fit++;
        else break;
      }
      setInlineProjects((n) => (n === fit ? n : fit));
      // Where the block ends: the chip on its own if no suggestion leans out,
      // otherwise the right edge of the last one that fits.
      const btn = btnRef.current;
      let right = btn ? btn.offsetLeft + btn.offsetWidth : 0;
      const last = fit > 0 ? chips[fit - 1] : null;
      if (last) right = Math.max(right, strip.offsetLeft + last.offsetLeft + last.offsetWidth);
      const w = Math.ceil(right) + SHELL_PAD;
      setShellWidth((v) => (v === w ? v : w));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    ro.observe(stripRowRef.current!);
    return () => ro.disconnect();
  }, [showProjects, projectOptions]);

  /**
   * The content of a suggestion's tooltip. Before it was one single line inside
   * a native `title=`: the operating system showed it after a good second and
   * without structure. Reported: «hovering over the filters ought to give a
   * minimum of information about the project, maybe the location too».
   *
   * Three things, in order of how much they are needed: the NAME (which in the
   * chip is truncated at `CHIP_MAX`), WHERE IT SITS on disk (the only thing that
   * tells apart two projects called the same in different folders), and how the
   * tasks are doing.
   */
  const countsTitle = (p: BoardProjectRef) => {
    const c = projectCounts[p.projectId];
    return (
      <div className="space-y-1">
        <div className="font-medium">{p.name}</div>
        {p.path ? (
          // Monospace and wrapping on the path: a long path on one single line
          // becomes unreadable, and it is exactly the datum you come looking for.
          <div className="break-all font-mono text-[10px] text-app-text-muted">{homeTilde(p.path)}</div>
        ) : (
          // Why it is not there: without this line the tooltip of a vanished
          // project just looks like a tooltip with a piece missing.
          <div className="text-[10px] text-app-text-faint">{tr('board.filter.projectUnknown')}</div>
        )}
        {c && <div className="text-[10px] text-app-text-muted">{countsSummary(c, STATUS_LABEL)}</div>}
      </div>
    );
  };

  if (!showProjects) return null;

  return (
    /* `grow basis-0` + `min-w-0`: the block takes ONLY the space left over in
       the filter row, and its minimum width is the chip's. */
    <div ref={hostRef} className="relative flex min-w-0 grow basis-0 items-center gap-1.5 px-1" data-testid="project-filter">
      {/* THE SHELL that holds chip and suggestions together: without it they
          stay two objects standing near each other and whoever looks has no way
          of knowing that the projects lined up there ARE the selector opened
          onto the row. It sits behind (absolute, `pointer-events-none`), so it
          enters no measurement.

          THE COLOURS COME IN PAIRS, and it is not a whim: born `border-white/15
          bg-white/[0.05]`, the shell was white on white in the light theme,
          that is, invisible exactly where it was being looked for (reported
          three times: «they are still not wrapped by the selector»). It is the
          mistake the RULE at the top of `index.css` describes word for word: a
          raised surface is declared `bg-black/N dark:bg-white/N`, or with the
          opaque tokens. The border moves to a token, which the two themes
          resolve by themselves. It is the `-light` variant and not the base one
          because the numbers impose it: in light `--border` is worth 91.4% of
          lightness on a background worth 93 (difference 1.6: a border that is
          not there), and in DARK it would be 18% against the 24.8 the old
          white/15 reached, that is, a step backwards exactly where something
          was visible. `--border-light` is 88.5% in light and 24% in dark:
          better than the base border in the first, equal to the old one in the
          second. Neither theme loses out. */}
      <div
        aria-hidden
        data-testid="project-filter-shell"
        className="pointer-events-none absolute -inset-y-1 left-0 rounded-md border border-app-border-light bg-black/[0.05] dark:bg-white/[0.06]"
        style={{ width: shellWidth || undefined }}
      />
      <button
        ref={btnRef} onClick={() => setOpen(true)}
        data-testid="filter-project-chip"
        title={soleProject ? tr('board.filter.projectNamed', { name: soleProject.name }) : tr('board.filter.projectTitle')}
        className={`${filterFieldClass(selectedFilterIds.length > 0)} min-w-0 ${CHIP_MAX}`}
      >
        {soleProject && <ChipIcon path={soleProject.path} />}
        <span className="min-w-0 truncate">{soleProject ? soleProject.name : tr('common.project')}</span>
        {!soleProject && pickedProjects.length > 0 && (
          <span className="tabular-nums text-app-text-secondary">·{pickedProjects.length}</span>
        )}
        <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />
      </button>
      {/* THE SAME `ProjectPickerBody` as the composer, in multi-selection mode:
          the menu does not close on every click because a filter is built out
          of several choices. */}
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={230} role="listbox" unmanagedFocus>
        <ProjectPickerBody
          projects={projectOptions}
          selectedIds={selectedRowIds}
          onPick={toggleProject}
          busy={false}
          listLabel={tr('common.project')}
          counts={projectCounts}
        />
      </Menu>

      {/* THE SUGGESTIONS, in the space left over. See the `useLayoutEffect`. */}
      <div ref={stripRef} className="relative h-6 min-w-0 grow basis-0 overflow-hidden" data-testid="project-filter-strip">
        <div ref={stripRowRef} className="absolute inset-y-0 left-0 flex w-max flex-nowrap items-center gap-1.5 [&>*]:shrink-0">
          {projectOptions.map((p, i) => {
            const on = selectedRowIds.includes(p.projectId);
            const shown = i < inlineProjects;
            return (
              // The `key` sits on the Tooltip: it is the list's child now.
              <Tooltip key={p.projectId} content={countsTitle(p)}>
              <button
                onClick={() => toggleProject(p)}
                aria-hidden={!shown}
                tabIndex={shown ? 0 : -1}
                data-testid={`project-filter-chip-${p.projectId}`}
                className={`${filterFieldClass(on)} min-w-0 ${CHIP_MAX} ${shown ? '' : 'invisible'}`}
              >
                <ChipIcon path={p.path} />
                <span className="min-w-0 truncate">{p.name}</span>
                {projectCounts[p.projectId] && <ProjectTaskCounts counts={projectCounts[p.projectId]!} />}
                {on && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
              </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </div>
  );
}
