/**
 * THE SETTINGS PANEL PIECES THAT DO NOT NEED A BOARD.
 *
 * They live here, apart from `TaskDetail.tsx`, for one reason that is about
 * tests and not about tidiness: `TaskDetail.tsx` drags in the API client, the
 * pane layout and a dozen stores, so nothing defined in it can be mounted in a
 * unit test — and the assertion that mattered ("the settings panel really does
 * draw the cap") had to be downgraded to a regex over the source file. A regex
 * cannot tell `<GlobalCapControl />` from `{false && <GlobalCapControl />}`.
 *
 * This file imports the translation hook, two icons and the cap control. That
 * is little enough to render for real with `renderToStaticMarkup`, so the test
 * asserts on painted output instead of on the presence of a string.
 */
import { Bot, ChevronRight, X } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { ChecksFloorField, GlobalCapControl } from './GlobalCapControl';
import { SpendCapControl } from './SpendCapControl';
import { DispatchDetails, DispatchHolders, DispatchSummary } from './DispatchDashboard';
import type { BoardTask } from '../../lib/board';

/** The panel is not "Auto-dispatch": it holds effort, model, language, worktree,
 *  fan-out, night mode, auto-merge, MCP. Naming it after its first row made that
 *  name look like a title AND a switch at the same time. */
export function SettingsPanelHead({ onClose }: { onClose: () => void }) {
  const tr = useT();
  return (
    <div className="flex items-center justify-between">
      <span className="font-semibold text-app-text">{tr('board.settings.title')}</span>
      <button
        aria-label={tr('board.settings.close')}
        onClick={onClose}
        // 24 with the mouse (`tap-expand`), a real 44 box under a finger: a
        // projected 44 here would reach into the first row of the panel and
        // take its taps (usability audit, 04/10).
        className="tap-expand rounded p-0.5 text-app-text-secondary hover:bg-white/10 coarse:flex coarse:h-11 coarse:w-11 coarse:items-center coarse:justify-center"
      ><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}

/**
 * The two settings that belong to the MACHINE, not to a board: the global start
 * switch and the one concurrency cap.
 *
 * Extracted because the general board has no per-project settings at all, and
 * that is exactly where the cap used to become invisible again — the panel was
 * mounted behind `hasProject`, so on the board without a project the only
 * surface left was the ▾, the very surface this change exists to stop relying on.
 */
export function GlobalSettingsSection({ dispatchOn, onToggleDispatch, tasks, onOpenTask }: {
  /** Opens a card's drawer (the stopped cards the red box names). */
  onOpenTask?: (id: string) => void;
  dispatchOn: boolean | null;
  onToggleDispatch: () => void;
  /** The board's cards, from which the dashboard derives the queue. Absent = no dashboard. */
  tasks?: readonly BoardTask[];
}) {
  const tr = useT();
  return (
    <>
      {/* ONE ORDER: summary with the single switch and the answer, the queue, the
          memory chart, how many cards together, then Advanced (closed). */}
      {tasks && <DispatchSummary tasks={tasks} dispatchOn={dispatchOn} onTurnOn={onToggleDispatch} onToggle={onToggleDispatch} onOpenTask={onOpenTask} />}
      {tasks && <DispatchDetails tasks={tasks} withHolders={false} />}
      {/* Without the dashboard (no tasks) the switch keeps its own row. */}
      {!tasks && (
        <label
          className="flex min-h-6 cursor-pointer items-center justify-between gap-3 coarse:min-h-11"
          title={tr('board.settings.dispatchOnTitle')}
        >
          <span className="flex items-center gap-1.5"><Bot className="h-3.5 w-3.5 text-app-text-secondary" /> {tr('board.settings.autoDispatch')}</span>
          <input type="checkbox" checked={!!dispatchOn} onChange={onToggleDispatch} className="h-3.5 w-3.5 shrink-0 accent-emerald-500" />
        </label>
      )}

      {/* THE CAP stays in the panel (a tooltip does not exist on a phone). It is the
          SAME component the header menu mounts, on the same store. */}
      <div className="border-y border-app-border-subtle py-2">
        <GlobalCapControl quiet={!!tasks} />
      </div>

      {/* Spend and caps are born empty (= unlimited) and are not the daily question:
          closed by default, with who holds the Mac's memory. */}
      {tasks ? (
        <details className="group" data-testid="settings-advanced">
          <summary className="flex min-h-6 cursor-pointer list-none items-center gap-1 text-mini font-medium uppercase tracking-wide text-app-text-secondary coarse:min-h-11">
            <ChevronRight size={10} className="shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
            {tr('board.dash.advanced')}
          </summary>
          <div className="space-y-2 pt-1.5">
            <SpendCapControl />
            <ChecksFloorField />
            <DispatchHolders />
          </div>
        </details>
      ) : (
        <div className="border-b border-app-border-subtle pb-2">
          <SpendCapControl />
        </div>
      )}
    </>
  );
}

/**
 * The shell both panels share, so the general board's settings cannot drift
 * into looking like a different kind of surface.
 *
 * It is the BODY of a dropdown now, not a band under the toolbar (KANBAN-75,
 * and KANBAN-12 before it: no line under the bar). The surface, border and
 * shadow come from the `Menu` that hosts it, so none are declared here; what
 * this owns is the reading width, the ceiling and the scroll. The width is a
 * `max-w` and not a `w`: the host panel shrinks to fit, and on the phone the
 * `Menu` becomes a full-width sheet this must not narrow.
 */
export const SETTINGS_PANEL_SHELL =
  'mx-auto w-full max-w-[400px] space-y-2 overflow-y-auto overscroll-contain px-3 py-2.5 text-compact leading-4 text-app-text-heading max-h-[min(70vh,640px)]';

/**
 * The settings panel for the GENERAL board, which has no project and therefore
 * no per-board rows: the machine-wide block, alone, behind the same ⚙ and in the
 * same place as on a project board. One gesture finds the cap on every board.
 */
export function GlobalOnlySettingsPanel({ dispatchOn, onToggleDispatch, onClose, tasks, onOpenTask }: {
  onOpenTask?: (id: string) => void;
  dispatchOn: boolean | null;
  onToggleDispatch: () => void;
  onClose: () => void;
  tasks?: readonly BoardTask[];
}) {
  return (
    <div className={SETTINGS_PANEL_SHELL}>
      <SettingsPanelHead onClose={onClose} />
      <GlobalSettingsSection dispatchOn={dispatchOn} onToggleDispatch={onToggleDispatch} tasks={tasks} onOpenTask={onOpenTask} />
    </div>
  );
}
