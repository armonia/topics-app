/**
 * Lo snapshot `ui-state:init` NON porta le chiavi per-task del browser.
 *
 * Il guasto che chiude: `loadAllUiState` non filtrava, quindi `task-browser-tabs:*`
 * e `task-browser-layout:*` — una coppia per ogni task che ha aperto un browser,
 * e i task non si cancellano — viaggiavano verso OGNI client a OGNI
 * riconnessione. Misura sul db vivo dell'11/08: 91 righe su 172, 31 KB su 101 KB,
 * il 30,8% del payload. Il client quelle chiavi le legge per-task, con un GET
 * pigro all'apertura del task: dallo snapshot non le leggeva nessuno.
 *
 * Si pinna anche il contorno: `GET /api/ui-state` (all-keys) resta COMPLETO —
 * è una porta di servizio, non il broadcast — e il GET singolo continua a
 * servire la chiave identica, che è la strada da cui il client la prende.
  * @covers WIRE-06
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createUiStateRouter,
  loadAllUiState,
  isExcludedFromUiStateInit,
  UI_STATE_INIT_EXCLUDED_PREFIXES,
} from "./ui-state";
import type { AppContext } from "../types";

let db: Database;

function putRow(key: string, value: unknown, seq: number): void {
  db.query("INSERT OR REPLACE INTO ui_state (key, value, payload_version, server_seq) VALUES (?, ?, 2, ?)")
    .run(key, JSON.stringify(value), seq);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE ui_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    payload_version INTEGER NOT NULL DEFAULT 1,
    server_seq INTEGER NOT NULL DEFAULT 0
  )`);
  putRow("pane-store-v2", { panes: {} }, 1);
  putRow("theme", "dark", 2);
  putRow("task-browser-tabs:t-1", { tabs: [{ contextId: "task-t1-0", url: "u", title: "T", seq: 0 }] }, 3);
  putRow("task-browser-layout:t-1", { groups: [{ id: "g1", paneIds: ["browser:task-t1-0"] }] }, 4);
  putRow("task-browser-tabs:t-2", { tabs: [] }, 5);
});

describe("loadAllUiState (frame ui-state:init)", () => {
  test("esclude task-browser-tabs:* e task-browser-layout:*, tiene tutto il resto", () => {
    const { data, meta } = loadAllUiState(db);
    expect(Object.keys(data).sort()).toEqual(["pane-store-v2", "theme"]);
    expect(Object.keys(meta).sort()).toEqual(["pane-store-v2", "theme"]);
    // Il valore delle chiavi tenute non è toccato dal filtro.
    expect(data["theme"]).toBe("dark");
    expect(meta["pane-store-v2"].server_seq).toBe(1);
  });

  test("un task che si CHIAMA come il prefisso ma non lo è resta nello snapshot", () => {
    // Il filtro è per PREFISSO, non per sottostringa: una chiave futura che
    // contiene 'task-browser' più avanti non deve sparire per sbaglio.
    putRow("board:task-browser-tabs-prefs", { x: 1 }, 6);
    expect(Object.keys(loadAllUiState(db).data)).toContain("board:task-browser-tabs-prefs");
  });

  test("db senza nessuna chiave per-task: snapshot invariato", () => {
    db.run("DELETE FROM ui_state WHERE key LIKE 'task-browser-%'");
    expect(Object.keys(loadAllUiState(db).data).sort()).toEqual(["pane-store-v2", "theme"]);
  });

  test("isExcludedFromUiStateInit è il gemello JS del WHERE", () => {
    for (const p of UI_STATE_INIT_EXCLUDED_PREFIXES) expect(isExcludedFromUiStateInit(`${p}abc`)).toBe(true);
    expect(isExcludedFromUiStateInit("pane-store-v2")).toBe(false);
    expect(isExcludedFromUiStateInit("theme")).toBe(false);
  });
});

describe("le chiavi escluse restano leggibili (è da lì che il client le prende)", () => {
  const ctx = () => ({
    db,
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
    broadcastToAll: () => {},
  }) as unknown as AppContext;

  async function get(path: string) {
    const router = createUiStateRouter(ctx());
    const res = await router(new Request(`http://x${path}`), new URL(`http://x${path}`), path, "GET");
    return { status: res!.status, body: await res!.json() };
  }

  test("GET singolo serve la chiave per-task com'era", async () => {
    const r = await get("/api/ui-state/task-browser-tabs:t-1");
    expect(r.status).toBe(200);
    expect((r.body as any).value.tabs[0].contextId).toBe("task-t1-0");
  });

  test("GET all-keys resta COMPLETO — il filtro è solo del broadcast", async () => {
    const r = await get("/api/ui-state");
    expect(Object.keys((r.body as any).data).sort()).toEqual([
      "pane-store-v2",
      "task-browser-layout:t-1",
      "task-browser-tabs:t-1",
      "task-browser-tabs:t-2",
      "theme",
    ]);
  });
});
