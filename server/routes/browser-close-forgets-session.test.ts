/**
 * CHIUDERE UNA PANE DIMENTICA LA SESSIONE — da tutte e due le parti.
 *
 * La chiusura VERA di una pane browser (quella col tombstone, non il re-key
 * transitorio dell'auto-split) fa tre cose dal client: `DELETE /api/browsers/:id`
 * per il contesto server, `browser_close` per la WKWebView, e
 * `browser_purge_data_store` che cancella il `WKWebsiteDataStore` di quel
 * contesto — cioè cookie, localStorage e IndexedDB della pane nativa.
 *
 * Il barattolo della SESSIONE CONDIVISA, però, sopravviveva: `destroyContext`
 * fa un ultimo salvataggio di `storageState` su
 * `data/browser-state/<ctx>/storage.json`, e `deleteStorageState` — che quel
 * file lo toglie — non aveva NESSUN chiamante di produzione. Chiudevi una pane
 * credendo di aver buttato via la sessione (il lato nativo lo faceva davvero) e
 * il login restava su disco per sempre, pronto a tornare in vita al primo
 * contesto riaperto con lo stesso id.
 *
 * Qui si prova sulla rotta vera. Si guarda attraverso i lettori dello store
 * (`loadStorageState` / `loadLastUrl`) e non con `existsSync` su un percorso
 * ricostruito a mano: `BASE_DIR` si fissa all'import del modulo, e in una suite
 * dove altri file spostano `DATA_DIR` un percorso indovinato dà rossi che non
 * parlano del guasto.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createBrowserRouter } from "./browser";
import {
  saveStorageState,
  loadStorageState,
  saveLastUrl,
  loadLastUrl,
  deleteStorageState,
} from "../browser-state-store";

const CTX = "topic-che-si-chiude";
const ALTRO = "topic-che-resta";

const FIXTURE = {
  cookies: [
    {
      name: "sid", value: "sessione-viva", domain: ".example.com", path: "/",
      expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const,
    },
  ],
  origins: [],
};

function harness() {
  const destroyed: string[] = [];
  const service = {
    destroyContext: async (id: string) => { destroyed.push(id); },
    setEngineHint: () => {},
    listContexts: () => [],
  } as unknown as Parameters<typeof createBrowserRouter>[1];

  const ctx = {
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    errorResponse: (status: number, message: string) =>
      new Response(JSON.stringify({ error: message }), { status }),
    // Copia fedele di utils.ts:matchRoute (confronta prima il numero di segmenti).
    matchRoute: (pathname: string, pattern: string): Record<string, string> | null => {
      const pp = pattern.split("/");
      const xp = pathname.split("/");
      if (pp.length !== xp.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < pp.length; i++) {
        if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
        else if (pp[i] !== xp[i]) return null;
      }
      return params;
    },
    broadcastToAll: () => {},
  } as unknown as Parameters<typeof createBrowserRouter>[0];

  const router = createBrowserRouter(ctx, service);
  const del = (id: string) => {
    const url = new URL(`http://x/api/browsers/${encodeURIComponent(id)}`);
    return router(new Request(url, { method: "DELETE" }), url, url.pathname, "DELETE");
  };
  return { del, destroyed };
}

beforeEach(async () => {
  await deleteStorageState(CTX);
  await deleteStorageState(ALTRO);
  await saveStorageState(CTX, FIXTURE as never);
  saveLastUrl(CTX, "https://example.com/dashboard");
});

afterEach(async () => {
  await deleteStorageState(CTX);
  await deleteStorageState(ALTRO);
});

describe("DELETE /api/browsers/:id", () => {
  test("cancella il barattolo della sessione condivisa, non solo il contesto", async () => {
    expect(await loadStorageState(CTX)).not.toBeNull();

    const { del, destroyed } = harness();
    const res = await del(CTX);

    expect(res?.status).toBe(200);
    expect(destroyed).toEqual([CTX]);
    // IL PUNTO: i cookie della sessione condivisa se ne sono andati con la
    // pane, come il WKWebsiteDataStore nativo (browser_purge_data_store).
    expect(await loadStorageState(CTX)).toBeNull();
  });

  test("porta via anche l'ultima url: una pane chiusa non risuscita la sua pagina", async () => {
    expect(loadLastUrl(CTX)).toBe("https://example.com/dashboard");
    const { del } = harness();
    await del(CTX);
    expect(loadLastUrl(CTX)).toBeNull();
  });

  test("è idempotente: una seconda DELETE non esplode", async () => {
    const { del } = harness();
    await del(CTX);
    const res = await del(CTX);
    expect(res?.status).toBe(200);
    expect(await loadStorageState(CTX)).toBeNull();
  });

  test("tocca SOLO il contesto chiesto", async () => {
    await saveStorageState(ALTRO, FIXTURE as never);
    const { del } = harness();
    await del(CTX);
    expect(await loadStorageState(ALTRO)).not.toBeNull();
  });
});
