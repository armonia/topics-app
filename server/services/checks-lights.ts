/**
 * THE «running» LIGHT OF THE PRE-REVIEW CHECKS, and who is allowed to believe it.
 *
 * A round of checks lives in the process (`checks-gate.ts`). The row says
 * `checks_state = 'running'` for its whole length, and `clearStaleChecksRuns()`
 * used to have exactly ONE caller: the route's construction, the single instant
 * when the gate's registry is empty by construction and every light in the
 * database therefore belongs to a dead process.
 *
 * A boot was never the only way to leave one on. Let `measure()`
 * (`routes/tasks.ts`) end without recording the terminal state - the swap
 * brake's `ChecksInterruptedError`, `throwIfStopping()`, any exception the gate
 * logs as `corsa … esplosa` - and the gate drops its key while the row keeps
 * saying "running". Measured on 2026-09-17: 89 boots found at least one light
 * already lit (71 times 1, 16 times 2, once 4, once 6). Between two boots that
 * row lied to everything that reads it - 1253 rearms of the stall judge, and a
 * StaleStream sweep answering `extend` to every mute turn of that session, so a
 * turn that had died was never finalized.
 *
 * Both halves of the answer live here so they can be tested: `server.ts` has no
 * test file, and a predicate nobody can run is a promise nobody can check.
 */
import type { Database } from "bun:sqlite";

/**
 * The card this session is working on, if it is still in progress.
 *
 * The session key is the topic's, `topic:` prefix and all, and the topic id on
 * the card is the FULL one: the key carries a prefix of it, which is why this
 * matches with LIKE instead of equality.
 */
export function checksHoldTaskId(db: Database, sessionKey: string): string | null {
  const topicPrefix = sessionKey.startsWith("topic:") ? sessionKey.slice("topic:".length) : sessionKey;
  if (!topicPrefix) return null;
  try {
    const row = db.prepare(
      `SELECT id FROM tasks WHERE status = 'in_progress' AND assigned_topic_id LIKE ? LIMIT 1`,
    ).get(topicPrefix + "%") as { id: string } | null;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Is the task this session works on waiting on OUR pre-review checks?
 *
 * The stall detector must not judge that silence: the agent asked for review,
 * the gate said 202 and is grinding typecheck/lint/test:unit, and the agent is
 * waiting on us - running, or queued behind another card's run (minutes each).
 *
 * THE LIVE REGISTRY ANSWERS, NOT THE ROW. `checks_state === 'running'` stood
 * here as an equal half of an OR, and that half is the light above: once left
 * on, this predicate was true FOREVER for that session. The row is now a
 * confirmation, not a source - it is what `sweepStaleChecksLights` reconciles
 * against this same registry.
 */
export function isChecksHold(
  db: Database,
  isRunning: ((taskId: string) => boolean) | null,
  sessionKey: string,
): boolean {
  const taskId = checksHoldTaskId(db, sessionKey);
  if (!taskId) return false;
  return isRunning?.(taskId) ?? false;
}

export interface StaleChecksLightsDeps {
  /** `svc.clearStaleChecksRuns`: switches off only the lights `isLive` rejects. */
  clearStale(isLive: (taskId: string) => boolean): string[];
  /** `checksGate.isRunning`, or null while the route is still being built. */
  isRunning: ((taskId: string) => boolean) | null;
  /** Push the card to the boards that have it open (`task:updated`). */
  announce(taskId: string): void;
  /**
   * `settleDelivery`: re-issue the PATCH this process is still holding for that
   * card, if it is holding one. THE OTHER HALF OF THE FIX, and without it the
   * two halves pull apart: an honest light leaves the card parked with no round
   * and no verdict, while the boot resume - the only other thing that would
   * ever restart it - now gives up after three rounds (`MAX_DELIVERY_ROUNDS`).
   * A no-op for a card with no delivery in flight.
   */
  resume(taskId: string): void;
  warn(line: string): void;
}

/**
 * Cross the two registries on the beat the StaleStream sweep already pays for:
 * the gate decides, the row follows, and a card whose run is alive or queued
 * behind another one is never touched.
 */
export function sweepStaleChecksLights(deps: StaleChecksLightsDeps): string[] {
  const live = deps.isRunning;
  // The route is not built yet: there is no registry to cross, and every light
  // is still the boot sweep's business.
  if (!live) return [];
  let spente: string[] = [];
  try {
    spente = deps.clearStale((taskId) => live(taskId));
  } catch (err) {
    deps.warn(`[checks] passata sulle spie 'running' fallita: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  if (!spente.length) return [];
  deps.warn(`[checks] ${spente.length} spie 'running' spente: il gate non ha piu' quella corsa, e nessuno ne scrivera' il verdetto`);
  for (const id of spente) {
    // The board that has the card open must stop showing the spinner NOW: the
    // next `task:updated` for a card whose round died may never come.
    try { deps.announce(id); } catch { /* an announcement is never the sweep */ }
    try { deps.resume(id); } catch { /* idem: the light is already honest */ }
  }
  return spente;
}
