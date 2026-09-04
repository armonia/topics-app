/**
 * Il goal di una chat: l'equivalente in conversazione di un task di board (3.4).
 *
 * Il problema che risolve. Sulla board l'obiettivo è un oggetto: sta lì, ha uno
 * stato, e nessuno se lo dimentica. In chat l'obiettivo si scrive nel primo
 * messaggio e poi scorre via — dopo una compattazione il modello non ce l'ha
 * più, ed è esattamente il momento in cui ricomincia a fare la cosa sbagliata
 * con grande sicurezza. Un goal è una riga di stato, non un messaggio: da qui
 * `assembleTopicContext` lo re-inietta a OGNI turno, compreso quello lean del
 * dispatcher.
 *
 * Le scelte non ovvie:
 *
 *  • **Un solo goal `active` per topic, imposto dal DB** (indice parziale unico
 *    in `064-topic-goals.sql`). `setGoal` chiude il precedente nella STESSA
 *    transazione che apre il nuovo: due goal attivi non sono uno stato
 *    degradato, sono due istruzioni che litigano dentro lo stesso prompt.
 *
 *  • **I passi si riscrivono in blocco.** Un `plan` di ACP manda l'elenco
 *    intero a ogni cambio di stato: fare la diff riga per riga sarebbe più
 *    codice per lo stesso risultato, e un elenco parzialmente aggiornato è
 *    peggio di uno sostituito. La sostituzione è una transazione, quindi
 *    nessun lettore vede mai mezzo piano.
 *
 *  • **Nessun goal implicito.** Non si deduce dal primo messaggio, non si
 *    inventa dal titolo della topic. Lo detta l'umano (`/goal`) o lo propone
 *    l'agente col suo piano — e in quel caso `createdBy: 'agent'` lo dice,
 *    così la UI non spaccia una deduzione per una decisione.
 */

import type { Database } from "bun:sqlite";
import { GOAL_STEP_STATUSES } from "../../shared/types";
// Solo i due tipi che qualcuno importa DA QUI: gli stati si prendono da
// `shared/types`, e ri-esportarli comodamente li farebbe esistere in due posti.
export type { TopicGoal, GoalStep } from "../../shared/types";
import type {
  TopicGoal, GoalStep, GoalStatus, GoalStepStatus, GoalLoopState,
} from "../../shared/types";
import { GOAL_LOOP_STATES } from "../../shared/types";

const STEP_STATUSES: readonly string[] = GOAL_STEP_STATUSES;

function normStepStatus(v: unknown): GoalStepStatus {
  return STEP_STATUSES.includes(v as string) ? (v as GoalStepStatus) : "pending";
}

function mapStep(r: Record<string, unknown>): GoalStep {
  return {
    id: String(r.id),
    goalId: String(r.goal_id),
    position: Number(r.position) || 0,
    content: String(r.content),
    status: normStepStatus(r.status),
    updatedAt: String(r.updated_at),
  };
}

function normLoopState(v: unknown): GoalLoopState {
  return (GOAL_LOOP_STATES as readonly string[]).includes(v as string)
    ? (v as GoalLoopState)
    : "running";
}

function mapGoal(r: Record<string, unknown>, steps: GoalStep[]): TopicGoal {
  return {
    id: String(r.id),
    topicId: String(r.topic_id),
    content: String(r.content),
    status: (r.status === "achieved" || r.status === "abandoned" ? r.status : "active") as GoalStatus,
    createdBy: r.created_by === "agent" ? "agent" : "human",
    createdAt: String(r.created_at),
    closedAt: r.closed_at != null ? String(r.closed_at) : null,
    steps,
    continuations: Number(r.continuations) || 0,
    idleTurns: Number(r.idle_turns) || 0,
    loopState: normLoopState(r.loop_state),
  };
}

function stepsFor(db: Database, goalIds: string[]): Map<string, GoalStep[]> {
  const out = new Map<string, GoalStep[]>();
  if (!goalIds.length) return out;
  const placeholders = goalIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM topic_goal_steps WHERE goal_id IN (${placeholders}) ORDER BY goal_id, position ASC`,
    )
    .all(...goalIds) as Record<string, unknown>[];
  for (const r of rows) {
    const step = mapStep(r);
    const list = out.get(step.goalId) ?? [];
    list.push(step);
    out.set(step.goalId, list);
  }
  return out;
}

/** Il goal che il topic sta perseguendo adesso, o null. */
export function getActiveGoal(db: Database, topicId: string): TopicGoal | null {
  const row = db
    .prepare(`SELECT * FROM topic_goals WHERE topic_id = ? AND status = 'active'`)
    .get(topicId) as Record<string, unknown> | null;
  if (!row) return null;
  return mapGoal(row, stepsFor(db, [String(row.id)]).get(String(row.id)) ?? []);
}

/** Lo storico completo del topic, dal più recente. */
export function listGoals(db: Database, topicId: string): TopicGoal[] {
  const rows = db
    .prepare(`SELECT * FROM topic_goals WHERE topic_id = ? ORDER BY created_at DESC, rowid DESC`)
    .all(topicId) as Record<string, unknown>[];
  const steps = stepsFor(db, rows.map((r) => String(r.id)));
  return rows.map((r) => mapGoal(r, steps.get(String(r.id)) ?? []));
}

export function getGoal(db: Database, goalId: string): TopicGoal | null {
  const row = db.prepare(`SELECT * FROM topic_goals WHERE id = ?`).get(goalId) as
    | Record<string, unknown>
    | null;
  if (!row) return null;
  return mapGoal(row, stepsFor(db, [goalId]).get(goalId) ?? []);
}

/**
 * Dichiara il goal del topic. Se ce n'era uno attivo viene ABBANDONATO nella
 * stessa transazione — non si accumulano obiettivi, se ne persegue uno.
 *
 * Un contenuto vuoto è un errore del chiamante, non un modo per cancellare:
 * per chiudere c'è `closeGoal`, che dice anche COME è finita.
 */
export function setGoal(
  db: Database,
  input: { topicId: string; content: string; createdBy?: "human" | "agent" },
): TopicGoal {
  const content = input.content.trim();
  if (!content) throw new Error("goal_content_required");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE topic_goals SET status = 'abandoned', closed_at = ?
        WHERE topic_id = ? AND status = 'active'`,
    ).run(now, input.topicId);
    db.prepare(
      `INSERT INTO topic_goals (id, topic_id, content, status, created_by, created_at, closed_at)
       VALUES (?, ?, ?, 'active', ?, ?, NULL)`,
    ).run(id, input.topicId, content, input.createdBy ?? "human", now);
  })();

  return getGoal(db, id)!;
}

/**
 * Chiude un goal. `achieved` o `abandoned`: la differenza è tutta lì, e serve
 * a chi rilegge lo storico ("cosa avevamo mollato?" è una domanda diversa da
 * "cosa avevamo finito?").
 *
 * Idempotente su un goal già chiuso: torna la riga com'è, senza sovrascrivere
 * il `closedAt` originale — una seconda chiusura non deve riscrivere la storia.
 */
export function closeGoal(
  db: Database,
  goalId: string,
  status: "achieved" | "abandoned",
): TopicGoal | null {
  const existing = getGoal(db, goalId);
  if (!existing) return null;
  if (existing.status !== "active") return existing;
  db.prepare(`UPDATE topic_goals SET status = ?, closed_at = ? WHERE id = ?`).run(
    status,
    new Date().toISOString(),
    goalId,
  );
  return getGoal(db, goalId);
}

/**
 * Writes the loop counters of a goal. It is the ONLY door onto those three
 * columns: the rule that computes them is pure and lives in `goal-loop.ts`, so
 * everything that decides is testable without a database and everything that
 * writes passes through one statement.
 *
 * A closed goal is not touched. Its loop is over by definition, and letting a
 * late end-of-turn verdict bump the counters of an abandoned goal would revive
 * a ceiling nobody is counting any more.
 */
export function setGoalLoop(
  db: Database,
  goalId: string,
  loop: { continuations?: number; idleTurns?: number; state?: GoalLoopState },
): TopicGoal | null {
  const existing = getGoal(db, goalId);
  if (!existing) return null;
  if (existing.status !== "active") return existing;
  db.prepare(
    `UPDATE topic_goals SET continuations = ?, idle_turns = ?, loop_state = ? WHERE id = ?`,
  ).run(
    loop.continuations ?? existing.continuations,
    loop.idleTurns ?? existing.idleTurns,
    normLoopState(loop.state ?? existing.loopState),
    goalId,
  );
  return getGoal(db, goalId);
}

/**
 * The person adopts a goal the agent proposed: `created_by` becomes `human`,
 * everything else stays. From then on `set_goal` refuses to replace it, which
 * is what adopting means here: the objective stops being a proposal.
 *
 * Idempotent, and a no-op on a goal that was already the person's.
 */
export function promoteGoal(db: Database, goalId: string): TopicGoal | null {
  const existing = getGoal(db, goalId);
  if (!existing) return null;
  if (existing.createdBy === "human") return existing;
  db.prepare(`UPDATE topic_goals SET created_by = 'human' WHERE id = ?`).run(goalId);
  return getGoal(db, goalId);
}

/** Riapre un goal chiuso, abbandonando quello attivo se c'è. */
export function reopenGoal(db: Database, goalId: string): TopicGoal | null {
  const existing = getGoal(db, goalId);
  if (!existing) return null;
  if (existing.status === "active") return existing;
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE topic_goals SET status = 'abandoned', closed_at = ?
        WHERE topic_id = ? AND status = 'active'`,
    ).run(now, existing.topicId);
    // Reopening restarts the loop from zero. The counters of the run that
    // closed this goal describe a finished chase; carrying them over would
    // hand the reopened goal a ceiling it had already spent.
    db.prepare(
      `UPDATE topic_goals
          SET status = 'active', closed_at = NULL,
              continuations = 0, idle_turns = 0, loop_state = 'running'
        WHERE id = ?`,
    ).run(goalId);
  })();
  return getGoal(db, goalId);
}

/**
 * Sostituisce l'elenco dei passi. In blocco e in transazione: un `plan` di ACP
 * riscrive l'elenco intero a ogni cambio di stato, e un elenco mezzo aggiornato
 * è peggio di uno sostituito.
 *
 * Le voci vuote si scartano — un agente che manda una riga bianca non deve
 * poter piantare una casella senza testo nella UI.
 */
export function replaceSteps(
  db: Database,
  goalId: string,
  steps: Array<{ content: string; status?: string }>,
): GoalStep[] {
  const clean = steps
    .map((s) => ({ content: String(s.content ?? "").trim(), status: normStepStatus(s.status) }))
    .filter((s) => s.content.length > 0);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`DELETE FROM topic_goal_steps WHERE goal_id = ?`).run(goalId);
    const insert = db.prepare(
      `INSERT INTO topic_goal_steps (id, goal_id, position, content, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    clean.forEach((s, i) => insert.run(crypto.randomUUID(), goalId, i, s.content, s.status, now));
  })();
  return (stepsFor(db, [goalId]).get(goalId) ?? []);
}

/**
 * Il testo che l'envelope inietta. Null quando non c'è un goal attivo: un
 * blocco «Obiettivo: (nessuno)» costerebbe token per dire niente.
 *
 * Formato deliberatamente scarno. È un promemoria, non un prompt di ruolo: più
 * parole ci si mette, più si spinge il modello a commentare l'obiettivo invece
 * di perseguirlo.
 */
export function goalContextContent(goal: TopicGoal | null): string | null {
  if (!goal || goal.status !== "active") return null;
  const lines = [`Obiettivo di questa conversazione: ${goal.content}`];
  if (goal.steps.length) {
    lines.push("", "Piano dichiarato:");
    for (const s of goal.steps) {
      const mark = s.status === "completed" ? "x" : s.status === "in_progress" ? "~" : " ";
      lines.push(`  [${mark}] ${s.content}`);
    }
  }
  lines.push(
    "",
    "Resta su questo obiettivo. Se l'utente lo cambia, dillo esplicitamente invece di seguirlo in silenzio.",
    "Tieni i passi aggiornati con update_goal_steps a ogni passo che finisci: è ciò che l'utente vede sopra la chat.",
  );
  return lines.join("\n");
}

/**
 * What the envelope says when there is NO active goal, and the reason this
 * block exists at all: without it a twenty-step job runs with an empty bar,
 * because nothing ever tells the model that declaring the objective is
 * something it can do. Codex has `update_plan` and calls it by itself; here
 * the tool existed and the instruction did not.
 *
 * One sentence: the tools carry their own schema, and a longer block would buy
 * commentary about the plan instead of a plan.
 */
export function goalToolsHintContent(): string {
  return "Per un lavoro a più passi dichiara l'obiettivo con set_goal e tieni i passi aggiornati con update_goal_steps: è ciò che l'utente vede sopra la chat.";
}
