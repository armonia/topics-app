/**
 * What the rollback button and its dialog say, decided from the preflight.
 *
 * Pure on purpose: the timeline renders these, and a test can prove them
 * without a DOM. The codes never reach the screen; every line goes through
 * `tr`, so the reason is in the user's language.
 */
import type { Checkpoint } from '../../../../shared/types';
import type { RestoreBlockerCode, RestorePlan, RestoreVerdict } from '../../../../shared/checkpoint-plan';

// The same signature the queue copy already uses, declared once in shared/:
// two identical `Translate` on the two sides is a mirror, and the gate that
// forbids mirrors is right that they drift.
import type { Translate } from '../../../../shared/queue-reason-text';

/** The manual-checkpoint preflight, as `POST /checkpoints/:idx/plan` answers it. */
export interface CheckpointPreflight extends RestoreVerdict {
  checkpoint: Checkpoint;
  plan: RestorePlan;
}

export const BLOCKER_KEY: Record<RestoreBlockerCode, string> = {
  'turn-in-progress': 'checkpoint.blocked.turnInProgress',
  'other-session-active': 'checkpoint.blocked.otherSession',
  'no-checkpoint': 'checkpoint.blocked.noCheckpoint',
  'not-a-repo': 'checkpoint.blocked.notARepo',
  'legacy-checkpoint': 'checkpoint.blocked.legacy',
  'no-turn-mark': 'checkpoint.blocked.noTurnMark',
};

/** How many skipped paths the dialog names before folding the rest. */
export const SKIPPED_SHOWN = 5;

/** The title of an enabled button. */
export const ROLLBACK_TITLE_KEY = 'checkpoint.rollback.title';

/**
 * Disabled iff the route said the gesture must stop. A preflight that has not
 * arrived, or failed outright, leaves the button enabled: a preflight is an
 * aid, and a broken aid must not take away a gesture that used to work.
 */
export function rollbackButtonState(
  preflight: CheckpointPreflight | null | undefined,
  tr: Translate,
): { disabled: boolean; title: string } {
  if (!preflight) return { disabled: false, title: tr(ROLLBACK_TITLE_KEY) };
  const reason = preflight.blockedBy ? tr(BLOCKER_KEY[preflight.blockedBy]) : null;
  return { disabled: !preflight.canProceed, title: reason ?? tr(ROLLBACK_TITLE_KEY) };
}

export interface RollbackDialogText {
  lines: string[];
  /** The skipped paths shown, at most `SKIPPED_SHOWN`. */
  skippedPaths: string[];
  /** The "+N more" line, when there are more than shown. */
  more: string | null;
}

/** What the confirm dialog says: what the PLAN says, never a hash promise. */
export function rollbackDialogText(
  checkpoint: Checkpoint,
  preflight: CheckpointPreflight | null | undefined,
  tr: Translate,
): RollbackDialogText {
  const lines = [tr('checkpoint.plan.conversation', { n: checkpoint.messageCount })];
  if (!preflight) {
    lines.push(tr('checkpoint.plan.unknown'));
    return { lines, skippedPaths: [], more: null };
  }
  if (!preflight.filesRestorable) {
    if (preflight.blockedBy) lines.push(tr(BLOCKER_KEY[preflight.blockedBy]));
    return { lines, skippedPaths: [], more: null };
  }
  const restored = preflight.plan.entries.filter((e) => e.state !== 'added').length;
  const removed = preflight.plan.entries.length - restored;
  if (restored === 0 && removed === 0 && preflight.plan.skipped.length === 0) {
    lines.push(tr('checkpoint.plan.nothing'));
  } else {
    if (restored > 0) lines.push(tr('checkpoint.plan.restored', { n: restored }));
    if (removed > 0) lines.push(tr('checkpoint.plan.removed', { n: removed }));
  }
  const skipped = preflight.plan.skipped;
  if (skipped.length > 0) lines.push(tr('checkpoint.plan.skipped', { n: skipped.length }));
  const shown = skipped.slice(0, SKIPPED_SHOWN).map((e) => e.path);
  const hidden = skipped.length - shown.length;
  return { lines, skippedPaths: shown, more: hidden > 0 ? tr('checkpoint.plan.more', { n: hidden }) : null };
}
