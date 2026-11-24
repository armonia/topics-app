/**
 * The wire shapes of the worktree cleanup preview and of the adopt / move /
 * remove actions on worktrees made outside Topics' root (change
 * worktree-standard, T3 and T7). Read by the server routes and by the
 * Settings > Worktrees list, so both sides agree on the words.
 */

/** What the cleanup sees a folder or a row as. */
export type WorktreePlanClass = "tracked" | "orphan" | "ghost" | "row-no-folder" | "foreign" | "quarantined";

/** One line of the preview: a folder (or a row) and what the next pass would do to it. */
export interface WorktreePlanEntryPayload {
  absPath: string;
  projectId: string | null;
  projectName: string | null;
  /** The `worktrees` row at this path, when there is one. */
  rowId: string | null;
  cls: WorktreePlanClass;
  /** What the root pass does (`register`, `quarantine`, `purge`, `close-row`, `inventory`, `wait`, `judge`). */
  rootAction: string;
  /** What the sweep would do to a tracked worktree (`reap`, `archive-then-free`, `keep`, …), when it was asked. */
  plannedAction: string | null;
  reason: string;
  /** On-disk weight in bytes, when measured. */
  bytes: number | null;
  /** A folder in quarantine: where it came from. Moving it back there restores it. */
  from: string | null;
}

export interface WorktreePlanPayload {
  entries: WorktreePlanEntryPayload[];
  /** Folders outside the worktree root: Topics only lists them. */
  foreignCount: number;
  scanMs: number;
  overCap: Array<{ projectId: string; projectName: string | null; count: number; max: number }>;
}

/**
 * What a person may do by hand: adopt, move or remove a worktree made by another
 * tool (outside the root); move to quarantine a folder in the root that the GC
 * only lists (no Topics marker, so it never moves it on its own); restore a
 * quarantined folder where it came from.
 */
export const RELOCATE_ACTIONS = ["adopt", "move", "remove", "quarantine", "restore"] as const;
export type RelocateAction = (typeof RELOCATE_ACTIONS)[number];

/** Why an action is refused. Every code is a fact about the folder, never a guess. */
export type RelocateRefusal =
  | "inside-root"
  | "missing"
  | "not-linked"
  | "not-listed"
  | "no-project"
  | "dirty"
  | "submodules"
  | "live-session"
  | "locked"
  | "active-task"
  | "target-exists"
  | "unmerged-commits"
  /** `quarantine`: not a folder with no `.git`, no row and nothing git lists, two levels under the root. */
  | "not-a-ghost"
  /** `restore`: not a folder in the quarantine of a root. */
  | "not-quarantined";

/** Things worth knowing that do not stop the action. */
export type RelocateWarning = "transcripts" | "branch-kept" | "already-adopted";

/** What an action would do, and whether it may. Also the answer to the preview. */
export interface RelocateCheckPayload {
  action: RelocateAction;
  from: string;
  /** Where it would move to (`move` only). */
  to: string | null;
  projectId: string | null;
  projectName: string | null;
  rowId: string | null;
  ok: boolean;
  refusals: RelocateRefusal[];
  warnings: RelocateWarning[];
}

export interface RelocateResultPayload {
  ok: boolean;
  /** The preview this answer is about: on a refusal it says why. */
  check: RelocateCheckPayload;
  /** Set when the action ran: where the worktree is now (`move`) and its row. */
  to?: string;
  rowId?: string;
  /** A git or storage failure after the checks passed. */
  error?: string;
}
