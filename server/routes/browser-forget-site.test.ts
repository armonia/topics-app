/**
 * «DIMENTICA QUESTO SITO» SULLA PANE CONDIVISA, dalle rotte.
 *
 * Il patto è quello del ramo nativo, ed è il patto a essere il punto: si
 * ELENCA prima, e si cancella ESATTAMENTE quello che l'elenco ha mostrato.
 * Tradotto in rotte: la POST prende i NOMI dei silo, non l'host. Fra il «cosa
 * cancello» che l'utente ha letto e il «cancella» che ha premuto non si infila
 * un secondo confronto, perché un secondo confronto è una seconda regola da
 * tenere allineata alla prima, e quel tipo di divergenza non la nota nessuno
 * finché non cancella la cosa sbagliata.
 *
 * Cosa si prova QUI e non altrove. Il modulo puro (`browser-site-data.test.ts`)
 * sa ricavare i silo da uno stato, e il test pesante
 * (`browser-site-data.heavy.test.ts`, che gira solo con `test:heavy` perché
 * accende un Chromium vero) prova la cosa che conta di più: che dopo la
 * cancellazione l'autosave NON resuscita il sito. In mezzo resta il contratto
 * della rotta, che è veloce da provare e altrimenti non lo proverebbe nessuno
 * nel cancello di tutti i giorni: che i nomi arrivino al servizio intatti, e
 * che una richiesta senza nomi venga RIFIUTATA invece che interpretata.
 *
 * Il servizio è finto (stesso stampo di `browser-close-keeps-session.test.ts`):
 * queste rotte si giudicano su cosa passano al servizio, non su un browser.
  * @covers BROWSER-FORGET-01
 */
import { describe, test, expect } from "bun:test";
import { createBrowserRouter } from "./browser";

const CTX = "topic-che-dimentica";

function harness(answer?: { supported?: boolean; records?: unknown[]; removed?: number }) {
  const listed: string[] = [];
  const forgotten: Array<{ id: string; names: string[] }> = [];

  const service = {
    siteDataRecords: async (id: string) => {
      listed.push(id);
      return { supported: answer?.supported !== false, records: answer?.records ?? [] };
    },
    forgetSite: async (id: string, displayNames: string[]) => {
      forgotten.push({ id, names: displayNames });
      return { supported: answer?.supported !== false, removed: answer?.removed ?? displayNames.length };
    },
    setEngineHint: () => {},
    listContexts: () => [],
  } as unknown as Parameters<typeof createBrowserRouter>[1];

  const ctx = {
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => {
      try {
        return await req.json();
      } catch {
        return null;
      }
    },
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

  const list = (id: string) => {
    const url = new URL(`http://x/api/browsers/${encodeURIComponent(id)}/site-data`);
    return router(new Request(url, { method: "GET" }), url, url.pathname, "GET");
  };
  const forget = (id: string, body: unknown) => {
    const url = new URL(`http://x/api/browsers/${encodeURIComponent(id)}/forget-site`);
    const req = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? "" : JSON.stringify(body),
    });
    return router(req, url, url.pathname, "POST");
  };

  return { list, forget, listed, forgotten };
}

describe("GET /api/browsers/:id/site-data", () => {
  test("elenca i silo del contesto, con i tipi che ci ha trovato dentro", async () => {
    const records = [
      { displayName: "github.com", types: ["cookies", "localStorage"] },
      { displayName: "mail.google.com", types: ["cookies"] },
    ];
    const { list, listed } = harness({ records });

    const res = await list(CTX);

    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ supported: true, records });
    expect(listed).toEqual([CTX]);
  });

  test("i nomi restano PRECISI: un sottodominio è un silo suo, non finisce nel padre", async () => {
    // È la differenza dichiarata col nativo, e va nella direzione buona. WebKit
    // raggruppa per dominio registrabile, quindi lì `mail.google.com` sparisce
    // dentro `google.com` e il dialogo deve avvertire che si porta via i vicini.
    // Qui i due silo si vedono separati, e si cancella solo quello scelto.
    const { list } = harness({
      records: [
        { displayName: "google.com", types: ["cookies"] },
        { displayName: "mail.google.com", types: ["localStorage"] },
      ],
    });

    const body = (await (await list(CTX))!.json()) as { records: Array<{ displayName: string }> };
    expect(body.records.map((r) => r.displayName)).toEqual(["google.com", "mail.google.com"]);
  });

  test("un motore che non è nostro lo DICE, invece di elencare zero silo", async () => {
    // Zero record e «non è roba mia» sono due risposte diverse, e il dialogo le
    // scrive diverse: la prima dice che non c'è niente da dimenticare, la
    // seconda che da qui non si cancella. Confonderle è una bugia comoda.
    const { list } = harness({ supported: false });

    expect(await (await list(CTX))!.json()).toEqual({ supported: false, records: [] });
  });
});

describe("POST /api/browsers/:id/forget-site", () => {
  test("passa al servizio ESATTAMENTE i nomi elencati, senza ricavarli dall'host", async () => {
    const { forget, forgotten } = harness({ removed: 2 });

    const res = await forget(CTX, { displayNames: ["github.com", "mail.google.com"] });

    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ supported: true, removed: 2 });
    expect(forgotten).toEqual([{ id: CTX, names: ["github.com", "mail.google.com"] }]);
  });

  test("senza `displayNames` RIFIUTA, e non chiama il servizio", async () => {
    // Il rifiuto è la parte importante. Una POST senza nomi che venisse
    // interpretata («allora cancello tutto del sito aperto») romperebbe il
    // patto proprio dove serve: l'utente non ha letto nessun elenco.
    const { forget, forgotten } = harness();

    for (const body of [{}, { displayNames: "github.com" }, { displayNames: null }]) {
      const res = await forget(CTX, body);
      expect(res?.status).toBe(400);
    }
    expect(forgotten).toEqual([]);
  });

  test("scarta le voci che non sono nomi, invece di passarle giù", async () => {
    const { forget, forgotten } = harness();

    await forget(CTX, { displayNames: ["github.com", "", "   ", 42, null, "example.org"] });

    expect(forgotten).toEqual([{ id: CTX, names: ["github.com", "example.org"] }]);
  });

  test("una lista vuota è una richiesta valida che non cancella niente", async () => {
    // Non è un errore: è il tasto premuto su un sito che non aveva salvato
    // nulla. Deve rispondere 200 con zero rimossi, non 400.
    const { forget, forgotten } = harness({ removed: 0 });

    const res = await forget(CTX, { displayNames: [] });

    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ supported: true, removed: 0 });
    expect(forgotten).toEqual([{ id: CTX, names: [] }]);
  });
});
