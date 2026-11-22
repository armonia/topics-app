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
import { CAUSE_TEXT, pingPongCards, type CureOutcome, type CureReport, type InvestigationSettings, type Move, type Sample, type StuckCause, type Thresholds } from "./topics-check";
import type { Task, TaskService } from "./tasks";

export type ProblemCause = StuckCause | "bounce";
export interface Problem { key: string; cause: ProblemCause; taskId: string }
export type { CureOutcome, CureReport };

/** Key prefix of the investigation cards: the daily cap counts the cards that carry it. */
const INVESTIGATION_KEY = "topics-check:";

export interface CureDeps {
  db: Database;
  svc: Pick<TaskService, "get" | "update" | "addComment" | "create">;
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

interface CardState { task: Task; runOpen: boolean; /** Delegated or mirror cards are bound to their node: no cure moves them. */ bound: boolean; /** Pinned to a machine by a person, not by the system. */ personPin: boolean }

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

  /** The card as the database has it now; null when it is gone or archived. */
  function read(taskId: string): CardState | null {
    const task = svc.get(taskId)?.task;
    if (!task) return null;
    const row = db.query("SELECT node_run_open AS open, archived, delegated_start_capability_id AS delegated, claude_task_id AS cid, overflowed_at AS overflowed FROM tasks WHERE id = ?")
      .get(taskId) as { open: number | null; archived: number | null; delegated: string | null; cid: string | null; overflowed: string | null } | null;
    if (!row || row.archived) return null;
    return {
      task, runOpen: row.open === 1,
      bound: !!row.delegated || !!row.cid?.startsWith("node-run:"),
      personPin: !!task.machineId && !row.overflowed,
    };
  }

  /** The cure of one cause, or false when there is none (or it had nothing to do). */
  function cure(p: Problem, { task, runOpen, bound, personPin }: CardState): boolean {
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

  /** One investigation card for this key, within the day's cap. */
  function investigate(p: Problem, inv: InvestigationSettings): CureOutcome {
    if (!inv.boardId) return "off";
    const day = today();
    if (investigated(p, inv.boardId)) return "skipped";
    const opened = (db.query("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND claude_task_id LIKE ? AND substr(created_at, 1, 10) = ?")
      .get(inv.boardId, `${INVESTIGATION_KEY}%`, day) as { n: number }).n;
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

  return {
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
          cured.delete(p.key);
          reports.push({ key: p.key, outcome: investigate(p, inv) });
        } catch (err) {
          console.warn("[topics-check] cure failed:", p.key, err instanceof Error ? err.message : err);
          reports.push({ key: p.key, outcome: "skipped" });
        }
      }
      return reports;
    },
  };
}
