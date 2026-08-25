/**
 * task-tab-persist.test — la tab che l'agente apre su un task dispatchato deve
 * esistere ANCHE se nessun client è connesso: il reducer è un mirror di quello
 * del client (idempotente per contextId) e la scrittura passa dal db.
 *
 * @covers RETIRE-07
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  parseTaskTabs,
  upsertTaskTab,
  persistAgentTaskTab,
  taskTabsKeyFor,
  EMPTY_TASK_TABS,
} from "./task-tab-persist";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE ui_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    payload_version INTEGER NOT NULL DEFAULT 2,
    server_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  )`);
  return db;
}

describe("parseTaskTabs", () => {
  it("torna vuoto su qualunque valore non riconoscibile", () => {
    expect(parseTaskTabs(null)).toEqual(EMPTY_TASK_TABS);
    expect(parseTaskTabs("nope")).toEqual(EMPTY_TASK_TABS);
    expect(parseTaskTabs({ tabs: "no" })).toEqual(EMPTY_TASK_TABS);
  });

  it("scarta le tab senza contextId e tiene parked/titleSource", () => {
    const s = parseTaskTabs({
      tabs: [{ url: "u" }, { contextId: "task-aa-0", url: "u", title: "T", seq: 0, parked: true, titleSource: "user" }],
      activeContextId: "task-aa-0",
      nextSeq: 1,
    });
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toEqual({ contextId: "task-aa-0", url: "u", title: "T", seq: 0, parked: true, titleSource: "user" });
    expect(s.activeContextId).toBe("task-aa-0");
  });

  it("tiene nextSeq oltre il seq massimo anche se il record mente", () => {
    const s = parseTaskTabs({ tabs: [{ contextId: "c", url: "", title: "", seq: 7 }], nextSeq: 1 });
    expect(s.nextSeq).toBe(8);
  });

  it("azzera un activeContextId che non punta a nessuna tab", () => {
    const s = parseTaskTabs({ tabs: [{ contextId: "c", url: "", title: "", seq: 0 }], activeContextId: "ghost" });
    expect(s.activeContextId).toBeNull();
  });
});

describe("upsertTaskTab", () => {
  it("appende una tab nuova e la attiva", () => {
    const s = upsertTaskTab(EMPTY_TASK_TABS, "task-aa-a11", "https://x.test");
    expect(s.tabs).toEqual([{ contextId: "task-aa-a11", url: "https://x.test", title: "", seq: 0 }]);
    expect(s.activeContextId).toBe("task-aa-a11");
    expect(s.nextSeq).toBe(1);
  });

  it("è idempotente sul contextId: rinfresca, non duplica", () => {
    const a = upsertTaskTab(EMPTY_TASK_TABS, "ctx", "https://a.test");
    const b = upsertTaskTab(a, "ctx", "https://b.test");
    expect(b.tabs).toHaveLength(1);
    expect(b.tabs[0].url).toBe("https://b.test");
    expect(b.nextSeq).toBe(1);
  });

  it("riapre (un-parca) e riattiva una tab parcheggiata", () => {
    const parked = { tabs: [{ contextId: "ctx", url: "u", title: "T", seq: 0, parked: true }], activeContextId: null, nextSeq: 1 };
    const s = upsertTaskTab(parked, "ctx", "u2");
    expect(s.tabs[0].parked).toBe(false);
    expect(s.activeContextId).toBe("ctx");
  });

  it("non perde le tab già presenti sotto altri ctx", () => {
    const a = upsertTaskTab(EMPTY_TASK_TABS, "one", "https://a.test");
    const b = upsertTaskTab(a, "two", "https://b.test");
    expect(b.tabs.map((t) => t.contextId)).toEqual(["one", "two"]);
    expect(b.tabs[1].seq).toBe(1);
  });
});

describe("persistAgentTaskTab", () => {
  let db: Database;
  let sent: any[];
  const broadcast = (m: unknown) => { sent.push(m); };

  beforeEach(() => { db = freshDb(); sent = []; });

  const read = (taskId: string) => {
    const row = db.query("SELECT value, server_seq FROM ui_state WHERE key = ?").get(taskTabsKeyFor(taskId)) as
      | { value: string; server_seq: number }
      | null;
    return row ? { value: JSON.parse(row.value), server_seq: row.server_seq } : null;
  };

  it("scrive il record anche se non c'era (nessun client connesso)", () => {
    expect(persistAgentTaskTab(db, broadcast, "t-1", "task-t1-a99", "https://x.test")).toBe(true);
    expect(read("t-1")!.value.tabs[0]).toMatchObject({ contextId: "task-t1-a99", url: "https://x.test" });
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("ui-state:updated");
    expect(sent[0].key).toBe("task-browser-tabs:t-1");
    // Nessun sourceClientId: la scrittura non è di un client, quindi TUTTI la applicano.
    expect(sent[0].sourceClientId).toBeUndefined();
  });

  it("fonde sulle tab già persistite invece di sovrascriverle", () => {
    persistAgentTaskTab(db, broadcast, "t-1", "ctx-a", "https://a.test");
    persistAgentTaskTab(db, broadcast, "t-1", "ctx-b", "https://b.test");
    const v = read("t-1")!.value;
    expect(v.tabs.map((t: any) => t.contextId)).toEqual(["ctx-a", "ctx-b"]);
    expect(v.activeContextId).toBe("ctx-b");
  });

  it("una riapertura identica non scrive né broadcasta", () => {
    persistAgentTaskTab(db, broadcast, "t-1", "ctx", "https://x.test");
    const before = read("t-1")!.server_seq;
    sent = [];
    expect(persistAgentTaskTab(db, broadcast, "t-1", "ctx", "https://x.test")).toBe(false);
    expect(read("t-1")!.server_seq).toBe(before);
    expect(sent).toHaveLength(0);
  });

  it("alloca un server_seq monotono sopra il MAX globale di ui_state", () => {
    db.run("INSERT INTO ui_state (key, value, payload_version, server_seq) VALUES ('panels', '{}', 2, 41)");
    persistAgentTaskTab(db, broadcast, "t-1", "ctx", "https://x.test");
    expect(read("t-1")!.server_seq).toBe(42);
    expect(sent[0].server_seq).toBe(42);
  });

  it("sopravvive a un record corrotto (JSON invalido) ripartendo da zero", () => {
    db.run("INSERT INTO ui_state (key, value, payload_version, server_seq) VALUES (?, '{not json', 2, 1)", [taskTabsKeyFor("t-1")]);
    expect(persistAgentTaskTab(db, broadcast, "t-1", "ctx", "https://x.test")).toBe(true);
    expect(read("t-1")!.value.tabs).toHaveLength(1);
  });

  it("è un no-op senza taskId o contextId", () => {
    expect(persistAgentTaskTab(db, broadcast, "", "ctx", "u")).toBe(false);
    expect(persistAgentTaskTab(db, broadcast, "t-1", "", "u")).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("non propaga un errore del db: l'apertura del browser non deve fallire", () => {
    const broken = new Database(":memory:"); // niente tabella ui_state
    expect(persistAgentTaskTab(broken, broadcast, "t-1", "ctx", "u")).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
