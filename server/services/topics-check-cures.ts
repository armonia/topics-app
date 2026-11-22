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
  breaker?: Pick<typeof hangBreaker, "failure" | "isOpen">;
  now?: () => number;
}

/** One key per problem: two different problems never share a card. */
export function problemsOf(sample: Sample, t: Thresholds): Problem[] {
  const stuck = sample.stuck.filter((c) => c.cause !== "person").map((c): Problem => ({ key: `${c.cause}:${c.id}`, cause: c.cause, taskId: c.id }));
  const bounces = [...pingPongCards(sample.moves, t)].map((id): Problem => ({ key: `bounce:${id}`, cause: "bounce", taskId: id }));
  return [...stuck, ...bounces];
}

export function createCures(deps: CureDeps) {
  const { db, svc } = deps;
  const now = deps.now ?? Date.now;
  const breaker = deps.breaker ?? hangBreaker;
  /** Cured last round: still red this round means the cure did not work. */
  const cured = new Set<string>();
  /** Already escalated while the problem lasts, so a card is never opened twice for it. */
  const escalated = new Set<string>();

  const note = (taskId: string, content: string) => svc.addComment({ taskId, author: "system", kind: "service", content });

  /** The cure of one cause, or false when there is none (or it had nothing to do). */
  function cure(p: Problem): boolean {
    const task = svc.get(p.taskId)?.task;
    if (!task) return false;
    switch (p.cause) {
      case "offline":
      case "seats":
        return !!task.machineId && deps.reassign(task);
      case "hung-node": {
        if (!task.machineId || breaker.isOpen(task.machineId)) return false;
        for (let i = 0; i < WAKE_FAIL_THRESHOLD; i++) breaker.failure(task.machineId);
        note(task.id, "Il nodo non risponde più: non gli mando altre card finché la finestra non si chiude da sola."); // allow-italian: board comment
        return true;
      }
      case "bounce": {
        if (task.stayLocal) return false;
        svc.update({ taskId: task.id, actor: "agent", by: "topics-check", patch: { machineId: null, stayLocal: true, stayLocalUntil: new Date(now() + EMPTY_RUN_PIN_MS).toISOString() } });
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
      text: `Verifica: ${CAUSE_TEXT[p.cause === "bounce" ? "stay-local" : p.cause]}`, // allow-italian: board card title
      description: `Problema ${p.key}: la card ${p.taskId} resta rossa nella Verifica e la cura nota non c'è o non l'ha tolta.`, // allow-italian: board card body
    });
    note(p.taskId, `Indagine aperta: card ${card.id}.`); // allow-italian: board comment
    return "investigated";
  }

  return {
    /** One round over the last sample. A failure on one problem never stops the others. */
    run(sample: Sample, t: Thresholds, inv: InvestigationSettings): CureReport[] {
      const problems = problemsOf(sample, t);
      const live = new Set(problems.map((p) => p.key));
      for (const k of [...cured, ...escalated]) if (!live.has(k)) { cured.delete(k); escalated.delete(k); }
      return problems.map((p): CureReport => {
        if (escalated.has(p.key)) return { key: p.key, outcome: "skipped" };
        try {
          if (!cured.has(p.key) && cure(p)) { cured.add(p.key); return { key: p.key, outcome: "cured" }; }
          cured.delete(p.key);
          const outcome = investigate(p, inv);
          if (outcome !== "off") escalated.add(p.key);
          return { key: p.key, outcome };
        } catch (err) {
          console.warn("[topics-check] cure failed:", p.key, err instanceof Error ? err.message : err);
          return { key: p.key, outcome: "skipped" };
        }
      });
    },
  };
}
