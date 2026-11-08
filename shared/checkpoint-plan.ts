/**
 * The restore plan, as it travels: what a rewind MAY touch and why it may
 * not. One declaration for both sides, like `topic-changes.ts`: the server
 * builds it (`server/services/checkpoint-restore-plan.ts`), the client reads
 * it to decide whether its button is enabled and what its dialog promises.
 *
 * Blocker codes carry no prose on purpose: the client owns the words, in the
 * user's language.
 */

/** What undoing the turn does to the path: `added` is deleted, `modified` and
 *  `deleted` are written back from the target. */
export type RestorePathState = "added" | "modified" | "deleted";

export interface RestorePlanEntry {
  /** Project-relative path, as git reports it. */
  path: string;
  state: RestorePathState;
  /** Present only on skipped entries: why the plan left this path alone. */
  reason?: "changed-after-checkpoint";
}

/**
 * Two families, and the route keeps them apart (see `RestoreVerdict`):
 *  - `turn-in-progress`, `other-session-active`, `no-checkpoint`: nothing can
 *    be trusted, the whole gesture stops;
 *  - `not-a-repo`, `legacy-checkpoint`, `no-turn-mark`: only the FILES half
 *    cannot happen. A manual checkpoint saved before file snapshots existed
 *    has no tree to go back to, a topic outside a git repository has no files
 *    to put back, and a turn whose end was never recorded has files nobody can
 *    attribute. In all three the conversation still rolls back.
 */
export type RestoreBlockerCode =
  | "not-a-repo"
  | "no-checkpoint"
  | "turn-in-progress"
  | "other-session-active"
  | "legacy-checkpoint"
  | "no-turn-mark";

export interface RestoreBlocker {
  code: RestoreBlockerCode;
  /** A number, a session slug, a timestamp: something for the human, never a
   *  person's name or a path outside the project. */
  detail?: string;
}

export interface RestorePlan {
  targetCommit: string;
  /** The session's newest snapshot, of any kind. `null` when there is none. */
  latestCommit: string | null;
  /** Paths the apply WILL touch. */
  entries: RestorePlanEntry[];
  /** Manifest paths somebody else changed after `latest`: left alone. */
  skipped: RestorePlanEntry[];
  blockers: RestoreBlocker[];
  /** `blockers.length === 0`. Skipped entries do not make a plan unsafe. */
  safe: boolean;
}

/**
 * What the ROUTE says the gesture can do, next to the plan. The plan only
 * knows about files; the route knows whether there is a conversation half
 * that can still happen, and says so instead of leaving the client to guess
 * from the codes.
 */
export interface RestoreVerdict {
  /** False when the gesture must stop entirely: the button is disabled. */
  canProceed: boolean;
  /** The first blocker the client should name. Present whenever the plan has
   *  one, even when `canProceed` is true (the files half is what is missing). */
  blockedBy?: RestoreBlockerCode;
  /** False when nothing on disk will be touched, whatever the reason. */
  filesRestorable: boolean;
}
