/**
 * PUT /api/ui-state/:key accetta QUALSIASI valore JSON, non solo un oggetto.
 *
 * Il guasto che chiude: `useServerState<T>` scrive il valore nudo, e le sue due
 * chiavi — `theme` (stringa) e `claude-prefs-skip` (booleano) — sono primitive.
 * La guardia "deve essere un oggetto", ereditata dalla fase pane-state, le
 * rifiutava con 400: il tema NON è mai stato persistito lato server (viveva solo
 * in localStorage, quindi non seguiva l'utente su un altro dispositivo) e la
 * riga `claude-prefs-skip` nel DB era ferma all'ultima scrittura precedente al
 * vincolo. In silenzio, perché il hook fa `.catch(() => {})`.
 *
 * Si pinna anche il contorno: `null` resta rifiutato (una chiave assente legge
 * già `null`, quindi scriverlo non è rileggibile) e il PUT BULK — che è il
 * canale di pane-store/settings — tiene il vincolo oggetto.
  * @covers APPSET-04
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createUiStateRouter } from "./ui-state";
import type { AppContext } from "../types";

let db: Database;
let broadcasts: any[];
let router: ReturnType<typeof createUiStateRouter>;

function makeCtx(): AppContext {
  return {
    db,
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    broadcastToAll: (msg: unknown) => { broadcasts.push(msg); },
  } as unknown as AppContext;
}

async function call(method: string, path: string, body?: unknown) {
  const url = new URL(`http://x${path}`);
  const req = new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await router(req, url, url.pathname, method);
  if (!res) throw new Error(`router did not handle ${method} ${path}`);
  return { status: res.status, body: await res.json() };
}

const put = (key: string, value: unknown) => call("PUT", `/api/ui-state/${key}`, value);
const get = (key: string) => call("GET", `/api/ui-state/${key}`);

beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE ui_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    payload_version INTEGER NOT NULL DEFAULT 2,
    server_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  )`);
  broadcasts = [];
  router = createUiStateRouter(makeCtx());
});

describe("PUT /api/ui-state/:key — valori scalari", () => {
  // I due casi VERI, quelli che rispondevano 400 a ogni load.
  test("un booleano si scrive e si rilegge identico (claude-prefs-skip)", async () => {
    expect((await put("claude-prefs-skip", false)).status).toBe(200);
    expect((await get("claude-prefs-skip")).body.value).toBe(false);
  });

  test("una stringa si scrive e si rilegge identica (theme)", async () => {
    expect((await put("theme", "dark")).status).toBe(200);
    expect((await get("theme")).body.value).toBe("dark");
  });

  test("anche numeri e array passano: il negozio è chiave→JSON", async () => {
    // Il prossimo `useServerState<number>` non deve ricadere nello stesso buco.
    expect((await put("qualche-conteggio", 42)).status).toBe(200);
    expect((await get("qualche-conteggio")).body.value).toBe(42);
    expect((await put("qualche-lista", [1, 2])).status).toBe(200);
    expect((await get("qualche-lista")).body.value).toEqual([1, 2]);
  });

  test("gli oggetti continuano a funzionare come prima", async () => {
    expect((await put("panels", { openPanels: ["x"] })).status).toBe(200);
    expect((await get("panels")).body.value).toEqual({ openPanels: ["x"] });
  });

  test("il broadcast porta il valore primitivo, non un involucro", async () => {
    // È il canale da cui l'altro dispositivo aggiorna il tema in diretta: se
    // qui arrivasse `{v: "dark"}` il client scriverebbe un oggetto nello stato.
    await put("theme", "dark");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ type: "ui-state:updated", key: "theme", value: "dark" });
  });
});

describe("PUT /api/ui-state/:key — cosa resta rifiutato", () => {
  test("null è rifiutato: non sarebbe rileggibile", async () => {
    const res = await put("theme", null);
    expect(res.status).toBe(400);
    // Una chiave assente risponde già `null`: la scrittura non aggiungerebbe
    // nessuna informazione distinguibile.
    expect((await get("theme")).body).toBeNull();
  });

  test("un body non-JSON resta 400", async () => {
    const url = new URL("http://x/api/ui-state/theme");
    const req = new Request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{non json" });
    const res = await router(req, url, url.pathname, "PUT");
    expect(res!.status).toBe(400);
  });

  test("il PUT BULK tiene il vincolo oggetto (è il canale di pane-store)", async () => {
    const res = await call("PUT", "/api/ui-state", { theme: "dark" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must be a JSON object");
  });
});
