/**
 * `emitReviewReadyEdge` is the anti-spam heart of the end-of-task
 * notification: it broadcasts the dedicated `task:review-ready` event ONLY on
 * the transition INTO review, so re-emitting `task:updated` for an
 * already-in-review task (a new comment, a preview bump) never re-notifies.
 * If this ever fired on every `task:updated` the user would get a banner storm.
  * @covers KANBAN-50
 */
import { describe, test, expect } from "bun:test";
import { emitReviewReadyEdge, pendingQuestion } from "./tasks";
import { buildNotifyActions } from "../../shared/notify-actions";

/** Il blocco canonico, composto come lo compone il servizio (addComment). */
function questionComment(text: string, options: string[]) {
  return { content: ["```question", text, ...options.map((o) => `- ${o}`), "```"].join("\n") };
}

function collector() {
  const events: any[] = [];
  return { events, broadcast: (m: object) => events.push(m) };
}

describe("emitReviewReadyEdge", () => {
  test("emits on the transition INTO review", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "proj1", { id: "t1", text: "Fix login", status: "review" }, "in_progress");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task:review-ready",
      projectId: "proj1",
      taskId: "t1",
      taskTitle: "Fix login",
    });
  });

  test("does NOT re-emit when the task was already in review", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "proj1", { id: "t1", text: "x", status: "review" }, "review");
    expect(events).toHaveLength(0);
  });

  test("does not emit for a non-review target status", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "p", { id: "t", text: "x", status: "in_progress" }, "todo");
    emitReviewReadyEdge(broadcast, "p", { id: "t", text: "x", status: "done" }, "review");
    expect(events).toHaveLength(0);
  });

  test("first-seen task going straight to review (unknown prev) still notifies", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "p", { id: "t", text: "x", status: "review" }, undefined);
    expect(events).toHaveLength(1);
  });

  test("falls back to 'Task' title and carries reason when given", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "p", { id: "t", text: "", status: "review" }, undefined, "system-delivered");
    expect(events[0].taskTitle).toBe("Task");
    expect(events[0].reason).toBe("system-delivered");
  });

  test("no-op on a null/undefined task", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "p", null, "in_progress");
    emitReviewReadyEdge(broadcast, "p", undefined, "in_progress");
    expect(events).toHaveLength(0);
  });

  test("la consegna che È una domanda porta la domanda nel fronte", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "p", { id: "t", text: "x", status: "review" }, "in_progress", undefined,
      () => [{ content: "prima nota" }, questionComment("Lando?", ["Landa su main", "Aspetta"])]);
    expect(events[0].question).toEqual({ text: "Lando?", options: ["Landa su main", "Aspetta"] });
    // …e quelle opzioni sono ESATTAMENTE i tasti che il banner disegnerà.
    expect(buildNotifyActions({ kind: "review-ready", question: { options: events[0].question.options } })
      .map((a) => a.title)).toEqual(["Landa su main", "Aspetta"]);
  });

  test("consegna normale → `question: null` ESPLICITO (e il banner offrirà «Approva»)", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "p", { id: "t", text: "x", status: "review" }, "in_progress", undefined,
      () => [{ content: "Fatto: ho sistemato il login." }]);
    // `null`, non assente: è ciò che distingue «ho guardato, domanda non ce n'è»
    // da «server che il campo non lo manda». Con il campo omesso, un client
    // nuovo su un server vecchio metterebbe «Approva» su un task che sta
    // aspettando una risposta.
    expect(events[0].question).toBeNull();
    expect("question" in events[0]).toBe(true);
    expect(buildNotifyActions({ kind: "review-ready", question: events[0].question }))
      .toEqual([{ id: "approve", title: "Approva" }]);
  });

  test("il campo c'è su OGNI fronte, anche senza thread da leggere", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "p", { id: "t", text: "x", status: "review" }, "in_progress");
    expect("question" in events[0]).toBe(true);
    expect(events[0].question).toBeNull();
  });

  test("il thread NON si legge se il fronte non scatta", () => {
    const { broadcast } = collector();
    let reads = 0;
    const resolve = () => { reads++; return [questionComment("Q?", ["a"])]; };
    emitReviewReadyEdge(broadcast, "p", { id: "t", text: "x", status: "review" }, "review", undefined, resolve);
    emitReviewReadyEdge(broadcast, "p", { id: "t", text: "x", status: "todo" }, "backlog", undefined, resolve);
    expect(reads).toBe(0);
  });

  test("una lettura del thread che esplode non si mangia il banner", () => {
    const { events, broadcast } = collector();
    emitReviewReadyEdge(broadcast, "p", { id: "t", text: "x", status: "review" }, "in_progress", undefined,
      () => { throw new Error("db chiuso"); });
    expect(events).toHaveLength(1);
    expect(events[0].question).toBeNull();
  });
});

describe("pendingQuestion", () => {
  test("conta l'ULTIMA parola dell'agente, non una domanda già superata", () => {
    expect(pendingQuestion([
      questionComment("Vecchia?", ["sì"]),
      { content: "Poi ho deciso da solo e ho consegnato." },
    ])).toBeNull();
  });

  test("le righe di transizione (kind 'status') non sono parole di nessuno", () => {
    // Il servizio scrive una riga di stato a OGNI transizione: senza questo
    // filtro la riga «in_progress → review», che arriva sempre per ultima,
    // seppellirebbe ogni domanda e i tasti non comparirebbero mai.
    expect(pendingQuestion([
      questionComment("Lando?", ["Landa su main"]),
      { content: "in_progress → review", kind: "status" },
    ])).toEqual({ text: "Lando?", options: ["Landa su main"] });
  });

  test("una domanda senza opzioni resta una domanda (nessun tasto, ma non è da approvare)", () => {
    const q = pendingQuestion([{ content: "```question\nChe faccio?\n```" }]);
    expect(q).toEqual({ text: "Che faccio?", options: [] });
    expect(buildNotifyActions({ kind: "review-ready", question: { options: q!.options } })).toEqual([]);
  });

  test("thread vuoto o assente → nessuna domanda", () => {
    expect(pendingQuestion([])).toBeNull();
    expect(pendingQuestion(null)).toBeNull();
    expect(pendingQuestion(undefined)).toBeNull();
  });
});
