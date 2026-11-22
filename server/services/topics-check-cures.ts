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
import { CAUSE_TEXT, pingPongCards, type InvestigationSettings, type Sample, type StuckCause, type Thresholds } from "./topics-check";
import type { Task, TaskService } from "./tasks";

export type ProblemCause = StuckCause | "bounce";
export interface Problem { key: string; cause: ProblemCause; taskId: string }
export type CureOutcome = "cured" | "investigated" | "capped" | "off" | "skipped";
export interface CureReport { key: string; outcome: CureOutcome }

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

/** One key per problem: two different problems never share a card. A bounce counts only while its moves are inside the window. */
export function problemsOf(sample: Sample, t: Thresholds): Problem[] {
  const stuck = sample.stuck.filter((c) => c.cause !== "person").map((c): Problem => ({ key: `${c.cause}:${c.id}`, cause: c.cause, taskId: c.id }));
  const recent = sample.moves.filter((m) => m.at >= sample.at - t.cardMovesWindowMin * 60_000);
  const bounces = [...pingPongCards(recent, t)].map((id): Problem => ({ key: `bounce:${id}`, cause: "bounce", taskId: id }));
  return [...stuck, ...bounces];
}

export function createCures(deps: CureDeps) {
  const { db, svc } = deps;
  const now = deps.now ?? Date.now;
  const breaker = deps.breaker ?? hangBreaker;
  /** Cured last round: still red this round means the cure did not work. */
  const cured = new Set<string>();
  /** Already escalated while the problem lasts (null), or capped on that day: no second card, no second note. */
  const escalated = new Map<string, string | null>();

  const note = (taskId: string, content: string) => svc.addComment({ taskId, author: "system", kind: "service", content });

  /** The card as the database has it now, with whether a node run is still open on it. */
  function read(taskId: string): { task: Task; runOpen: boolean } | null {
    const task = svc.get(taskId)?.task;
    if (!task) return null;
    const row = db.query("SELECT node_run_open AS open FROM tasks WHERE id = ?").get(taskId) as { open: number | null } | null;
    return { task, runOpen: row?.open === 1 };
  }

  /** The cure of one cause, or false when there is none (or it had nothing to do). */
  function cure(p: Problem, task: Task, runOpen: boolean): boolean {
    switch (p.cause) {
      case "offline":
      case "seats":
        // The dispatcher's reassignment is made for queued cards: a card with a run open keeps its machine, the run is on it.
        return task.status === "todo" && !runOpen && !!task.machineId && deps.reassign(task);
      case "hung-node": {
        if (!task.machineId || breaker.isOpen(task.machineId)) return false;
        for (let i = 0; i < WAKE_FAIL_THRESHOLD; i++) breaker.failure(task.machineId);
        note(task.id, "Il nodo non risponde più: non gli mando altre card finché la finestra non si chiude da sola."); // allow-italian: board comment
        return true;
      }
      case "bounce": {
        if (task.status !== "todo" || runOpen || task.stayLocal) return false;
        const pinned = svc.update({ taskId: task.id, actor: "agent", by: "topics-check", patch: { machineId: null, stayLocal: true, stayLocalUntil: new Date(now() + EMPTY_RUN_PIN_MS).toISOString() } });
        deps.emit(pinned);
        note(task.id, "La card rimbalzava fra i nodi: la tengo qui, «solo Mac», per 6 ore."); // allow-italian: board comment
        return true;
      }
      default:
        return false;
    }
  }

  /** One investigation card for this key, within the day's cap. */
  function investigate(p: Problem, inv: InvestigationSettings): CureOutcome {
    if (!inv.boardId) return "off";
    const day = new Date(now()).toISOString().slice(0, 10);
    const opened = (db.query("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND claude_task_id LIKE ? AND substr(created_at, 1, 10) = ?")
      .get(inv.boardId, `${INVESTIGATION_KEY}%`, day) as { n: number }).n;
    if (opened >= inv.perDay) {
      note(p.taskId, `Tetto di ${inv.perDay} indagini al giorno raggiunto: non apro un'altra card per questo problema.`); // allow-italian: board comment
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

  const today = () => new Date(now()).toISOString().slice(0, 10);

  return {
    /** One round over the last sample. A failure on one problem never stops the others. */
    run(sample: Sample, t: Thresholds, inv: InvestigationSettings): CureReport[] {
      const reports: CureReport[] = [];
      const seen = new Set<string>();
      const problems: { p: Problem; task: Task; runOpen: boolean }[] = [];
      for (const raw of problemsOf(sample, t)) {
        const state = read(raw.taskId);
        // A bounce is only a problem for a card that is still waiting in todo.
        if (!state || (raw.cause === "bounce" && state.task.status !== "todo")) continue;
        // A hung node is one problem for the node, however many cards sit on it.
        const key = raw.cause === "hung-node" && state.task.machineId ? `hung-node:${state.task.machineId}` : raw.key;
        if (seen.has(key)) continue;
        seen.add(key);
        problems.push({ p: { ...raw, key }, ...state });
      }
      for (const k of [...cured, ...escalated.keys()]) if (!seen.has(k)) { cured.delete(k); escalated.delete(k); }
      for (const { p, task, runOpen } of problems) {
        const held = escalated.get(p.key);
        if (held === null || held === today()) { reports.push({ key: p.key, outcome: "skipped" }); continue; }
        try {
          if (!cured.has(p.key) && cure(p, task, runOpen)) { cured.add(p.key); reports.push({ key: p.key, outcome: "cured" }); continue; }
          cured.delete(p.key);
          const outcome = investigate(p, inv);
          // A capped problem is asked again tomorrow; an opened one is never opened twice.
          if (outcome === "investigated") escalated.set(p.key, null);
          else if (outcome === "capped") escalated.set(p.key, today());
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
