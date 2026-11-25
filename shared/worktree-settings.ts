/**
 * The worktree settings (change worktree-standard, track T1), read by both sides
 * of the wire: the server resolves them, the Settings form draws their choices.
 *
 * Every value here is a MACHINE preference, stored in `app_settings`. A null
 * column means "never touched" and resolves to the default below, so a fresh
 * installation behaves exactly as it did before the settings existed.
 */

/** Where agents' worktrees live when nothing says otherwise: `<topicsHome>/worktrees`. */
export const WORKTREE_ROOT_FOLDER = "worktrees";

/** Worktrees one project may keep before the cleanup starts slimming and reaping. */
export const DEFAULT_WORKTREE_MAX_PER_PROJECT = 20;
export const WORKTREE_MAX_PER_PROJECT_RANGE = { min: 1, max: 200 } as const;

/**
 * Free disk, in GB, under which the dispatcher stops admitting cards. The
 * number of worktrees is capped, not their GB: `du` counts cloned blocks twice,
 * so a cap in GB would lie.
 */
export const DEFAULT_WORKTREE_DISK_FLOOR_GB = 12;
export const WORKTREE_DISK_FLOOR_RANGE = { min: 1, max: 500 } as const;

/** Days of silence after which an unmerged branch's worktree counts as stale. */
export const DEFAULT_WORKTREE_ABANDON_DAYS = 7;
export const WORKTREE_ABANDON_DAYS_RANGE = { min: 1, max: 365 } as const;

/**
 * Days a folder the cleanup moved to `{root}/.quarantine` is kept before it is
 * deleted: the window in which a wrong guess can still be undone by hand.
 */
export const DEFAULT_WORKTREE_QUARANTINE_DAYS = 7;
export const WORKTREE_QUARANTINE_DAYS_RANGE = { min: 1, max: 90 } as const;

/**
 * Rust `target/` is the one weight that cannot be cloned: `shared` points every
 * worktree of a project at one `CARGO_TARGET_DIR`, `per-worktree` leaves cargo
 * alone (for build scripts that pin absolute paths).
 */
export const CARGO_TARGET_MODES = ["shared", "per-worktree"] as const;
export type CargoTargetMode = (typeof CARGO_TARGET_MODES)[number];
export const DEFAULT_CARGO_TARGET_MODE: CargoTargetMode = "shared";

/** What the cleanup may do with worktrees made outside the root: look only, or remove the merged ones. */
export const GC_FOREIGN_MODES = ["off", "merged"] as const;
export type GcForeignMode = (typeof GC_FOREIGN_MODES)[number];
export const DEFAULT_GC_FOREIGN_MODE: GcForeignMode = "off";

/**
 * Whether the Claude Code sessions Topics launches carry the WorktreeCreate /
 * WorktreeRemove hooks (`scripts/claude-hooks/worktree-hook.sh`): `topics`, the
 * default, puts every `--worktree`, `EnterWorktree` and `isolation: worktree` of
 * those sessions under the worktree root; `off` leaves Claude Code its own
 * `<repo>/.claude/worktrees`. Every other Claude session of the machine is the
 * opt-in installer's (`install-claude-hooks.ts --worktrees`): the server never
 * writes the user's `~/.claude`.
 */
export const CLAUDE_WORKTREE_HOOK_MODES = ["off", "topics"] as const;
export type ClaudeWorktreeHookMode = (typeof CLAUDE_WORKTREE_HOOK_MODES)[number];
export const DEFAULT_CLAUDE_WORKTREE_HOOK_MODE: ClaudeWorktreeHookMode = "topics";

/** Bring a dial into its range; anything that is not a finite number falls to `fallback`. */
export function clampInto(n: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(n)));
}
