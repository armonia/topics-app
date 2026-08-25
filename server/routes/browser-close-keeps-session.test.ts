/**
 * CHIUDERE UNA PANE NON DISCONNETTE — purge selettivo, non totale.
 *
 * Decisione (cb1f588f): la chiusura di una pane browser toglie SOLO la cache
 * (il lato nativo cancella `WKWebsiteDataStore` via `browser_purge_data_store`
 * in `usePaneLifecycle`), ma il barattolo della SESSIONE CONDIVISA su
 * `data/browser-state/<ctx>/storage.json` resta: cookie e localStorage
 * sopravvivono, così riaprire lo stesso contesto non richiede un nuovo login.
 *
 * `DELETE /api/browsers/:id` aveva guadagnato un `deleteStorageState` (task
 * 7fb737a9) che rendeva la chiusura simmetrica sulla politica VECCHIA
 * (disconnetti sempre). Con la politica nuova è il difetto: va tolto, e
 * questo test lo blocca se torna.
 * @covers BROWSER-CHAT-01
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
  test("distrugge il contesto ma lascia intatto il barattolo della sessione condivisa", async () => {
    expect(await loadStorageState(CTX)).not.toBeNull();

    const { del, destroyed } = harness();
    const res = await del(CTX);

    expect(res?.status).toBe(200);
    expect(destroyed).toEqual([CTX]);
    // IL PUNTO: la chiusura è purge selettivo. Il lato nativo butta la cache
    // (WKWebsiteDataStore), ma cookie/localStorage condivisi restano su
    // disco: riaprire lo stesso contesto ritrova il login.
    expect(await loadStorageState(CTX)).not.toBeNull();
  });

  test("lascia intatta anche l'ultima url: una pane chiusa resta riprendibile", async () => {
    expect(loadLastUrl(CTX)).toBe("https://example.com/dashboard");
    const { del } = harness();
    await del(CTX);
    expect(loadLastUrl(CTX)).toBe("https://example.com/dashboard");
  });

  test("è idempotente: una seconda DELETE non esplode", async () => {
    const { del } = harness();
    await del(CTX);
    const res = await del(CTX);
    expect(res?.status).toBe(200);
  });

  test("tocca SOLO il contesto chiesto", async () => {
    await saveStorageState(ALTRO, FIXTURE as never);
    const { del } = harness();
    await del(CTX);
    expect(await loadStorageState(ALTRO)).not.toBeNull();
  });
});
