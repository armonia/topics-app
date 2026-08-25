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
 * @covers APPSET-01
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase } from "../db";
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
