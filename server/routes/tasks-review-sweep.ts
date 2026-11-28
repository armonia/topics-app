/**
 * The review sweep's two moves on a card that waits in review: measure again a
 * commit that has no verdict, and send back a green card whose pull request
 * no longer merges into main. Called once per card by `sweepAutoLand` in
 * `tasks-land.ts`.
 */
import type { Task } from "../services/tasks";
import type { createCiPhase } from "./tasks-ci-phase";
import type { TasksCore, TasksLate } from "./tasks-scope";

type CiPhase = ReturnType<typeof createCiPhase>;

export interface ReviewSweepDeps {
  svc: TasksCore["svc"];
  broadcastToAll: TasksCore["broadcastToAll"];
  runChecksGate: TasksLate["runChecksGate"];
  capturaConsegna: TasksLate["capturaConsegna"];
  nodeMeter: { measure(taskId: string): Promise<unknown> };
  bounceRed: CiPhase["bounceRed"];
  afterDelivery: CiPhase["afterDelivery"];
  bounceWithReason: CiPhase["bounceWithReason"];
  reviewPrMergeable?: NonNullable<TasksCore["opts"]>["reviewPrMergeable"];
  /** How many remeasures may run at once: the same cap the checks gate itself holds (default 1). */
  maxConcurrent?: number;
  /** Where the measure count lives, so it outlives a restart; defaults to memory. */
  remeasureStore?: RemeasureStore;
}

export interface RemeasureRecord { commit: string; at: number; tries: number }
export interface RemeasureStore {
  get(taskId: string): RemeasureRecord | undefined;
  set(taskId: string, rec: RemeasureRecord): void;
}

/** No verdict about the commit this card delivers: never measured on it, or measured with no outcome. */
export function unmeasuredInReview(t: Task): boolean {
  if (!t.deliveryCommit || !t.deliveryBranch || (t.humanAsk ?? "").trim()) return false;
  // `null` is the state a node delivery enters review with (never measured once): a card stuck there
  // read as "no verdict yet, nothing to do" forever (11 cards, 26/11) because this only matched the
  // string `"unknown"` the LOCAL gate writes, never the column's own default.
  if (t.checksState === "unknown" || t.checksState === null) return true;
  return (t.checksState === "fail" || t.checksState === "pass") && !sameSha(t.checksCommit, t.deliveryCommit);
}

function sameSha(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n) === b.slice(0, n);
}

/**
 * Arrival order. `svc.list` sorts review rows by `updated_at DESC`, which any
 * write on the card (a comment, a label) bumps - feeding that order straight
 * into the land-intent split below reshuffled the queue on every sweep
 * (reviewer feedback 27/11). `created_at` never moves once the row exists, so
 * the order of the rest of the queue holds from one sweep to the next.
 */
export function sortForSweep(rows: Task[]): Task[] {
  return [...rows].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/**
 * A person already said "land it" (`landIntent === "human"`): the bar is the
 * only thing left between that decision and the merge. Those cards go first,
 * stable (by `sortForSweep`) otherwise - a card nobody has looked at yet does
 * not get to sit in front of one a person is already waiting on. Sorting
 * lives INSIDE this function, not beside its one call site in `sweepAutoLand`:
 * two separate calls there once let a later edit drop one of them unnoticed.
 */
export function orderForSweep(rows: Task[]): Task[] {
  const first: Task[] = [];
  const rest: Task[] = [];
  for (const t of sortForSweep(rows)) {
    if (t.landIntent === "human" && unmeasuredInReview(t)) first.push(t);
    else rest.push(t);
  }
  return [...first, ...rest];
}

export function createReviewSweep(deps: ReviewSweepDeps) {
  const { svc, broadcastToAll, runChecksGate, capturaConsegna, nodeMeter, bounceRed, afterDelivery } = deps;
  const maxConcurrent = Math.max(1, deps.maxConcurrent ?? 1);

  /*
   * A CARD IN REVIEW WITH NO VERDICT ON WHAT IT DELIVERS IS MEASURED AGAIN.
   *
   * The sweep below acted only on `fail`, and only on the commit the card
   * delivers. Two kinds of card sat in review for a day with a red or a
   * conflicting pull request and nobody moving them (18/11/2026):
   *   - no verdict on the delivered commit: a node delivery whose CI ended
   *     without one (9c055516, `unknown`), a card the dispatcher carried into
   *     review after its turns (0b6eba9f), whose last verdict was about an
   *     older commit. Nothing ever measured the commit they deliver;
   *   - green, and its pull request no longer merges into main (4c0e7985).
   * The first kind gets its bar measured here, one card at a time and at most
   * `REVIEW_REMEASURE_TRIES` times per commit, `REVIEW_REMEASURE_PAUSE_MS`
   * apart; a red then goes back to the agent like any red, and a commit that
   * still has no verdict after that is a person's. The second goes back to its
   * agent to bring main in, asked of GitHub at most once per pause per card.
   */
  const REVIEW_REMEASURE_PAUSE_MS = 30 * 60_000;
  const REVIEW_REMEASURE_TRIES = 3;
  const memory = new Map<string, RemeasureRecord>();
  const reviewRemeasures: RemeasureStore = deps.remeasureStore ?? {
    get: (id) => memory.get(id),
    set: (id, rec) => { memory.set(id, rec); },
  };
  const conflictProbedAt = new Map<string, number>();
  // One slot per concurrent remeasure, up to `maxConcurrent`: a run that lasts
  // as long as its CI must not hold every other card still, which is the
  // second serialization `reviewMeasuring: string | null` used to add on top
  // of the checks gate's own `maxConcurrent` semaphore.
  const reviewMeasuring = new Set<string>();

  async function remeasureInReview(t: Task): Promise<void> {
    const now = Date.now();
    const prev = reviewRemeasures.get(t.id);
    const same = prev?.commit === t.deliveryCommit;
    if (same && now - prev!.at < REVIEW_REMEASURE_PAUSE_MS) return;
    const tries = same ? prev!.tries + 1 : 1;
    if (tries > REVIEW_REMEASURE_TRIES) {
      if (!(t.humanAsk ?? "").trim()) {
        try {
          const asked = svc.update({ taskId: t.id, actor: "human", by: "system", projectId: t.projectId, patch: {
            humanAsk: `La barra non dà un esito su \`${t.deliveryCommit!.slice(0, 8)}\` dopo ${REVIEW_REMEASURE_TRIES} misure: leggi l'ultima riga dei check e decidi se serve un commit nuovo.`,
          } });
          broadcastToAll({ type: "task:updated", projectId: t.projectId, task: asked });
        } catch { /* stays in review either way */ }
      }
      return;
    }
    reviewRemeasures.set(t.id, { commit: t.deliveryCommit!, at: now, tries });
    reviewMeasuring.add(t.id);
    try {
      console.warn(`[review-sweep] ${t.id.slice(0, 8)}: nessun verdetto su ${t.deliveryCommit!.slice(0, 8)}, misuro la barra (${tries}/${REVIEW_REMEASURE_TRIES})`);
      let out: Awaited<ReturnType<typeof runChecksGate>> = null;
      for (let leg = 0; leg < 240; leg++) {
        // The first leg drops the verdict the gate may still retain for this commit: it is the one being questioned.
        out = await runChecksGate(t.id, t.projectId, 60_000, undefined, leg === 0);
        if (!out || !("pending" in out)) break;
      }
      // No worktree of its own (a planted branch, a reaped worktree): the
      // throwaway checkout of the node lane, which serialises on its own
      // (`queueTail`) and can wait far longer than any local leg. Free this
      // slot BEFORE that wait, or a node delivery stuck behind another one
      // held a local slot for up to ~80 minutes with nothing running in it
      // (reviewer feedback 27/11).
      if (out === null) { reviewMeasuring.delete(t.id); await nodeMeter.measure(t.id); return; }
      if ("interrupted" in out || "pending" in out) return;
      // The realign may have moved the tip: the delivery is the commit just measured.
      await capturaConsegna(t.id);
      const after = svc.get(t.id)?.task;
      if (after) broadcastToAll({ type: "task:updated", projectId: after.projectId, task: after });
      if (await bounceRed(t.projectId, t.id)) return;
      if (after?.checksState === "pass") await afterDelivery(t.projectId, t.id);
    } finally { reviewMeasuring.delete(t.id); }
  }

  /** A green card waiting in review whose pull request conflicts with main goes back to its agent. */
  async function probeConflict(t: Task): Promise<boolean> {
    if (!deps.reviewPrMergeable || !t.deliveryBranch || (t.humanAsk ?? "").trim() || t.landIntent) return false;
    const now = Date.now();
    if (now - (conflictProbedAt.get(t.id) ?? 0) < REVIEW_REMEASURE_PAUSE_MS) return false;
    conflictProbedAt.set(t.id, now);
    const state = await deps.reviewPrMergeable(t.id, t.deliveryBranch).catch(() => null);
    if (state !== "CONFLICTING") return false;
    console.warn(`[review-sweep] ${t.id.slice(0, 8)}: verde ma la PR è in conflitto con main, torna all'agente`);
    return deps.bounceWithReason(t.projectId, t.id,
      `La pull request di \`${t.deliveryBranch}\` è in conflitto con main: così non può atterrare. ` +
      "Porta main nel tuo ramo (`git fetch origin main && git merge origin/main`), risolvi, committa e rimetti in review.");
  }

  /** A free slot is available for one more remeasure, within `maxConcurrent`. */
  function hasFreeSlot(): boolean {
    return reviewMeasuring.size < maxConcurrent;
  }

  /** This card itself already holds one of the slots: a full cap is not a queue for it. */
  function isMeasuring(taskId: string): boolean {
    return reviewMeasuring.has(taskId);
  }

  return { unmeasuredInReview, remeasureInReview, probeConflict, hasFreeSlot, isMeasuring };
}
