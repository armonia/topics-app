/**
 * The cures of the self-check round (CHECK-03): a recognised cause is healed by
 * the cure the dispatcher already has, reversibly, with one line on the card it
 * touched. A cause with no cure, or a cure that did not clear the red by the
 * next round, opens one investigation card per problem key on the board chosen
 * in the settings, under a daily cap. With no board chosen nothing is opened.
 *
 * Nothing here names a machine, a host or an account: the board and the cap live
 * in the `topicsCheck` setting, and the default (no board) is off and works.
 */
import type { Database } from "bun:sqlite";
import { hangBreaker, WAKE_FAIL_THRESHOLD } from "./wake-breaker";
import { EMPTY_RUN_PIN_MS } from "./task-dispatcher-remote-node-empty";
import { isAgentWorking, PARKED_STOPPED, statusEventEnters } from "../../shared/board";
import { AGENT_ASSIGNEE, CAUSE_TEXT, pingPongCards, type CureOutcome, type CureReport, type InvestigationSettings, type Move, type Sample, type StuckCause, type Thresholds } from "./topics-check";
import type { Task, TaskService } from "./tasks";

export type ProblemCause = StuckCause | "bounce";
export interface Problem { key: string; cause: ProblemCause; taskId: string }
export type { CureOutcome, CureReport };

/** Key prefix of the investigation cards: the daily cap counts the cards that carry it. */
const INVESTIGATION_KEY = "topics-check:";

/** The author on a requeue/park note, so `unknownRetries` can count only its own tries. */
const UNKNOWN_CURE_AUTHOR = "topics-check";
/** Fresh shots an "unknown" card gets before it is parked for a human to look at it. */
export const UNKNOWN_RETRY_CAP = 2;

export interface CureDeps {
  db: Database;
  svc: Pick<TaskService, "get" | "update" | "addComment" | "create" | "release">;
  /** The dispatcher's own reassignment of a card pinned to a machine that cannot run it; true = the card moved. */
  reassign: (task: Task) => boolean;
  /** Publishes a changed card to the open views. */
  emit: (task: Task) => void;
  breaker?: Pick<typeof hangBreaker, "failure" | "isOpen">;
  now?: () => number;
}

/** What a bounce is, for the title of its investigation card (no stuck cause describes it). */
const BOUNCE_TEXT = "la card rimbalza fra i nodi"; // allow-italian: board card title

/**
 * One key per problem: two different problems never share a card. A bounce counts only the moves inside the
 * window and made after the card was last cured (`curedAt`): the same old moves never convict a cure twice.
 */
export function problemsOf(sample: Sample, t: Thresholds, curedAt: ReadonlyMap<string, number> = new Map()): Problem[] {
  const stuck = sample.stuck.filter((c) => c.cause !== "person").map((c): Problem => ({ key: `${c.cause}:${c.id}`, cause: c.cause, taskId: c.id }));
  const recent = sample.moves.filter((m: Move) => m.at >= sample.at - t.cardMovesWindowMin * 60_000 && m.at > (curedAt.get(m.id) ?? 0));
  const bounces = [...pingPongCards(recent, t)].map((id): Problem => ({ key: `bounce:${id}`, cause: "bounce", taskId: id }));
  return [...stuck, ...bounces];
}

/**
 * The deps the server boot hands to the cures: the dispatcher's own reassignment with the settings of the
 * card's own board (its pinned model counts), and its own publisher for the views.
 */
export function cureDepsOf(
  db: Database,
  svc: CureDeps["svc"] & { getBoardSettings(projectId: string): { dispatchModel?: string | null } },
  dispatcher: { reassignFromForbidden(task: Task, settings: { dispatchModel?: string | null }): boolean; emitTask(task: Task): void },
): CureDeps {
  return {
    db, svc,
    reassign: (task) => dispatcher.reassignFromForbidden(task, svc.getBoardSettings(task.projectId)),
    emit: (task) => dispatcher.emitTask(task),
  };
}

interface CardState {
  task: Task; runOpen: boolean;
  /** Delegated or mirror cards are bound to their node: no cure moves them. */
  bound: boolean;
  /** Pinned to a machine by a person, not by the system. */
  personPin: boolean;
  /** `stay_local` set by a person (no pin expiry running): "none of our machines", so no cure reassigns it. */
  stayLocal: boolean;
  /** True when a card the sample called "unknown" has since moved on in a way the sample could not see: a live
   * agent turn, a human question, the review stage, or a person holding it. None of these is `cure`'s to touch. */
  waitingOnSomeoneElse: boolean;
}

export function createCures(deps: CureDeps) {
  const { db, svc } = deps;
  const now = deps.now ?? Date.now;
  const breaker = deps.breaker ?? hangBreaker;
  /** Cured last round: still red this round means the cure did not work. */
  const cured = new Set<string>();

  /**
   * When each bounced card was last cured, read from the pin the cure left in the database (it survives a restart):
   * only the moves after that count against the cure.
   */
  function curedAtOf(sample: Sample): Map<string, number> {
    const at = new Map<string, number>();
    for (const id of new Set(sample.moves.map((m) => m.id))) {
      const row = db.query("SELECT stay_local_until AS until FROM tasks WHERE id = ? AND stay_local = 1 AND machine_id IS NULL").get(id) as { until: string | null } | null;
      const pinnedAt = row?.until ? Date.parse(row.until) - EMPTY_RUN_PIN_MS : Number.NaN;
      if (!Number.isNaN(pinnedAt)) at.set(id, pinnedAt);
    }
    return at;
  }

  const note = (taskId: string, content: string) => svc.addComment({ taskId, author: "system", kind: "service", content });

  /** When a person (never this cure, never the dispatcher) last put the card back into `todo`: the moment the
   * count below restarts from, so a card a person looked at and requeued does not land straight back in the park
   * it was just pulled out of. */
  function personReopenedAt(taskId: string): string | null {
    const rows = db.query("SELECT author, content, created_at FROM task_comments WHERE task_id = ? AND kind = 'status' ORDER BY created_at DESC")
      .all(taskId) as { author: string; content: string; created_at: string }[];
    return rows.find((r) => statusEventEnters(r.content, "todo") && r.author !== "system" && r.author !== "dispatcher" && r.author !== UNKNOWN_CURE_AUTHOR)?.created_at ?? null;
  }

  /** How many times `topics-check` already requeued this card for "unknown" since it was last parked, or since a
   * person last put it back in `todo`: the readable cap before it parks it instead. */
  const unknownRetries = (taskId: string): number =>
    (db.query("SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ? AND author = ? AND content LIKE 'Rimessa in coda%' AND created_at > ?")
      .get(taskId, UNKNOWN_CURE_AUTHOR, personReopenedAt(taskId) ?? "") as { n: number }).n;

  /** The card as the database has it now; null when it is gone or archived. */
  function read(taskId: string): CardState | null {
    const task = svc.get(taskId)?.task;
    if (!task) return null;
    const row = db.query(
      "SELECT node_run_open AS open, archived, delegated_start_capability_id AS delegated, claude_task_id AS cid, overflowed_at AS overflowed, stay_local_until AS stayLocalUntil FROM tasks WHERE id = ?",
    ).get(taskId) as { open: number | null; archived: number | null; delegated: string | null; cid: string | null; overflowed: string | null; stayLocalUntil: string | null } | null;
    if (!row || row.archived) return null;
    const personAssignee = task.status === "in_progress" && !!task.assignedTo && !AGENT_ASSIGNEE.test(task.assignedTo);
    return {
      task, runOpen: row.open === 1,
      bound: !!row.delegated || !!row.cid?.startsWith("node-run:"),
      personPin: !!task.machineId && !row.overflowed,
      stayLocal: task.stayLocal && !(row.stayLocalUntil && Date.parse(row.stayLocalUntil) <= now()),
      waitingOnSomeoneElse: isAgentWorking(task.dispatchState) || !!task.humanAsk?.trim() || task.stage === "human_review" || personAssignee,
    };
  }

  /** The cure of one cause, or false when there is none (or it had nothing to do). */
  function cure(p: Problem, { task, runOpen, bound, personPin, stayLocal, waitingOnSomeoneElse }: CardState): boolean {
    switch (p.cause) {
      case "offline":
      case "seats":
        // The dispatcher's reassignment is made for queued cards: a card with a run open keeps its machine, the run is on it.
        return task.status === "todo" && !runOpen && !bound && !!task.machineId && deps.reassign(task);
      case "hung-node": {
        if (!task.machineId) return false;
        for (let i = 0; i < WAKE_FAIL_THRESHOLD; i++) breaker.failure(task.machineId);
        note(task.id, "Il nodo non risponde più: non gli mando altre card finché la finestra non si chiude da sola."); // allow-italian: board comment
        return true;
      }
      case "bounce": {
        // A pin a person chose is theirs: a card the system put on a node is the one a bounce can move.
        if (task.status !== "todo" || runOpen || bound || personPin || task.stayLocal) return false;
        const pinned = svc.update({ taskId: task.id, actor: "agent", by: "topics-check", patch: { machineId: null, stayLocal: true, stayLocalUntil: new Date(now() + EMPTY_RUN_PIN_MS).toISOString() } });
        deps.emit(pinned);
        note(task.id, "La card rimbalzava fra i nodi: la tengo qui, «solo Mac», per 6 ore."); // allow-italian: board comment
        return true;
      }
      // "chain-parked" has no cure of its own here: `deriveQueueReason` (shared/board.ts) only reports a card's
      // blocker as open when its DIRECT blocker is neither done nor archived, and `isDispatchBlocked` re-reads
      // the same fact live on every dispatch tick. A card whose direct blocker just finished is no longer
      // "blocked" for either of them by the next tick, with nothing here needed to make that happen; a card
      // still classified "chain-parked" has a direct blocker that is genuinely still open, which this cure
      // cannot clear without un-blocking a card that is not actually free yet. It falls through to `investigate`.
      case "unknown": {
        // The sample can be up to half a minute old: re-check everything it could not see happen in the
        // meantime. Only an `in_progress` card with no live turn, no open question, no review stage and no
        // person holding it is actually "unknown" — a `todo` card was never the cause this cures, and a
        // card the system cannot touch (a run, its node, a person's pin) is never this cure's to move.
        if (task.status !== "in_progress" || runOpen || bound || personPin || stayLocal || waitingOnSomeoneElse) return false;
        const tries = unknownRetries(task.id);
        if (tries < UNKNOWN_RETRY_CAP) {
          const requeued = svc.release({
            taskId: task.id, requeue: true, by: UNKNOWN_CURE_AUTHOR,
            reason: `Rimessa in coda (giro ${tries + 1} di ${UNKNOWN_RETRY_CAP}): nessun turno vivo e nessuna domanda aperta, forse una ripartenza basta.`, // allow-italian: board comment
          });
          deps.emit(requeued);
          return true;
        }
        const parked = svc.release({
          taskId: task.id, requeue: false, by: UNKNOWN_CURE_AUTHOR, parkState: PARKED_STOPPED,
          reason: `Tolta dalla coda dopo ${UNKNOWN_RETRY_CAP} tentativi a vuoto: nessun turno vivo e nessuna domanda aperta, serve un occhio umano.`, // allow-italian: board comment
        });
        deps.emit(parked);
        return true;
      }
      default:
        return false;
    }
  }

  const today = () => new Date(now()).toISOString().slice(0, 10);

  /**
   * One open card per problem key is enough, today's or an older one, and a restart does not change that:
   * the rule reads the database, never the memory. A card closed today is not reopened the same day.
   */
  function investigated(p: Problem, boardId: string): boolean {
    const keyAt = INVESTIGATION_KEY.length + "YYYY-MM-DD:".length + 1;
    return !!db.query("SELECT 1 FROM tasks WHERE project_id = ? AND claude_task_id LIKE ? AND substr(claude_task_id, ?) = ? AND ((status != 'done' AND COALESCE(archived, 0) = 0) OR substr(created_at, 1, 10) = ?)")
      .get(boardId, `${INVESTIGATION_KEY}%`, keyAt, p.key, today());
  }

  /** Investigation cards (any kind) opened on `day`: what the cap counts. */
  const openedToday = (boardId: string, day: string): number =>
    (db.query("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND claude_task_id LIKE ? AND substr(created_at, 1, 10) = ?")
      .get(boardId, `${INVESTIGATION_KEY}%`, day) as { n: number }).n;

  /** One investigation card for this key, within the day's cap. */
  function investigate(p: Problem, inv: InvestigationSettings): CureOutcome {
    if (!inv.boardId) return "off";
    const day = today();
    if (investigated(p, inv.boardId)) return "skipped";
    const opened = openedToday(inv.boardId, day);
    if (opened >= inv.perDay) {
      const line = `Tetto di ${inv.perDay} indagini al giorno raggiunto: non apro un'altra card per questo problema.`; // allow-italian: board comment
      // The cap stays in the report for as long as it holds; the line on the card is written once a day.
      if (!db.query("SELECT 1 FROM task_comments WHERE task_id = ? AND content = ? AND substr(created_at, 1, 10) = ?").get(p.taskId, line, day)) note(p.taskId, line);
      return "capped";
    }
    const card = svc.create({
      projectId: inv.boardId, status: "backlog", idempotencyKey: `${INVESTIGATION_KEY}${day}:${p.key}`,
      text: `Verifica: ${p.cause === "bounce" ? BOUNCE_TEXT : CAUSE_TEXT[p.cause]}`, // allow-italian: board card title
      description: `Problema ${p.key}: la card ${p.taskId} resta rossa nella Verifica e la cura nota non c'è o non l'ha tolta.`, // allow-italian: board card body
    });
    note(p.taskId, `Indagine aperta: card ${card.id}.`); // allow-italian: board comment
    return "investigated";
  }

  /**
   * The card of a red daily reading: it takes the investigation board, the `topics-check:` key prefix and the
   * day's cap like any investigation card, so it can never be a second path to an unbounded stream of cards.
   */
  function openDaily(inv: InvestigationSettings, title: string, body: string): { outcome: "opened" | "capped" | "off"; cardId: string | null } {
    if (!inv.boardId) return { outcome: "off", cardId: null };
    const day = today();
    const opened = openedToday(inv.boardId, day);
    if (opened >= inv.perDay) return { outcome: "capped", cardId: null };
    const card = svc.create({ projectId: inv.boardId, status: "backlog", idempotencyKey: `${INVESTIGATION_KEY}${day}:daily`, text: title, description: body });
    deps.emit(card);
    return { outcome: "opened", cardId: card.id };
  }

  return {
    openDaily,
    /** One round over the last sample. A failure on one problem never stops the others. */
    run(sample: Sample, t: Thresholds, inv: InvestigationSettings): CureReport[] {
      const reports: CureReport[] = [];
      const seen = new Set<string>();
      const problems: { p: Problem; state: CardState }[] = [];
      for (const raw of problemsOf(sample, t, curedAtOf(sample))) {
        const state = read(raw.taskId);
        // A bounce is only a problem for a card that is still waiting in todo.
        if (!state || (raw.cause === "bounce" && state.task.status !== "todo")) continue;
        // A hung node is one problem for the node, however many cards sit on it.
        const key = raw.cause === "hung-node" && state.task.machineId ? `hung-node:${state.task.machineId}` : raw.key;
        if (seen.has(key)) continue;
        seen.add(key);
        problems.push({ p: { ...raw, key }, state });
      }
      for (const k of cured) if (!seen.has(k)) cured.delete(k);
      for (const { p, state } of problems) {
        try {
          // An open breaker is the cure at work: wait for it. Only a node still hung after it closed is investigated.
          if (p.cause === "hung-node" && state.task.machineId && breaker.isOpen(state.task.machineId)) { reports.push({ key: p.key, outcome: "skipped" }); continue; }
          // A problem with its card open is waiting on it: the cure is not tried again.
          if (inv.boardId && investigated(p, inv.boardId)) { reports.push({ key: p.key, outcome: "skipped" }); continue; }
          if (!cured.has(p.key) && cure(p, state)) { cured.add(p.key); reports.push({ key: p.key, outcome: "cured" }); continue; }
          const outcome = investigate(p, inv);
          // A capped problem keeps its cure marked as tried: otherwise the next round cures it again (a curable
          // card would be moved every other round) and the self-check row shows the cap only half the time.
          if (outcome !== "capped") cured.delete(p.key);
          reports.push({ key: p.key, outcome });
        } catch (err) {
          console.warn("[topics-check] cure failed:", p.key, err instanceof Error ? err.message : err);
          reports.push({ key: p.key, outcome: "skipped" });
        }
      }
      return reports;
    },
  };
}
