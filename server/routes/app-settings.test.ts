/**
 * `PUT /api/app-settings` — la validazione del patch.
 *
 * Il caso che conta è `aiProvider`. Prima l'allow-set era una lista di cinque
 * nomi scritta a mano, e sbagliava in tutti e due i versi: accettava un
 * provider NON registrato (la riga finiva in DB e `recomputeDefault()` la
 * ignorava, perché senza il nome nel registro non entra nel ramo esplicito e
 * ripiega sull'ordine di preferenza — scelta scritta e disattesa insieme), e
 * rifiutava gli agenti ACP, che `PUT /api/providers/default` invece accetta e
 * scrive nella STESSA colonna. Adesso l'insieme ammesso è il registro dei
 * provider vivi, quindi le due rotte non possono più contraddirsi.
 *
 * Qui il registro è VUOTO (nessun provider avviato in un test), che è
 * esattamente il caso limite: nessun nome è accettabile, e il messaggio deve
 * dirlo invece di elencare un insieme vuoto.
 *
 * @covers APPSET-01, BROWSER-STORE-REAP-02, BROWSER-STORE-REAP-03, BROWSER-STORE-REAP-05
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase, getDatabase } from "../db";
import { getAppSettings, updateAppSettings } from "../services/app-settings";
import { createAppSettingsRouter } from "./app-settings";
import type { AppContext } from "../types";

let tmpRoot: string;
let router: ReturnType<typeof createAppSettingsRouter>;

/** Il minimo di AppContext che questa rotta tocca: `json` e il broadcast. */
function fakeCtx(): AppContext {
  return {
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    broadcastToAll: () => {},
  } as unknown as AppContext;
}

async function put(body: unknown): Promise<{ status: number; body: any }> {
  const req = new Request("http://localhost/api/app-settings", {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await router(req, new URL(req.url), "/api/app-settings", "PUT");
  if (!res) throw new Error("la rotta non ha risposto");
  return { status: res.status, body: await res.json() };
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "app-settings-route-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
    initDatabase(tmpRoot);
  router = createAppSettingsRouter(fakeCtx());
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  updateAppSettings({
    aiProvider: null, claudeModel: null, claudeMaxTokens: null, claudeEffort: null,
    openaiModel: null, openaiMaxTokens: null, codexModel: null, codexReasoningEffort: null,
    claudeCodePermissionMode: null, codexApprovalMode: null, claudeCodeEnabled: null,
    outputLanguage: null,
  });
});

describe("GET", () => {
  test("torna la riga singleton", async () => {
    const req = new Request("http://localhost/api/app-settings");
    const res = await router(req, new URL(req.url), "/api/app-settings", "GET");
    expect(res?.status).toBe(200);
    expect((await res!.json()).settings.aiProvider).toBeNull();
  });
});

describe("il modello di default è scrivibile — è il campo che la card del provider salva", () => {
  test("un modello per provider, e ognuno nella sua colonna", async () => {
    const r = await put({ claudeModel: "claude-opus-5[1m]", openaiModel: "gpt-5", codexModel: "gpt-5-codex" });
    expect(r.status).toBe(200);
    const s = getAppSettings();
    expect(s.claudeModel).toBe("claude-opus-5[1m]");
    expect(s.openaiModel).toBe("gpt-5");
    expect(s.codexModel).toBe("gpt-5-codex");
  });

  test("`null` è «Auto»: cancella la scelta e restituisce l'ultima parola all'env", async () => {
    await put({ claudeModel: "claude-opus-5[1m]" });
    const r = await put({ claudeModel: null });
    expect(r.status).toBe(200);
    expect(getAppSettings().claudeModel).toBeNull();
  });
});

describe("aiProvider — l'insieme ammesso è il registro, non una lista scritta a mano", () => {
  test("un provider non registrato è un 400, non una riga scritta e poi ignorata", async () => {
    const r = await put({ aiProvider: "openai" });
    expect(r.status).toBe(400);
    expect(r.body.errors[0].field).toBe("aiProvider");
    expect(getAppSettings().aiProvider).toBeNull();
  });

  test("con registro vuoto il messaggio lo DICE, invece di elencare il nulla", async () => {
    const r = await put({ aiProvider: "gemini" });
    expect(r.status).toBe(400);
    expect(r.body.errors[0].message).not.toContain("expected one of: ");
  });

  test("`null` passa sempre: è «scegli tu», ed è l'unico modo di togliere il default dalla UI", async () => {
    updateAppSettings({ aiProvider: "claude-code" });
    const r = await put({ aiProvider: null });
    expect(r.status).toBe(200);
    expect(getAppSettings().aiProvider).toBeNull();
  });
});

describe("outputLanguage — la lingua in cui il modello risponde (migration 087)", () => {
  test("i tre valori ammessi passano e si rileggono", async () => {
    for (const v of ["auto", "it", "en"]) {
      const r = await put({ outputLanguage: v });
      expect(r.status).toBe(200);
      expect(getAppSettings().outputLanguage).toBe(v);
    }
  });

  test("una lingua non prevista è un 400, non una riga scritta e mai onorata", async () => {
    // `resolveOutputLanguage` ripiegherebbe comunque su 'auto', ma scrivere
    // 'fr' e poi ignorarlo è il difetto che questa scheda ha già avuto una
    // volta con `aiProvider`: la scelta salvata e disattesa insieme.
    const r = await put({ outputLanguage: "fr" });
    expect(r.status).toBe(400);
    expect(r.body.errors[0].field).toBe("outputLanguage");
    expect(getAppSettings().outputLanguage).toBeNull();
  });

  test("`null` azzera la scelta — è lo stesso stato di «auto»", async () => {
    await put({ outputLanguage: "it" });
    const r = await put({ outputLanguage: null });
    expect(r.status).toBe(200);
    expect(getAppSettings().outputLanguage).toBeNull();
  });
});

describe("il resto della validazione non si è mosso", () => {
  test("un effort fuori scala è un 400", async () => {
    const r = await put({ claudeEffort: "turbo" });
    expect(r.status).toBe(400);
    expect(r.body.errors[0].message).toContain("expected one of");
  });

  test("una modalità di approvazione inventata è un 400", async () => {
    const r = await put({ codexApprovalMode: "full_access" });
    expect(r.status).toBe(400);
    expect(getAppSettings().codexApprovalMode).toBeNull();
  });

  test("il flag di claude-code vuole un booleano, non la stringa 'true'", async () => {
    expect((await put({ claudeCodeEnabled: "true" })).status).toBe(400);
    expect((await put({ claudeCodeEnabled: true })).status).toBe(200);
    expect(getAppSettings().claudeCodeEnabled).toBe(true);
  });

  test("un body che non è un oggetto è un 400, non un patch vuoto", async () => {
    // Nota: un ARRAY passa (è `typeof "object"`) e si comporta come un patch
    // senza chiavi note — 200 e nessuna scrittura. Non è la stessa cosa di uno
    // scalare, che qui viene respinto.
    expect((await put("7")).status).toBe(400);
    expect((await put("null")).status).toBe(400);
  });

  test("le chiavi sconosciute si ignorano, il resto del patch passa", async () => {
    const r = await put({ nonEsiste: "x", claudeEffort: "medium" });
    expect(r.status).toBe(200);
    expect(getAppSettings().claudeEffort).toBe("medium");
  });
});

describe("the cleanup of closed browsers' data: a setting, clamped when saved", () => {
  // Removing a browser store cannot be undone, so the reaper only runs on a
  // setting it has read. NULL in both columns = never touched, which the
  // reaper reads as on, 60 days (`shared/browser-store-reap.ts`).
  beforeEach(() => {
    updateAppSettings({ browserStoreReapEnabled: null, browserStoreReapAfterDays: null });
  });

  test("never touched: both columns are NULL, the default is the code's", async () => {
    const req = new Request("http://localhost/api/app-settings");
    const res = await router(req, new URL(req.url), "/api/app-settings", "GET");
    const { settings } = await res!.json();
    expect(settings.browserStoreReapEnabled).toBeNull();
    expect(settings.browserStoreReapAfterDays).toBeNull();
  });

  test("the switch is stored and read back, and null clears it", async () => {
    const off = await put({ browserStoreReapEnabled: false });
    expect(off.status).toBe(200);
    expect(off.body.settings.browserStoreReapEnabled).toBe(false);
    expect(getAppSettings().browserStoreReapEnabled).toBe(false);

    expect((await put({ browserStoreReapEnabled: null })).status).toBe(200);
    expect(getAppSettings().browserStoreReapEnabled).toBeNull();
  });

  test("switched back on: true is stored as 1 and every reader gets true back", async () => {
    // Off, then on again. The way back is what a person does after switching
    // the cleanup off by mistake, and it has to reach the reaper: the PUT
    // answer is what the switch draws, the GET is what the reaper reads.
    expect((await put({ browserStoreReapEnabled: false })).status).toBe(200);
    const on = await put({ browserStoreReapEnabled: true });
    expect(on.status).toBe(200);
    expect(on.body.settings.browserStoreReapEnabled).toBe(true);

    const column = getDatabase()
      .query("SELECT browser_store_reap_enabled AS v FROM app_settings LIMIT 1")
      .get() as { v: number | null };
    expect(column.v).toBe(1);
    expect(getAppSettings().browserStoreReapEnabled).toBe(true);

    const req = new Request("http://localhost/api/app-settings");
    const res = await router(req, new URL(req.url), "/api/app-settings", "GET");
    expect((await res!.json()).settings.browserStoreReapEnabled).toBe(true);
  });

  test("the switch wants a boolean, not the string 'false'", async () => {
    const r = await put({ browserStoreReapEnabled: "false" });
    expect(r.status).toBe(400);
    expect(r.body.errors[0].field).toBe("browserStoreReapEnabled");
    expect(getAppSettings().browserStoreReapEnabled).toBeNull();
  });

  test("days inside 7..365 are stored as they are", async () => {
    for (const days of [7, 30, 90, 365]) {
      expect((await put({ browserStoreReapAfterDays: days })).status).toBe(200);
      expect(getAppSettings().browserStoreReapAfterDays).toBe(days);
    }
  });

  test("days outside 7..365 are brought back to the nearest limit, not refused", async () => {
    const cases: Array<[number, number]> = [[3, 7], [0, 7], [-10, 7], [366, 365], [1000, 365]];
    for (const [written, kept] of cases) {
      const r = await put({ browserStoreReapAfterDays: written });
      expect(r.status).toBe(200);
      expect(r.body.settings.browserStoreReapAfterDays).toBe(kept);
      expect(getAppSettings().browserStoreReapAfterDays).toBe(kept);
    }
  });

  test("a fraction of a day is rounded to a whole day: Tauri takes an unsigned integer", async () => {
    // `browser_reap_data_stores(max_age_days: u64)`: a 14.4 stored here would
    // reach Tauri as 14.4, the invoke would be refused, and the cleanup would
    // quietly never run while the switch says on.
    const cases: Array<[number, number]> = [[14.4, 14], [7.4, 7], [30.6, 31], [200.5, 201]];
    for (const [written, kept] of cases) {
      const r = await put({ browserStoreReapAfterDays: written });
      expect(r.status).toBe(200);
      expect(r.body.settings.browserStoreReapAfterDays).toBe(kept);
      expect(getAppSettings().browserStoreReapAfterDays).toBe(kept);
    }
  });

  test("a value that is not a number is a 400, and nothing is written", async () => {
    await put({ browserStoreReapAfterDays: 90 });
    const r = await put({ browserStoreReapAfterDays: "many" });
    expect(r.status).toBe(400);
    expect(r.body.errors[0].field).toBe("browserStoreReapAfterDays");
    expect(getAppSettings().browserStoreReapAfterDays).toBe(90);
  });
});

describe("a read that failed is never answered as 'never touched'", () => {
  // The reaper reads NULL as never touched, which is ON at 60 days. So a GET
  // that swallowed a failed read and answered 200 with every field NULL would
  // turn a stored OFF into a permission to delete, on a deletion that cannot
  // be undone. A read that failed has to look like a failure on the wire.
  const GET_SQL = "FROM app_settings WHERE id = 1";

  async function get(): Promise<{ status: number; body: any }> {
    const req = new Request("http://localhost/api/app-settings");
    const res = await router(req, new URL(req.url), "/api/app-settings", "GET");
    if (!res) throw new Error("la rotta non ha risposto");
    return { status: res.status, body: await res.json() };
  }

  /** Makes the SELECT of the settings row throw, the way a busy or failing
   *  SQLite does, and leaves every other query alone. */
  function failTheSettingsRead(): () => void {
    const db = getDatabase() as unknown as { query: (sql: string) => unknown };
    const realQuery = db.query.bind(db);
    db.query = (sql: string) => {
      if (sql.includes("SELECT") && sql.includes(GET_SQL)) {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return realQuery(sql);
    };
    return () => { db.query = realQuery; };
  }

  beforeEach(() => {
    updateAppSettings({ browserStoreReapEnabled: false, browserStoreReapAfterDays: 30 });
  });

  test("the stored values come back as they are when the read works", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.settings.browserStoreReapEnabled).toBe(false);
    expect(r.body.settings.browserStoreReapAfterDays).toBe(30);
  });

  test("the SELECT throws: a 503 with no settings, not a 200 with every field NULL", async () => {
    const restore = failTheSettingsRead();
    let r: { status: number; body: any };
    try {
      r = await get();
    } finally {
      restore();
    }
    expect(r.status).toBe(503);
    expect(r.body.settings).toBeUndefined();
  });

  test("the database is not open: a 503 as well", async () => {
    closeDatabase();
    let r: { status: number; body: any };
    try {
      r = await get();
    } finally {
      initDatabase(tmpRoot);
    }
    expect(r.status).toBe(503);
    expect(r.body.settings).toBeUndefined();
    // The row was not lost, it was only unreadable for a moment.
    expect((await get()).body.settings.browserStoreReapEnabled).toBe(false);
  });

  test("PUT: the write lands and the re-read fails: a 503, not a 200 with every field NULL", async () => {
    // The switch draws the PUT answer. An all-NULL answer draws ON at 60 days
    // while the disk holds OFF, and hides a stored 30 behind a displayed 60.
    updateAppSettings({ browserStoreReapEnabled: true, browserStoreReapAfterDays: 30 });
    const restore = failTheSettingsRead();
    let r: { status: number; body: any };
    try {
      r = await put({ browserStoreReapEnabled: false });
    } finally {
      restore();
    }
    expect(r.status).toBe(503);
    expect(r.body.settings).toBeUndefined();
    // The write itself went through: only the answer could not say so.
    expect(getAppSettings().browserStoreReapEnabled).toBe(false);
    expect(getAppSettings().browserStoreReapAfterDays).toBe(30);
  });

  test("the server's own readers keep their fallback: getAppSettings still answers all-null", () => {
    // Thirty-odd resolvers read `setting ?? env ?? default` through it, and
    // for them NULL is the safe answer (env, then the built-in default). Only
    // the wire stops pretending.
    const restore = failTheSettingsRead();
    try {
      expect(getAppSettings().browserStoreReapEnabled).toBeNull();
    } finally {
      restore();
    }
  });
});
