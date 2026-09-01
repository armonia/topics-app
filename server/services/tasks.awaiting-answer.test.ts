/**
 * A CARD PARKED ON A QUESTION SAYS SO, AND KEEPS SAYING IT AFTER A RESTART.
 *
 * The live hold travels as the transient `task:awaiting-human` event. That event
 * is edge-triggered and stored nowhere, so a server restart, a page reload, or a
 * client connecting after the edge all leave the card showing whatever chip it
 * had - `queued` over a turn that is parked on a question nobody can see.
 *
 * Measured on 2026-09-01 on the real board: card `1c8fd103` sat 36 hours on an
 * unanswered mid-turn question showing only its `queued` chip, and every tick
 * skipped it in silence. The queue read as a broken dispatcher; it was a
 * question waiting for an answer.
 *
 * `awaitingAnswer` is therefore DERIVED from the thread on every read, never
 * persisted: an answer ends the wait by itself, and a column written in the DB
 * would stay lit over a turn that had already resumed. It is also deliberately
 * not `dispatch_state`: that chip takes the task out of ACTIVE_DISPATCH_STATES,
 * the orphan-recovery door, which is the defect this repo already paid for.
 *
 * @covers KANBAN-71
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { type TaskService } from "./tasks";
import { freshDb, svc, PID } from "./tasks-test-db";

/** The shape `addComment` composes when it is handed options. */
const ask = (s: TaskService, taskId: string) =>
  s.addComment({
    taskId, author: "claude", content: "Quale spazio a sinistra ti da' fastidio?",
    questionOptions: ["Il vuoto davanti al nome", "Il rientro per livello"],
  });

const readBack = (s: TaskService, taskId: string) =>
  s.list({ scope: "project", projectId: PID }).find((t) => t.id === taskId)!;

describe("awaitingAnswer: la domanda senza risposta arriva sulla card", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("un turno fermo su una domanda lo dice, in Todo come in corso", () => {
    for (const status of ["todo", "in_progress"] as const) {
      const t = s.create({ projectId: PID, text: `lavoro ${status}` });
      s.update({ taskId: t.id, actor: "human", by: "u", patch: { status } });
      expect(readBack(s, t.id).awaitingAnswer).toBe(false);
      ask(s, t.id);
      expect(readBack(s, t.id).awaitingAnswer).toBe(true);
    }
  });

  test("la risposta spegne l'attesa: l'ultima parola non e' piu' la domanda", () => {
    const t = s.create({ projectId: PID, text: "lavoro" });
    s.update({ taskId: t.id, actor: "human", by: "u", patch: { status: "in_progress" } });
    ask(s, t.id);
    expect(readBack(s, t.id).awaitingAnswer).toBe(true);
    s.addComment({ taskId: t.id, author: "user", content: "Il vuoto davanti al nome" });
    expect(readBack(s, t.id).awaitingAnswer).toBe(false);
  });

  test("una consegna non e' una domanda, e le note di macchina non coprono la domanda", () => {
    const delivered = s.create({ projectId: PID, text: "delivery" });
    s.update({ taskId: delivered.id, actor: "human", by: "u", patch: { status: "in_progress" } });
    s.addComment({ taskId: delivered.id, author: "claude", content: "fatto: sintesi di consegna" });
    expect(readBack(s, delivered.id).awaitingAnswer).toBe(false);

    // Service notes land AFTER the question on every round, and they are exactly
    // what used to bury the last real word: they must not end the wait.
    const asking = s.create({ projectId: PID, text: "asks" });
    s.update({ taskId: asking.id, actor: "human", by: "u", patch: { status: "in_progress" } });
    ask(s, asking.id);
    s.addComment({ taskId: asking.id, author: "system", kind: "service", content: "Nuovo worktree: topics/marigold-outpost" });
    expect(readBack(s, asking.id).awaitingAnswer).toBe(true);
  });
});
