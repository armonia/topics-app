/**
 * A card that sits in `todo` or `in_progress` for an hour with nothing on it
 * that says why gets, from the system, one service note with the reason worked
 * out from the facts (queue position, machine full, machine silent), and goes
 * back to the queue when the machine it was pinned to is down.
 *
 * The decision is pure (`diagnoseStuckCard`); `sweepStuckCards` is the thin
 * driver the reconcile pass calls, throttled by its caller.
 */
import type { Task } from "./task-shapes";
import { effectiveSlots, MODEL_SKIP_MS, type OverflowMachine } from "./dispatch-overflow";

/** How long a card may sit without a legible reason before the system speaks. */
export const STUCK_AFTER_MS = 60 * 60_000;

/** Opening of the one note per card: also the marker that keeps the sweep idempotent. */
export const STUCK_NOTE_PREFIX = "Ferma da"; // allow-italian: user-facing board comment

/** The facts the decision reads; `machines` is the dispatcher's own view of the fleet. */
export interface StuckContext {
  nowMs: number;
  machines: readonly OverflowMachine[];
  /** Live cards counted on a machine (todo + in progress that name it). */
  loadOf: (machineId: string) => number;
  /** A live turn, a queued resume or a retry timer owns the card: it is not stuck. */
  busy: (taskId: string) => boolean;
}

export interface StuckVerdict {
  /** The sentence for the thread. */
  note: string;
  /** The pinned machine is down: send the card back to the queue with no fixed machine. */
  requeue: boolean;
  /** The machine to keep the card away from, when `requeue`. */
  skipMachineId: string | null;
}

/** Waiting reasons that already explain themselves, so the system adds nothing. */
const LEGIBLE_QUEUE_KINDS = new Set(["slot", "unknown", "no_agent"]);

function sinceOf(card: Task): number {
  const stamp = card.status === "in_progress" ? (card.inProgressAt ?? card.updatedAt) : card.updatedAt;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/** True when the card already carries a reason a reader can see. */
export function hasLegibleReason(card: Task): boolean {
  if (card.dispatchError && card.dispatchError.trim()) return true;
  if (card.waitReason && card.waitReason.trim()) return true;
  if (card.dispatchState === "waiting" || card.dispatchState === "parked") return true;
  // In progress the dispatch chip (working, starting, needs_input...) is the
  // reason: a card a person dragged there by hand carries one too, and moving
  // it would undo that choice.
  if (card.status === "in_progress" && card.dispatchState) return true;
  const q = card.queueReason;
  return !!q && !LEGIBLE_QUEUE_KINDS.has(q.kind);
}

/**
 * Null = leave the card alone: not in a stuck status, not old enough, owned by
 * a live turn, or already explaining itself.
 */
export function diagnoseStuckCard(card: Task, ctx: StuckContext): StuckVerdict | null {
  if (card.archived || (card.status !== "todo" && card.status !== "in_progress")) return null;
  const since = sinceOf(card);
  if (!Number.isFinite(since)) return null;
  const minutes = Math.floor((ctx.nowMs - since) / 60_000);
  if (ctx.nowMs - since < STUCK_AFTER_MS) return null;
  if (ctx.busy(card.id) || hasLegibleReason(card)) return null;

  const head = `${STUCK_NOTE_PREFIX} ${minutes} min`;
  const machine = card.machineId ? ctx.machines.find((m) => m.id === card.machineId) : undefined;
  if (card.machineId && machine && !machine.online && !machine.wakeable) {
    return {
      note: `${head}: la macchina «${machine.name}» a cui è assegnata non risponde. Rimessa in coda su un'altra.`, // allow-italian: user-facing board comment
      requeue: true,
      skipMachineId: machine.id,
    };
  }
  if (card.machineId && !machine) {
    return {
      note: `${head}: la macchina assegnata non è più nell'elenco. Rimessa in coda su un'altra.`, // allow-italian: user-facing board comment
      requeue: true,
      skipMachineId: null,
    };
  }
  if (machine) {
    const seats = effectiveSlots(machine);
    const load = ctx.loadOf(machine.id);
    if (load >= seats) {
      return {
        note: `${head}: la macchina «${machine.name}» è piena (${load} card su ${seats} posti). Parte quando si libera un posto.`, // allow-italian: user-facing board comment
        requeue: false,
        skipMachineId: null,
      };
    }
  }
  if (card.status === "in_progress") {
    return {
      note: `${head} in corso senza un turno vivo: nessun agente la sta lavorando.`, // allow-italian: user-facing board comment
      requeue: false,
      skipMachineId: null,
    };
  }
  const ahead = card.queueReason?.params?.ahead;
  return {
    note: typeof ahead === "number" && ahead > 0
      ? `${head} in coda: ${ahead} card davanti, aspetta un posto libero o il tetto di concorrenza.` // allow-italian: user-facing board comment
      : `${head} in coda senza altro motivo registrato: aspetta un posto libero o il tetto di concorrenza.`, // allow-italian: user-facing board comment
    requeue: false,
    skipMachineId: null,
  };
}

/** The slice of the task service the sweep needs. */
export interface StuckSweepSvc {
  list(input: { scope: "all"; status?: "todo" | "in_progress" }): Task[];
  get(taskId: string): { task: Task; comments: Array<{ kind?: string | null; content: string }> } | null;
  addComment(args: { taskId: string; author: string; content: string; kind: "service" }): unknown;
}

export interface StuckSweepDeps extends StuckContext {
  svc: StuckSweepSvc;
  /** Back to the queue with no fixed machine; false = it did not work, the note is not written. */
  requeue: (taskId: string, skipMachineId: string | null, note: string) => boolean;
}

/**
 * One pass. One note per card, ever: a card that already carries the marker is
 * skipped, so a second pass (or a restart) writes nothing. Returns the cards it
 * spoke on, for the log.
 */
export function sweepStuckCards(deps: StuckSweepDeps): Array<{ id: string; requeued: boolean }> {
  const spoke: Array<{ id: string; requeued: boolean }> = [];
  const cards = [...deps.svc.list({ scope: "all", status: "todo" }), ...deps.svc.list({ scope: "all", status: "in_progress" })];
  for (const card of cards) {
    const verdict = diagnoseStuckCard(card, deps);
    if (!verdict) continue;
    const thread = deps.svc.get(card.id);
    if (!thread || thread.comments.some((c) => c.kind === "service" && c.content.startsWith(STUCK_NOTE_PREFIX))) continue;
    if (verdict.requeue) {
      if (!deps.requeue(card.id, verdict.skipMachineId, verdict.note)) continue;
      spoke.push({ id: card.id, requeued: true });
      continue;
    }
    deps.svc.addComment({ taskId: card.id, author: "system", kind: "service", content: verdict.note });
    spoke.push({ id: card.id, requeued: false });
  }
  return spoke;
}

/** How long the requeued card stays away from the machine that did not answer. */
export const STUCK_SKIP_MS = MODEL_SKIP_MS;
