/**
 * «Dimentica questo sito» sulla pane CONDIVISA, filmato.
 *
 * COSA PROVA. Il patto del comando è che si ELENCA prima e si cancella dopo
 * esattamente quello che è stato elencato. I test delle due rotte lo verificano
 * a metà: dicono che il server sa farlo, non che dalla pane ci si arrivi. Qui il
 * giro è quello vero e intero — il menu ⋯ della pane condivisa, la voce rossa,
 * il dialogo che NOMINA il silo, il tasto — e la prova non è un resoconto: è la
 * pagina rispecchiata nella pane che passa da SEI DENTRO a SEI FUORI.
 *
 * IL SITO È NOSTRO E STA IN LOCALE. Serve un sito che abbia DAVVERO un cookie e
 * un localStorage, e serve che ce li abbia il browser del SERVER: è lì che vive
 * la sessione condivisa, non in questo Chromium. Quindi un `http.createServer`
 * su loopback, zero internet:
 *   · `/entra` consegna il cookie e scrive il localStorage — ci si passa UNA
 *     volta sola, nel prologo;
 *   · `/` non scrive niente e dice soltanto se ti riconosce.
 * Quella separazione è ciò che rende la cancellazione VISIBILE: dopo il tasto la
 * pane ricarica `/` e il sito stesso dice SEI FUORI. Se il cookie lo desse anche
 * `/`, il ricaricamento lo rimetterebbe e non si vedrebbe niente.
 *
 * PERCHÉ NON FINISCE IN UN <iframe>. Il ramo web disegna un sito framabile
 * dentro un `<iframe>` del CLIENT, dove i cookie non sono del server: là il
 * comando non compare apposta, e quella non sarebbe la pane condivisa. Loopback
 * è già non-framabile per la guardia SSRF di `probeFraming`; l'`X-Frame-Options:
 * DENY` lo dice comunque a voce alta, così la ragione sta nel sito e non solo in
 * questo commento.
 *
 * L'IDENTITÀ SI SEMINA DAL SERVER. Le due visite a `/entra` e `/` passano dalla
 * rotta `POST /api/browsers/:id/navigate` — la stessa che usa la pane quando il
 * WS non è ancora aperto. Il contesto condiviso esiste prima che la pane si
 * monti, ed è esattamente il caso vero: la sessione è del server, la pane è uno
 * dei suoi spettatori.
 *
 * CORSIA NOTTURNA. Come tutta la famiglia che apre un Chromium headless lato
 * server (`browser-ws-streaming`, `browser-shared-session`, …): sotto quattro
 * shard quel `launch` va in timeout e accusa il prodotto di una contesa di
 * macchina. Vedi `NIGHTLY_ONLY_SPECS` in `playwright.config.ts`.
 *
 * La clip di consegna (`videos/clip/browser-forget-site-shared.webm`):
 *     E2E_CLIP=1 ./node_modules/.bin/playwright test browser-forget-site-shared
  * @covers FORGET-03
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { goToApp } from "./helpers";
import {
  closeAllBrowserContexts,
  createTopic,
  deleteTopic,
  resetPaneStore,
  waitForTopicVisible,
} from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { clipDiConsegna } from "./helpers/clip";
import { beat, didascalia } from "./helpers/evidence";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** Il nome che il dialogo mostrerà: il silo di un cookie è il suo dominio,
 *  quello di un origin il suo hostname (`server/browser-site-data.ts`). */
const HOST = "127.0.0.1";

/** La pagina del sito finto: grande e leggibile, perché è metà della clip. */
function pagina(dentro: boolean, scrive: boolean): string {
  const stato = dentro ? "SEI DENTRO" : "SEI FUORI";
  const fondo = dentro ? "#123a26" : "#3a1a16";
  const bordo = dentro ? "#3fb984" : "#e2725b";
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${stato}</title>
<style>
 html,body{height:100%;margin:0}
 body{display:flex;align-items:center;justify-content:center;background:${fondo};color:#fff;
      font-family:system-ui,-apple-system,sans-serif}
 .scheda{text-align:center;padding:36px 44px;border:3px solid ${bordo};border-radius:16px}
 h1{font-size:46px;margin:0 0 16px;letter-spacing:-.02em}
 p{margin:6px 0;font-size:18px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.9}
</style></head><body>
 <div class="scheda">
  <h1 id="stato">${stato}</h1>
  <p id="cookie">cookie sid=${dentro ? "BUONO" : "(nessuno)"}</p>
  <p id="ls">localStorage</p>
 </div>
 <script>
  ${scrive ? "localStorage.setItem('bozza','la mia bozza');" : ""}
  document.getElementById('ls').textContent =
    'localStorage bozza=' + (localStorage.getItem('bozza') || '(vuoto)');
 </script>
</body></html>`;
}

/** Il sito: `/entra` dà l'identità, `/` la legge e basta. */
async function alzaIlSito(): Promise<{ server: Server; origine: string }> {
  const server = createServer((req, res) => {
    const percorso = (req.url ?? "/").split("?")[0];
    const entra = percorso === "/entra";
    const dentro = entra || /(?:^|;\s*)sid=BUONO(?:;|$)/.test(req.headers.cookie ?? "");
    const headers: Record<string, string> = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // Vedi la docstring: fuori dall'<iframe>, dentro la sessione condivisa.
      "x-frame-options": "DENY",
    };
    if (entra) headers["set-cookie"] = "sid=BUONO; Path=/";
    res.writeHead(200, headers);
    res.end(pagina(dentro, entra));
  });
  await new Promise<void>((ok) => server.listen(0, HOST, ok));
  return { server, origine: `http://${HOST}:${(server.address() as AddressInfo).port}` };
}

/** I silo che il server vede per questo contesto: la STESSA rotta che interroga
 *  il dialogo, non una copia della sua logica. */
async function siloVisti(request: APIRequestContext, contextId: string): Promise<string[]> {
  const res = await request.get(`${E2E_BASE}/api/browsers/${encodeURIComponent(contextId)}/site-data`);
  if (!res.ok()) return [];
  const body = (await res.json()) as { records?: Array<{ displayName?: string }> };
  return (body.records ?? []).map((r) => r.displayName ?? "").filter(Boolean);
}

/** Manda il browser del server su una url e aspetta che ci sia arrivato. */
async function navigaIlContesto(request: APIRequestContext, contextId: string, url: string): Promise<void> {
  const res = await request.post(
    `${E2E_BASE}/api/browsers/${encodeURIComponent(contextId)}/navigate`,
    { data: { url } },
  );
  expect(res.ok(), `navigate ${url} → ${res.status()}`).toBeTruthy();
}

/** Monta la pane del browser per un topic, come fa `/browser <url>` in chat. */
async function montaLaPane(page: Page, topicId: string, url: string): Promise<void> {
  await page.evaluate(
    ({ tid, u }) => {
      window.dispatchEvent(
        new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url: u } }),
      );
    },
    { tid: topicId, u: url },
  );
  await expect(page.locator('[data-browser-pane]').first()).toBeVisible({ timeout: 30_000 });
}

/** Quello che la pane sta DAVVERO mostrando: il co-browse DOM ricostruisce la
 *  pagina del server in questo browser, quindi il titolone è leggibile qui. */
function statoMostrato(page: Page) {
  return page
    .locator('[data-testid="browser-dom-cobrowse"]')
    .first()
    .frameLocator("iframe")
    .locator("#stato");
}

/** Apre il dialogo dal menu ⋯ della pane. */
/** "Forget this site" now lives in the TAB menu (the three dots), not in the
 *  address bar: on a loaded page that bar is gone. The dots come out on hover,
 *  so the pointer goes over the tab first. */
async function apriIlDialogo(page: Page): Promise<void> {
  await page.locator('[data-pane-id^="browser:"]').first().hover();
  await page.getByTestId("browser-tab-menu").first().click();
  await page.getByTestId("browser-tab-forget-site").click();
  await expect(page.getByTestId("forget-site-dialog")).toBeVisible({ timeout: 15_000 });
}

test.describe("Dimentica questo sito — pane condivisa", () => {
  // Il prologo aspetta che il SERVER apra un Chromium headless e navighi due
  // volte: il tetto del file (30s) non è per questa famiglia.
  test.describe.configure({ timeout: 240_000 });

  let sito: { server: Server; origine: string } | null = null;
  let topicId = "";

  test.beforeAll(async () => {
    sito = await alzaIlSito();
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
    await closeAllBrowserContexts(request);
    sito?.server.close();
  });

  test("si elenca il silo, si preme, e il sito non ti riconosce più", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "FORGET-03" });
    const origine = sito!.origine;
    await resetPaneStore(request, []);
    const topic = await createTopic(request, `E2E-FORGET-${Date.now()}`);
    topicId = topic.id;
    // La pane di una chat gira sul contesto che porta il nome del topic
    // (`resolveContextIdForTopic`): è lì che il dialogo andrà a leggere.
    const contextId = topic.id;

    const clip = await clipDiConsegna({
      nome: "browser-forget-site-shared",
      // Il contesto è NOSTRO: niente arriva qui dal `use` della config.
      context: {
        baseURL: E2E_BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 800 },
        reducedMotion: "reduce",
      },
      // FUORI DALLA REGISTRAZIONE: far partire il Chromium del server, prendersi
      // il cookie e montare la pane è lavoro di scena. Sta su una pagina il cui
      // video si butta; la pane resta scritta nel pane-store, e la pagina della
      // scena la ritrova già aperta sul sito.
      prologo: async (p) => {
        // UNA sola visita a `/entra`: da qui in poi l'identità c'è.
        await navigaIlContesto(request, contextId, `${origine}/entra`);
        // …e si torna su `/`, che non scrive niente: è la pagina da cui parte la
        // clip, ed è quella che dopo la cancellazione dirà SEI FUORI.
        await navigaIlContesto(request, contextId, `${origine}/`);
        // Il cookie e il localStorage devono essere DAVVERO nel contesto del
        // server prima di filmare: registrare senza vorrebbe dire un dialogo
        // vuoto e un rosso che arriva a video già girato.
        expect(await siloVisti(request, contextId)).toContain(HOST);

        await goToApp(p);
        await waitForTopicVisible(p, topic.id);
        await montaLaPane(p, topic.id, `${origine}/`);
      },
      scena: async (page) => {
        await goToApp(page);
        // WHERE WE ARE is written on the TAB, which is where the address lives
        // now: the bar hides itself as soon as the page is loaded.
        const host = new URL(origine).host;
        await expect(page.getByRole("tab", { name: new RegExp(host.replace(".", "\\.")) }).first())
          .toBeVisible({ timeout: 30_000 });

        // ── 1. La pane condivisa è dentro il sito ────────────────────────────
        // Non «la barra dice l'indirizzo»: la PAGINA rispecchiata dice che il
        // sito ti riconosce. È lo stato che dopo dovrà cambiare.
        await expect(statoMostrato(page)).toHaveText("SEI DENTRO", { timeout: 30_000 });
        await didascalia(page, "Pane condivisa: il sito ti riconosce");
        await beat(page, 1200);

        // ── 2. Prima l'elenco: il dialogo NOMINA il silo ─────────────────────
        await apriIlDialogo(page);
        const dialogo = page.getByTestId("forget-site-dialog");
        await expect(dialogo).toContainText(HOST);
        await expect(dialogo.getByTestId("forget-site-item-session")).toBeVisible();
        await expect(dialogo.getByTestId("forget-site-item-storage")).toBeVisible();
        // La cache non è per-sito nel condiviso, e il dialogo non la promette.
        await expect(dialogo.getByTestId("forget-site-item-cache")).toHaveCount(0);
        await didascalia(page, `Prima si elenca: cookie e dati di ${HOST}`);
        await beat(page, 1800);

        // ── 3. Si preme, e sparisce quello che era elencato ──────────────────
        await page.getByRole("dialog").getByRole("button", { name: "Dimentica", exact: true }).click();
        await expect(dialogo).toHaveCount(0, { timeout: 15_000 });
        await didascalia(page, "Premuto: la pane ricarica il sito");
        // La prova, e non è un resoconto: la pane ricarica `/` e il sito non
        // riconosce più nessuno.
        await expect(statoMostrato(page)).toHaveText("SEI FUORI", { timeout: 30_000 });
        await beat(page, 1400);

        // ── 4. Riaperto, non c'è più niente da dimenticare ───────────────────
        await apriIlDialogo(page);
        await expect(page.getByTestId("forget-site-dialog"))
          .toContainText("non c'è niente di salvato", { timeout: 15_000 });
        await didascalia(page, "Riaperto: non c'è più niente da dimenticare");
        await beat(page, 1600);
      },
    });

    // Il cancello del prodotto, non della clip: il silo non c'è più nemmeno per
    // il server, che è l'unico posto in cui quella sessione viveva davvero.
    expect(await siloVisti(request, contextId)).not.toContain(HOST);

    if (clip) console.log(`[clip] pronta: ${clip.path}`);
  });
});
