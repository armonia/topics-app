/**
 * paneActivity — generic "this pane is producing output" registry, keyed by
 * pane id. The companion to useTerminalActivity / StreamingContext for pane
 * kinds whose loading state lives inside the pane's own component and isn't
 * otherwise observable from the tab bar (today: browser panes, whose
 * loading/agent-active state lives in useRemoteBrowser / the native hook).
 *
 * The pane content reports its own state via `setPaneActive(paneId, bool)`;
 * the tab bar reads it back with `usePaneActive(paneId)`, and ProjectWindow
 * folds it into the project rollup. Explicit on/off (no decay timer) — the
 * source already has a concrete boolean.
 */
import { create } from 'zustand';

interface PaneActivityStore {
  active: Record<string, boolean>;
  setPaneActive: (paneId: string, active: boolean) => void;
}

export const usePaneActivityStore = create<PaneActivityStore>((set) => ({
  active: {},
  setPaneActive: (paneId, active) =>
    set((state) => {
      const cur = state.active[paneId] ?? false;
      if (cur === active) return state; // no-op — preserve identity
      const next = { ...state.active };
      if (active) next[paneId] = true;
      else delete next[paneId];
      return { active: next };
    }),
}));

/** Reactive: is this pane currently producing output? */
export function usePaneActive(paneId: string | undefined): boolean {
  return usePaneActivityStore((s) => (paneId ? s.active[paneId] : false) ?? false);
}
