/**
 * Le tab di un task archiviato se ne vanno — e solo quelle.
 *
 * Schema minimo in `:memory:` (stesso pattern di `tab-resolver.test.ts`): le
 * colonne che compaiono qui SONO il contratto di questo servizio.
 *
 * @covers RETIRE-07
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  purgeTaskBrowserState,
  sweepArchivedTaskBrowserState,
  taskBrowserKeysFor,
  taskSubtreeIds,
  teardownArchivedTaskBrowserState,
  type TaskTabTeardownDeps,
} from "./task-tab-teardown";
import { TASKS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

let db: Database;
let broadcasts: any[];
let destroyed: string[];

function freshDb(): Database {
  const d = new Database(":memory:");
  d.run(`CREATE TABLE ui_state (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    payload_version INTEGER NOT NULL DEFAULT 2, server_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  )`);
  d.run(TASKS_DDL);
  d.run(TASK_LABELS_DDL); // migration 100 — rowToTask la legge per OGNI task
  return d;
}

function putUi(key: string, value: unknown, seq = 1): void {
  db.run("INSERT OR REPLACE INTO ui_state (key, value, payload_version, server_seq) VALUES (?, ?, 2, ?)", [
    key,
    JSON.stringify(value),
    seq,
  ]);
}

function task(id: string, opts: { archived?: boolean; parent?: string; status?: string } = {}): void {
  db.run("INSERT INTO tasks (id, text, status, archived, parent_task_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'p-test', '2026-01-01', '2026-01-01')", [
    id,
    `task ${id}`,
    opts.status ?? "todo",
    opts.archived ? 1 : 0,
    opts.parent ?? null,
  ]);
}

/** Un record tab con N contesti, nella forma che scrive `task-tab-persist`. */
function tabsRecord(contextIds: string[]): unknown {
  return {
    tabs: contextIds.map((contextId, i) => ({ contextId, url: `https://e.test/${i}`, title: `T${i}`, seq: i })),
    activeContextId: contextIds[0] ?? null,
    nextSeq: contextIds.length,
  };
}

function deps(extra: Partial<TaskTabTeardownDeps> = {}): TaskTabTeardownDeps {
  return {
    db,
    broadcastToAll: (m) => broadcasts.push(m),
    destroyContext: async (id) => { destroyed.push(id); },
    ...extra,
  };
}

function keys(): string[] {
  return (db.query("SELECT key FROM ui_state ORDER BY key").all() as { key: string }[]).map((r) => r.key);
}

beforeEach(() => {
  db = freshDb();
  broadcasts = [];
  destroyed = [];
});

describe("purgeTaskBrowserState — le due chiavi, e nient'altro", () => {
  test("cancella tabs + layout del task e lascia in pace tutto il resto", () => {
    task("t-1");
    putUi("task-browser-tabs:t-1", tabsRecord(["task-t1-0"]));
    putUi("task-browser-layout:t-1", { groups: [{ id: "g1", paneIds: ["browser:task-t1-0"] }] });
    putUi("task-browser-tabs:t-2", tabsRecord(["task-t2-0"]));
    putUi("pane-store-v2", { panes: {} });
    putUi("settings", { theme: "dark" });

    const report = purgeTaskBrowserState(deps(), ["t-1"]);

    expect(keys()).toEqual(["pane-store-v2", "settings", "task-browser-tabs:t-2"]);
    expect(report.keysDeleted.sort()).toEqual(["task-browser-layout:t-1", "task-browser-tabs:t-1"]);
    expect(report.bytesFreed).toBeGreaterThan(0);
  });

  test("rilascia i contesti delle tab E i gemelli `_ws` del workspace", () => {
    task("t-1");
    putUi("task-browser-tabs:t-1", tabsRecord(["task-t1-0", "task-t1-nmail"]));

    const report = purgeTaskBrowserState(deps(), ["t-1"]);

    expect(report.contextsReleased).toEqual([
      "task-t1-0", "task-t1-0_ws", "task-t1-nmail", "task-t1-nmail_ws",
    ]);
    expect(destroyed).toEqual(report.contextsReleased);
    expect(broadcasts.map((b) => b.contextId)).toEqual(report.contextsReleased);
    expect(new Set(broadcasts.map((b) => b.type))).toEqual(new Set(["browser:close-pane"]));
  });

  test("idempotente: la seconda passata non trova niente e non chiude niente", () => {
    task("t-1");
    putUi("task-browser-tabs:t-1", tabsRecord(["task-t1-0"]));
    purgeTaskBrowserState(deps(), ["t-1"]);
    broadcasts = []; destroyed = [];

    const again = purgeTaskBrowserState(deps(), ["t-1"]);

    expect(again.keysDeleted).toEqual([]);
    expect(again.bytesFreed).toBe(0);
    expect(destroyed).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  test("un contesto che non esiste (pane nativa) non fa esplodere la purga", () => {
    task("t-1");
    putUi("task-browser-tabs:t-1", tabsRecord(["task-t1-0"]));

    const report = purgeTaskBrowserState(
      deps({ destroyContext: async () => { throw new Error("no such context"); } }),
      ["t-1"],
    );

    expect(report.keysDeleted).toEqual(["task-browser-tabs:t-1"]);
    expect(keys()).toEqual([]);
  });

  test("un layout senza record tabs se ne va lo stesso (nessun contesto da chiudere)", () => {
    task("t-1");
    putUi("task-browser-layout:t-1", { groups: [{ id: "g1", paneIds: ["thread:abc"] }] });

    const report = purgeTaskBrowserState(deps(), ["t-1"]);

    expect(report.keysDeleted).toEqual(["task-browser-layout:t-1"]);
    expect(report.contextsReleased).toEqual([]);
  });
});

describe("teardownArchivedTaskBrowserState — root + intero sottoalbero", () => {
  test("porta via anche i figli e i nipoti, a qualunque profondità", () => {
    task("root");
    task("kid", { parent: "root" });
    task("grandkid", { parent: "kid" });
    task("estraneo");
    for (const id of ["root", "kid", "grandkid", "estraneo"]) {
      putUi(`task-browser-tabs:${id}`, tabsRecord([`task-${id}-0`]));
      putUi(`task-browser-layout:${id}`, { groups: [] });
    }

    const report = teardownArchivedTaskBrowserState(deps(), "root");

    expect(report.taskIds.sort()).toEqual(["grandkid", "kid", "root"]);
    expect(keys()).toEqual(["task-browser-layout:estraneo", "task-browser-tabs:estraneo"]);
  });

  test("subtreeIds di un id che la tabella non conosce è l'id stesso (le chiavi vanno via lo stesso)", () => {
    putUi("task-browser-tabs:fantasma", tabsRecord(["task-fant-0"]));

    expect(taskSubtreeIds(db, "fantasma")).toEqual(["fantasma"]);
    teardownArchivedTaskBrowserState(deps(), "fantasma");
    expect(keys()).toEqual([]);
  });
});

describe("sweepArchivedTaskBrowserState — il ripasso al boot RIPARA", () => {
  test("porta via il pregresso archiviato e NON tocca i task vivi né i done", () => {
    task("vecchio", { archived: true, status: "done" });
    task("vivo", { status: "in_progress" });
    task("consegnato", { status: "done" }); // done ma NON archiviato: la tab è la consegna
    for (const id of ["vecchio", "vivo", "consegnato"]) {
      putUi(`task-browser-tabs:${id}`, tabsRecord([`task-${id}-0`]));
      putUi(`task-browser-layout:${id}`, { groups: [] });
    }

    const report = sweepArchivedTaskBrowserState(deps());

    expect(report.taskIds).toEqual(["vecchio"]);
    expect(keys()).toEqual([
      "task-browser-layout:consegnato",
      "task-browser-layout:vivo",
      "task-browser-tabs:consegnato",
      "task-browser-tabs:vivo",
    ]);
  });

  test("una chiave il cui task non esiste più è orfana e se ne va", () => {
    task("vivo");
    putUi("task-browser-tabs:vivo", tabsRecord(["task-vivo-0"]));
    putUi("task-browser-tabs:sparito", tabsRecord(["task-spar-0"]));

    sweepArchivedTaskBrowserState(deps());

    expect(keys()).toEqual(["task-browser-tabs:vivo"]);
  });

  test("tabella `tasks` VUOTA: nessuna chiave è orfana (non si svuota tutto)", () => {
    putUi("task-browser-tabs:a", tabsRecord(["task-a-0"]));
    putUi("task-browser-layout:a", { groups: [] });

    const report = sweepArchivedTaskBrowserState(deps());

    expect(report.keysDeleted).toEqual([]);
    expect(keys()).toEqual(["task-browser-layout:a", "task-browser-tabs:a"]);
  });

  test("db già pulito: nessuna scrittura, nessun broadcast", () => {
    task("vivo");
    putUi("pane-store-v2", { panes: {} });

    const report = sweepArchivedTaskBrowserState(deps());

    expect(report).toEqual({ taskIds: [], keysDeleted: [], bytesFreed: 0, contextsReleased: [] });
    expect(broadcasts).toEqual([]);
  });

  test("senza broadcast né destroyContext (il boot) la purga funziona comunque", () => {
    task("vecchio", { archived: true });
    putUi("task-browser-tabs:vecchio", tabsRecord(["task-vec-0"]));

    const report = sweepArchivedTaskBrowserState({ db });

    expect(report.keysDeleted).toEqual(["task-browser-tabs:vecchio"]);
    expect(report.contextsReleased).toEqual(["task-vec-0", "task-vec-0_ws"]);
    expect(keys()).toEqual([]);
  });
});

describe("taskBrowserKeysFor", () => {
  test("le due chiavi, nell'ordine tabs → layout", () => {
    expect(taskBrowserKeysFor("abc")).toEqual(["task-browser-tabs:abc", "task-browser-layout:abc"]);
  });
});
