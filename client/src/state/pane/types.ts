// Pane types — authoritative union. This MUST stay a superset of the legacy
// `PaneType` in client/src/types/index.ts, otherwise sanitizeSnapshot will
// silently drop panes whose type it doesn't recognise (previous review-round-12
// B2: `project`, `files`, `git`, `activity`, `agents`, `all-boards`,
// `process-log`, `session-viewer` were dispatched at runtime but dropped on
// every HYDRATE_FROM_SNAPSHOT round-trip).
export type PaneType =
  // Used at runtime today (must include every legacy type)
  | 'chat'
  | 'file'
  | 'files'
  | 'browser'
  | 'git'
  | 'terminal'
  | 'activity'
  | 'journal'
  | 'agents'
  | 'board'
  | 'board-memory'
  | 'dashboard'
  | 'all-boards'
  | 'project'
  | 'process-log'
  | 'session-viewer'
  // Reserved for future panes — keep so code paths that opt in don't get
  // silently sanitized away the moment they land.
  | 'agent'
  | 'session'
  | 'context'
  | 'editor'
  | 'webhooks'
  | 'cron'
  | 'remote-access'
  | 'system-status'
  | 'processes';

export interface Pane {
  id: string;
  type: PaneType;
  /**
   * Stable identifier that survives PANE_ID_REMAP (draft → real topic
   * promotion). React tab list keys off this so the DOM element doesn't
   * unmount mid-flight when the pane id changes — without it the tab
   * visibly flashes as soon as the user submits the first message in a
   * draft chat. Set at pane creation and preserved by the remap reducer.
   * Falls back to `id` for legacy panes that predate this field.
   */
  stableKey?: string;
  /**
   * Display title. Optional because several legacy call sites (e.g.
   * ProjectWindow.buildDefaultGroups, hydration from openPanels) construct
   * panes without an explicit title — the consumer component falls back to
   * `pane.id` or `PANE_CONFIG[type].label`. sanitizePane (reducers/
   * sanitizeSnapshot.ts) coerces a missing title to an empty string so the
   * reducer never holds `undefined`.
   */
  title?: string;
  topicId?: string;
  projectPath?: string;
  filePath?: string;
  terminalSessionId?: string;
  // Legacy pane-shape fields — carried through sync so a round-trip through
  // the server doesn't silently erase tab metadata. Every field here must
  // also appear in sanitizePane's whitelist (reducers/sanitizeSnapshot.ts).
  diff?: boolean;
  diffProjectPath?: string;
  preview?: boolean;
  color?: string;
  processId?: string;
  sessionKey?: string;
  terminalType?: 'shell' | 'claude-code';
  // Device-local fields (never serialized to server snapshot):
  scrollOffset?: number;
}

export interface Group {
  id: string;
  paneIds: string[];
  splitRatio: number; // 0..1, default 0.5
  splitAxis: 'horizontal' | 'vertical';
}

export interface ProjectLayout {
  projectPath: string;
  groups: Group[];
  panes: Record<string, Pane>;
  groupOrder: string[];
  tabOrder: string[];
  focusedPaneId: string | null;
  lastOpenedAt: number;
}

export interface ClosedPaneRecord {
  id: string;
  closedAt: number;
  pane: Pane;
  groupId: string;
  groupIndex: number;
  level: 'project' | 'app';
  projectPath?: string;
  terminal?: { sessionId?: string; cwd?: string };
  topicId?: string;
  filePath?: string;
  // Phase 30 new fields for PANE-03 fidelity:
  splitRatio?: number;
  splitAxis?: 'horizontal' | 'vertical';
  focusedAtClose: boolean;
  tabOrderSnapshot: string[];
  scrollOffset?: number;
  seq: number;
}

export interface PaneState {
  panes: Record<string, Pane>;
  groups: Record<string, Group>;
  projects: Record<string, ProjectLayout>;
  closedStack: ClosedPaneRecord[]; // bounded at 50, FIFO
  focusedPaneId: string | null; // DEVICE-LOCAL — never in server snapshot
  groupOrder: string[];
  lastSeq: number;
}

// Action discriminated union — every action the reducer accepts
export type PaneAction =
  | { type: 'OPEN_PANE'; payload: Pane & { groupId: string; insertIndex?: number } }
  | { type: 'CLOSE_PANE'; payload: { id: string; groupId: string; groupIndex: number } }
  | { type: 'UNDO_CLOSE' }
  | { type: 'FOCUS_PANE'; payload: { id: string | null } }
  | { type: 'SPLIT'; payload: { groupId: string; axis: 'horizontal' | 'vertical'; ratio: number } }
  | { type: 'RESIZE'; payload: { groupId: string; ratio: number } }
  | { type: 'REORDER_PANES'; payload: { groupId: string; paneIds: string[] } }
  | { type: 'PROJECT_LAYOUT_RESTORE'; payload: { projectPath: string; layout: ProjectLayout } }
  | { type: 'PROJECT_LAYOUT_SNAPSHOT'; payload: { projectPath: string } }
  | {
      type: 'HYDRATE_FROM_LEGACY';
      payload: {
        openPanels: string[];
        focusedPaneId: string | null;
        panelOrder: { order: string[]; pinned: string[] };
        closedTabs: unknown[];
        gridLayout: unknown;
        projectLayout: unknown;
      };
    }
  | {
      type: 'HYDRATE_FROM_SNAPSHOT';
      payload: { snapshot: Partial<PaneState> & { seq: number; server_seq?: number } };
    }
  | { type: 'PANE_ID_REMAP'; payload: { from: string; to: string; updates?: Partial<Pane> } }
  | { type: 'CLEAR_CLOSED_RECORD'; payload: { id: string } }
  | { type: 'CLEAR_CLOSED_STACK' }
  /**
   * Surgically remove a pane from the store WITHOUT pushing it onto the
   * closedStack. Used by `usePanelLifecycle` Effect 7 when it detects an
   * orphan id (a topic with `project_path` set that was somehow opened as
   * a standalone pane). UNDO_CLOSE on a record like that would re-create
   * the orphan immediately and re-trigger Effect 7 → ping-pong.
   *
   * Differs from CLOSE_PANE on three points:
   *   1. No closedStack push (no undoable history for a corrupted state).
   *   2. Removes the pane id from EVERY group's paneIds (defensive — Effect 7
   *      can't always know which group hosts the orphan).
   *   3. No groupId/groupIndex required in payload (the caller usually
   *      doesn't have it for a state that was filtered out of the React view).
   *
   * Idempotent: if the id is unknown, the reducer is a no-op.
   */
  | { type: 'PURGE_ORPHAN_PANE'; payload: { id: string } };

export const CLOSED_STACK_MAX = 50;
