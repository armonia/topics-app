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
import { Bot, X } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { GlobalCapControl } from './GlobalCapControl';
import { SpendCapControl } from './SpendCapControl';

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
        className="rounded p-0.5 text-app-text-secondary hover:bg-white/10"
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
export function GlobalSettingsSection({ dispatchOn, onToggleDispatch }: {
  dispatchOn: boolean | null;
  onToggleDispatch: () => void;
}) {
  const tr = useT();
  return (
    <>
      <label
        className="flex cursor-pointer items-center justify-between gap-3"
        title={tr('board.settings.dispatchOnTitle')}
      >
        {/* SAME label as the ▾ in the header: it is the same global switch, and
            two different names for one value make it look like two settings.
            What it does lives in the `title`, not in the name. */}
        <span className="flex items-center gap-1.5"><Bot className="h-3.5 w-3.5 text-app-text-secondary" /> {tr('board.settings.autoDispatch')}</span>
        <input type="checkbox" checked={!!dispatchOn} onChange={onToggleDispatch} className="h-3.5 w-3.5 shrink-0 accent-emerald-500" />
      </label>

      {/* THE CAP, IN HERE. It used to live only in the ▾ menu next to the title,
          and this panel merely named it in a `title` — a tooltip, which does not
          exist on a phone. Whoever opened the settings saw no limit at all. It
          is the SAME component the menu mounts, on the same store: what you
          change here shows up there without a reload, and the other way round. */}
      <div className="border-y border-app-border-subtle py-2">
        <GlobalCapControl />
      </div>

      {/* THE SPEND, and the spend caps, in the same place and for the same
          reason: they belong to the MACHINE and live on the same reserved row.
          The dollars are always visible; the two caps are born empty, and empty
          means unlimited. Whoever looks for "how much am I spending" finds it
          next to "how many agents at once", the other question about the same tap. */}
      <div className="border-b border-app-border-subtle pb-2">
        <SpendCapControl />
      </div>
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
  'mx-auto w-full max-w-[400px] space-y-2 overflow-y-auto overscroll-contain px-3 py-2.5 text-xs text-app-text-heading max-h-[min(70vh,640px)]';

/**
 * The settings panel for the GENERAL board, which has no project and therefore
 * no per-board rows: the machine-wide block, alone, behind the same ⚙ and in the
 * same place as on a project board. One gesture finds the cap on every board.
 */
export function GlobalOnlySettingsPanel({ dispatchOn, onToggleDispatch, onClose }: {
  dispatchOn: boolean | null;
  onToggleDispatch: () => void;
  onClose: () => void;
}) {
  return (
    <div className={SETTINGS_PANEL_SHELL}>
      <SettingsPanelHead onClose={onClose} />
      <GlobalSettingsSection dispatchOn={dispatchOn} onToggleDispatch={onToggleDispatch} />
    </div>
  );
}
