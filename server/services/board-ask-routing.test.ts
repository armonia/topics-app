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
import { Database } from "bun:sqlite";
import {
  _resetRoutedAsks,
  answerRoutedAsk,
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
    kind TEXT NOT NULL DEFAULT 'comment'
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
        svc.addComment({
          taskId: a.taskId, author: "agent", content: a.content,
          projectId: a.projectId, questionOptions: a.options,
        });
        return true;
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
    expect(pendingRoutedAsk(taskId)).toEqual({ sessionKey: KID, isChild: true });

    expect(answerRoutedAsk(h.deps, taskId, "Rifare")).toBe(true);
    expect(h.delivered).toEqual([{ sessionKey: KID, answers: { rotta: "Rifare" } }]);
    // La domanda e' chiusa: il commento successivo e' un commento normale.
    expect(pendingRoutedAsk(taskId)).toBeNull();
    expect(answerRoutedAsk(h.deps, taskId, "e un'altra cosa")).toBe(false);
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
    expect(pendingRoutedAsk(taskId)).toEqual({ sessionKey: COORD, isChild: false });
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
    expect(answerRoutedAsk(h.deps, taskId, "   ")).toBe(false);
    expect(h.delivered).toHaveLength(0);
  });
});
