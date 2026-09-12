/**
 * DO NOT CLOBBER SOMEONE'S EVIDENCE WITH AN AUTOMATIC SCREENSHOT.
 *
 * The preview auto-capture runs again when a fan-out winner is picked. The
 * losing attempts are thrown away, but the WINNER's own worktree is booted
 * fresh and photographed, and that shot used to overwrite `preview_image`
 * unconditionally.
 *
 * A card can already carry a screenshot the agent chose — promoted from a
 * comment attachment through `promoteReviewPreview`. The automatic reboot lands
 * on whatever the app shows with no state at all, usually its own empty landing
 * page, and `blankShot` does not catch that: it is a dense render, not a blank
 * file (see `image-shape.ts`). Reported symptom: three review cards showing
 * "Welcome to Topics" while the agent's own comment said screenshots and video
 * were attached.
 *
 * WHAT COUNTS AS THE CARD'S OWN. Not a delivery sheet (that IS generated) and
 * not an earlier auto-capture (replacing one automatic shot with a newer one is
 * the behaviour we want). What is left is a picture a person or an agent chose.
 *
 * AN EXPLICIT RECAPTURE STILL WINS. `explain` means a human asked for the shot
 * again, and asking is the whole point: the guard steps aside.
 */
import { isAutoCapturedPreview, isDeliverySheetPath } from "../../shared/media-kind";

/**
 * Does the card already hold evidence the auto-capture must not replace?
 *
 * `current` absent ⇒ false: nothing to protect, and that is also the old
 * behaviour for a deps object that does not implement the lookup at all.
 */
export function holdsOwnEvidence(current: string | null | undefined, explain: boolean): boolean {
  if (explain) return false;
  if (!current) return false;
  return !isDeliverySheetPath(current) && !isAutoCapturedPreview(current);
}
