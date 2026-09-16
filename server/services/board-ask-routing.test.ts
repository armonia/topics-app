/**
 * @covers ASK-03
 */
// La BARRA numero 3: una domanda posta da una sessione figlia arriva nel thread
// del task padre e la risposta la sblocca, senza aprire nessun tab.
//
// «Senza aprire nessun tab» è una proprietà verificabile, non un'impressione: la
// domanda deve comparire nei COMMENTI del task (con le sue opzioni, cioè nella
// forma che la card rende come tasti) e la risposta deve partire da lì e
// arrivare al rendez-vous DELLA FIGLIA. Il test guarda entrambe le sponde: se la
// risposta tornasse al coordinatore invece che alla figlia, il thread sarebbe
// giusto e la sessione resterebbe ferma per sempre.
import { test, expect, describe, beforeEach } from "bun:test";
import { AskWaitError, beginAsk, cancelAsk, endAsk, waitForAnswer } from "../lib/ask-user-bridge";
import { Database } from "bun:sqlite";
import {
  _resetRoutedAsks,
  answerRoutedAsk,
  clearRoutedAsk,
  normalizeAsk,
  pendingRoutedAsk,
  routeAskToTaskThread,
} from "./board-ask-routing";
import { createTaskService, type TaskService } from "./tasks";
import { topicSessionKey } from "./agent-census";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment',
    -- migration 20260904190855: the assistant row an agent said this in.
    message_id TEXT
  )`);
  // `terminal_sessions` arriva da TASKS_FK_STUBS_DDL: il claim la legge.
  return db;
}

const TOPIC = "topic-c";
const COORD = topicSessionKey(TOPIC);
const KID = "kid-1";

function harness(db: Database, svc: TaskService) {
  const delivered: Array<{ sessionKey: string; answers: Record<string, string> }> = [];
  return {
    delivered,
    deps: {
      db,
      comment: (a: { taskId: string; projectId: string; content: string; options: string[] }) => {
        const written = svc.addComment({
          taskId: a.taskId, author: "agent", content: a.content,
          projectId: a.projectId, questionOptions: a.options,
        });
        return written?.id ?? null;
      },
      deliver: (sessionKey: string, answers: Record<string, string>) => {
        delivered.push({ sessionKey, answers });
        return true;
      },
    },
  };
}

describe("normalizeAsk", () => {
  test("prende testo, chiave e opzioni, sia stringhe che oggetti con label", () => {
    expect(normalizeAsk([{ key: "scelta", question: "A o B?", options: ["A", { label: "B" }] }]))
      .toEqual({ key: "scelta", text: "A o B?", options: ["A", "B"] });
  });
  test("senza chiave ripiega sull'header, poi su 'answer'", () => {
    expect(normalizeAsk([{ header: "Rotta", question: "Dove?" }])?.key).toBe("Rotta");
    expect(normalizeAsk([{ question: "Dove?" }])?.key).toBe("answer");
  });
  test("una domanda senza testo non e' una domanda", () => {
    expect(normalizeAsk([{ question: "  " }])).toBeNull();
    expect(normalizeAsk([])).toBeNull();
  });
});

describe("la domanda di una figlia esce nel thread del task", () => {
  let db: Database; let svc: TaskService; let taskId: string;
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    _resetRoutedAsks();
    db = freshDb();
    svc = createTaskService(db);
    const t = svc.create({ projectId: "proj-a", text: "coordina" });
    taskId = t.id;
    db.run("UPDATE tasks SET status='in_progress', dispatch_state='working', assigned_topic_id=? WHERE id=?", [TOPIC, taskId]);
    db.run(
      "INSERT INTO terminal_sessions (id, name, cwd, type, created_at, status, parent_session_key) VALUES (?, ?, '/w', 'claude-code', '2026-08-12', 'active', ?)",
      [KID, KID, COORD],
    );
    h = harness(db, svc);
  });

  test("la domanda diventa un commento del task, con le sue opzioni", () => {
    const out = routeAskToTaskThread(h.deps, {
      sessionKey: KID,
      questions: [{ key: "rotta", question: "Rifaccio il parser o lo rattoppo?", options: ["Rifare", "Rattoppare"] }],
    });
    expect(out?.taskId).toBe(taskId);
    const comments = svc.get(taskId)?.comments ?? [];
    const last = comments[comments.length - 1];
    expect(last.content).toContain("Rifaccio il parser o lo rattoppo?");
    // Chi chiede va detto: e' una sessione di lavoro, non il coordinatore.
    expect(last.content).toContain("sessione di lavoro");
    // Le opzioni ci sono, nella forma che la card rende come tasti.
    expect(last.content).toContain("Rifare");
    expect(last.content).toContain("Rattoppare");
  });

  test("la risposta dal thread torna ALLA FIGLIA, non al coordinatore", () => {
    routeAskToTaskThread(h.deps, {
      sessionKey: KID,
      questions: [{ key: "rotta", question: "Rifare o rattoppare?", options: ["Rifare", "Rattoppare"] }],
    });
    expect(pendingRoutedAsk(taskId)).toMatchObject({ sessionKey: KID, isChild: true });

    expect(answerRoutedAsk(h.deps, taskId, "Rifare").delivered).toBe(true);
    expect(h.delivered).toEqual([{ sessionKey: KID, answers: { rotta: "Rifare" } }]);
    // La domanda e' chiusa: il commento successivo e' un commento normale.
    expect(pendingRoutedAsk(taskId)).toBeNull();
    expect(answerRoutedAsk(h.deps, taskId, "e un'altra cosa").delivered).toBe(false);
    expect(h.delivered).toHaveLength(1);
  });

  test("le gambe successive dello stesso rendez-vous non ripetono il commento", () => {
    const q = [{ key: "rotta", question: "Rifare o rattoppare?", options: ["Rifare"] }];
    const prima = (svc.get(taskId)?.comments ?? []).length;
    for (let i = 0; i < 5; i++) routeAskToTaskThread(h.deps, { sessionKey: KID, questions: q });
    expect((svc.get(taskId)?.comments ?? []).length).toBe(prima + 1);
  });

  test("anche il coordinatore puo' chiedere, e si vede che e' lui", () => {
    routeAskToTaskThread(h.deps, { sessionKey: COORD, questions: [{ question: "Procedo?", options: ["Si"] }] });
    expect(pendingRoutedAsk(taskId)).toMatchObject({ sessionKey: COORD, isChild: false });
    const comments = svc.get(taskId)?.comments ?? [];
    expect(comments[comments.length - 1].content).toContain("Domanda a meta' turno");
  });

  test("una chat dell'umano non instrada niente: la sua domanda resta nel suo tab", () => {
    const prima = (svc.get(taskId)?.comments ?? []).length;
    expect(routeAskToTaskThread(h.deps, { sessionKey: topicSessionKey("topic-libero"), questions: [{ question: "Eh?" }] })).toBeNull();
    expect((svc.get(taskId)?.comments ?? []).length).toBe(prima);
    expect(h.delivered).toHaveLength(0);
  });

  test("una risposta vuota non sblocca niente, e non lascia la domanda appesa", () => {
    routeAskToTaskThread(h.deps, { sessionKey: KID, questions: [{ question: "Rifare o rattoppare?" }] });
    expect(answerRoutedAsk(h.deps, taskId, "   ").delivered).toBe(false);
    expect(h.delivered).toHaveLength(0);
  });
});

/**
 * TWO SESSIONS OF ONE TASK, which is the normal shape and not a corner: a
 * coordinator and its children sit on the same taskId by construction
 * (`boardTaskForSession`), and the registry of open questions is keyed there.
 *
 * THE DEFECT REPRODUCED. The second question evicted the first without writing
 * anything, and `answerRoutedAsk` delivered under the CURRENT key: the person
 * read the FIRST session's confirmation, clicked confirm, and the yes
 * reached the second one - a consent given for one message and spent on
 * another, to a different recipient. The rendez-vous here is the REAL one
 * (`beginAsk`/`waitForAnswer`, in-memory), because "the old one is alive" is
 * exactly the fact that decides who keeps the card.
 *
 * @covers OUTBOUND-03
 * @covers ASK-03
 */
describe("two questions on one card", () => {
  let db: Database; let svc: TaskService; let taskId: string;
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    _resetRoutedAsks();
    cancelAsk(KID, "test cleanup");
    cancelAsk(COORD, "test cleanup");
    db = freshDb();
    svc = createTaskService(db);
    const t = svc.create({ projectId: "proj-a", text: "coordina" });
    taskId = t.id;
    db.run("UPDATE tasks SET status='in_progress', dispatch_state='working', assigned_topic_id=? WHERE id=?", [TOPIC, taskId]);
    db.run(
      "INSERT INTO terminal_sessions (id, name, cwd, type, created_at, status, parent_session_key) VALUES (?, ?, '/w', 'claude-code', '2026-08-12', 'active', ?)",
      [KID, KID, COORD],
    );
    h = harness(db, svc);
  });

  const lineAt = (n: number) => (svc.get(taskId)?.comments ?? []).map((c) => c.content)[n];
  const lines = () => (svc.get(taskId)?.comments ?? []).length;

  test("the second one stays out while the first waits, and the yes stays the first's", () => {
    beginAsk(KID);
    const first = routeAskToTaskThread(h.deps, {
      sessionKey: KID,
      questions: [{ key: "outbound:aaa", question: "Preventivo -> cliente@esempio.test. Confermi?", options: ["Conferma"] }],
    });
    expect(first?.shown).toBe(true);
    const afterFirst = lines();

    // The OTHER session of the same task asks for its own confirmation.
    beginAsk(COORD);
    const second = routeAskToTaskThread(h.deps, {
      sessionKey: COORD,
      questions: [{ key: "outbound:bbb", question: "Credenziali -> attaccante@esempio.test. Confermi?", options: ["Conferma"] }],
    });
    // It did not come out: no extra row in the thread, and its caller knows.
    expect(second?.shown).toBe(false);
    expect(second?.busy?.sessionKey).toBe(KID);
    expect(lines()).toBe(afterFirst);
    // The registry is still the first one's: that is the question on screen.
    expect(pendingRoutedAsk(taskId)?.sessionKey).toBe(KID);

    // The yes read on the first question goes to the first session, its key.
    expect(answerRoutedAsk(h.deps, taskId, "Conferma").delivered).toBe(true);
    expect(h.delivered).toEqual([{ sessionKey: KID, answers: { "outbound:aaa": "Conferma" } }]);
  });

  test("when nobody waits on the first, the second takes over, says so, and the old leg fails", async () => {
    beginAsk(KID);
    routeAskToTaskThread(h.deps, {
      sessionKey: KID,
      questions: [{ key: "outbound:aaa", question: "Preventivo -> cliente@esempio.test. Confermi?", options: ["Conferma"] }],
    });
    // KID's turn died under the panel: no active ask, but a leg still in flight
    // that would come back to collect an answer.
    const legInFlight = waitForAnswer(KID, { timeoutMs: 5_000 });
    const ending = legInFlight.then(() => "delivered").catch((e) => (e instanceof AskWaitError ? e.code : "other"));
    endAsk(KID);

    const second = routeAskToTaskThread(h.deps, {
      sessionKey: COORD,
      questions: [{ key: "outbound:bbb", question: "Fattura -> cliente@esempio.test. Confermi?", options: ["Conferma"] }],
    });
    expect(second?.shown).toBe(true);
    // THE LINE IS THERE across sessions too: it used to be written only for the
    // same session.
    expect(lineAt(lines() - 2)).toContain("non aspetta pi\u00f9 una risposta");
    // And the old leg fails with its own reason instead of collecting a yes
    // that was given to another question.
    expect(await ending).toBe("cancelled");
    expect(pendingRoutedAsk(taskId)?.sessionKey).toBe(COORD);
  });

  test("an answer that names a superseded question is not delivered", () => {
    beginAsk(KID);
    const first = routeAskToTaskThread(h.deps, {
      sessionKey: KID,
      questions: [{ key: "outbound:aaa", question: "Preventivo -> cliente@esempio.test. Confermi?", options: ["Conferma"] }],
    });
    const oldId = first?.askId ?? "";
    expect(oldId).toBeTruthy();
    endAsk(KID);
    const second = routeAskToTaskThread(h.deps, {
      sessionKey: COORD,
      questions: [{ key: "outbound:bbb", question: "Fattura -> cliente@esempio.test. Confermi?", options: ["Conferma"] }],
    });
    expect(second?.askId).not.toBe(oldId);

    // The person clicks the confirm button on the OLD row - the card they had
    // in front of them. That is not a yes for the question open now.
    const outcome = answerRoutedAsk(h.deps, taskId, "Conferma", { askId: oldId });
    expect(outcome.delivered).toBe(false);
    expect(outcome.stale).toEqual({ askId: oldId, open: second!.askId! });
    expect(h.delivered).toHaveLength(0);
    // And the open question stays open: an answer that was not its own did not
    // close it.
    expect(pendingRoutedAsk(taskId)?.askId).toBe(second!.askId!);

    // Answering THAT one, instead, is delivered.
    expect(answerRoutedAsk(h.deps, taskId, "Conferma", { askId: second!.askId! }).delivered).toBe(true);
    expect(h.delivered).toEqual([{ sessionKey: COORD, answers: { "outbound:bbb": "Conferma" } }]);
  });

  // ONE SESSION, TWO REQUESTS - and the rule used to read "the same session
  // always replaces, the CLI blocks on one question at a time". The code
  // shipped says otherwise: `topics-mcp-server.ts` handles every JSON-RPC line
  // in a callback it does not await, so two `send_mail` of one message run
  // together on one session, and the route is callable by hand anyway.
  // Reproduced 120 ms apart: the second confirmation took the first one's place
  // and the card carried two blocks of buttons, one of them unanswerable.
  test("the same session does NOT replace its own live question: it is told the card is taken", () => {
    beginAsk(KID);
    const first = routeAskToTaskThread(h.deps, {
      sessionKey: KID,
      questions: [{ key: "outbound:aaa", question: "Preventivo -> cliente@esempio.test. Confermi?", options: ["Conferma"] }],
    });
    expect(first?.shown).toBe(true);
    const afterFirst = lines();

    const second = routeAskToTaskThread(h.deps, {
      sessionKey: KID,
      questions: [{ key: "outbound:bbb", question: "Credenziali -> attaccante@esempio.test. Confermi?", options: ["Conferma"] }],
    });
    expect(second?.shown).toBe(false);
    expect(second?.busy?.sessionKey).toBe(KID);
    // Nothing written: the card keeps ONE confirmation to read.
    expect(lines()).toBe(afterFirst);
    expect(pendingRoutedAsk(taskId)?.askId).toBe(first!.askId!);
    // And the yes read on it pays for the message it names, not the other one.
    expect(answerRoutedAsk(h.deps, taskId, "Conferma", { askId: first!.askId! }).delivered).toBe(true);
    expect(h.delivered).toEqual([{ sessionKey: KID, answers: { "outbound:aaa": "Conferma" } }]);
  });

  test("a question nobody waits on any more is replaced, by its own session too", () => {
    beginAsk(KID);
    routeAskToTaskThread(h.deps, { sessionKey: KID, questions: [{ key: "leftover", question: "Left by an interrupted turn?" }] });
    // The turn died under the panel: the rendez-vous is gone, the entry is not.
    // Holding the card for it would make every later confirmation of this
    // session refuse for a question nobody can answer.
    endAsk(KID);
    const now = routeAskToTaskThread(h.deps, {
      sessionKey: KID,
      questions: [{ key: "outbound:aaa", question: "Preventivo -> cliente@esempio.test. Confermi?", options: ["Conferma"] }],
    });
    expect(now?.shown).toBe(true);
    expect(pendingRoutedAsk(taskId)?.askId).toBe(now!.askId!);
  });

  // THE LOSER MUST NOT CLEAR WHAT IS NOT ITS. The clear used to take a
  // sessionKey and delete every entry of that session: on one session the leg
  // that was refused deleted the entry of the leg that WON, so the confirmation
  // stayed on screen with its buttons while `pendingRoutedAsk` answered null -
  // the click reached nothing and the card said nothing.
  test("clearing by id leaves another question alone", () => {
    beginAsk(KID);
    const first = routeAskToTaskThread(h.deps, {
      sessionKey: KID,
      questions: [{ key: "outbound:aaa", question: "Preventivo -> cliente@esempio.test. Confermi?", options: ["Conferma"] }],
    });
    // The id of a question that is not on the card: the refused leg has none of
    // its own, and whatever it names must not touch this one.
    clearRoutedAsk("c-mai-scritto");
    expect(pendingRoutedAsk(taskId)?.askId).toBe(first!.askId!);
    clearRoutedAsk(first!.askId!);
    expect(pendingRoutedAsk(taskId)).toBeNull();
  });
});
