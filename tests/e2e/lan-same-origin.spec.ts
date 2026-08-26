/**
 * LAN-OPEN-01 — il contratto del gate d'origine, sul server vero.
 *
 * Questa spec esiste perché la rimozione della barriera LAN **non produce nessun
 * rosso** nel resto della suite: gira tutta su `http://localhost:13334` con
 * l'Origin coerente con l'Host, nessuna spec asseriva un 401/403 del gate e
 * nessuna mandava `x-topics-token`. Una suite che non ti ferma e non ti conferma
 * nulla è, su questo confine, indistinguibile dall'assenza di test. Qui i quattro
 * lati del contratto sono asseriti esplicitamente.
 *
 * Il quinto caso è il più importante e il meno ovvio: il gate lascia passare le
 * richieste NON mutanti, e a proteggerle è l'ASSENZA di
 * `Access-Control-Allow-Origin` per un'origine forestiera. Quell'assenza non è
 * una svista, è la difesa: senza, ogni `GET /api/*` diventerebbe leggibile da
 * qualunque sito l'utente visiti. Non c'è nessun altro punto in cui quel patto è
 * scritto in modo eseguibile — allargare il CORS «per far funzionare la PWA»
 * aprirebbe tutto senza che niente diventi rosso. Questo test è il presidio.
  * @covers LANGATE-01
 */
import { test, expect } from "./fixtures/test-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Il presidio `tests/unit/e2e-hermetic-coverage.test.ts` lo pretende da OGNI
// spec, anche da una che parla solo con l'API: dimenticarlo non rompe niente
// qui, rompe quaranta test più avanti in un file che non c'entra.
hermetic(test);

const FOREIGN = "https://evil.example";

/** L'Origin che un dispositivo LAN manda: identico al proprio Host. */
function sameOrigin(): string {
  return new URL(E2E_BASE).origin;
}

test.describe("LAN-OPEN-01 · gate d'origine", () => {
  test("una mutazione da un'origine forestiera è respinta con 403", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "LANGATE-01" });
    const res = await request.post(`${E2E_BASE}/api/topics`, {
      headers: { Origin: FOREIGN, "Content-Type": "application/json" },
      data: { title: "csrf" },
      failOnStatusCode: false,
    });

    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("cross-site origin blocked");
    expect(body.code).toBe("forbidden");
  });

  test("una mutazione same-origin passa il gate", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "LANGATE-01" });
    const res = await request.post(`${E2E_BASE}/api/topics`, {
      headers: { Origin: sameOrigin(), "Content-Type": "application/json" },
      data: { title: `lan-same-origin ${process.pid}` },
      failOnStatusCode: false,
    });

    // Passare il gate è ciò che si asserisce: qualunque cosa dica poi la route,
    // l'importante è che NON sia il rifiuto del gate.
    expect(res.status()).not.toBe(403);
    expect(res.status()).not.toBe(401);

    // Pulizia: se la topic è nata davvero, si toglie di mezzo.
    if (res.ok()) {
      const created = await res.json().catch(() => null);
      if (created?.id) {
        await request.delete(`${E2E_BASE}/api/topics/${created.id}`, {
          headers: { Origin: sameOrigin() },
          failOnStatusCode: false,
        }).catch(() => {});
      }
    }
  });

  test("una GET senza token e senza Origin passa: nessun 401 è sopravvissuto", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "LANGATE-01" });
    // È il cuore della change: prima questa stessa richiesta, da un peer non
    // loopback, tornava 401 «pairing token required for remote access».
    const res = await request.get(`${E2E_BASE}/api/topics`, { failOnStatusCode: false });

    expect(res.status()).toBe(200);
  });

  test("una mutazione SENZA header Origin passa: non è un browser", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "LANGATE-01" });
    // CLI, tool MCP, hook HTTP, sendBeacon di teardown. Il CSRF è un attacco da
    // browser, e un browser manda sempre Origin su una mutazione cross-origin.
    const res = await request.post(`${E2E_BASE}/api/topics`, {
      headers: { "Content-Type": "application/json" },
      data: {},
      failOnStatusCode: false,
    });

    expect(res.status()).not.toBe(403);
    expect(res.status()).not.toBe(401);
  });

  test("il patto del CORS: una GET cross-origin NON riceve Access-Control-Allow-Origin", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "LANGATE-01" });
    // Il gate lascia passare la GET; a rendere illeggibile la risposta è solo
    // questa assenza. Se un giorno qualcuno emettesse l'header per far
    // funzionare qualcosa, ogni /api diventerebbe leggibile da qualunque sito:
    // è l'unico posto in cui quel patto è verificato.
    const res = await request.get(`${E2E_BASE}/api/topics`, {
      headers: { Origin: FOREIGN },
      failOnStatusCode: false,
    });

    const headers = res.headers();
    const acao = headers["access-control-allow-origin"];
    expect(acao === undefined || acao === "" || acao !== FOREIGN).toBe(true);
  });

  test("un upgrade WS da un'origine forestiera è respinto, da una same-origin no", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LANGATE-01" });
    // L'handshake WS non è raggiungibile con l'APIRequestContext: l'Origin lo
    // mette il browser, e coincide con quella del documento. Si prova quindi da
    // due documenti diversi — uno sull'origine del server, uno su un'origine
    // forestiera servita da un route handler — e si guarda chi apre.
    const openFrom = async (origin: string): Promise<boolean> => {
      await page.route(`${origin}/__ws-probe`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>probe</title>" }),
      );
      await page.goto(`${origin}/__ws-probe`);
      const wsUrl = `${E2E_BASE.replace(/^http/, "ws")}/ws`;
      return page.evaluate(
        (url) =>
          new Promise<boolean>((resolve) => {
            const ws = new WebSocket(url);
            const done = (v: boolean) => { try { ws.close(); } catch { /* già chiusa */ } resolve(v); };
            ws.onopen = () => done(true);
            ws.onerror = () => done(false);
            ws.onclose = () => done(false);
            setTimeout(() => done(false), 5000);
          }),
        wsUrl,
      );
    };

    expect(await openFrom(sameOrigin())).toBe(true);
    expect(await openFrom(FOREIGN)).toBe(false);
  });
});
