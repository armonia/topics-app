/**
 * projectActivity — global rollup of per-project child signals so a PROJECT
 * tab can inherit the state of its descendants.
 *
 * Problem this solves: a project's live child panes (chat / terminal /
 * browser / agent …) live in `useProjectLayout`'s LOCAL React state, not in
 * the global pane store — so the top-level project tab can't enumerate them
 * to know "is any child loading?" or "how many unread across children?".
 * The signals themselves (chat stream, terminal pulse, agent status) are
 * scattered across different sources too.
 *
 * Mechanism: report-up. The mounted `<ProjectWindowPane>` already has every
 * child + every signal in scope, so it computes its own aggregate and
 * `report()`s it here, keyed by projectPath. The project tab (and sidebar
 * project row) read it back via the selector hooks. One store, one shape,
 * every pane kind folded in at a single site — adding a new child signal
 * means extending ProjectWindow's aggregate, nothing here.
 *
 * Note: a project tab that has never been opened in this session won't have
 * a mounted window reporting for it, so its rollup reads as empty until
 * first visit. The live case the user cares about (a child loading while the
 * project is open) always has the window mounted (keep-alive), so it works.
 *
 * Loading reported here is the NON-chat aggregate. Chat streaming already
 * rolls up to the project via StreamingContext.isProjectStreaming (topics
 * carry projectPath), so consumers OR the two sources together — this keeps
 * chat-loading visible on the project tab even before the window mounts.
 */
import { create } from 'zustand';

export interface ProjectActivity {
  /** Any NON-chat child (terminal / browser / agent …) is producing output. */
  loading: boolean;
  /** Sum of unread / notification badges across every child pane. */
  notifications: number;
}

const EMPTY: ProjectActivity = { loading: false, notifications: 0 };

interface ProjectActivityStore {
  byPath: Record<string, ProjectActivity>;
  /** Idempotent: only writes when the value actually changed, so a
   *  ProjectWindow can call this every render without churning consumers. */
  report: (projectPath: string, activity: ProjectActivity) => void;
  /** Drop a project's entry — call on ProjectWindow unmount. */
  clear: (projectPath: string) => void;
}

export const useProjectActivityStore = create<ProjectActivityStore>((set) => ({
  byPath: {},
  report: (projectPath, activity) =>
    set((state) => {
      const cur = state.byPath[projectPath];
      if (cur && cur.loading === activity.loading && cur.notifications === activity.notifications) {
        return state; // no-op — preserve identity, skip re-render
      }
      return { byPath: { ...state.byPath, [projectPath]: activity } };
    }),
  clear: (projectPath) =>
    set((state) => {
      if (!(projectPath in state.byPath)) return state;
      const next = { ...state.byPath };
      delete next[projectPath];
      return { byPath: next };
    }),
}));

/** Stable `report` action (does not change across renders). */
export function useReportProjectActivity() {
  return useProjectActivityStore((s) => s.report);
}

/** Stable `clear` action (does not change across renders). */
export function useClearProjectActivity() {
  return useProjectActivityStore((s) => s.clear);
}

/** True iff a NON-chat child of this project is currently loading. */
export function useProjectActivityLoading(projectPath: string | undefined): boolean {
  return useProjectActivityStore((s) => (projectPath ? s.byPath[projectPath]?.loading : false) ?? false);
}

/** Total notification badge count rolled up across this project's children. */
export function useProjectActivityNotifications(projectPath: string | undefined): number {
  return useProjectActivityStore((s) => (projectPath ? s.byPath[projectPath]?.notifications : 0) ?? 0);
}

/** Non-reactive read — for building maps in a single pass. */
export function getProjectActivity(projectPath: string): ProjectActivity {
  return useProjectActivityStore.getState().byPath[projectPath] ?? EMPTY;
}
