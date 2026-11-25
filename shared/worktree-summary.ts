/**
 * The worktrees of every machine, as one line each (change worktree-standard,
 * track T12). Each Topics server keeps its own `worktrees` table and is the only
 * one that writes it or touches its disk; the primary keeps a read-model per
 * machine, filled by the heartbeat. The wire shapes live here so the node route,
 * the primary's store and the Settings list agree on the words.
 */

/** What a machine says about its worktree root, at one moment. */
export interface WorktreeSummary {
  /** The worktree root this machine resolves, in its own path syntax. */
  root: string;
  /** Worktree folders under the root (with or without a row). */
  count: number;
  /** Their weight on disk, in bytes; `null` when not measured yet. */
  bytes: number | null;
  /** Free space on the volume of the root, in GB; `null` when it could not be read. */
  rootFreeGb: number | null;
  /** Worktrees outside the root that git lists for a known project. */
  foreign: number;
  /** Folders without `.git` under the root. */
  ghosts: number;
  /** Folders with `.git` under the root and no row. */
  orphans: number;
  scanMs: number;
  /** When it was measured (ISO). */
  at: string;
}

/** What the primary stores per machine: whether the node speaks this protocol, and its last summary. */
export interface MachineWorktreeReport {
  /** `false` = a node built before the protocol: skipped, shown as an old node. */
  supported: boolean;
  summary: WorktreeSummary | null;
}

/** One line of Settings > Worktrees > machines. */
export interface MachineWorktreeLine {
  machineId: string;
  name: string;
  status: "online" | "offline";
  /** This server's own machine. */
  local: boolean;
  /** `null` = no report yet (never answered since the primary started asking). */
  supported: boolean | null;
  summary: WorktreeSummary | null;
}

/**
 * The policy the primary may send a node, by its wire name. Each maps onto the
 * `app_settings` field of the same meaning on the node, and is validated there
 * by the same rules as `PUT /api/app-settings`.
 */
export const WORKTREE_POLICY_FIELDS = {
  root: "worktreeRoot",
  maxPerProject: "worktreeMaxPerProject",
  diskFloorGb: "worktreeDiskFloorGb",
  gcForeign: "gcForeign",
  abandonDays: "worktreeAbandonDays",
  cargoTargetMode: "cargoTargetMode",
} as const;

export type WorktreePolicyKey = keyof typeof WORKTREE_POLICY_FIELDS;
export type WorktreePolicy = Partial<Record<WorktreePolicyKey, string | number | null>>;
