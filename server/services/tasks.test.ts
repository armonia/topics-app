/**
 * The task service: create/list, the human delivery gate, the atomic claim and
 * board settings the dispatcher reads, and the nested-subtask rules.
 * @covers KANBAN-01, KANBAN-05, KANBAN-07, KANBAN-08, KANBAN-09
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { ARCHIVE_PARKED_LABEL, commentAsksHuman, createTaskService, isLandActionLabel, isPublishActionLabel, LAND_ACTION_LABEL, PUBLISH_ACTION_LABEL, projectIdForPath, REQUEUE_PARKED_LABEL, TaskServiceError, type TaskService } from "./tasks";
import { PARKED_WAITED_OUT, WAIT_SERIES_MAX_MS, WAIT_STREAK_CAP, parseQuestionBlock } from "../../shared/board";
import { freshDb, svc, PID } from "./tasks-test-db";

describe("reserved action labels", () => {
  test("isLandActionLabel matches its label tolerantly, and NOT the publish one", () => {
    expect(isLandActionLabel(LAND_ACTION_LABEL)).toBe(true);
    expect(isLandActionLabel("🚀 Landa su main")).toBe(true);
    expect(isLandActionLabel("  landa   su  main. ")).toBe(true);
    expect(isLandActionLabel(PUBLISH_ACTION_LABEL)).toBe(false); // distinct action
    expect(isLandActionLabel("Rifiuta")).toBe(false);
    expect(isLandActionLabel(undefined)).toBe(false);
  });
  test("isPublishActionLabel matches its label tolerantly, and NOT the land one", () => {
    expect(isPublishActionLabel(PUBLISH_ACTION_LABEL)).toBe(true);
    expect(isPublishActionLabel("🚀 Landa e pubblica")).toBe(true);
    expect(isPublishActionLabel(LAND_ACTION_LABEL)).toBe(false); // land only, no push
    expect(isPublishActionLabel("")).toBe(false);
  });
  // `isBoardActionLabel` and the option-level rule now live in shared/board.ts,
  // because the client needs the same verdict for the review banner's title;
  // they are pinned in shared/board.test.ts. What stays here is the TEXT-level
  // entry point, which owns one rule of its own: the unparseable fence.
});

/**
 * A DELIVERY THAT WEARS A QUESTION'S CLOTHES IS STILL A DELIVERY.
 *
 * The kickoff envelope orders a landable delivery to attach
 * `options=["Landa su main"]`, and `addComment` wraps any options in a
 * ```question fence. So every reader that asked "does this contain a question
 * block" answered yes on finished work. Measured on 13/08 against the live
 * board db: of the 437 agent comments carrying that fence, 331 are deliveries.
 */
describe("commentAsksHuman", () => {
  /** Same shape addComment composes, so the test reads what production writes. */
  const block = (question: string, ...options: string[]) =>
    ["```question", question, ...options.map((o) => `- ${o}`), "```"].join("\n");

  test("a delivery whose only option is a board action is NOT a question", () => {
    expect(commentAsksHuman(block("Fatto: sei cancelli verdi.", LAND_ACTION_LABEL))).toBe(false);
    // Tolerant on the label, like the predicates it delegates to.
    expect(commentAsksHuman(block("Fatto.", "🚀  landa su  main."))).toBe(false);
    // The two answers to the parked-subtask stall come out the same way: the
    // board runs both. That block is written by `author: 'system'`, and both
    // readers of this predicate look at the AGENT's last word only, so the
    // verdict never reaches a card. Pinned here so a future reader who wires
    // this predicate to a system-authored surface sees what it says first.
    expect(commentAsksHuman(block("Fermo su 2 sottotask.", REQUEUE_PARKED_LABEL, ARCHIVE_PARKED_LABEL))).toBe(false);
  });

  test("MIXED stays a question: one option the board cannot run needs a person", () => {
    expect(commentAsksHuman(block("Ho finito, ma il nome del flag non mi convince.", LAND_ACTION_LABEL, "Aspetta, ho un dubbio"))).toBe(true);
    expect(commentAsksHuman(block("Che approccio uso?", "JWT in cookie", "Bearer token"))).toBe(true);
    // A plan waiting for its verdict is the case this must never swallow.
    expect(commentAsksHuman(block("Ecco il piano.", "Approva il piano", "Da rivedere"))).toBe(true);
  });

  test("no options at all is still a question, and no block at all is not", () => {
    expect(commentAsksHuman(block("E adesso?"))).toBe(true);
    expect(commentAsksHuman("Fatto, guarda demo/. Niente da decidere.")).toBe(false);
    expect(commentAsksHuman("")).toBe(false);
    expect(commentAsksHuman(null)).toBe(false);
  });

  test("prose around the block does not change the verdict", () => {
    const testo = `Consegna: rifatto il gate.\n\n${block("Landa?", LAND_ACTION_LABEL)}`;
    expect(commentAsksHuman(testo)).toBe(false);
  });

  /**
   * AN UNREADABLE FENCE IS A QUESTION, and this is the regression that reading
   * the parsed options alone would have introduced.
   *
   * `parseQuestionBlock` returns null for a body that is all bullets and no
   * question line — a shape only a hand-written `comment_task` produces, since
   * `addComment` composes the canonical block whenever `options` is non-empty.
   * The rule this replaced was `content.includes("```question")`, so that shape
   * counted as a question and was exempt from the two review gates. Falling
   * through to "no block ⇒ delivery" would have given a legitimate mid-work
   * question a `delivered` chip and two 409s.
   */
  test("a question fence that does not parse stays a question", () => {
    const malformed = "```question\n- Sì\n- No\n```";
    expect(parseQuestionBlock(malformed)).toBeNull(); // the shape, pinned
    expect(commentAsksHuman(malformed)).toBe(true);
    // An empty fence is the same story: there IS a fence, we just cannot read it.
    expect(commentAsksHuman("Ho un dubbio.\n```question\n```")).toBe(true);
    // And a fence that is not a question fence must not be swept in.
    expect(commentAsksHuman("```ts\nconst x = 1;\n```")).toBe(false);
  });
});


describe("projectIdForPath", () => {
  test("basename + 6-char base36 hash, deterministic", () => {
    const a = projectIdForPath("/Users/utente/Projects/topics-app");
    const b = projectIdForPath("/Users/utente/Projects/topics-app");
    expect(a).toBe(b);
    expect(a.startsWith("topics-app-")).toBe(true);
    expect(a.slice("topics-app-".length)).toMatch(/^[0-9a-z]{1,6}$/);
  });
  // Regression lock: la funzione ora vive in shared/board.ts e questo modulo
  // la ri-esporta. Il test pinna che il re-export non sia un alias silenzioso
  // verso un'implementazione derivata.
  // (Il trailing slash cambia l'hash: topic.projectPath e' normalizzato, non morde.)
  test("exact output is stable (regression lock)", () => {
    expect(projectIdForPath("/x/proj")).toBe("proj-xwac8t");
  });
});

describe("create", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("senza status nasce in BACKLOG, con kanban_order incrementale", () => {
    const t1 = s.create({ projectId: PID, text: "one" });
    const t2 = s.create({ projectId: PID, text: "two" });
    // `todo` è la coda di esecuzione: nascerci fa partire un agente. Chi crea
    // senza dire dove sta annotando, non dando un via — quindi il default deve
    // essere la colonna che non esegue.
    expect(t1.status).toBe("backlog");
    expect(t1.kanbanOrder).toBe(1);
    expect(t2.kanbanOrder).toBe(2);
  });

  test("«vai» si scrive: status todo esplicito resta todo", () => {
    const t = s.create({ projectId: PID, text: "one", status: "todo" });
    expect(t.status).toBe("todo");
  });

  test("idempotencyKey returns the same task, no duplicate", () => {
    const a = s.create({ projectId: PID, text: "x", idempotencyKey: "K1" });
    const b = s.create({ projectId: PID, text: "x again", idempotencyKey: "K1" });
    expect(b.id).toBe(a.id);
    expect((db.prepare("SELECT COUNT(*) c FROM tasks").get() as any).c).toBe(1);
  });

  test("planFirst persists through create → get (default false)", () => {
    const t = s.create({ projectId: PID, text: "big thing", planFirst: true });
    expect(t.planFirst).toBe(true);
    expect(s.get(t.id)!.task.planFirst).toBe(true);
    expect(s.create({ projectId: PID, text: "normal" }).planFirst).toBe(false);
  });

  test("planFirst is togglable via update (settable after creation)", () => {
    const t = s.create({ projectId: PID, text: "fuzzy bug" });
    expect(t.planFirst).toBe(false);
    expect(s.update({ taskId: t.id, actor: "human", by: "u", patch: { planFirst: true } }).planFirst).toBe(true);
    expect(s.update({ taskId: t.id, actor: "human", by: "u", patch: { planFirst: false } }).planFirst).toBe(false);
  });

  test("rejects empty text and create-done", () => {
    expect(() => s.create({ projectId: PID, text: "  " })).toThrow(TaskServiceError);
    expect(() => s.create({ projectId: PID, text: "y", status: "done" })).toThrow(/done/);
  });
});

describe("list", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => {
    db = freshDb(); s = svc(db);
    s.create({ projectId: "p1", text: "a" });
    s.create({ projectId: "p1", text: "b" });
    s.create({ projectId: "p2", text: "c" });
  });

  test("scope=project filters by project", () => {
    expect(s.list({ scope: "project", projectId: "p1" }).length).toBe(2);
    expect(s.list({ scope: "project", projectId: "p2" }).length).toBe(1);
  });
  test("scope=all crosses projects", () => {
    const all = s.list({ scope: "all" });
    expect(all.length).toBe(3);
    expect(new Set(all.map(t => t.projectId))).toEqual(new Set(["p1", "p2"]));
  });
  test("scope=project without projectId throws", () => {
    expect(() => s.list({ scope: "project" })).toThrow(/projectId/);
  });

  test("rootsOnly hides subtasks from column feeds (they live in the parent's tree)", () => {
    const parent = s.create({ projectId: "p1", text: "epic" });
    s.create({ projectId: "p1", text: "step 1", parentTaskId: parent.id });
    s.create({ projectId: "p1", text: "step 2", parentTaskId: parent.id });
    // Default list still returns everything (agent surface, introspection).
    expect(s.list({ scope: "project", projectId: "p1" }).length).toBe(5);
    // Board feed: roots only, on both scopes.
    const roots = s.list({ scope: "project", projectId: "p1", rootsOnly: true });
    expect(roots.length).toBe(3);
    expect(roots.every((t) => t.parentTaskId === null)).toBe(true);
    expect(s.list({ scope: "all", rootsOnly: true }).every((t) => t.parentTaskId === null)).toBe(true);
    // The steps are still reachable through the parent.
    expect(s.get(parent.id)!.children.length).toBe(2);
  });
});

describe("review gate (KANBAN-05)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("agent cannot move to done", () => {
    const t = s.create({ projectId: PID, text: "work" });
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });

  test("agent → review opens a pending review approval", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto: sintesi di consegna" });
    const r = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    expect(r.status).toBe("review");
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.approval_type).toBe("review");
    expect(ap.status).toBe("pending");
    expect(ap.requested_by).toBe("claude");
  });

  test("mute delivery is rejected: a delivery is DECLARED, in the call that moves the card", () => {
    const t = s.create({ projectId: PID, text: "work" });
    // No summary → coached rejection, task stays put.
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }))
      .toThrow(/summary/);
    // Comments in the thread do NOT stand in for it — not a human's, not the
    // agent's own. That substitution is the reported defect: the agent's last
    // comment before delivering is the chronicle of its commits, and that is
    // what the review card opened with.
    s.addComment({ taskId: t.id, author: "user", content: "occhio ai test" });
    s.addComment({ taskId: t.id, author: "claude", content: "terzo commit: check:security chiuso alla fonte" });
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }))
      .toThrow(/summary/);
    // Declaring it unlocks the handoff — and the declared line lands in the
    // thread as `delivery`, ahead of the plumbing, because that is the row the
    // card shows.
    expect(s.update({
      taskId: t.id, actor: "agent", by: "claude",
      patch: { status: "review", summary: "fatto, guarda demo/" },
    }).status).toBe("review");
    const ultimo = s.get(t.id)!.comments.filter((c) => c.kind === "delivery");
    expect(ultimo.map((c) => c.content)).toEqual(["fatto, guarda demo/"]);
  });

  test("human re-drag to todo resets the retry budget (parked tasks stay re-dispatchable)", () => {
    const t = s.create({ projectId: PID, text: "work", status: "backlog" });
    db.prepare("UPDATE tasks SET dispatch_attempts = 3 WHERE id = ?").run(t.id);
    const back = s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "todo" } });
    expect(back.dispatchAttempts).toBe(0);
    // An AGENT moving to todo does NOT refresh its own retries.
    db.prepare("UPDATE tasks SET dispatch_attempts = 3, status = 'backlog' WHERE id = ?").run(t.id);
    const agentMove = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "todo" } });
    expect(agentMove.dispatchAttempts).toBe(3);
  });

  /**
   * IL BUDGET NON ERA L'UNICA COSA CHE TENEVA FERMA LA CARD.
   *
   * `dispatch_deferred_until` è la finestra d'attesa che l'agente dichiara, e il
   * CAS del claim la rifiuta finché non è passata: fino a 24 ore. Il bottone
   * «rimetti in Todo» azzerava i tentativi e lasciava lì la finestra — la card
   * tornava in una colonna dove nessuno la prendeva, con il chip del parcheggio
   * ancora sopra a raccontare la storia di prima.
   */
  test("rimettere in Todo azzera anche la finestra di rinvio e il chip, non solo i tentativi", () => {
    const t = s.create({ projectId: PID, text: "work", status: "backlog" });
    db.prepare(
      "UPDATE tasks SET dispatch_attempts = 3, dispatch_deferred_until = '2099-01-01T00:00:00.000Z', " +
        "dispatch_state = 'failed', dispatch_error = 'budget finito' WHERE id = ?",
    ).run(t.id);

    const back = s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "todo" } });

    expect(back.dispatchAttempts).toBe(0);
    expect(back.dispatchDeferredUntil).toBeNull();
    expect(back.dispatchState).toBeNull();
    expect(back.dispatchError).toBeNull();
    // La controprova sull'asse dei permessi: un AGENTE non si ridà niente.
    db.prepare(
      "UPDATE tasks SET status = 'backlog', dispatch_deferred_until = '2099-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(t.id);
    const agente = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "todo" } });
    expect(agente.dispatchDeferredUntil).toBe("2099-01-01T00:00:00.000Z");
  });

  test("human drag review → done clears the lingering dispatch chip", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "review" } });
    s.setDispatchState({ taskId: t.id, state: "delivered" });
    const done = s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "done" } });
    expect(done.status).toBe("done");
    expect(done.dispatchState).toBeNull();
  });

  test("status events (kind='status') do NOT satisfy the mute-delivery gate", () => {
    const t = s.create({ projectId: PID, text: "work", status: "todo" });
    // The agent moving the task writes a status event AUTHORED by the agent —
    // it's history, not a delivery summary.
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "in_progress" } });
    const evts = db.prepare("SELECT * FROM task_comments WHERE task_id = ? AND kind = 'status'").all(t.id) as any[];
    expect(evts.length).toBe(1);
    expect(evts[0].author).toBe("claude");
    expect(evts[0].content).toBe("todo→in_progress");
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }))
      .toThrow(/summary/);
  });

  test("una consegna vecchia non ne sblocca una nuova: il riassunto è di QUESTO turno per costruzione", () => {
    // The reported bug: a task steered by hand back into review handed itself
    // over mute, because an OLD comment satisfied the gate. Now the summary
    // rides in the very call that moves the card, and a delivery already in the
    // thread does not count as the delivery of this turn.
    const t = s.create({ projectId: PID, text: "work" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "in_progress" } });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review", summary: "turno 1: importato il CSV" } });
    // Turn 2: the card goes back to work, turn 1's delivery stays in the thread.
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "in_progress" } });
    expect(s.get(t.id)!.comments.some((c) => c.kind === "delivery")).toBe(true);
    // Mute re-delivery: refused all the same.
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }))
      .toThrow(/summary/);
    // Turn 2's delivery goes through, and is appended without erasing the first:
    // the thread stays the history, it is the card that prefers the latest.
    expect(s.update({
      taskId: t.id, actor: "agent", by: "claude",
      patch: { status: "review", summary: "turno 2: risolti i conflitti" },
    }).status).toBe("review");
    expect(s.get(t.id)!.comments.filter((c) => c.kind === "delivery").map((c) => c.content))
      .toEqual(["turno 1: importato il CSV", "turno 2: risolti i conflitti"]);
  });

  test("una transizione può portare la sua RAGIONE, e resta una transizione", () => {
    const t = s.create({ projectId: PID, text: "work", status: "todo" });
    s.update({
      taskId: t.id, actor: "human", by: "system", patch: { status: "in_progress" },
      statusReason: "il land ha fatto conflitto con main",
    });
    const ev = s.get(t.id)!.comments.filter((c) => c.kind === "status");
    expect(ev.length).toBe(1);
    expect(ev[0]!.author).toBe("system");
    expect(ev[0]!.content).toBe("todo→in_progress · il land ha fatto conflitto con main");
  });

  test("il confine del turno regge quando la transizione porta la sua RAGIONE", () => {
    // Il buco che una ragione appesa avrebbe aperto in silenzio: l'inizio del
    // turno si leggeva col suffisso (`…in_progress`), e `done→in_progress · …`
    // no longer ends with the status. Whoever reads that boundary — today the
    // claim check, which only looks at THIS turn's words — would have anchored
    // to the PREVIOUS turn, and thrown a claim from an already-closed turn back
    // at a clean delivery.
    const t = s.create({ projectId: PID, text: "work" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "in_progress" } });
    // Turn 1 carries a sha that does not exist: the line that must NOT come back.
    s.update({
      taskId: t.id, actor: "agent", by: "claude",
      patch: { status: "review", summary: "fatto (commit 0000000deadbee1)" },
    });
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "done" } });
    // All of turn 1 is OLD: what is left to tell the two readings of the
    // boundary apart is the shape of the status row that opens turn 2.
    db.prepare("UPDATE task_comments SET created_at = ? WHERE task_id = ?")
      .run("2020-01-01T00:00:00.000Z", t.id);
    // Il land va in conflitto: la card esce da `done` con la sua causa scritta.
    s.update({
      taskId: t.id, actor: "human", by: "system", patch: { status: "in_progress" },
      statusReason: "il land ha fatto conflitto con main",
    });
    s.update({
      taskId: t.id, actor: "agent", by: "claude",
      patch: { status: "review", summary: "conflitti risolti, guarda il ramo" },
    });
    const note = s.get(t.id)!.comments.filter((c) => c.kind === "review-note").map((c) => c.content).join("\n");
    expect(note).not.toContain("0000000deadbee1");
  });

  test("status history: update, claim and reviewDecision log who moved it and when", () => {
    const t = s.create({ projectId: PID, text: "work", status: "backlog" });
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "todo" } });
    const claimed = s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    expect(claimed).not.toBeNull();
    s.addComment({ taskId: t.id, author: "agent-x", content: "consegna" });
    s.update({ taskId: t.id, actor: "agent", by: "agent-x", patch: { status: "review", summary: "riassunto della consegna" } });
    s.reviewDecision({ taskId: t.id, by: "user", decision: "approve" });

    const events = (s.get(t.id)!.comments).filter((c) => c.kind === "status");
    expect(events.map((e) => [e.content, e.author])).toEqual([
      ["backlog→todo", "user"],
      ["todo→in_progress", "dispatcher"],
      ["in_progress→review", "agent-x"],
      ["review→done", "user"],
    ]);
    // Normal comments keep kind='comment'.
    const normal = (s.get(t.id)!.comments).find((c) => c.content === "consegna");
    expect(normal?.kind).toBe("comment");
  });

  test("human approve → done, approval approved, completed_at set", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    const done = s.reviewDecision({ taskId: t.id, by: "attilio", decision: "approve" });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("approved");
    expect(ap.reviewed_by).toBe("attilio");
  });

  // Uscire da review NON passa solo da `reviewDecision`: c'è il trascinamento
  // sulla board, c'è `update({status})` da MCP, c'è l'archiviazione. Prima del
  // fix la richiesta di approvazione restava 'pending' per sempre su tutte
  // quelle strade — misurate 13 righe appese su 48 nel DB reale, 9 su task già
  // 'done' — e nessuno l'avrebbe più chiusa, perché `reviewDecision` rifiuta un
  // task che non è più in review.
  test("review → done trascinato: l'approvazione si chiude come approved", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { status: "done" } });
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("approved");
    expect(ap.reviewed_at).not.toBeNull();
  });

  test("review → backlog: l'approvazione scade, NON viene respinta", () => {
    // 'expired' e non 'rejected': nessun umano ha detto no, la domanda ha solo
    // perso l'oggetto. Confonderle mentirebbe sulla storia del task.
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { status: "backlog" } });
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("expired");
  });

  test("un task che RESTA in review tiene la sua approvazione pendente", () => {
    // Il caso che non va toccato: 35 delle 48 righe misurate erano lavoro vero
    // in attesa di un umano.
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { text: "work rinominato" } });
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("pending");
  });

  /**
   * LE DUE STRADE CHE LASCIAVANO LA RICHIESTA APPESA.
   *
   * Il land chiude la card a SQL grezzo (`settleLanded`) e l'archiviazione la
   * toglie dalla board: nessuna delle due passava da `update`, quindi la riga
   * `pending` restava lì per sempre — il task non è più in review e
   * `reviewDecision` la rifiuterebbe. Misurate il 13/08: 13 appese su 48, 9 su
   * card già `done`. È la stessa perdita che la migration 068 aveva ripulito.
   */
  test("il LAND chiude l'approvazione pendente: approved, che è ciò che chiedeva", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });

    s.settleLanded({ taskId: t.id, by: "system", reason: "il land è riuscito" });

    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("approved");
    expect(ap.reviewed_at).not.toBeNull();
  });

  test("l'ARCHIVIAZIONE la fa scadere: expired, perché nessuno ha detto di no", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });

    s.archive({ taskId: t.id });

    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("expired");
  });

  test("human reject → in_progress + comment + approval rejected", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    const back = s.reviewDecision({ taskId: t.id, by: "attilio", decision: "reject", comment: "manca il test" });
    expect(back.status).toBe("in_progress");
    const got = s.get(t.id)!;
    expect(got.comments.some(c => c.content === "manca il test")).toBe(true);
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("rejected");
  });

  test("reject resets the attempt budget (new work cycle); approve keeps it", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    db.prepare("UPDATE tasks SET dispatch_attempts = 2 WHERE id = ?").run(t.id);
    const back = s.reviewDecision({ taskId: t.id, by: "attilio", decision: "reject" });
    expect(back.dispatchAttempts).toBe(0);

    const t2 = s.create({ projectId: PID, text: "work2" });
    s.addComment({ taskId: t2.id, author: "claude", content: "fatto" });
    s.update({ taskId: t2.id, actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    db.prepare("UPDATE tasks SET dispatch_attempts = 2 WHERE id = ?").run(t2.id);
    const done = s.reviewDecision({ taskId: t2.id, by: "attilio", decision: "approve" });
    expect(done.dispatchAttempts).toBe(2);
  });

  test("projectId guard blocks cross-project get/update/comment", () => {
    const t = s.create({ projectId: "p1", text: "x" });
    expect(s.get(t.id, { projectId: "p2" })).toBeNull();
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "c", projectId: "p2", patch: { status: "review", summary: "riassunto della consegna" } }))
      .toThrow(/not found/);
    expect(() => s.addComment({ taskId: t.id, author: "c", content: "hi", projectId: "p2" }))
      .toThrow(/not found/);
    expect(s.get(t.id, { projectId: "p1" })).not.toBeNull();
  });

  test("human can move directly to done", () => {
    const t = s.create({ projectId: PID, text: "work", status: "in_progress" });
    const done = s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { status: "done" } });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
  });
});

describe("own steps carve-out (KANBAN-08: the agent checks off its own checklist)", () => {
  let db: Database; let s: TaskService;
  // parent = the task dispatched to topic 'top-1'; steps nest under it.
  let parentId: string;
  beforeEach(() => {
    db = freshDb(); s = svc(db);
    db.run("INSERT INTO topics (id) VALUES ('top-1'), ('top-2')");
    const parent = s.create({ projectId: PID, text: "deliverable", status: "in_progress" });
    parentId = parent.id;
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1' WHERE id = ?").run(parentId);
  });

  test("agent marks its own direct step done (completed_at set)", () => {
    const step = s.create({ projectId: PID, text: "step 1", status: "backlog", parentTaskId: parentId });
    const done = s.update({ taskId: step.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
  });

  test("carve-out reaches any depth (step of a step)", () => {
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: parentId });
    const sub = s.create({ projectId: PID, text: "sub-step", status: "backlog", parentTaskId: step.id });
    const done = s.update({ taskId: sub.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } });
    expect(done.status).toBe("done");
  });

  test("STRICT: the agent still cannot close its own MAIN task", () => {
    expect(() => s.update({ taskId: parentId, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });

  test("a different agent's topic does not unlock the step", () => {
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: parentId });
    expect(() => s.update({ taskId: step.id, actor: "agent", by: "claude", agentTopicId: "top-2", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });

  test("an unrelated top-level task stays gated even with agentTopicId set", () => {
    const other = s.create({ projectId: PID, text: "unrelated" });
    expect(() => s.update({ taskId: other.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });

  test("open_subtasks still gates a step that has its own open children", () => {
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: parentId });
    s.create({ projectId: PID, text: "sub-step", status: "backlog", parentTaskId: step.id });
    expect(() => s.update({ taskId: step.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } }))
      .toThrow(/open subtasks/);
  });

  // L'INCIDENTE dell'11/08 (task f9d60212). Il legame che rendeva "miei" gli step
  // era `assigned_topic_id` del PADRE — cioè stato di dispatch, che vive quanto
  // il dispatch e non quanto il turno. `release()` lo azzera quando rimette in
  // coda o parcheggia, e il turno dell'agent NON muore con quella riga: da lì in
  // poi ogni `done` sulla propria checklist tornava 409, e la consegna arrivava
  // all'umano con gli step aperti (che un task con figli aperti non è nemmeno
  // approvabile). La provenienza — CHI ha scritto lo step — non cambia mai.
  test("il rimescolamento del dispatch non porta via all'agent la SUA checklist", () => {
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: parentId, createdByTopicId: "top-1" });
    s.release({ taskId: parentId, requeue: true, reason: "rimesso in coda dal dispatcher", by: "dispatcher" });
    const done = s.update({ taskId: step.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } });
    expect(done.status).toBe("done");
  });

  test("nemmeno un ri-dispatch a un ALTRO topic: gli step che ho scritto io restano miei", () => {
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: parentId, createdByTopicId: "top-1" });
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-2' WHERE id = ?").run(parentId);
    const done = s.update({ taskId: step.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } });
    expect(done.status).toBe("done");
  });

  test("STRICT anche sulla provenienza: un task SENZA padre creato da me resta dietro il gate", () => {
    const mine = s.create({ projectId: PID, text: "un task che ho creato io", createdByTopicId: "top-1" });
    expect(() => s.update({ taskId: mine.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });

  test("la provenienza di un ALTRO agent non apre nulla", () => {
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: parentId, createdByTopicId: "top-1" });
    db.prepare("UPDATE tasks SET assigned_topic_id = NULL WHERE id = ?").run(parentId);
    expect(() => s.update({ taskId: step.id, actor: "agent", by: "claude", agentTopicId: "top-2", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });
});

describe("boundRootOf (dispatch root of a subtree)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("finds the bound ancestor from any depth (and self)", () => {
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const root = s.create({ projectId: PID, text: "deliverable", status: "in_progress" });
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1' WHERE id = ?").run(root.id);
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: root.id });
    const sub = s.create({ projectId: PID, text: "sub-step", status: "backlog", parentTaskId: step.id });
    expect(s.boundRootOf(sub.id)?.id).toBe(root.id);
    expect(s.boundRootOf(step.id)?.id).toBe(root.id);
    expect(s.boundRootOf(root.id)?.id).toBe(root.id); // self counts
  });

  test("null when nothing in the chain is bound", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b", parentTaskId: a.id });
    expect(s.boundRootOf(b.id)).toBeNull();
  });
});

describe("taskForTopic / taskByIdPrefix (task-owned browser fork)", () => {
  let db: Database;
  // Hex uuids so `taskByIdPrefix` (guarded on hex id8) is testable end to end.
  const hexSvc = (d: Database): TaskService => {
    let n = 0;
    return createTaskService(d, {
      now: () => "2026-07-18T10:00:00.000Z",
      uuid: () => `125aafd${n++}-0e15-4aa0-ab25-f00000000000`,
    });
  };
  beforeEach(() => { db = freshDb(); });

  test("taskForTopic returns the bound task's id/project/text, null for an unbound topic", () => {
    const s = hexSvc(db);
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const t = s.create({ projectId: PID, text: "build the thing", status: "in_progress" });
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1' WHERE id = ?").run(t.id);
    expect(s.taskForTopic("top-1")).toEqual({ id: t.id, projectId: PID, text: "build the thing" });
    expect(s.taskForTopic("top-nope")).toBeNull();
    expect(s.taskForTopic("")).toBeNull();
  });

  test("taskForTopic prefers a non-archived, most-recent binding", () => {
    const s = hexSvc(db);
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const older = s.create({ projectId: PID, text: "older" });
    const newer = s.create({ projectId: PID, text: "newer" });
    db.prepare("UPDATE tasks SET assigned_topic_id='top-1', archived=1, updated_at='2026-07-18T09:00:00.000Z' WHERE id=?").run(older.id);
    db.prepare("UPDATE tasks SET assigned_topic_id='top-1', archived=0, updated_at='2026-07-18T11:00:00.000Z' WHERE id=?").run(newer.id);
    expect(s.taskForTopic("top-1")?.id).toBe(newer.id);
  });

  test("taskByIdPrefix resolves the `task-<id8>` hex prefix → { id, text }", () => {
    const s = hexSvc(db);
    const t = s.create({ projectId: PID, text: "hello world" });
    const id8 = t.id.slice(0, 8); // "125aafd0"
    expect(s.taskByIdPrefix(id8)).toEqual({ id: t.id, text: "hello world" });
    expect(s.taskByIdPrefix("125aafd0")).toEqual({ id: t.id, text: "hello world" });
  });

  test("taskByIdPrefix rejects non-hex / empty input and unknown prefixes", () => {
    const s = hexSvc(db);
    s.create({ projectId: PID, text: "x" });
    expect(s.taskByIdPrefix("")).toBeNull();
    expect(s.taskByIdPrefix("not-hex")).toBeNull(); // '-' and 'n/t' aren't hex
    expect(s.taskByIdPrefix("deadbeef")).toBeNull(); // valid hex, no match
  });
});

describe("moveToProject", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("moves the whole subtree; the root re-appends on the target board", () => {
    const root = s.create({ projectId: "pA", text: "root" });
    const step = s.create({ projectId: "pA", text: "step", status: "backlog", parentTaskId: root.id });
    const sub = s.create({ projectId: "pA", text: "sub", status: "backlog", parentTaskId: step.id });
    s.create({ projectId: "pB", text: "existing" }); // target board order 1
    const moved = s.moveToProject({ taskId: root.id, toProjectId: "pB" });
    expect(moved.projectId).toBe("pB");
    expect(moved.kanbanOrder).toBe(2);
    expect(s.get(step.id)!.task.projectId).toBe("pB");
    expect(s.get(sub.id)!.task.projectId).toBe("pB");
    expect(s.list({ scope: "project", projectId: "pA" }).length).toBe(0);
  });

  test("a subtask never moves alone (same-board parent invariant)", () => {
    const root = s.create({ projectId: "pA", text: "root" });
    const step = s.create({ projectId: "pA", text: "step", status: "backlog", parentTaskId: root.id });
    expect(() => s.moveToProject({ taskId: step.id, toProjectId: "pB" })).toThrow(/subtask/);
  });

  test("a task with a live agent stays put", () => {
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const t = s.create({ projectId: "pA", text: "x", status: "in_progress" });
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1' WHERE id = ?").run(t.id);
    expect(() => s.moveToProject({ taskId: t.id, toProjectId: "pB" })).toThrow(/live agent/);
  });

  test("a settled failed park does not travel to the target board", () => {
    const root = s.create({ projectId: "pA", text: "root" });
    const step = s.create({ projectId: "pA", text: "step", status: "backlog", parentTaskId: root.id });
    db.prepare("UPDATE tasks SET dispatch_state = 'failed', dispatch_error = 'boom on pA' WHERE id IN (?, ?)")
      .run(root.id, step.id);
    const moved = s.moveToProject({ taskId: root.id, toProjectId: "pB" });
    expect(moved.dispatchState).toBeNull();
    expect(moved.dispatchError).toBeNull();
    expect(s.get(step.id)!.task.dispatchState).toBeNull();
    expect(s.get(step.id)!.task.dispatchError).toBeNull();
  });

  test("same-board move is a no-op; projectId guard reports not_found", () => {
    const t = s.create({ projectId: "pA", text: "x" });
    expect(s.moveToProject({ taskId: t.id, toProjectId: "pA" }).projectId).toBe("pA");
    expect(() => s.moveToProject({ taskId: t.id, toProjectId: "pB", projectId: "pWRONG" })).toThrow(/not found/);
  });
});

describe("outputUrl (KANBAN-09 review panel)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("http(s) URL persists and comes back from get()", () => {
    const t = s.create({ projectId: PID, text: "x" });
    const up = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { outputUrl: "http://localhost:5173/preview" } });
    expect(up.outputUrl).toBe("http://localhost:5173/preview");
    expect(s.get(t.id)!.task.outputUrl).toBe("http://localhost:5173/preview");
  });

  test("non-http(s) schemes are rejected (iframe target: no LFI/XSS)", () => {
    const t = s.create({ projectId: PID, text: "x" });
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "ftp://x", "totally not a url"]) {
      expect(() => s.update({ taskId: t.id, actor: "human", by: "user", patch: { outputUrl: bad } }))
        .toThrow(/http\(s\)/);
    }
  });

  test("empty string (or null) clears it", () => {
    const t = s.create({ projectId: PID, text: "x" });
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { outputUrl: "https://example.com" } });
    const cleared = s.update({ taskId: t.id, actor: "human", by: "user", patch: { outputUrl: "" } });
    // Cleared and never-set are ONE state, and the payload now says it the
    // same way for both: the key rides only when there is a URL.
    expect(cleared.outputUrl).toBeUndefined();
  });
});

describe("archive", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("archived task drops off the list but the row is kept", () => {
    const t = s.create({ projectId: "p1", text: "x" });
    s.archive({ taskId: t.id, projectId: "p1" });
    expect(s.list({ scope: "project", projectId: "p1" }).length).toBe(0);
    expect(s.get(t.id)).not.toBeNull();
  });
  test("archive is projectId-guarded", () => {
    const t = s.create({ projectId: "p1", text: "x" });
    expect(() => s.archive({ taskId: t.id, projectId: "p2" })).toThrow(/not found/);
  });
});

describe("comments", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test("adds a comment with mentions round-trip", () => {
    const s = svc(db);
    const t = s.create({ projectId: PID, text: "work" });
    const c = s.addComment({ taskId: t.id, author: "claude", content: "fatto", mentions: ["attilio"] });
    expect(c.author).toBe("claude");
    expect(c.mentions).toEqual(["attilio"]);
    expect(s.get(t.id)!.comments.length).toBe(1);
  });

  test("dedupes identical author+content within the window", () => {
    const clock = { t: Date.parse("2026-07-09T10:00:00.000Z") };
    const s = svc(db, clock);
    const t = s.create({ projectId: PID, text: "work" });
    const a = s.addComment({ taskId: t.id, author: "claude", content: "same" });
    const b = s.addComment({ taskId: t.id, author: "claude", content: "same" });
    expect(b.id).toBe(a.id);
    expect(s.get(t.id)!.comments.length).toBe(1);
  });

  test("media round-trips (absolute paths only, capped at 8); attachment-only comments are legal", () => {
    const s = svc(db);
    const t = s.create({ projectId: PID, text: "x" });
    const c = s.addComment({
      taskId: t.id, author: "user", content: "guarda qui",
      media: ["/tmp/shot.png", "relative/nope.png", ...Array.from({ length: 10 }, (_, i) => `/tmp/f${i}.txt`)],
    });
    expect(c.media[0]).toBe("/tmp/shot.png");
    expect(c.media).not.toContain("relative/nope.png"); // non-absolute dropped
    expect(c.media.length).toBe(8); // capped
    expect(s.get(t.id)!.comments[0].media.length).toBe(8);
    // Attachment-only: no text → placeholder body, media kept.
    const only = s.addComment({ taskId: t.id, author: "user", content: "", media: ["/tmp/doc.pdf"] });
    expect(only.content).toBe("(allegato)");
    expect(only.media).toEqual(["/tmp/doc.pdf"]);
  });

  test("same content after the window is a new comment", () => {
    const clock = { t: Date.parse("2026-07-09T10:00:00.000Z") };
    const s = svc(db, clock);
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "same" });
    clock.t += 60_000; // past the 10s dedupe window
    const b = s.addComment({ taskId: t.id, author: "claude", content: "same" });
    expect(s.get(t.id)!.comments.length).toBe(2);
    expect(b).toBeTruthy();
  });
});

describe("nested tasks (subtask cascade)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("creates a subtask under a parent; get() lists children; list() fills counters", () => {
    const parent = s.create({ projectId: PID, text: "epic" });
    const kid = s.create({ projectId: PID, text: "part 1", parentTaskId: parent.id });
    expect(kid.parentTaskId).toBe(parent.id);
    const got = s.get(parent.id)!;
    expect(got.children.map((c) => c.id)).toEqual([kid.id]);
    expect(got.task.subtaskCount).toBe(1);
    expect(got.task.subtaskDoneCount).toBe(0);
    const listed = s.list({ scope: "project", projectId: PID }).find((t) => t.id === parent.id)!;
    expect(listed.subtaskCount).toBe(1);
  });

  test("unlimited depth: a subtask can have its own subtasks", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b", parentTaskId: a.id });
    const c = s.create({ projectId: PID, text: "c", parentTaskId: b.id });
    expect(s.get(b.id)!.children.map((x) => x.id)).toEqual([c.id]);
    expect(s.get(a.id)!.children.map((x) => x.id)).toEqual([b.id]);
  });

  test("parent must exist, be alive, and live on the SAME board", () => {
    expect(() => s.create({ projectId: PID, text: "x", parentTaskId: "ghost" })).toThrow(/not found/);
    const foreign = s.create({ projectId: "other-board", text: "y" });
    expect(() => s.create({ projectId: PID, text: "x", parentTaskId: foreign.id })).toThrow(/not found/);
    const dead = s.create({ projectId: PID, text: "z" });
    s.archive({ taskId: dead.id });
    expect(() => s.create({ projectId: PID, text: "x", parentTaskId: dead.id })).toThrow(/not found/);
  });

  test("a parent with open subtasks cannot go done — any actor, update or approve", () => {
    const parent = s.create({ projectId: PID, text: "epic" });
    const kid = s.create({ projectId: PID, text: "part", parentTaskId: parent.id });
    expect(() => s.update({ taskId: parent.id, actor: "human", by: "user", patch: { status: "done" } }))
      .toThrow(/open subtasks/);
    s.addComment({ taskId: parent.id, author: "claude", content: "fatto" });
    s.update({ taskId: parent.id, actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto della consegna" } });
    expect(() => s.reviewDecision({ taskId: parent.id, by: "user", decision: "approve" }))
      .toThrow(/open subtasks/);
    // Close the child → the parent can now complete.
    s.update({ taskId: kid.id, actor: "human", by: "user", patch: { status: "done" } });
    const done = s.reviewDecision({ taskId: parent.id, by: "user", decision: "approve" });
    expect(done.status).toBe("done");
  });

  test("archiving a parent archives the whole subtree (cascade, deep)", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b", parentTaskId: a.id });
    const c = s.create({ projectId: PID, text: "c", parentTaskId: b.id });
    s.archive({ taskId: a.id });
    const archived = (id: string) => (db.prepare("SELECT archived FROM tasks WHERE id = ?").get(id) as any).archived;
    expect(archived(a.id)).toBe(1);
    expect(archived(b.id)).toBe(1);
    expect(archived(c.id)).toBe(1);
  });

  test("archived subtasks don't count and unblock the parent", () => {
    const parent = s.create({ projectId: PID, text: "epic" });
    const kid = s.create({ projectId: PID, text: "part", parentTaskId: parent.id });
    s.archive({ taskId: kid.id });
    expect(s.get(parent.id)!.task.subtaskCount).toBe(0);
    const done = s.update({ taskId: parent.id, actor: "human", by: "user", patch: { status: "done" } });
    expect(done.status).toBe("done");
  });
});

describe("addComment — question block (server-composed)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("questionOptions compose the CANONICAL block: fences + newlines + '- ' options", () => {
    const t = s.create({ projectId: PID, text: "w" });
    const c = s.addComment({
      taskId: t.id, author: "agent-1",
      content: "Quale approccio uso?",
      questionOptions: ["JWT in cookie", "Bearer token"],
    });
    expect(c.content).toBe("```question\nQuale approccio uso?\n- JWT in cookie\n- Bearer token\n```");
  });

  test("newlines inside the question are flattened (the block stays parseable)", () => {
    const t = s.create({ projectId: PID, text: "w" });
    const c = s.addComment({
      taskId: t.id, author: "agent-1",
      content: "Domanda\nsu due righe?",
      questionOptions: ["sì"],
    });
    expect(c.content).toBe("```question\nDomanda su due righe?\n- sì\n```");
  });

  test("rejects fences inside a question (no nested blocks) and all-empty options", () => {
    const t = s.create({ projectId: PID, text: "w" });
    expect(() => s.addComment({ taskId: t.id, author: "a", content: "```question hack```", questionOptions: ["x"] }))
      .toThrow(TaskServiceError);
    expect(() => s.addComment({ taskId: t.id, author: "a", content: "ok?", questionOptions: ["  ", ""] }))
      .toThrow(TaskServiceError);
  });

  test("without questionOptions the content is stored verbatim", () => {
    const t = s.create({ projectId: PID, text: "w" });
    const c = s.addComment({ taskId: t.id, author: "a", content: "nota semplice" });
    expect(c.content).toBe("nota semplice");
  });
});

describe("claim (atomic dispatch)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  const todo = () => { const t = s.create({ projectId: PID, text: "w", status: "todo" }); return t; };

  test("claims a todo task: → in_progress + 'starting', attempts=1, NO topic binding yet", () => {
    const t = todo();
    const claimed = s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("in_progress");
    // The binding arrives via bindTopic() once the REAL topic exists —
    // assigned_topic_id has a FK to topics(id), placeholders would violate it.
    expect(claimed!.assignedTopicId).toBeNull();
    expect(claimed!.dispatchState).toBe("starting");
    expect(claimed!.dispatchAttempts).toBe(1);
  });

  test("bindTopic attaches the real topic to a claimed task (FK enforced)", () => {
    const t = todo();
    s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const bound = s.bindTopic({ taskId: t.id, topicId: "top-1" });
    expect(bound.assignedTopicId).toBe("top-1");
    // A topic id that does not exist must be rejected by the schema.
    expect(() => s.bindTopic({ taskId: t.id, topicId: "pending:" + t.id })).toThrow();
  });

  test("idempotent: a second claim on the same task returns null (no double dispatch)", () => {
    const t = todo();
    expect(s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 })).not.toBeNull();
    expect(s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 })).toBeNull();
    expect(s.get(t.id)!.task.dispatchAttempts).toBe(1); // not double-counted
  });

  test("concurrency cap: no free slot → null, task stays todo", () => {
    const a = todo(); const b = todo();
    expect(s.claim({ taskId: a.id, cap: 1, maxAttempts: 3 })).not.toBeNull();
    const bClaim = s.claim({ taskId: b.id, cap: 1, maxAttempts: 3 });
    expect(bClaim).toBeNull();
    expect(s.get(b.id)!.task.status).toBe("todo");
    expect(s.get(b.id)!.task.dispatchAttempts).toBe(0); // not consumed when capped out
  });

  test("retry cap: attempts >= maxAttempts → null", () => {
    const t = todo();
    // burn attempts via claim+release(requeue) cycles
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
    s.release({ taskId: t.id, requeue: true });
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
    s.release({ taskId: t.id, requeue: true });
    // attempts now 2 == cap → refuse
    expect(s.get(t.id)!.task.dispatchAttempts).toBe(2);
    expect(s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 })).toBeNull();
  });

  test("only claims 'todo' — a backlog task is not eligible", () => {
    const t = s.create({ projectId: PID, text: "w", status: "backlog" });
    expect(s.claim({ taskId: t.id, cap: 5, maxAttempts: 3 })).toBeNull();
  });
});

describe("release", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("requeue=true → todo, binding cleared, attempts preserved, note posted", () => {
    const t = s.create({ projectId: PID, text: "w", status: "todo" });
    s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    s.bindTopic({ taskId: t.id, topicId: "top-1" });
    const r = s.release({ taskId: t.id, requeue: true, reason: "worked in topic top-1", by: "system" });
    expect(r.status).toBe("todo");
    expect(r.assignedTopicId).toBeNull();
    expect(r.dispatchState).toBe("queued");
    expect(r.dispatchAttempts).toBe(1); // preserved so the retry cap still bites
    expect(s.get(t.id)!.comments.some((c) => c.content.includes("top-1"))).toBe(true);
  });

  test("requeue=false → parked in backlog with binding cleared", () => {
    const t = s.create({ projectId: PID, text: "w", status: "todo" });
    s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    const r = s.release({ taskId: t.id, requeue: false, reason: "gave up" });
    expect(r.status).toBe("backlog");
    expect(r.assignedTopicId).toBeNull();
    expect(r.dispatchState).toBeNull();
  });

  // IL GUASTO DEL 12/08, alla sua strozzatura. Quattro card che aspettavano una
  // decisione umana sono finite in backlog marcate `failed` perché il land aveva
  // potato il loro ramo e il GC aveva parcheggiato la card. In backlog nessuno le
  // dispaccia e nessuno le guarda: la decisione non era rimandata, era persa.
  test("card in review → il park scioglie il legame ma NON la fa scendere in backlog", () => {
    const t = s.create({ projectId: PID, text: "w", status: "todo" });
    s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    db.run("INSERT INTO topics (id) VALUES ('top-2')");
    s.bindTopic({ taskId: t.id, topicId: "top-2" });
    // Consegnata: lo stato si scrive a mano perché il cancello della review
    // (serve un commento di sintesi) qui non c'entra ed è collaudato altrove.
    db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(t.id);
    const attemptsPrima = s.get(t.id)!.task.dispatchAttempts;

    const r = s.release({
      taskId: t.id, requeue: false, parkState: "failed", by: "system",
      reason: "Worktree liberato: il branch del worktree non esiste più.",
    });

    expect(r.status).toBe("review");
    expect(r.assignedTopicId).toBeNull();   // il legame col worktree morto se ne va comunque
    expect(r.dispatchState).toBeNull();     // e nessun timbro `failed` addosso a chi non ha fallito
    expect(r.dispatchError).toBeNull();
    expect(r.dispatchAttempts).toBe(attemptsPrima); // il contatore non si muove
    // La ragione resta leggibile dove serve: nel thread, non come stato della card.
    expect(s.get(t.id)!.comments.some((c) => c.content.includes("non esiste più"))).toBe(true);
  });

  test("keepStatus → il park non sposta di colonna nemmeno un task attivo", () => {
    const t = s.create({ projectId: PID, text: "w", status: "todo" });
    s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    const r = s.release({ taskId: t.id, requeue: false, keepStatus: true, parkState: "failed", reason: "consegna già su main" });
    expect(r.status).toBe("in_progress");
    expect(r.assignedTopicId).toBeNull();
    expect(r.dispatchState).toBeNull();
  });
});

describe("board settings", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("defaults when no row exists (auto off, worktree on)", () => {
    const bs = s.getBoardSettings(PID);
    expect(bs.autoDispatch).toBe(false);
    expect(bs.dispatchEffort).toBe("medium");
    expect(bs.dispatchUseWorktree).toBe(true);
  });

  // Il tetto NON è per board: la board non ne espone uno, e il default di
  // un'installazione nuova è quello della riga '*' — auto, che è come la
  // macchina si protegge da sé finché nessuno sceglie un numero.
  test("il tetto di default è quello GLOBALE, non un campo della board", () => {
    expect(s.getGlobalCap()).toEqual({ auto: true, max: 3 });
  });

  test("upsert persists + clamps + reads back", () => {
    const bs = s.updateBoardSettings(PID, { autoDispatch: true, dispatchTimeoutMin: 999 });
    expect(bs.autoDispatch).toBe(true);
    expect(bs.dispatchTimeoutMin).toBe(120); // clamped 1..120
    expect(s.getBoardSettings(PID).autoDispatch).toBe(true);
  });

  // `dispatchIdleMin` is the stall detector's silence threshold (default 5,
  // migration `dispatch-idle-min`): it never cuts a turn by itself, but it is
  // still a per-board setting with the same read/write/clamp contract as
  // `dispatchTimeoutMin` — see shared/board.ts.
  test("dispatchIdleMin defaults to 5, persists, and clamps 1..60", () => {
    expect(s.getBoardSettings(PID).dispatchIdleMin).toBe(5);
    const bs = s.updateBoardSettings(PID, { dispatchIdleMin: 999 });
    expect(bs.dispatchIdleMin).toBe(60); // clamped 1..60
    expect(s.getBoardSettings(PID).dispatchIdleMin).toBe(60);
    expect(s.updateBoardSettings(PID, { dispatchIdleMin: 0 }).dispatchIdleMin).toBe(1);
  });

  // Il clamp del tetto viveva su un campo per board che non limitava niente:
  // qui misura la leva che comanda davvero (riga '*'), e il suo intervallo è
  // 1..20, non l'1..10 di quel campo morto.
  test("il tetto si clampa dove vive DAVVERO: riga '*', 1..20", () => {
    expect(s.setGlobalCap({ auto: false, max: 99 })).toEqual({ auto: false, max: 20 });
    expect(s.getGlobalCap()).toEqual({ auto: false, max: 20 });
  });

  test("rejects an invalid effort", () => {
    expect(() => s.updateBoardSettings(PID, { dispatchEffort: "turbo" })).toThrow(TaskServiceError);
  });

  test("il task espone lo sforzo con cui ha girato DAVVERO, letto dal topic", () => {
    // Con la board su `auto` lo sceglie il classificatore, e senza questo campo
    // la scelta non si vede da nessuna parte: ne' sulla card ne' nell'API, solo
    // nel log del server. E' la leva di costo piu' pesante che abbiamo.
    const t = s.create({ projectId: PID, text: "x" });
    db.run("INSERT INTO topics (id, effort) VALUES ('topic-1', 'xhigh')");
    db.run("UPDATE tasks SET assigned_topic_id = 'topic-1' WHERE id = ?", [t.id]);
    expect(s.get(t.id)!.task.effort).toBe("xhigh");
  });

  test("nessun topic assegnato → effort null, non un valore inventato", () => {
    const t = s.create({ projectId: PID, text: "y" });
    expect(s.get(t.id)!.task.effort).toBeNull();
  });

  test("accetta `auto` come effort di board (lo sceglie il classificatore)", () => {
    // Senza questo, accendere l'effort dinamico e' impossibile dall'API: `auto`
    // non e' un tier della scala e verrebbe rifiutato come "turbo".
    const bs = s.updateBoardSettings(PID, { dispatchEffort: "auto" });
    expect(bs.dispatchEffort).toBe("auto");
    expect(s.getBoardSettings(PID).dispatchEffort).toBe("auto");
  });

  // Accendere l'interruttore MATERIALIZZA la riga '*', che è dove sta il tetto
  // vero: se nascesse sul default 5 della colonna legacy, un semplice ON
  // alzerebbe il tetto della macchina senza che nessuno lo abbia chiesto.
  test("enabling auto-dispatch alone keeps the GLOBAL cap at 2 (not the legacy column default 5)", () => {
    s.updateBoardSettings(PID, { autoDispatch: true });
    expect(s.getGlobalCap()).toEqual({ auto: true, max: 2 });
  });

  // The OTHER way the reserved row gets created: `INSERT OR IGNORE ... VALUES
  // (?, 2)`, which runs for any patch at all, not just the auto-dispatch one.
  // It carries the same explicit 2 and had lost its only guard — the test that
  // pinned it was rewritten onto the upsert above, so mutating this literal to 5
  // went unnoticed by the whole suite. Two seeds, two guards.
  test("ANY patch on the reserved row seeds the cap at 2, never the column default", () => {
    s.updateBoardSettings("*", { dispatchEffort: "high" });
    expect(s.getGlobalCap()).toEqual({ auto: true, max: 2 });
  });

  test("auto-dispatch is GLOBAL: flipping it from one board flips every board", () => {
    expect(s.getGlobalAutoDispatch()).toBe(false);
    s.updateBoardSettings(PID, { autoDispatch: true });
    expect(s.getGlobalAutoDispatch()).toBe(true);
    // A completely different board reads the same switch…
    expect(s.getBoardSettings("other-board-zzz999").autoDispatch).toBe(true);
    // …and the dedicated setter flips it back for everyone.
    expect(s.setGlobalAutoDispatch(false)).toBe(false);
    expect(s.getBoardSettings(PID).autoDispatch).toBe(false);
  });

  test("global switch does not leak per-board config across boards", () => {
    s.updateBoardSettings(PID, { autoDispatch: true, dispatchTimeoutMin: 45, dispatchEffort: "max" });
    const other = s.getBoardSettings("other-board-zzz999");
    expect(other.autoDispatch).toBe(true); // global
    expect(other.dispatchTimeoutMin).toBe(20); // per-board default, untouched
    expect(other.dispatchEffort).toBe("medium");
  });

  // Il gate pre-review è OPT-IN: nessuna board esistente cambia comportamento
  // finché qualcuno non dichiara cosa vuol far girare.
  test("checks pre-review: nessun comando di default", () => {
    expect(s.getBoardSettings(PID).reviewChecks).toEqual([]);
  });

  test("checks pre-review: round-trip e normalizzazione a forma lunga", () => {
    const bs = s.updateBoardSettings(PID, { reviewChecks: [{ name: "", cmd: "bun run typecheck" }] });
    expect(bs.reviewChecks).toEqual([{ name: "bun run typecheck", cmd: "bun run typecheck" }]);
    expect(s.getBoardSettings(PID).reviewChecks).toHaveLength(1);
  });

  test("checks pre-review: lista vuota SPEGNE il gate", () => {
    s.updateBoardSettings(PID, { reviewChecks: [{ name: "t", cmd: "true" }] });
    expect(s.updateBoardSettings(PID, { reviewChecks: [] }).reviewChecks).toEqual([]);
    // NULL in colonna, non "[]": "spento" è uno stato solo.
    const raw = db.prepare("SELECT review_checks FROM board_settings WHERE project_id = ?").get(PID) as any;
    expect(raw.review_checks).toBeNull();
  });

  test("checks pre-review: i comandi NON si propagano alle altre board", () => {
    s.updateBoardSettings(PID, { reviewChecks: [{ name: "t", cmd: "true" }] });
    expect(s.getBoardSettings("other-board-zzz999").reviewChecks).toEqual([]);
  });

  test("reviewDecision clears the dispatch chip on approve", () => {
    const t = s.create({ projectId: PID, text: "x" });
    // Drive it to review with a dispatch chip set, then approve.
    s.update({ taskId: t.id, actor: "human", by: "u", patch: { status: "review" } });
    s.setDispatchState({ taskId: t.id, state: "needs_input" });
    const done = s.reviewDecision({ taskId: t.id, by: "u", decision: "approve" });
    expect(done.status).toBe("done");
    expect(done.dispatchState).toBeNull();
  });
});



describe("blocked-by dependency", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("claim refuses a todo whose blocker is still open; unblocks at done", () => {
    const a = s.create({ projectId: PID, text: "blocker", status: "todo" });
    const b = s.create({ projectId: PID, text: "dependent", blockedByTaskId: a.id, status: "todo" });
    expect(b.blockedByTaskId).toBe(a.id);
    expect(s.isDispatchBlocked(b.id)).toBe(true);
    expect(s.claim({ taskId: b.id, cap: 5, maxAttempts: 3 })).toBeNull();
    // Blocker completes → same claim now succeeds.
    s.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "done" } });
    expect(s.isDispatchBlocked(b.id)).toBe(false);
    expect(s.claim({ taskId: b.id, cap: 5, maxAttempts: 3 })).not.toBeNull();
  });

  test("an archived blocker does not block", () => {
    const a = s.create({ projectId: PID, text: "blocker" });
    const b = s.create({ projectId: PID, text: "dependent", blockedByTaskId: a.id });
    s.archive({ taskId: a.id });
    expect(s.isDispatchBlocked(b.id)).toBe(false);
  });

  test("il bloccante arriva RISOLTO nel payload, anche quando NON è nella lista della board", () => {
    // Un sottotask come bloccante: la board fetcha `rootsOnly`, quindi il client
    // non ce l'ha mai in mano — ed è esattamente il caso in cui il chip spariva.
    const parent = s.create({ projectId: PID, text: "epica" });
    const step = s.create({ projectId: PID, text: "lo step che blocca", parentTaskId: parent.id });
    const dep = s.create({ projectId: PID, text: "dipendente", blockedByTaskId: step.id, status: "todo" });
    expect(dep.blockedBy).toEqual({ id: step.id, text: "lo step che blocca", status: "backlog", archived: false });

    const roots = s.list({ scope: "project", projectId: PID, rootsOnly: true });
    expect(roots.map((t) => t.id)).not.toContain(step.id); // fuori dalla lista…
    expect(roots.find((t) => t.id === dep.id)?.blockedBy?.text).toBe("lo step che blocca"); // …ma risolto lo stesso

    // Anche in lettura singola e — cosa che conta per il WS — in SCRITTURA:
    // ogni `task:updated` porta il bloccante risolto, non solo i fetch pieni.
    expect(s.get(dep.id)?.task.blockedBy?.text).toBe("lo step che blocca");
    const touched = s.update({ taskId: dep.id, actor: "human", by: "u", patch: { priority: 3 } });
    expect(touched.blockedBy?.text).toBe("lo step che blocca");
  });

  test("il contatore «N in attesa» lo risolve il server: conta anche i dipendenti fuori dalla lista", () => {
    // L'altra metà del legame. Il client contava i dipendenti fra i task
    // fetchati — un progetto, `rootsOnly`, non archiviati: un dipendente che è
    // un sottotask, o che sta in un altro progetto, non veniva contato e la
    // card del bloccante si presentava libera.
    const bloccante = s.create({ projectId: PID, text: "bloccante", status: "todo" });
    const epica = s.create({ projectId: PID, text: "epica" });
    const sottotask = s.create({ projectId: PID, text: "step", parentTaskId: epica.id, blockedByTaskId: bloccante.id });
    const otherProject = s.create({ projectId: "altro-progetto-x", text: "fuori progetto", blockedByTaskId: bloccante.id });
    const inList = s.create({ projectId: PID, text: "dipendente in lista", blockedByTaskId: bloccante.id, status: "todo" });

    const roots = s.list({ scope: "project", projectId: PID, rootsOnly: true });
    const card = roots.find((t) => t.id === bloccante.id);
    expect(roots.map((t) => t.id)).not.toContain(sottotask.id);   // fuori dalla lista…
    expect(roots.map((t) => t.id)).not.toContain(otherProject.id); // …e anche questo…
    expect(card?.waitingOnCount).toBe(3);                          // …ma contati lo stesso

    // In lettura singola e — cosa che conta per il WS — in SCRITTURA: ogni
    // `task:updated` porta il contatore, non solo i fetch pieni.
    expect(s.get(bloccante.id)?.task.waitingOnCount).toBe(3);
    expect(s.update({ taskId: bloccante.id, actor: "human", by: "u", patch: { priority: 3 } }).waitingOnCount).toBe(3);

    // Vivi = non done e non archiviati: gli stessi che il gate di dispatch tiene
    // fermi e che ripartono quando il bloccante chiude.
    s.update({ taskId: inList.id, actor: "human", by: "u", patch: { status: "done" } });
    expect(s.get(bloccante.id)?.task.waitingOnCount).toBe(2);
    s.archive({ taskId: otherProject.id });
    expect(s.get(bloccante.id)?.task.waitingOnCount).toBe(1);
    // Sciolto il legame, il contatore va a zero (e chi non blocca nessuno sta a 0).
    s.update({ taskId: sottotask.id, actor: "human", by: "u", patch: { blockedByTaskId: null } });
    expect(s.get(bloccante.id)?.task.waitingOnCount).toBe(0);
    expect(s.get(epica.id)?.task.waitingOnCount).toBe(0);
  });

  test("done e archiviato viaggiano nel payload: sono i due bit che spengono il chip", () => {
    const a = s.create({ projectId: PID, text: "bloccante" });
    const b = s.create({ projectId: PID, text: "dipendente", blockedByTaskId: a.id });
    s.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "done" } });
    expect(s.get(b.id)?.task.blockedBy).toMatchObject({ status: "done", archived: false });
    // Archiviato: la riga esce dalla board ma il link resta, e il payload lo dice
    // (un `null` muto non distinguerebbe "non blocca più" da "non lo trovo").
    s.archive({ taskId: a.id });
    expect(s.get(b.id)?.task.blockedBy).toMatchObject({ id: a.id, archived: true });
  });

  test("self-block and cycles are rejected; clearing works", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b" });
    s.update({ taskId: b.id, actor: "human", by: "u", patch: { blockedByTaskId: a.id } });
    expect(() => s.update({ taskId: a.id, actor: "human", by: "u", patch: { blockedByTaskId: a.id } })).toThrow();
    // a ← b already; blocking a on b would close the loop.
    expect(() => s.update({ taskId: a.id, actor: "human", by: "u", patch: { blockedByTaskId: b.id } })).toThrow();
    const cleared = s.update({ taskId: b.id, actor: "human", by: "u", patch: { blockedByTaskId: null } });
    expect(cleared.blockedByTaskId).toBeNull();
  });

  test("listBlockedBy returns the alive dependents", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b", blockedByTaskId: a.id });
    const c = s.create({ projectId: PID, text: "c", blockedByTaskId: a.id });
    s.archive({ taskId: c.id });
    const deps = s.listBlockedBy(a.id).map((t) => t.id);
    expect(deps).toEqual([b.id]);
  });

  test("model and reuseBlockerContext persist through create/update", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b", blockedByTaskId: a.id, reuseBlockerContext: true, model: "claude-fable-5" });
    expect(b.model).toBe("claude-fable-5");
    expect(b.reuseBlockerContext).toBe(true);
    const upd = s.update({ taskId: b.id, actor: "human", by: "u", patch: { model: null, reuseBlockerContext: false } });
    expect(upd.model).toBeNull();
    expect(upd.reuseBlockerContext).toBe(false);
  });
});

describe("priorità automatica", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("auto finché nessuno la sceglie; un write esplicito la fissa", () => {
    const t = s.create({ projectId: PID, text: "x" });
    expect(t.priorityAuto).toBe(true);
    const chosen = s.create({ projectId: PID, text: "y", priority: 4 });
    expect(chosen.priorityAuto).toBe(false);
    const upd = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { priority: 3 } });
    expect(upd.priority).toBe(3);
    expect(upd.priorityAuto).toBe(false);
  });
});


// ── Il park deve essere autoritativo ───────────────────────────────────────
//
// `release()` toglie il task all'agente (azzera `assigned_topic_id`), ma il suo
// TURNO non muore con quella riga: continua a girare. La sua `update_task`
// passava senza che nessuno controllasse se quel task gli appartenesse ancora.
// Misurato: parcheggiato alle 22:48, tornato `in_progress` 79 secondi dopo, e
// rimasto lì SETTE GIORNI — nessun reaper lo guardava, perché per il DB stava
// lavorando, e falsava anche la capacità di dispatch.
describe("il park è autoritativo: l'agente scartato non si riprende il task", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => {
    db = freshDb(); s = svc(db);
    db.run("INSERT INTO topics (id) VALUES ('top-1'), ('top-2')");
  });

  function dispatched(): string {
    const t = s.create({ projectId: PID, text: "lavoro", status: "in_progress" });
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1' WHERE id = ?").run(t.id);
    return t.id;
  }

  test("dopo il PARK l'agente non può riportarlo in_progress", () => {
    const id = dispatched();
    s.release({ taskId: id, requeue: false, parkState: "failed", reason: "tentativi esauriti" });
    expect(s.get(id)!.task.status).toBe("backlog");

    expect(() => s.update({
      taskId: id, actor: "agent", by: "claude", agentTopicId: "top-1",
      patch: { status: "in_progress" },
    })).toThrow(/non è più assegnato a te/);

    // E lo stato NON si è mosso: è la parte che contava.
    expect(s.get(id)!.task.status).toBe("backlog");
  });

  test("dopo un REQUEUE vale lo stesso (il task è tornato in coda, non è più tuo)", () => {
    const id = dispatched();
    s.release({ taskId: id, requeue: true, reason: "rimesso in coda" });
    expect(s.get(id)!.task.status).toBe("todo");
    expect(() => s.update({
      taskId: id, actor: "agent", by: "claude", agentTopicId: "top-1",
      patch: { status: "in_progress" },
    })).toThrow(/non è più assegnato a te/);
  });

  test("un task MAI dispacciato resta lavorabile: la guardia non deve allargarsi", () => {
    // Nessun legame e nessuna firma di rilascio: qui nessuno ha tolto niente a
    // nessuno, e bloccare sarebbe impedire lavoro legittimo.
    const t = s.create({ projectId: PID, text: "mai dispacciato", status: "todo" });
    const out = s.update({
      taskId: t.id, actor: "agent", by: "claude", agentTopicId: "top-1",
      patch: { status: "in_progress" },
    });
    expect(out.status).toBe("in_progress");
  });

  test("il task di un ALTRO agente resta intoccabile", () => {
    const id = dispatched(); // legato a top-1
    expect(() => s.update({
      taskId: id, actor: "agent", by: "claude", agentTopicId: "top-2",
      patch: { status: "review" },
    })).toThrow(/non è più assegnato a te/);
  });

  test("l'agente legittimo continua a lavorare normalmente", () => {
    const id = dispatched();
    const out = s.update({
      taskId: id, actor: "agent", by: "claude", agentTopicId: "top-1",
      patch: { status: "review", summary: "fatto: sintesi" },
    });
    expect(out.status).toBe("review");
  });

  test("un UMANO può sempre rimetterci le mani dopo un park", () => {
    // La guardia è sull'agente: il park non deve incastrare anche te.
    const id = dispatched();
    s.release({ taskId: id, requeue: false, parkState: "failed" });
    const out = s.update({ taskId: id, actor: "human", by: "user", patch: { status: "todo" } });
    expect(out.status).toBe("todo");
  });
});



/**
 * Il segnale «chi lavora questo sottotask» esce da `rowToTask`, cioè da OGNI
 * payload di task — non solo da `list`/`get`. Qui si pinna la risalita vera sul
 * DB: la CTE, la guardia che la tiene spenta sul caso normale, e i due modi in
 * cui la catena può essere storta (padre sparito, ciclo).
 */
describe("subtaskWork: chi lavora un sottotask senza agente suo", () => {
  let db: Database;
  let s: TaskService;
  // `get` torna la busta {task, comments, children}: qui interessa solo il task.
  const work = (id: string) => s.get(id)!.task.subtaskWork;
  beforeEach(() => {
    db = freshDb();
    db.run("INSERT INTO topics (id) VALUES ('t-parent')");
    s = svc(db);
  });

  // Un padre col suo agente dentro un turno: topic + chip + in_progress.
  function workingParent(text = "il padre") {
    const p = s.create({ projectId: PID, text, status: "backlog" });
    db.run(
      "UPDATE tasks SET status='in_progress', assigned_topic_id='t-parent', dispatch_state='working' WHERE id = ?",
      [p.id],
    );
    return p;
  }
  // Uno step della checklist come lo crea l'agente: figlio, mai dispacciato.
  function step(parentId: string, text = "lo step") {
    const c = s.create({ projectId: PID, text, status: "backlog", parentTaskId: parentId });
    db.run("UPDATE tasks SET status='in_progress' WHERE id = ?", [c.id]);
    return c;
  }

  test("(a) lo step lo lavora il padre nel suo turno: il payload dice chi", () => {
    const p = workingParent();
    const c = step(p.id);
    expect(work(c.id)).toEqual({
      kind: "parent-turn", ancestor: { id: p.id, text: "il padre" },
    });
  });

  test("(b) il padre è tornato indietro senza topic: nessuno lo lavora", () => {
    const p = workingParent();
    const c = step(p.id);
    // Il caso misurato sul DB vivo: il padre torna in backlog e molla il topic.
    db.run("UPDATE tasks SET status='backlog', assigned_topic_id=NULL, dispatch_state=NULL WHERE id = ?", [p.id]);
    expect(work(c.id)).toEqual({ kind: "unattended" });
  });

  test("un padre archiviato non lavora niente", () => {
    const p = workingParent();
    const c = step(p.id);
    db.run("UPDATE tasks SET archived=1 WHERE id = ?", [p.id]);
    expect(work(c.id)).toEqual({ kind: "unattended" });
  });

  test("risale oltre il padre diretto: vince il primo antenato AL LAVORO", () => {
    const nonno = workingParent("il nonno");
    const padre = step(nonno.id, "lo step di mezzo");
    const nipote = step(padre.id, "il sotto-step");
    // Il padre diretto è a sua volta un sottotask senza agente: chi tiene il
    // turno è il nonno, ed è lui che va nominato.
    expect(work(nipote.id)).toEqual({
      kind: "parent-turn", ancestor: { id: nonno.id, text: "il nonno" },
    });
  });

  test("la domanda non si pone: con un topic suo, con un chip suo, o da fermo", () => {
    const p = workingParent();
    const own = step(p.id, "step con agente suo");
    db.run("UPDATE tasks SET assigned_topic_id='t-parent', dispatch_state='working' WHERE id = ?", [own.id]);
    // Ha già il deep-link e lo stato sulla card: `null` = niente da dire, che
    // NON è «non lo lavora nessuno».
    expect(work(own.id)).toBeNull();

    const parked = step(p.id, "step fermo");
    db.run("UPDATE tasks SET status='todo' WHERE id = ?", [parked.id]);
    expect(work(parked.id)).toBeNull();

    // Un task radice in corso senza chip non è questa storia.
    const root = s.create({ projectId: PID, text: "radice", status: "backlog" });
    db.run("UPDATE tasks SET status='in_progress' WHERE id = ?", [root.id]);
    expect(work(root.id)).toBeNull();
  });

  test("il chip del padre vale solo se è ATTIVO: consegnato o in attesa non lavora", () => {
    const p = workingParent();
    const c = step(p.id);
    for (const dead of ["delivered", "needs_input", "waiting", "failed"]) {
      db.run("UPDATE tasks SET dispatch_state = ? WHERE id = ?", [dead, p.id]);
      expect(work(c.id)).toEqual({ kind: "unattended" });
    }
    for (const alive of ["queued", "starting", "working"]) {
      db.run("UPDATE tasks SET dispatch_state = ? WHERE id = ?", [alive, p.id]);
      expect(work(c.id)!.kind).toBe("parent-turn");
    }
  });

  test("catena storta: padre sparito e ciclo non appendono la lettura", () => {
    // Edge orfano: il padre non c'è più (FK spenta a mano, come una riga vecchia).
    db.run("PRAGMA foreign_keys = OFF");
    const p = workingParent();
    const c = step(p.id);
    db.run("DELETE FROM tasks WHERE id = ?", [p.id]);
    expect(work(c.id)).toEqual({ kind: "unattended" });

    // Ciclo: due righe che si fanno da padre l'una all'altra. Non deve girare
    // all'infinito — il tetto sulla profondità è lì per questo.
    const a = s.create({ projectId: PID, text: "a", status: "backlog" });
    const b = s.create({ projectId: PID, text: "b", status: "backlog", parentTaskId: a.id });
    db.run("UPDATE tasks SET parent_task_id = ? WHERE id = ?", [b.id, a.id]);
    db.run("UPDATE tasks SET status='in_progress' WHERE id IN (?, ?)", [a.id, b.id]);
    expect(work(b.id)).toEqual({ kind: "unattended" });
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// L'ATTESA DICHIARATA HA UN CONTATORE SUO
//
// Il guasto che questi test chiudono: `wait_for_condition` restituiva lo slot ma
// NON il tentativo, che la claim si era già preso prima che l'agent potesse
// sapere di dover aspettare. Con `dispatch_retry_cap` a 2 si potevano dichiarare
// due attese, e alla terza il task non veniva più reclamato: la spazzata dei
// tentativi esauriti lo parcheggiava `failed`, «guarda cosa lo fa fallire», per
// un'attesa deliberata e corretta (card e285d5d8 sulla board quadra, due volte
// in un giorno).
// ─────────────────────────────────────────────────────────────────────────────
describe("attesa dichiarata: rimborso del tentativo e contatore separato", () => {
  let db: Database; let s: TaskService;
  const T0 = Date.parse("2026-08-12T09:00:00.000Z");
  const clock = { t: T0 };
  beforeEach(() => { clock.t = T0; db = freshDb(); s = svc(db, clock); });

  /** Il tetto dei tentativi VERO della board (default 2): è quello che mordeva. */
  const CAP = 2;
  /** Un giro completo: la claim spende il tentativo, poi l'agent dichiara l'attesa. */
  const attende = (id: string, reason: string, minutes = 15) => {
    const claimed = s.claim({ taskId: id, cap: 5, maxAttempts: CAP });
    expect(claimed).not.toBeNull();
    return s.deferForWait({ taskId: id, reason, minutes, by: "claude" });
  };
  /** Il tempo passa oltre la finestra, così la claim successiva è ammessa. */
  const passa = (minuti: number) => { clock.t += minuti * 60_000; };

  test("il tentativo speso dalla claim torna indietro: `dispatch_attempts` com'era prima", () => {
    const t = s.create({ projectId: PID, text: "aspetta la CI", status: "todo" });
    const claimed = s.claim({ taskId: t.id, cap: 5, maxAttempts: CAP })!;
    expect(claimed.dispatchAttempts).toBe(1); // la claim l'ha già speso

    const atteso = s.deferForWait({ taskId: t.id, reason: "la CI sta girando", minutes: 15, by: "claude" });
    expect(atteso.dispatchAttempts).toBe(0);  // rimborsato
    expect(atteso.status).toBe("todo");
    expect(atteso.dispatchState).toBe("waiting");
    expect(atteso.waitStreak).toBe(1);        // contata sulla SUA grandezza
    expect(atteso.waitSince).not.toBeNull();
  });

  test("con cap 2 anche la QUINTA attesa è ancora reclamabile: era qui che la card veniva accusata", () => {
    const t = s.create({ projectId: PID, text: "aspetta la CI", status: "todo" });
    for (let i = 1; i <= 5; i++) {
      // Col vecchio codice la claim numero 3 tornava `null` (attempts 2 >= cap)
      // e il task restava fermo finché la spazzata non lo dava per fallito.
      const atteso = attende(t.id, "la CI sta girando");
      expect(atteso.status).toBe("todo");
      expect(atteso.waitStreak).toBe(i);
      passa(16);
    }
    const finale = s.get(t.id)!.task;
    expect(finale.dispatchAttempts).toBe(0);
    expect(finale.dispatchState).toBe("waiting");
    expect(finale.dispatchState).not.toBe("failed");
  });

  test("la serie è per RAGIONE: una condizione diversa la fa ricominciare da uno", () => {
    const t = s.create({ projectId: PID, text: "aspetta", status: "todo" });
    attende(t.id, "la CI sta girando"); passa(16);
    const due = attende(t.id, "  LA CI   STA GIRANDO "); // stessa cosa, riscritta a mano
    expect(due.waitStreak).toBe(2);                      // normalizzata: la serie continua
    const inizioSerie = due.waitSince;
    passa(16);

    const altra = attende(t.id, "aspetto la risposta di Attilio");
    expect(altra.waitStreak).toBe(1);                    // altra condizione, altra serie
    expect(altra.waitSince).not.toBe(inizioSerie);
  });

  test("alla soglia il task si ferma, ma col chip `waited_out` e senza la parola «fallito»", () => {
    const t = s.create({ projectId: PID, text: "aspetta la CI", status: "todo" });
    for (let i = 0; i < WAIT_STREAK_CAP; i++) {
      expect(attende(t.id, "la CI sta girando").status).toBe("todo");
      passa(16);
    }
    const parked = attende(t.id, "la CI sta girando"); // la prima oltre il tetto

    expect(parked.status).toBe("backlog");
    expect(parked.dispatchState).toBe(PARKED_WAITED_OUT);
    expect(parked.dispatchState).not.toBe("failed");
    expect(parked.dispatchDeferredUntil).toBeNull();    // non riparte da solo
    expect(parked.dispatchAttempts).toBe(0);            // rimborsato anche qui
    expect(parked.waitStreak).toBe(WAIT_STREAK_CAP + 1);

    // Il testo: dice quante attese, per cosa, e di chi è la decisione. NON dice
    // «fallito» — nemmeno negato, che sarebbe lo stesso nominarlo.
    const nota = parked.dispatchError ?? "";
    expect(nota).toContain(`${WAIT_STREAK_CAP + 1} attese di fila`);
    expect(nota).toContain("la CI sta girando");
    expect(nota).toContain("la decisione torna a te");
    expect(nota).toContain("Rimetti il task in Todo");
    expect(nota.toLowerCase()).not.toContain("fallit");
    // E la stessa riga è nel thread, non solo nel tooltip.
    expect(s.get(t.id)!.comments.map((c) => c.content).join("\n")).toContain("la decisione torna a te");
  });

  test("l'altro tetto è l'OROLOGIO: due attese lunghissime fermano il task quanto sette corte", () => {
    const t = s.create({ projectId: PID, text: "aspetta la finestra notturna", status: "todo" });
    const una = attende(t.id, "la finestra notturna", 1440);
    expect(una.status).toBe("todo");
    expect(una.waitStreak).toBe(1);

    passa(1441); // la finestra di 24h passa, e con essa il tetto sulla durata
    const parked = attende(t.id, "la finestra notturna", 1440);
    expect(parked.status).toBe("backlog");
    expect(parked.dispatchState).toBe(PARKED_WAITED_OUT);
    expect(parked.waitStreak).toBe(2);                          // due sole attese
    expect(parked.waitStreak).toBeLessThan(WAIT_STREAK_CAP);    // il conteggio non c'entra
    expect(WAIT_SERIES_MAX_MS).toBeLessThan(1441 * 60_000);     // è stato il tempo
    expect(parked.dispatchError ?? "").toContain("ore");
  });

  test("il rientro in Todo dell'umano chiude la serie: il bottone rimette in coda davvero", () => {
    const t = s.create({ projectId: PID, text: "aspetta la CI", status: "todo" });
    for (let i = 0; i <= WAIT_STREAK_CAP; i++) { attende(t.id, "la CI sta girando"); passa(16); }
    expect(s.get(t.id)!.task.status).toBe("backlog");

    const back = s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { status: "todo" } });
    expect(back.waitStreak).toBe(0);
    expect(back.waitReason).toBeNull();
    expect(back.waitSince).toBeNull();
    expect(back.dispatchAttempts).toBe(0);

    // Senza l'azzeramento questa ripartirebbe già oltre il tetto e si
    // riparcheggerebbe subito: il bottone non rimetterebbe in coda niente.
    const di_nuovo = attende(t.id, "la CI sta girando");
    expect(di_nuovo.status).toBe("todo");
    expect(di_nuovo.waitStreak).toBe(1);
  });

  test("anche la consegna chiude la serie: le attese di prima non si portano dietro", () => {
    const t = s.create({ projectId: PID, text: "aspetta la CI", status: "todo" });
    attende(t.id, "la CI sta girando"); passa(16);
    attende(t.id, "la CI sta girando");
    expect(s.get(t.id)!.task.waitStreak).toBe(2);

    const consegnato = s.deliverToReviewBySystem({ taskId: t.id, reason: "tempo scaduto", cause: "retries_exhausted" });
    expect(consegnato.status).toBe("review");
    expect(consegnato.waitStreak).toBe(0);
    expect(consegnato.waitReason).toBeNull();
    expect(consegnato.waitSince).toBeNull();
  });

  test("un turno che muore DAVVERO consuma ancora il tentativo: il rimborso è solo dell'attesa", () => {
    const t = s.create({ projectId: PID, text: "questo esplode", status: "todo" });
    s.claim({ taskId: t.id, cap: 5, maxAttempts: CAP });
    s.release({ taskId: t.id, requeue: true, reason: "timeout del turno", by: "dispatcher" });

    const dopo = s.get(t.id)!.task;
    expect(dopo.dispatchAttempts).toBe(1);  // NON rimborsato: qui il freno serve
    expect(dopo.waitStreak).toBe(0);        // e non era un'attesa
    expect(dopo.waitSince).toBeNull();
  });
});

/**
 * IL COSTO DI UNA LISTA, MISURATO IN STATEMENT E IN BYTE.
 *
 * Misurato il 15/08 su `GET /api/all-boards/tasks` contro il database vivo
 * (2.135 task, 651 MB): 467 radici, 1.435.735 byte, 145 ms. Il mappatore faceva
 * da 4 a 7 query PER RIGA — etichette, bloccante, topic, dipendenti, stato del
 * padre, e per ogni card in `todo` due COUNT correlati sull'intera coda — cioè
 * O(N) statement più O(Q²) scansioni: ~1.500 statement per una lista sola.
 *
 * Due cancelli, e sono su due grandezze diverse apposta. Il primo conta gli
 * STATEMENT: è la forma del guasto (per riga invece che per lotto), e va rosso
 * il giorno in cui qualcuno rimette una lettura dentro il ciclo, qualunque sia
 * la sua durata su questa macchina. Il secondo conta i BYTE per task: è il
 * grasso nuovo, quello che nessun invariante conosce ancora.
 */
describe("il costo di una lista non cresce con le righe", () => {
  /**
   * Conta le COMPILAZIONI, non le esecuzioni. È la grandezza giusta: una query
   * dentro il ciclo si vede qui anche quando SQLite se la cava in un
   * microsecondo, mentre un tempo misurato su questa macchina direbbe cose
   * diverse su un'altra.
   *
   * Si intercetta `prepare` e BASTA: in `bun:sqlite` è `db.query` a chiamarlo
   * (e a tenersi il risultato in cache per la stessa SQL), quindi contare
   * entrambi conterebbe due volte ogni `query` e nasconderebbe proprio il
   * risparmio della cache.
   */
  function countStatements<T>(db: Database, run: () => T): { n: number; out: T } {
    const raw = db.prepare.bind(db);
    let n = 0;
    (db as unknown as { prepare: unknown }).prepare =
      (...a: unknown[]) => { n++; return (raw as unknown as (...x: unknown[]) => unknown)(...a); };
    try {
      const out = run();
      return { n, out };
    } finally {
      (db as unknown as { prepare: unknown }).prepare = raw;
    }
  }

  /** 300 righe, 100 delle quali radici in coda: la forma del feed vero. */
  function seed(db: Database, opts: { description?: string; rows?: number } = {}): void {
    const totale = opts.rows ?? 300;
    const ins = db.prepare(
      `INSERT INTO tasks (id, project_id, text, description, status, priority, kanban_order, created_at, updated_at, checks_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const checks = JSON.stringify([
      { name: "typecheck", cmd: "bun run typecheck", ok: true, code: 0, ms: 4210, timedOut: false, tail: "x".repeat(600) },
    ]);
    for (let i = 0; i < totale; i++) {
      const status = i < totale / 3 ? "todo" : i < (2 * totale) / 3 ? "review" : "done";
      ins.run(
        `t-${i}`, `board-${i % 5}`, `task numero ${i}`, opts.description ?? null,
        status, i % 5, i, `2026-08-${String((i % 27) + 1).padStart(2, "0")}T10:00:00.000Z`,
        "2026-08-15T10:00:00.000Z", checks,
      );
    }
  }

  test("300 task, 100 in coda: una lista sta sotto i 25 statement (ne faceva ~1500)", () => {
    const db = freshDb();
    const s = svc(db);
    seed(db);
    const { n, out } = countStatements(db, () => s.list({ scope: "all", rootsOnly: true }));
    expect(out.length).toBe(300);
    expect(n).toBeLessThan(25);
  });

  test("e non cresce: dieci volte le righe, lo STESSO numero di statement", () => {
    // La controprova che rende il numero sopra un INVARIANTE e non una soglia
    // calibrata: stessa forma, dieci volte le righe. Se una lettura tornasse
    // dentro il ciclo questo conto si moltiplicherebbe, anche lasciando il primo
    // cancello verde su una board piccola.
    const piccolo = freshDb(); seed(piccolo, { rows: 30 });
    const grande = freshDb(); seed(grande, { rows: 300 });
    const a = countStatements(piccolo, () => svc(piccolo).list({ scope: "all", rootsOnly: true })).n;
    const b = countStatements(grande, () => svc(grande).list({ scope: "all", rootsOnly: true })).n;
    expect(b).toBe(a);
  });

  /**
   * IL BUDGET IN BYTE, e il numero non è quello che sembrava.
   *
   * La descrizione da 2.500 caratteri è la coda misurata sul database vivo
   * (massimo 5.140 byte, 470 KB sul feed); i `checks` sono l'altra metà del
   * grasso (217 KB). Nessuno dei due viaggia nella proiezione magra.
   *
   * Il tetto è 1.700 e non 700 perché 700 sta SOTTO IL PAVIMENTO: un task con
   * ogni campo a null pesa già ~1.500 byte, che sono i nomi delle chiavi e i
   * loro `null`. Il tetto è salito da 1.600 il 16/08, quando le tre colonne
   * dell'entità della consegna (`deliveryFilesChanged`/`Insertions`/`Deletions`,
   * migration 20260816174500) hanno aggiunto ~53 byte per task: misurato 1.653.
   * Rialzato a 1.750 il 18/08, quando `urlProbeStatus` e `urlProbeCheckedAt`
   * (migration 20260818164410) hanno aggiunto ~40 byte per task: misurato 1.716.
   * Alzarlo è legittimo SOLO perché il pavimento è cresciuto per una ragione
   * dichiarata — due campi che la card in review usa per decidere se mostrare
   * il link all'anteprima viva — e non perché il payload si è ingrassato di
   * nascosto. La controprova sotto, che è la parte che non si ricalibra, resta
   * identica. Restano poi due campi che non sono grasso ma contenuto:
   * l'anteprima (263 byte, ed è ciò che la card disegna) e `queueReason`
   * (242 byte, la frase che dice perché la card non parte). Sotto i 700 non ci
   * si arriva accorciando: ci si arriva togliendo chiavi, che è un altro
   * cambio, con un altro client da avvisare.
   *
   * La CONTROPROVA sotto è la parte che non si può ricalibrare: il payload
   * magro non deve contenere né la descrizione intera né la coda dell'output
   * dei check, e quella condizione va rossa il giorno in cui uno dei due torna,
   * qualunque soglia si scriva sopra.
   */
  test("proiezione magra: sotto i 1750 byte per task, con descrizioni da 2500 caratteri", () => {
    const db = freshDb();
    const s = svc(db);
    seed(db, { description: "d".repeat(2500) });
    const magra = s.list({ scope: "all", rootsOnly: true });
    expect(magra.length).toBe(300);
    const testo = JSON.stringify({ tasks: magra });
    expect(testo.length / magra.length).toBeLessThan(1750);
    // Strutturale: i due pesi che questo cambio toglie non sono nel payload.
    expect(testo).not.toContain("d".repeat(300));  // la descrizione intera
    expect(testo).not.toContain("x".repeat(300));  // la coda dei check
    // E il confronto con la proiezione di prima, che li portava entrambi.
    // `withDescription` è l'interruttore che resta acceso per le due letture
    // che il testo intero lo LEGGONO (proposta di collegamento, lista di un
    // agente): la lista che disegna card non lo accende mai.
    const grassa = s.list({ scope: "all", rootsOnly: true, withDescription: true });
    expect(JSON.stringify({ tasks: grassa }).length / grassa.length).toBeGreaterThan(2500);
  });

  test("la lista porta l'anteprima della descrizione, il dettaglio la porta intera", () => {
    const db = freshDb();
    const s = svc(db);
    seed(db, { description: "d".repeat(2500) });
    const [primo] = s.list({ scope: "all", rootsOnly: true });
    expect(primo!.descriptionPreview!.length).toBe(240);
    expect(primo!.checks).toBeNull();          // fuori dalla proiezione della lista
    const dettaglio = s.get(primo!.id)!.task;
    expect(dettaglio.description!.length).toBe(2500);
    expect(dettaglio.checks!.length).toBe(1);  // il dettaglio li porta
  });
});

describe("la lista: filtro per id, stato validato, commenti sulla card", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  /**
   * IL PREDICATO DI AUTORIZZAZIONE ARRIVA FINO A SQL.
   *
   * Il feed dell'ospite idratava OGNI task del database — etichette, bloccante,
   * ragione di coda, commenti — per poi tenere in JS i due condivisi con lui.
   * Pagava l'intera board per rispondere «due card».
   */
  test("`ids` taglia in SQL, e l'insieme VUOTO vale «nessuna riga»", () => {
    const a = s.create({ projectId: PID, text: "condivisa" });
    s.create({ projectId: PID, text: "privata" });

    expect(s.list({ scope: "all", rootsOnly: true, ids: [a.id] }).map((t) => t.text)).toEqual(["condivisa"]);
    // Vuoto = niente, non «nessun filtro»: sbagliare qui vorrebbe dire mostrare
    // a un ospite l'intera board.
    expect(s.list({ scope: "all", rootsOnly: true, ids: [] })).toEqual([]);
    // E si compone con gli altri tagli invece di sostituirli.
    expect(s.list({ scope: "all", rootsOnly: true, status: "done", ids: [a.id] })).toEqual([]);
  });

  /**
   * UNO STATO CHE NON ESISTE È UN ERRORE, NON UNA BOARD VUOTA. Il filtro
   * arrivava dal query string con un `as any` e finiva in `WHERE status = ?`,
   * dove non matcha niente: 200 con zero card, cioè una risposta perfettamente
   * plausibile sopra un refuso.
   */
  test("uno stato inesistente è invalid_input, non una lista vuota", () => {
    s.create({ projectId: PID, text: "c'è" });
    expect(() => s.list({ scope: "all", status: "in-progress" as never }))
      .toThrow(TaskServiceError);
    expect(s.list({ scope: "all", status: "backlog" }).length).toBe(1); // il caso buono resta
  });

  /**
   * I COMMENTI DELLA CARD VIAGGIANO CON LA LISTA. Senza, la board apriva un
   * `GET /api/tasks/:id` per ogni card in review solo per leggere il fondo del
   * thread — e quel dettaglio carica l'INTERO thread.
   */
  /**
   * LA PAROLA DELL'AGENTE ARRIVA SEMPRE, ANCHE SE E' LONTANA DAL FONDO.
   *
   * La finestra `rn <= 3` prendeva le ultime tre righe parlate, e il client poi
   * scarta le note di macchina per trovare la parola vera. Funziona finche' le
   * note dopo una consegna sono meno di tre. Non lo sono: dopo ogni ingresso in
   * review ne arrivano di norma TRE — l'esito dei checks, la nota
   * sull'anteprima, «Non e' su main: <sha>» — e il riassunto dell'agente esce
   * dalla finestra prima ancora di partire. Il client filtrava correttamente e
   * non trovava niente: ripiegava sulle note, e la card apriva con «Non e' su
   * main», identica su tre card su quattro.
   *
   * Misurato il 2026-08-18 sulla board vera: delle 26 card in review/done
   * lavorate davvero da un agente, 23 avevano il riassunto nel thread e ZERO lo
   * mostravano. Segnalato: «parecchi task non hanno un commento utile, hanno
   * soltanto un commento di sistema».
   */
  test("recentComments: il riassunto dell'agente entra anche con quattro note di sistema dopo", () => {
    const t = s.create({ projectId: PID, text: "work", status: "review" });
    s.addComment({ taskId: t.id, author: "claude", content: "Consegna: ramo topics/x, 5 file +100 -20" });
    // Le quattro che il sistema scrive davvero dopo ogni consegna.
    s.addComment({ taskId: t.id, author: "system", content: "L'agent ha lavorato 4 turni…" });
    s.addComment({ taskId: t.id, author: "system", kind: "review-note", content: "Consegna SENZA anteprima…" });
    s.addComment({ taskId: t.id, author: "system", content: "**Checks pre-review verdi** su abc1234…" });
    s.addComment({ taskId: t.id, author: "system", content: "Non è su main: `abc1234` — landa il ramo…" });

    const [card] = s.list({ scope: "all", rootsOnly: true, ids: [t.id] });
    const testi = card!.recentComments.map((c) => c.content);
    expect(
      testi.some((x) => x.startsWith("Consegna: ramo topics/x")),
      `la parola dell'agente non e' arrivata alla card: ${JSON.stringify(testi)}`,
    ).toBe(true);
    // …ed e' la PRIMA: le righe viaggiano dal piu' vecchio al piu' recente.
    expect(testi[0]!.startsWith("Consegna: ramo topics/x")).toBe(true);
  });

  test("recentComments: anche una card IN CORSO porta la parola dell'agente (e una in todo no)", () => {
    // The kickoff asks for a comment as soon as the work is framed, and the
    // agent writes it: attached to review only, the kanban showed a stopwatch.
    // Todo stays without: 455 cards out of 467 have nothing to say.
    const t = s.create({ projectId: PID, text: "work", status: "in_progress" });
    s.addComment({ taskId: t.id, author: "claude", content: "Inquadrato: parto dal dispatcher." });
    const idle = s.create({ projectId: PID, text: "idle", status: "todo" });
    s.addComment({ taskId: idle.id, author: "claude", content: "non dovrebbe viaggiare" });

    const rows = s.list({ scope: "all", rootsOnly: true, ids: [t.id, idle.id] });
    const working = rows.find((r) => r.id === t.id)!;
    expect(working.recentComments.map((c) => c.content)).toContain("Inquadrato: parto dal dispatcher.");
    expect(rows.find((r) => r.id === idle.id)!.recentComments ?? []).toHaveLength(0);
  });

  /**
   * A DECLARED DELIVERY ALWAYS TRAVELS, and it needs a guarantee of its own.
   *
   * `rn_parola = 1` carries the last real word: not enough. After delivering,
   * the agent keeps talking, and the chronicle of commits is made of words — so
   * it takes that slot and pushes the delivery out of the window. That is
   * exactly the reported defect (only useless git things visible in review),
   * coming back through the transport door even with a card that chooses right.
   * Hence `rn_consegna`.
   */
  test("recentComments: la consegna dichiarata arriva anche sepolta sotto quattro commenti dell'agente", () => {
    const t = s.create({ projectId: PID, text: "work", status: "todo" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "in_progress" } });
    s.update({
      taskId: t.id,
      actor: "agent",
      by: "claude",
      patch: { status: "review", summary: "Importate le 25 righe: la board le mostra col nome del progetto." },
    });
    for (const n of [1, 2, 3, 4]) s.addComment({ taskId: t.id, author: "claude", content: `commit ${n}: refactor` });

    const [card] = s.list({ scope: "all", rootsOnly: true, ids: [t.id] });
    expect(
      card!.recentComments.filter((c) => c.kind === "delivery").map((c) => c.content),
      `la consegna non e' arrivata alla card: ${JSON.stringify(card!.recentComments.map((c) => c.content))}`,
    ).toEqual(["Importate le 25 righe: la board le mostra col nome del progetto."]);
  });

  /**
   * UNA DOMANDA DEL SISTEMA E' UNA PAROLA VERA, e non deve essere promossa due
   * volte ne' scartata: il recinto ```question e' la firma di qualcosa che
   * aspetta una risposta, ed e' l'unica nota di macchina che tiene ferma la
   * card. Il predicato SQL deve dire esattamente quello che dice `contorno()`
   * nel client — se fosse piu' largo, la finestra trasporterebbe righe che il
   * client scarta e la card resterebbe muta come prima.
   */
  test("recentComments: una domanda del sistema conta come parola, una nota no", () => {
    const t = s.create({ projectId: PID, text: "work", status: "review" });
    s.addComment({ taskId: t.id, author: "system", content: "```question\nRimetto in coda?\n- Si\n- No\n```" });
    for (const n of [1, 2, 3, 4]) s.addComment({ taskId: t.id, author: "system", content: `nota ${n}` });

    const testi = s.list({ scope: "all", rootsOnly: true, ids: [t.id] })[0]!.recentComments.map((c) => c.content);
    expect(testi.some((x) => x.includes("```question"))).toBe(true);
  });

  test("recentComments: gli ultimi tre PARLATI, senza cronologia né contabilità", () => {
    const t = s.create({ projectId: PID, text: "work", status: "review" });
    for (const n of [1, 2, 3, 4]) s.addComment({ taskId: t.id, author: "claude", content: `parola ${n}` });
    // `status` (transizioni) e `service` (contabilità del dispatcher) non sono
    // le parole di nessuno: stesso taglio di `isThreadSpeech`.
    s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { priority: 1 } });
    s.addComment({ taskId: t.id, author: "system", kind: "service", content: "in coda" });

    const [card] = s.list({ scope: "all", rootsOnly: true });
    expect(card!.recentComments.map((c) => c.content)).toEqual(["parola 2", "parola 3", "parola 4"]);
    // E su OGNI payload, anche su quelli che le scritture ribaltano sul WS: un
    // campo riempito solo in lettura si spegnerebbe al primo giro di WS.
    const afterWrite = s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { priority: 3 } });
    expect(afterWrite.recentComments.map((c) => c.content)).toEqual(["parola 2", "parola 3", "parola 4"]);
  });

  /**
   * I COMMENTI VIAGGIANO SOLO DOVE LA CARD LI DISEGNA.
   *
   * Misurato il 15/08 su `GET /api/all-boards/tasks`: 731 KB di commenti
   * attaccati a 455 schede su 467, per le 11 in review che li leggono. Il
   * predicato è lo stesso del client (`showsCardThread`), e il verso conta:
   * allargarlo qui è peso che non serve, stringerlo è una card muta.
   */
  test("fuori dalla review i commenti non partono, e tornano appena la card ci entra", () => {
    const t = s.create({ projectId: PID, text: "work", status: "todo" });
    s.addComment({ taskId: t.id, author: "claude", content: "una parola" });

    const inCoda = s.list({ scope: "all", rootsOnly: true })[0]!;
    expect(inCoda.recentComments).toEqual([]);
    // Il thread c'è, ed è il dettaglio a portarlo: la lista non lo nasconde,
    // semplicemente non è lei a doverlo spedire.
    expect(s.get(t.id)!.comments.map((c) => c.content)).toContain("una parola");

    // Entrare in review fa scrivere al servizio la sua nota di evidenza: la
    // parola dell'agente è quella davanti, e la nota è la coda del thread.
    const inReview = s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { status: "review" } });
    expect(inReview.recentComments.map((c) => c.content)).toContain("una parola");
  });

  /**
   * IL TESTO È TAGLIATO, MA NON DENTRO UNA ```question.
   *
   * Il blocco domanda non è prosa: la card ne ricava i bottoni di risposta
   * rapida. Tagliato a metà `parseQuestionBlock` torna `null` e la card perde i
   * bottoni stampando il recinto grezzo, senza che niente diventi rosso.
   */
  test("il contenuto viaggia tagliato, e i tre campi sono quelli che la card legge", () => {
    const t = s.create({ projectId: PID, text: "work", status: "review" });
    s.addComment({ taskId: t.id, author: "user", content: `chiedo: ${"x".repeat(3000)}` });
    s.addComment({ taskId: t.id, author: "claude", content: `rispondo: ${"y".repeat(3000)}` });

    const [card] = s.list({ scope: "all", rootsOnly: true });
    const [contesto, ultima] = card!.recentComments;
    // L'ultima parola la card la stampa intera: 1.200 caratteri.
    expect(ultima!.content.length).toBe(1201);
    // IL CONTESTO NON È PIÙ 200, ed è una correzione non un allentamento.
    //
    // «Una riga sola già tagliata dal CSS» descriveva la card di allora. Il
    // client la ripiega su tre righe e offre «mostra di più» oltre 620
    // caratteri (`COMMENTO_PIEGA_CHARS`), promettendo che «il testo c'è tutto».
    // Con 200 dal server quel bottone apriva sul vuoto: misurati 1.215 messaggi
    // umani su questa macchina, mediana 520, il 76% sopra i 200.
    //
    // 620 non è scelto: è il massimo che sta nel cancello sul peso del payload
    // (`board-payload-weight`), che a 800 va rosso. Le due costanti sono tenute
    // allineate da un test apposta in `card-comments-window`.
    expect(contesto!.content.length).toBe(621);
    expect(Object.keys(ultima!).sort()).toEqual(["author", "content", "kind"]);
  });

  test("una ```question più lunga del tetto viaggia INTERA: i bottoni sopravvivono", () => {
    const t = s.create({ projectId: PID, text: "work", status: "review" });
    const domanda = `Ho finito.\n${"prosa lunga. ".repeat(90)}\n\`\`\`question\nChe faccio?\n- Vai\n- Fermati\n\`\`\`\ncoda`;
    expect(domanda.length).toBeGreaterThan(1200);
    s.addComment({ taskId: t.id, author: "claude", content: domanda });

    const [card] = s.list({ scope: "all", rootsOnly: true });
    const testo = card!.recentComments[0]!.content;
    expect(testo).toContain("```question");
    expect(testo).toContain("- Fermati");
    // Il recinto è chiuso: è la condizione che `parseQuestionBlock` chiede.
    expect(testo.split("```").length - 1).toBe(2);
    // E il taglio c'è comunque: la coda dopo il recinto non viaggia.
    expect(testo).not.toContain("coda");
  });
});

/**
 * IL LOTTO DEVE DIRE ESATTAMENTE CIÒ CHE DICEVA LA RIGA-PER-RIGA.
 *
 * Il rischio di questo cambio non è la lentezza, è il SILENZIO: una query di
 * lotto che dimentica una colonna, o una `JOIN` che perde la riga senza legame,
 * non fa fallire niente — spegne un campo su una card, e chi la guarda pensa
 * che il dato non ci sia. Nessuno dei test sopra lo vedrebbe: guardano un campo
 * alla volta, quindi coprono i campi a cui qualcuno ha già pensato.
 *
 * Qui il confronto è STRUTTURALE, chiave per chiave, fra le due porte che il
 * lotto ha separato: `list` (proiezione + mappatore a lotti) e `get`
 * (`SELECT *` + lotto da una riga). L'unica differenza ammessa è dichiarata e
 * pinzata sotto: `checks`, che la lista non porta apposta.
 */
describe("la lista e il dettaglio dicono la stessa cosa, campo per campo", () => {
  /** Il valore che ogni colonna nullable riceve, per tipo: vedi `tuttoPieno`. */
  const TS = "2026-07-09T09:00:00.000Z";

  /**
   * Un task con OGNI colonna di `tasks` valorizzata, più tutto ciò che il
   * mappatore va a cercare FUORI dalla riga: etichette, bloccante, topic,
   * padre, un figlio aperto, dipendenti e commenti.
   *
   * `dispatch_deferred_until` è nel PASSATO di proposito: sul futuro la ragione
   * di coda porta i minuti che mancano, arrotondati, e le due letture avvengono
   * a due istanti diversi — un confronto che fallisce una volta su ventimila
   * non è un cancello, è un rumore.
   */
  function tuttoPieno(db: Database, s: TaskService): { id: string; altri: string[] } {
    db.run("INSERT INTO topics (id, effort) VALUES ('top-1', 'xhigh')");
    db.run("INSERT INTO agent_profiles (id) VALUES ('ap-1')");
    const bloccante = s.create({ projectId: PID, text: "prima questo" });
    const padre = s.create({ projectId: PID, text: "il padre" });
    const t = s.create({ projectId: PID, text: "tutto pieno", parentTaskId: padre.id });
    const passo = s.create({ projectId: PID, text: "un passo ancora aperto", parentTaskId: t.id });
    // Una radice in coda: è l'unica forma per cui la ragione di coda calcola la
    // FILA, cioè il ramo che il lotto ha riscritto con la ricerca binaria.
    const inCoda = s.create({ projectId: PID, text: "in coda", status: "todo" });
    // Un dipendente vivo, così `waitingOnCount` non è zero da entrambe le parti.
    const dipendente = s.create({ projectId: PID, text: "aspetta il pieno" });
    db.run("UPDATE tasks SET blocked_by_task_id = ? WHERE id = ?", [t.id, dipendente.id]);
    for (const label of ["visibile", "bugfix"]) {
      db.run("INSERT INTO task_labels (task_id, label, source, created_at) VALUES (?, ?, 'human', ?)", [t.id, label, TS]);
    }
    s.addComment({ taskId: t.id, author: "user", content: "una parola" });
    s.addComment({ taskId: t.id, author: "claude", content: "un'altra parola" });

    db.run(
      `UPDATE tasks SET
         description = ?, status = 'review', priority = 3, kanban_order = 7,
         assigned_to = 'il-reviewer', fingerprint = 'fp-1', due_date = ?, chat_id = 'chat-1',
         created_at = ?, completed_at = ?, updated_at = ?, assigned_agent_id = 'ap-1',
         in_progress_at = ?, archived = 0, assigned_topic_id = 'top-1', claude_task_id = 'ct-1',
         dispatch_attempts = 2, dispatch_state = 'working', dispatch_error = 'un errore',
         output_url = 'https://example.invalid/x', plan_first = 1, agent_ms = 1234,
         agent_tokens = 5678, model = 'claude-opus-5', blocked_by_task_id = ?,
         reuse_blocker_context = 1, priority_auto = 0, agent_cache_read_tokens = 90,
         preview_image = '/tmp/x.png', dispatch_deferred_until = ?, delivery_branch = 'topics/x',
         delivery_commit = 'abc1234', landing_state = 'landed', landing_checked_at = ?,
         checks_state = 'green', checks_at = ?, checks_commit = 'abc1234', checks_json = ?,
         delivered_by = 'claude', delivered_reason = 'finito', dispatch_weight = 'heavy',
         created_by_topic_id = 'top-1', plan_comment_id = 'id-9', done_actor = 'human',
         reopened_at = ?, reopened_by = 'il-reviewer', reopened_actor = 'human',
         landing_witnessed = 1, wait_streak = 2, wait_reason = 'aspetto il gate',
         wait_since = ?, preview_retired_at = ?, preview_retired_reason = 'sostituita',
         -- 20260823210000: paths the retirement rejected, so the automatic
         -- promotion does not fish them back from the thread on restart.
         preview_rejected = '["/tmp/falsa.png"]',
         interrupt_claimed_at = ?,
         -- L'entita' della consegna (migration 20260816174500). Il cancello
         -- sotto ha preso questa dimenticanza da solo, che e' il motivo per cui
         -- esiste: senza, lista e dettaglio avrebbero potuto divergere sui tre
         -- campi nuovi senza che nessuno se ne accorgesse.
         -- (Niente backtick nei commenti SQL: questo DDL vive in un template
         -- literal e un backtick apre un'interpolazione JS. Seconda volta oggi.)
         delivery_files_changed = 7, delivery_insertions = 120, delivery_deletions = 30,
         -- 20260903092935: the work that sits in the worktree and not on a
         -- commit. Same reason as the three above: a column left NULL is not
         -- covered by the list-against-detail comparison.
         delivery_uncommitted_files = 2,
         -- 20260816214500: da quando la card aspetta una risposta umana.
         review_at = ?,
         -- 20260818164410: esito sonda server-side sull'output_url.
         url_probe_status = 'live', url_probe_checked_at = ?,
         -- 20260818234959: il turno tagliato da un riavvio, scritto invece che
         -- dedotto. Le tre colonne entrano qui perche' il cancello sotto le
         -- prenderebbe comunque: una colonna che resta NULL non e' coperta dal
         -- confronto fra lista e dettaglio, e il test lo dice invece di tacere.
         interrupted_at = ?, interrupted_by = 'SIGTERM', interrupted_notified_at = ?,
         -- 20260819122701: la rivendicazione del sollecito nella chat del task.
         -- Stessa ragione delle tre qui sopra: una colonna che resta NULL non e'
         -- coperta dal confronto fra lista e dettaglio.
         nudge_claimed_at = ?, nudge_fingerprint = 'fp-sollecito', nudge_repeats = 2,
         -- 20260827041049: la proposta di deploy post-approve. Stessa ragione:
         -- una colonna che resta NULL non e' coperta dal confronto.
         deploy_state = 'proposed', deploy_command_at_propose = 'bun run deploy'
       WHERE id = ?`,
      [
        // UNA DESCRIZIONE CON CARATTERI FUORI DAL PIANO BASE. `substr` di SQLite
        // conta CARATTERI, `String.slice` conta unità UTF-16: su un'emoji le due
        // porte tagliavano in due punti diversi, ed è esattamente la forma di
        // divergenza che questo confronto esiste per prendere.
        `🎯${"d".repeat(400)}`,
        TS, TS, TS, TS, TS, bloccante.id, "2020-01-01T00:00:00.000Z",
        TS, TS, JSON.stringify([{ name: "typecheck", cmd: "bun run typecheck", ok: true, code: 0, ms: 10, timedOut: false, tail: "ok" }]),
        TS, TS, TS, TS, TS, TS, TS, TS, TS, t.id,
      ],
    );
    return { id: t.id, altri: [padre.id, passo.id, bloccante.id, inCoda.id, dipendente.id] };
  }

  test("nessuna colonna resta a NULL: «tutti i campi» è verificato, non promesso", () => {
    const db = freshDb();
    const { id } = tuttoPieno(db, svc(db));
    const riga = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>;
    // Una colonna aggiunta domani entra in questo cancello da sola: se la
    // migration non la valorizza qui, il confronto sotto non la copre e questo
    // test lo dice invece di passare in silenzio.
    expect(Object.entries(riga).filter(([, v]) => v === null).map(([k]) => k)).toEqual([]);
  });

  test("list() e get() concordano su OGNI chiave, tranne le due dichiarate", () => {
    const db = freshDb();
    const s = svc(db);
    const { id, altri } = tuttoPieno(db, s);
    const listati = new Map(s.list({ scope: "all" }).map((x) => [x.id, x]));

    for (const each of [id, ...altri]) {
      const dallaLista = listati.get(each);
      const fromDetail = s.get(each)?.task;
      expect(dallaLista).toBeDefined();
      expect(fromDetail).toBeDefined();
      // `checks` e `description` fuori dal confronto e pinzate a parte: sono le
      // DUE differenze volute fra le due porte, quindi vanno nominate invece
      // che tollerate. Tutto il resto deve coincidere, campo per campo.
      const senzaGrasso = { checks: null, description: null };
      expect({ ...dallaLista!, ...senzaGrasso }).toEqual({ ...fromDetail!, ...senzaGrasso });
    }

    expect(listati.get(id)!.checks).toBeNull();          // la lista non li porta
    expect(s.get(id)!.task.checks!.length).toBe(1);      // il dettaglio sì
    // La descrizione: sulla lista solo l'anteprima, sul dettaglio il testo.
    expect(listati.get(id)!.description).toBeNull();
    expect(listati.get(id)!.descriptionPreview).toBe(s.get(id)!.task.descriptionPreview);
    expect(s.get(id)!.task.description!.length).toBe(402); // 400 «d» + l'emoji, che sono due unità UTF-16
    // E la prova che il confronto ha davvero guardato dei valori, non due
    // oggetti vuoti che si somigliano.
    expect(listati.get(id)!.labels.map((l) => l.label)).toEqual(["bugfix", "visibile"]);
    expect(listati.get(id)!.blockedBy?.text).toBe("prima questo");
    expect(listati.get(id)!.waitingOnCount).toBe(1);
    expect(listati.get(id)!.recentComments.length).toBe(2);
    expect(listati.get(id)!.effort).toBe("xhigh");
    expect(listati.get(id)!.model).toBe("claude-opus-5");
  });
});

describe("bindTopic: una sessione nuova e' un tentativo nuovo", () => {
  // `dispatch_attempts` frena un agente che gira in tondo DENTRO una
  // conversazione. Fra un dispatch e l'altro invece restava, e la card
  // ripartiva su una sessione vergine col budget gia' speso: moriva al primo
  // turno annunciando di averne fatti quattro. Misurato il 18/08 su `eef64e32`
  // — tre dispatch, tre topic, e al terzo la sessione aveva DUE messaggi.
  test("una sessione NUOVA riparte da 1: il turno che comincia conta, quelli di prima no", () => {
    const db = freshDb(); const s = svc(db);
    db.prepare("INSERT INTO topics (id) VALUES ('t-uno')").run();
    db.prepare("INSERT INTO topics (id) VALUES ('t-due')").run();
    const t = s.create({ projectId: PID, text: "Un task" });
    s.bindTopic({ taskId: t.id, topicId: "t-uno", freshSession: true });
    db.prepare("UPDATE tasks SET dispatch_attempts = 4 WHERE id = ?").run(t.id);

    s.bindTopic({ taskId: t.id, topicId: "t-due", freshSession: true });

    expect(s.get(t.id)!.task.dispatchAttempts).toBe(1);
  });

  test("senza `freshSession` il freno resta dov'e'", () => {
    // E' il caso della ripresa e del riuso del topic del bloccante: stessa
    // conversazione, stesso budget. Ed e' anche il primo attacco di un
    // tentativo normale, che la rivendicazione ha gia' contato.
    const db = freshDb(); const s = svc(db);
    db.prepare("INSERT INTO topics (id) VALUES ('t-uno')").run();
    const t = s.create({ projectId: PID, text: "Un task" });
    db.prepare("UPDATE tasks SET dispatch_attempts = 3 WHERE id = ?").run(t.id);

    s.bindTopic({ taskId: t.id, topicId: "t-uno" });

    expect(s.get(t.id)!.task.dispatchAttempts, "stessa conversazione, stesso budget").toBe(3);
  });
});

// ── re-dispatch: il tentativo muore, la checklist no ─────────────────────
//
// Misurato il 18/08 su `eef64e32`: il task era passato a `stellar-weasel` ma
// i quattro sottotask creati dal topic `groovy-frond` erano rimasti attaccati,
// tre con status `done` e uno `in_progress`. L'agent nuovo leggeva una
// checklist di un tentativo morto — tre su quattro falsi positivi — e il
// quarto mandava il padre in attesa di nessuno (deadlock silenzioso).
//
// La prima cura archiviava TUTTO, e curava metà del male facendo l'altra metà:
// un `done` che descrive lavoro buttato è una bugia e se ne deve andare, ma un
// aperto è il PIANO — l'unica cosa buona che il tentativo morto lascia — e
// archiviarlo faceva ripartire il nuovo agente dal foglio bianco.
//
// La regola di adesso: i `done` si archiviano, gli aperti cambiano PADRONE
// (`status` a `todo`, `created_by_topic_id` al topic nuovo), e la nota dice
// quale dei due è successo a quanti.
describe("bindTopic: al cambio di topic i `done` si archiviano e gli aperti si ereditano", () => {
  function setup() {
    const db = freshDb();
    db.prepare("INSERT INTO topics (id) VALUES ('topic-a')").run();
    db.prepare("INSERT INTO topics (id) VALUES ('topic-b')").run();
    return { db, s: svc(db) };
  }

  /** Come farebbe il `create_task` MCP reale: la provenienza è del topic vivo. */
  function daTopic(db: Database, id: string, topic: string, status?: string): void {
    db.prepare("UPDATE tasks SET created_by_topic_id = ? WHERE id = ?").run(topic, id);
    if (status) db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
  }
  const rigaDi = (db: Database, id: string) =>
    db.prepare("SELECT archived, status, created_by_topic_id AS topic FROM tasks WHERE id = ?").get(id) as
      { archived: number; status: string; topic: string | null };

  test("tre `done` e un `in_progress`: i done spariscono, l'aperto resta e passa al topic nuovo", () => {
    const { db, s } = setup();
    const parent = s.create({ projectId: PID, text: "Il task padre" });
    s.bindTopic({ taskId: parent.id, topicId: "topic-a", freshSession: true });

    const c1 = s.create({ projectId: PID, text: "Step 1", parentTaskId: parent.id });
    const c2 = s.create({ projectId: PID, text: "Step 2", parentTaskId: parent.id });
    const c3 = s.create({ projectId: PID, text: "Step 3", parentTaskId: parent.id });
    const c4 = s.create({ projectId: PID, text: "Step 4", parentTaskId: parent.id });
    daTopic(db, c1.id, "topic-a", "done");
    daTopic(db, c2.id, "topic-a", "done");
    daTopic(db, c3.id, "topic-a", "done");
    daTopic(db, c4.id, "topic-a", "in_progress");

    s.bindTopic({ taskId: parent.id, topicId: "topic-b", freshSession: true });

    for (const c of [c1, c2, c3]) {
      expect(rigaDi(db, c.id).archived, `${c.text}: un done buttato non resta a mentire`).toBe(1);
    }
    const superstite = rigaDi(db, c4.id);
    expect(superstite.archived, "l'aperto non si archivia: è il piano").toBe(0);
    expect(superstite.status, "l'`in_progress` era di un turno che non gira più").toBe("todo");
    expect(superstite.topic, "cambia padrone: ora è del topic nuovo").toBe("topic-b");
  });

  test("il piano SOPRAVVIVE: il padre resta con la sua checklist aperta, non col foglio bianco", () => {
    const { db, s } = setup();
    const parent = s.create({ projectId: PID, text: "Il task padre" });
    s.bindTopic({ taskId: parent.id, topicId: "topic-a", freshSession: true });
    const step = s.create({ projectId: PID, text: "Quel che restava da fare", parentTaskId: parent.id });
    daTopic(db, step.id, "topic-a", "in_progress");

    s.bindTopic({ taskId: parent.id, topicId: "topic-b", freshSession: true });

    const aperti = (
      db.prepare(
        "SELECT COUNT(*) AS c FROM tasks WHERE parent_task_id = ? AND archived = 0 AND status != 'done'",
      ).get(parent.id) as any
    ).c;
    expect(aperti, "lo step resta nella checklist del padre").toBe(1);
    // E si vede anche dal drawer, non solo a SQL.
    expect(s.get(parent.id)!.children.map((c) => c.id)).toEqual([step.id]);
  });

  test("l'agente NUOVO può chiudere lo step ereditato, anche dopo che `release` ha azzerato il legame", () => {
    // È il deadlock del 18/08 preso di petto. `assigned_topic_id` è stato di
    // DISPATCH e `release` lo azzera mentre il turno gira ancora: se la
    // provenienza restasse al topic morto, `isOwnStep` direbbe di no e l'agente
    // nuovo prenderebbe 409 sul proprio step. È la provenienza a scioglierlo.
    const { db, s } = setup();
    const parent = s.create({ projectId: PID, text: "Il task padre" });
    s.bindTopic({ taskId: parent.id, topicId: "topic-a", freshSession: true });
    const step = s.create({ projectId: PID, text: "Step ereditato", parentTaskId: parent.id });
    daTopic(db, step.id, "topic-a", "in_progress");

    s.bindTopic({ taskId: parent.id, topicId: "topic-b", freshSession: true });
    // Il dispatcher rilascia il padre mentre il turno di topic-b continua.
    db.prepare("UPDATE tasks SET assigned_topic_id = NULL, dispatch_state = 'queued' WHERE id = ?").run(parent.id);

    const chiuso = s.update({
      taskId: step.id, actor: "agent", by: "topic-b",
      patch: { status: "done" }, agentTopicId: "topic-b",
    });
    expect(chiuso.status).toBe("done");
  });

  test("la nota nel thread dice quale dei due è successo, e a quanti", () => {
    const { db, s } = setup();
    const parent = s.create({ projectId: PID, text: "Il task padre" });
    s.bindTopic({ taskId: parent.id, topicId: "topic-a", freshSession: true });
    const fatto = s.create({ projectId: PID, text: "Step finito", parentTaskId: parent.id });
    const aperto = s.create({ projectId: PID, text: "Step rimasto a meta", parentTaskId: parent.id });
    daTopic(db, fatto.id, "topic-a", "done");
    daTopic(db, aperto.id, "topic-a", "in_progress");

    s.bindTopic({ taskId: parent.id, topicId: "topic-b", freshSession: true });

    const nota = s.get(parent.id)!.comments.find((c) => c.author === "system" && c.content.includes("topic-a"));
    expect(nota, "nota di sistema con il topic vecchio").toBeTruthy();
    expect(nota!.content).toContain("topic-b");
    expect(nota!.content, "un archiviato, al singolare").toContain("1 sottotask completato archiviato");
    expect(nota!.content, "un ereditato, al singolare").toContain("1 sottotask incompleto ereditato");
    expect(nota!.content, "e QUALE step si eredita, non solo quanti").toContain("- Step rimasto a meta");
    expect(nota!.content, "lo step archiviato non si rielenca: è cronaca chiusa").not.toContain("- Step finito");
  });

  test("solo `done`: la nota parla di archiviazione e basta", () => {
    const { db, s } = setup();
    const parent = s.create({ projectId: PID, text: "Padre" });
    s.bindTopic({ taskId: parent.id, topicId: "topic-a", freshSession: true });
    const fatto = s.create({ projectId: PID, text: "Solo questo", parentTaskId: parent.id });
    daTopic(db, fatto.id, "topic-a", "done");

    s.bindTopic({ taskId: parent.id, topicId: "topic-b", freshSession: true });

    const nota = s.get(parent.id)!.comments.find((c) => c.author === "system" && c.content.includes("topic-a"))!;
    expect(nota.content).toContain("archiviato");
    expect(nota.content, "niente eredità: non c'era niente di aperto").not.toContain("ereditat");
  });

  test("niente sottotask del topic morto: nessuna nota (la board non si sporca per niente)", () => {
    const { s } = setup();
    const parent = s.create({ projectId: PID, text: "Padre senza step" });
    s.bindTopic({ taskId: parent.id, topicId: "topic-a", freshSession: true });

    s.bindTopic({ taskId: parent.id, topicId: "topic-b", freshSession: true });

    const note = s.get(parent.id)!.comments.filter((c) => c.author === "system" && c.content.includes("Sessione cambiata"));
    expect(note.length, "nessun figlio, nessuna nota").toBe(0);
  });

  test("senza freshSession (ripresa) non si tocca niente", () => {
    const { db, s } = setup();
    const parent = s.create({ projectId: PID, text: "Task ripreso" });
    s.bindTopic({ taskId: parent.id, topicId: "topic-a", freshSession: true });
    const child = s.create({ projectId: PID, text: "Step", parentTaskId: parent.id });
    daTopic(db, child.id, "topic-a", "in_progress");

    s.bindTopic({ taskId: parent.id, topicId: "topic-a" });

    const r = rigaDi(db, child.id);
    expect(r.archived ?? 0, "stesso topic: figlio non toccato").toBe(0);
    expect(r.status, "e nemmeno lo stato: il turno è LO STESSO").toBe("in_progress");
  });

  test("figli creati da altri topic non vengono toccati, né archiviati né riassegnati", () => {
    const { db, s } = setup();
    db.prepare("INSERT INTO topics (id) VALUES ('topic-c')").run();
    const parent = s.create({ projectId: PID, text: "Task padre" });
    s.bindTopic({ taskId: parent.id, topicId: "topic-a", freshSession: true });

    const daA = s.create({ projectId: PID, text: "Da topic A", parentTaskId: parent.id });
    const daC = s.create({ projectId: PID, text: "Da topic C / umano", parentTaskId: parent.id });
    daTopic(db, daA.id, "topic-a", "in_progress");
    daTopic(db, daC.id, "topic-c", "in_progress");

    s.bindTopic({ taskId: parent.id, topicId: "topic-b", freshSession: true });

    const a = rigaDi(db, daA.id);
    expect(a.status, "il proprio: ereditato").toBe("todo");
    expect(a.topic).toBe("topic-b");
    const c = rigaDi(db, daC.id);
    expect(c.archived, "l'altrui non si archivia").toBe(0);
    expect(c.status, "e non gli si tocca lo stato").toBe("in_progress");
    expect(c.topic, "né la provenienza: non è roba del tentativo morto").toBe("topic-c");
  });

  test("il TASK non è uno step: la sua provenienza non si riscrive mai", () => {
    // Se il padre stesso portasse `created_by_topic_id = topic-a` (l'ha aperto
    // un agente su quel topic), il taglio sull'albero se lo prenderebbe e gli
    // riscriverebbe stato e provenienza: sarebbe il deliverable rimesso in
    // `todo` da un bind. L'esclusione della radice è quella riga.
    const { db, s } = setup();
    const parent = s.create({ projectId: PID, text: "Padre nato da un agente" });
    s.bindTopic({ taskId: parent.id, topicId: "topic-a", freshSession: true });
    daTopic(db, parent.id, "topic-a", "in_progress");

    s.bindTopic({ taskId: parent.id, topicId: "topic-b", freshSession: true });

    const r = rigaDi(db, parent.id);
    expect(r.status, "il deliverable non torna in todo").toBe("in_progress");
    expect(r.topic, "e resta figlio di chi l'ha aperto").toBe("topic-a");
    expect(r.archived).toBe(0);
  });

  test("la riga di stato la scrive chi sposta: lo step ereditato non cambia colonna da solo", () => {
    // Ogni altra porta che sposta un task scrive l'evento. Senza, il drawer
    // dello step (che È navigabile) mostra una colonna cambiata e nessuno che
    // l'abbia cambiata. Il `from` è quello VERO, come in `resolveParkedChildren`.
    const { db, s } = setup();
    const parent = s.create({ projectId: PID, text: "Padre" });
    s.bindTopic({ taskId: parent.id, topicId: "topic-a", freshSession: true });
    const step = s.create({ projectId: PID, text: "Step al lavoro", parentTaskId: parent.id });
    const fermo = s.create({ projectId: PID, text: "Step gia' in todo", parentTaskId: parent.id });
    daTopic(db, step.id, "topic-a", "in_progress");
    daTopic(db, fermo.id, "topic-a", "todo");

    s.bindTopic({ taskId: parent.id, topicId: "topic-b", freshSession: true });

    const eventsOf = (id: string) =>
      (db.prepare("SELECT content FROM task_comments WHERE task_id = ? AND kind = 'status'").all(id) as any[])
        .map((r) => r.content);
    expect(eventsOf(step.id).join(" "), "in_progress -> todo, scritto").toContain("todo");
    expect(eventsOf(step.id).length).toBe(1);
    expect(
      eventsOf(fermo.id),
      "gia' in todo: non si e' mosso, e non deve inventarsi un passaggio",
    ).toEqual([]);
  });

  test("uno step in `review` non lascia dietro un'approvazione che nessuno puo' piu' chiudere", () => {
    // `reviewDecision` rifiuta un task che in review non c'e' piu': se la riga
    // resta `pending`, resta pendente per sempre. È la perdita che la migration
    // 068 ha dovuto ripulire una volta.
    const { db, s } = setup();
    const parent = s.create({ projectId: PID, text: "Padre" });
    s.bindTopic({ taskId: parent.id, topicId: "topic-a", freshSession: true });
    const step = s.create({ projectId: PID, text: "Step consegnato", parentTaskId: parent.id });
    daTopic(db, step.id, "topic-a");
    // Il cancello sulla consegna muta vuole il riassunto del turno: e' la
    // strada vera, e senza non si arriva nemmeno a `review`.
    s.update({
      taskId: step.id, actor: "agent", by: "topic-a",
      patch: { status: "review", summary: "Fatto, guarda qui." }, agentTopicId: "topic-a",
    });
    const pendenti = () =>
      (db.prepare(
        "SELECT COUNT(*) AS c FROM approvals WHERE task_id = ? AND approval_type = 'review' AND status = 'pending'",
      ).get(step.id) as any).c;
    expect(pendenti(), "premessa: l'approvazione c'e' davvero").toBe(1);

    s.bindTopic({ taskId: parent.id, topicId: "topic-b", freshSession: true });

    expect(rigaDi(db, step.id).status, "lo step torna lavorabile").toBe("todo");
    expect(pendenti(), "e l'approvazione e' chiusa, non abbandonata").toBe(0);
  });

  test("lo step ereditato non porta con se' il parcheggio del tentativo morto", () => {
    // Le stesse colonne che `resolveParkedChildren` azzera rimettendo in coda un
    // figlio: un mandato nuovo, non un residuo. Una finestra di rinvio rimasta
    // sopra vuol dire uno step che dice «in coda» dentro una coda che non lo serve.
    const { db, s } = setup();
    const parent = s.create({ projectId: PID, text: "Padre" });
    s.bindTopic({ taskId: parent.id, topicId: "topic-a", freshSession: true });
    const step = s.create({ projectId: PID, text: "Step incagliato", parentTaskId: parent.id });
    daTopic(db, step.id, "topic-a", "in_progress");
    db.prepare(
      "UPDATE tasks SET dispatch_state = 'failed', dispatch_error = 'esploso', " +
        "dispatch_attempts = 4, dispatch_deferred_until = '2099-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(step.id);

    s.bindTopic({ taskId: parent.id, topicId: "topic-b", freshSession: true });

    const r = db.prepare(
      "SELECT dispatch_state, dispatch_error, dispatch_attempts, dispatch_deferred_until AS until FROM tasks WHERE id = ?",
    ).get(step.id) as any;
    expect(r.dispatch_state).toBe(null);
    expect(r.dispatch_error).toBe(null);
    expect(r.dispatch_attempts).toBe(0);
    expect(r.until, "la finestra di rinvio del tentativo morto non vincola quello nuovo").toBe(null);
  });

  test("annidati: anche lo step DELLO step cambia padrone, non solo il primo livello", () => {
    // Il buco che il taglio sui figli diretti lascerebbe: il nipote resterebbe
    // col topic morto, e sarebbe l'unico che nessuno può chiudere — un livello
    // più sotto, lo stesso deadlock.
    const { db, s } = setup();
    const parent = s.create({ projectId: PID, text: "Padre" });
    s.bindTopic({ taskId: parent.id, topicId: "topic-a", freshSession: true });
    const step = s.create({ projectId: PID, text: "Step", parentTaskId: parent.id });
    const sotto = s.create({ projectId: PID, text: "Sotto-step", parentTaskId: step.id });
    daTopic(db, step.id, "topic-a", "in_progress");
    daTopic(db, sotto.id, "topic-a", "in_progress");

    s.bindTopic({ taskId: parent.id, topicId: "topic-b", freshSession: true });

    for (const id of [step.id, sotto.id]) {
      const r = rigaDi(db, id);
      expect(r.archived).toBe(0);
      expect(r.status).toBe("todo");
      expect(r.topic, "a ogni profondità").toBe("topic-b");
    }
  });

  test("un aperto appeso a uno step `done` se ne va con lui: non resta a pendere dal vuoto", () => {
    const { db, s } = setup();
    const parent = s.create({ projectId: PID, text: "Padre" });
    s.bindTopic({ taskId: parent.id, topicId: "topic-a", freshSession: true });
    const fatto = s.create({ projectId: PID, text: "Step chiuso", parentTaskId: parent.id });
    const sotto = s.create({ projectId: PID, text: "Sotto-step aperto", parentTaskId: fatto.id });
    daTopic(db, fatto.id, "topic-a", "done");
    daTopic(db, sotto.id, "topic-a", "in_progress");

    s.bindTopic({ taskId: parent.id, topicId: "topic-b", freshSession: true });

    expect(rigaDi(db, fatto.id).archived).toBe(1);
    expect(rigaDi(db, sotto.id).archived, "la cascata se lo porta: il suo passo non esiste più").toBe(1);
    // E la nota non lo elenca fra gli ereditati.
    const nota = s.get(parent.id)!.comments.find((c) => c.author === "system" && c.content.includes("Sessione cambiata"))!;
    expect(nota.content).not.toContain("- Sotto-step aperto");
  });
});

/**
 * IL CHIP «IN CODA» SU UNA CARD CHE NESSUNO METTERÀ IN CODA.
 *
 * Il claim del dispatcher pesca `status = 'todo'` e basta. Una card trascinata
 * fuori da Todo esce quindi dalla coda per sempre — ma il chip `queued`
 * restava acceso, promettendo una partenza che non arriva, e con lui il tasto
 * «Ferma»: l'offerta di interrompere un agente mai nato.
 *
 * Segnalato il 19/08 («l'ho spostato in backlog, ho premuto, non è successo
 * nulla») e riprodotto sull'API viva prima di scrivere la riga: `todo/queued`
 * → PATCH `backlog` → `backlog/queued`.
 */
describe("uscire da Todo spegne il chip della coda", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  const inCoda = (stato: "backlog" | "in_progress" | "review" | "done") => {
    const t = s.create({ projectId: PID, text: "c", status: "todo" });
    db.prepare("UPDATE tasks SET dispatch_state = 'queued' WHERE id = ?").run(t.id);
    return s.update({ taskId: t.id, actor: "human", by: "u", patch: { status: stato } });
  };

  test.each(["backlog", "in_progress", "review", "done"] as const)(
    "todo → %s: il chip si spegne", (dove) => { expect(inCoda(dove).dispatchState).toBeNull(); },
  );

  test("restare in Todo NON spegne il chip (un riordino non è un'uscita)", () => {
    const t = s.create({ projectId: PID, text: "c", status: "todo" });
    db.prepare("UPDATE tasks SET dispatch_state = 'queued' WHERE id = ?").run(t.id);
    const r = s.update({ taskId: t.id, actor: "human", by: "u", patch: { status: "todo", priority: 1 } });
    expect(r.dispatchState).toBe("queued");
  });

  test("un turno VIVO non lo chiude un trascinamento: 'working' sopravvive", () => {
    // Quello lo chiude chi lo possiede (`/stop`, che taglia il turno prima di
    // parcheggiare). Spegnerlo qui vorrebbe dire perdere di vista un agente che
    // sta ancora scrivendo file.
    const t = s.create({ projectId: PID, text: "c", status: "todo" });
    db.prepare("UPDATE tasks SET dispatch_state = 'working' WHERE id = ?").run(t.id);
    expect(s.update({ taskId: t.id, actor: "human", by: "u", patch: { status: "backlog" } }).dispatchState).toBe("working");
  });
});

/**
 * L'ANTEPRIMA DELLA DESCRIZIONE parte da dove comincia la sostanza.
 *
 * Segnalato guardando una card: «anche la descrizione non ha senso». Su
 * `235afe11` i 240 caratteri che la card mostra erano metà preambolo — «Potremmo
 * fare una roba molto figa per poter assicurarci che il nostro browser ide sia
 * effettivamente perfetto e interessante.» — e il secondo punto elenco finiva
 * tagliato a metà. Quello che c'era da fare stava sotto.
 *
 * È un taglio STRUTTURALE, non un giudizio sul contenuto: non si decide che una
 * frase è inutile, si osserva che chi scrive mette i punti sotto un cappello e
 * che i punti sono la parte che si legge. Il preambolo non si perde: il drawer
 * mostra la descrizione intera.
 */
describe("anteprima della descrizione", () => {
  const svc2 = () => createTaskService(freshDb());

  test("IL CASO 235afe11: salta il cappello lungo e parte dall'elenco", () => {
    const s = svc2();
    const t = s.create({
      projectId: PID, text: "x",
      description: "Potremmo fare una roba molto figa per poter assicurarci che il nostro browser ide sia effettivamente perfetto e interessante.\n- Omologare la cronologia delle tab.\n- Metterlo come menu nella sidebar.",
    });
    const [card] = s.list({ scope: "all", rootsOnly: true }).filter((r) => r.id === t.id);
    expect(card!.descriptionPreview!.startsWith("- Omologare")).toBe(true);
    // IL TESTO INTERO RESTA, e si legge dal DETTAGLIO — non dalla lista, che
    // per costruzione non trasporta `description` (sono 470 KB: e' la ragione
    // per cui il taglio sta in SQL). Qui si sceglie solo da dove partono i 240
    // caratteri che stanno sulla card.
    expect(s.get(t.id)?.task.description).toContain("Potremmo fare una roba");
  });

  /**
   * UN CAPPELLO CORTO È GIÀ IL PUNTO: «Tre cose da fare:» vale più del primo
   * elenco, e saltarlo perderebbe l'unica frase che inquadra la lista.
   */
  test("un cappello corto NON si salta", () => {
    const s = svc2();
    const t = s.create({ projectId: PID, text: "x", description: "Tre cose da fare:\n- una\n- due" });
    const [card] = s.list({ scope: "all", rootsOnly: true }).filter((r) => r.id === t.id);
    expect(card!.descriptionPreview!.startsWith("Tre cose da fare:")).toBe(true);
  });

  test("senza elenco l'anteprima resta l'inizio del testo", () => {
    const s = svc2();
    const t = s.create({ projectId: PID, text: "x", description: "Una descrizione lunga ".repeat(20) });
    const [card] = s.list({ scope: "all", rootsOnly: true }).filter((r) => r.id === t.id);
    expect(card!.descriptionPreview!.startsWith("Una descrizione lunga")).toBe(true);
  });

  test("il tetto resta 240 caratteri: la lista non trasporta le descrizioni intere", () => {
    const s = svc2();
    const t = s.create({ projectId: PID, text: "x", description: "y".repeat(5000) });
    const [card] = s.list({ scope: "all", rootsOnly: true }).filter((r) => r.id === t.id);
    expect(card!.descriptionPreview!.length).toBe(240);
  });
});
