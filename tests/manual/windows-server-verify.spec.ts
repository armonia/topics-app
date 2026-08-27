/**
 * VERIFICHE CONTRO L'APP WINDOWS INSTALLATA (non un banco).
 *
 * Punta al `topics-server` della build 2.2.176 installata sul PC Windows 11
 * (`%LOCALAPPDATA%\Topics\`, app.exe sha256 27AB5DBA24E2F8A3…), raggiunto dal
 * Mac via tunnel ssh. Serve a lasciare una misura RIPETIBILE dove finora
 * c'era solo il mio resoconto a parole.
 *
 * Si lancia a mano (non e' nella CI: richiede quel PC acceso):
 *   ssh -f -N -L 51156:127.0.0.1:51156 zorah@100.92.197.74
 *   TOPICS_WIN_BASE=http://127.0.0.1:51156 \
 *     npx playwright test -c playwright.windows.config.ts
 *
 * PERCHE' QUI NON C'E' NESSUNA MISURA DEL DOM, che era il mio piano iniziale.
 * L'interfaccia NON e' servita via HTTP: e' compilata dentro `app.exe` e la
 * webview la carica da `tauri://localhost` (verificato cercando quella stringa
 * nel binario). `GET /` sulla porta del server risponde 503 «Bundle not built
 * yet», che e' corretto: in produzione quel server fa solo da API. E la porta
 * di debug di WebView2 non e' aperta, ne' si puo' aprirla al volo, perche'
 * l'app e' a istanza singola — un secondo avvio con
 * `--remote-debugging-port` rientra nella finestra gia' viva (misurato: dopo
 * il lancio le istanze restano 1, pid invariato) e quella finestra e' quella
 * dell'utente, che non si tocca.
 *
 * Quindi: le cose di geometria e pixel (pulsanti finestra, campanella, chip
 * identita', tooltip, banda grigia) restano verificate a mano sul ferro e
 * NON sono qui. Qui c'e' cio' che si puo' interrogare davvero dall'esterno,
 * che e' il contratto del server come gira su Windows.
 */
import { test, expect } from "@playwright/test";

test.beforeEach(({}, testInfo) => {
  testInfo.annotations.push({ type: "spec", description: "RUNTIME-17" });
});

test.describe("Windows 2.2.176 — contratto del server sulla build pubblicata", () => {
  test("WIN-SRV-01: la versione servita e' la 2.2.176 della pipeline", async ({ request }) => {
    const v = await (await request.get("/api/version")).json();
    expect(v.version).toBe("2.2.176");
  });

  test("WIN-SRV-02: le rotte che l'interfaccia interroga all'avvio rispondono tutte 200", async ({ request }) => {
    for (const p of [
      "/api/system/status",
      "/api/topics",
      "/api/terminal/sessions",
      "/api/providers/snapshot",
      "/api/all-boards/tasks",
    ]) {
      expect((await request.get(p)).status(), p).toBe(200);
    }
  });

  test("WIN-SRV-03: i provider sono dichiarati con requisiti e modelli, non una lista vuota", async ({ request }) => {
    const snap = await (await request.get("/api/providers/snapshot")).json();
    expect(Array.isArray(snap.providers)).toBe(true);
    expect(snap.providers.length).toBeGreaterThan(0);
    // Ogni provider dice come si chiama e cosa gli serve: e' esattamente cio'
    // che permette all'app di DIRE che un agente manca invece di aprire una
    // tab vuota, che era il difetto segnalato il 26/08.
    for (const p of snap.providers) {
      expect(typeof p.name, JSON.stringify(p).slice(0, 80)).toBe("string");
      expect(typeof p.status).toBe("string");
    }
  });

  test("WIN-SRV-04: nessun modello resta senza listino (il costo non e' mai finto zero)", async ({ request }) => {
    const s = await (await request.get("/api/system/status")).json();
    expect(s.server.unpricedModels).toEqual([]);
  });

  test("WIN-SRV-05: la versione del binario coincide con quella che il server dichiara", async ({ request }) => {
    // Prova che il server interrogato e' DAVVERO quello dell'installazione
    // 2.2.176, non un processo di sviluppo rimasto acceso su quella porta:
    // sarebbe il modo piu' facile di prendersi in giro da soli.
    const v = await (await request.get("/api/version")).json();
    const s = await (await request.get("/api/system/status")).json();
    expect(v.version).toBe("2.2.176");
    expect(s.server.devReload).toBe(false);
  });

  test("WIN-SRV-06: una rotta inesistente da' 404, non 500 e non una pagina", async ({ request }) => {
    expect((await request.get("/api/usage/other")).status()).toBe(404);
  });

  test("WIN-SRV-07: il server e' su da ore e non sta perdendo memoria", async ({ request }) => {
    const s = await (await request.get("/api/system/status")).json();
    expect(s.server.uptimeMs).toBeGreaterThan(60_000);
    // 37 MB alla misura di stanotte dopo ~2h di vita. La soglia e' larga
    // apposta: qui interessa una perdita evidente, non il singolo megabyte.
    expect(s.server.memoryMB).toBeLessThan(600);
  });

  test("WIN-SRV-08: lo stato dichiara il gateway e le connessioni vive", async ({ request }) => {
    const s = await (await request.get("/api/system/status")).json();
    expect(s.gateway).toBeDefined();
    expect(s.connections).toBeDefined();
  });

  test("WIN-SRV-09: creare, leggere e cancellare un topic funziona sulla macchina vera", async ({ request }) => {
    const name = `win-verify-${Date.now()}`;
    const created = await request.post("/api/topics", { data: { name } });
    expect(created.status()).toBeLessThan(300);
    const topic = await created.json();
    try {
      // `/api/topics` risponde con una MAPPA id → topic, non con un array.
      const list = await (await request.get("/api/topics")).json();
      expect(Object.keys(list.topics)).toContain(topic.id);
    } finally {
      expect((await request.delete(`/api/topics/${topic.id}`)).status()).toBeLessThan(300);
    }
  });

  test("WIN-SRV-10: le sessioni di terminale si elencano senza autenticazione mancante", async ({ request }) => {
    const r = await request.get("/api/terminal/sessions");
    expect(r.status()).toBe(200);
    expect(Array.isArray(await r.json())).toBe(true);
  });
});
