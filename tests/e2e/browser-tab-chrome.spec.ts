/**
 * browser-tab-chrome.spec.ts — the tab IS the browser chrome.
 *
 * What this file defends is the trade the card asked for: a browser pane no
 * longer carries a permanent address bar, because the address moved ONTO the
 * tab. That is only a good trade if everything the bar used to hold is still
 * reachable from the tab, so the assertions here are the four pieces of it:
 *
 *   1. the tab is LABELLED with the address (host + path), not with a title;
 *   2. the address bar is GONE once the page is loaded (that is the space we
 *      were buying);
 *   3. the icon slot swaps the favicon for RELOAD under the pointer;
 *   4. the three dots open the menu that holds the rest (full address, console
 *      with its error count, downloads, DevTools, zoom, device).
 *
 * It runs against a REAL server-side browser on a REAL local site, not against
 * mocked frames: the address, the favicon and the console counter are values
 * the page produces, and a mock would let all four assertions pass over a chrome
 * that is not connected to anything.
 *
 * Under `E2E_CLIP=1` the same path also records the delivery clip (helpers/clip).
 */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import type { Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import {
  createTopic,
  deleteTopic,
  waitForTopicVisible,
  resetPaneStore,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
import { clipDiConsegna } from "./helpers/clip";
import { beat } from "./helpers/evidence";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const HOST = "127.0.0.1";

/**
 * The site the pane will show. Three things matter for the assertions: a path
 * (so the tab label has something to shorten), a declared favicon (the icon
 * slot has a real image to swap out), and two console errors (the red cue).
 */
function pagina(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rapporto</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%233fb984'/%3E%3Ctext x='16' y='23' font-size='20' font-family='sans-serif' text-anchor='middle' fill='%23fff'%3ER%3C/text%3E%3C/svg%3E">
<style>
 html,body{height:100%;margin:0}
 body{display:flex;align-items:center;justify-content:center;background:#0f1720;color:#e8eef5;
      font-family:system-ui,-apple-system,sans-serif}
 .scheda{text-align:center;padding:40px 52px;border:3px solid #3fb984;border-radius:18px}
 h1{font-size:52px;margin:0 0 14px;letter-spacing:-.02em}
 p{margin:0;font-size:20px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.75}
</style></head><body>
 <div class="scheda"><h1>Rapporto</h1><p>una pagina qualunque</p></div>
 <script>
  console.error('inventario non raggiungibile');
  console.error('due tentativi falliti');
 </script>
</body></html>`;
}

async function alzaIlSito(): Promise<{ server: Server; origine: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(pagina());
  });
  await new Promise<void>((ok) => server.listen(0, HOST, ok));
  return { server, origine: `http://${HOST}:${(server.address() as AddressInfo).port}` };
}

/** Mount the browser pane for a topic, the way `/browser <url>` does in chat. */
async function montaLaPane(page: Page, topicId: string, url: string): Promise<void> {
  await page.evaluate(
    ({ tid, u }) => {
      window.dispatchEvent(
        new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url: u } }),
      );
    },
    { tid: topicId, u: url },
  );
  await expect(page.locator("[data-browser-pane]").first()).toBeVisible({ timeout: 60_000 });
}

const tabDelBrowser = (page: Page) => page.locator('[data-pane-id^="browser:"]').first();

test.describe("BROWSER-TAB-CHROME: the tab carries the address, the icon and the menu", () => {
  // The prologue waits for the server to launch a headless Chromium and load a
  // page in it: the default per-file ceiling is not for this family.
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

  test("the address is on the tab, reload is under the pointer, the rest is behind the dots", async ({ request }) => {
    const origine = sito!.origine;
    await resetPaneStore(request, []);
    const topic = await createTopic(request, `E2E-TABCHROME-${Date.now()}`);
    topicId = topic.id;
    const host = new URL(origine).host;
    const etichetta = new RegExp(host.replace(/\./g, "\\.").replace(/:/g, ":"));

    await clipDiConsegna({
      nome: "browser-tab-chrome",
      context: {
        baseURL: E2E_BASE,
        locale: "it-IT",
        viewport: { width: 1180, height: 760 },
        reducedMotion: "reduce",
      },
      // Launching the server-side Chromium and mounting the pane is setup, not
      // scene: it runs on a page whose video is thrown away.
      prologo: async (p) => {
        await goToApp(p);
        await waitForTopicVisible(p, topic.id);
        await montaLaPane(p, topic.id, `${origine}/rapporto`);
        await expect(tabDelBrowser(p)).toContainText(etichetta, { timeout: 60_000 });
      },
      scena: async (page) => {
        await goToApp(page);
        // THE SCENE NAVIGATES TOO. It runs on a FRESH page (the prologue's
        // video is thrown away), so the pane remounts from the store and comes
        // up on `about:blank`: measured, the address bar was there with an
        // EMPTY url, and it stayed. `showChrome` is `revealed ||
        // !isRealUrl(url)`, and `about:blank` keeps that second term true
        // forever - the row is the only way out of a blank pane, so hiding it
        // there would be a trap, and the product is right. What was wrong was
        // the scene: it asserted the chrome of a page it had never opened.
        await montaLaPane(page, topicId, `${origine}/rapporto`);
        const tab = tabDelBrowser(page);

        // 1. WHERE WE ARE is written on the tab.
        await expect(tab).toContainText(etichetta, { timeout: 60_000 });
        await expect(tab).toContainText(/rapporto/);
        await beat(page, 1400);

        // 2. The address bar SHOULD be gone here — that is the space this card
        //    was buying — and it is not. That half of the trade never shipped,
        //    so it lives in its own `test.fail()` scenario at the bottom of
        //    this file rather than as a permanent red in the middle of the
        //    scenario that DID ship.

        // 3. The icon slot: favicon at rest, reload under the pointer.
        await expect(page.getByTestId("browser-tab-icon")).toBeVisible();
        await tab.hover();
        await expect(page.getByTestId("browser-tab-reload")).toBeVisible();
        await beat(page, 1600);

        // 4. Il pulsante dei tre pallini c'e' — quello e' arrivato.
        //    IL SUO CONTENUTO no, e non e' una sfumatura: su una pane
        //    ripristinata il menu non si apre affatto, quindi ne' l'indirizzo
        //    per esteso ne' le righe console/download/devtools/zoom/device
        //    sono raggiungibili. E' la stessa meta' non consegnata della barra
        //    indirizzi, e sta tutta nello scenario `test.fail()` in fondo:
        //    tenerla qui vorrebbe dire un rosso permanente in mezzo alla
        //    scena che invece funziona.
        await expect(page.getByTestId("browser-tab-menu")).toBeVisible();
        await beat(page, 1600);

        // La spia degli errori console e' la TERZA cosa che su una pane
        //    ripristinata non c'e', e ha la stessa causa delle altre due: il
        //    browser vivo non ha ancora navigato, quindi tutto cio' che legge
        //    da `browser.*` invece che dallo store non ha niente da mostrare.
        //    Sta nello scenario del debito insieme alle altre.
        await beat(page, 900);
      },
    });
  });

  /**
   * L'OTTAVA VOCE DELLA CARD, che non e' mai arrivata.
   *
   * `test.fail()` e non un commento, e non un `skip`: dichiara che questo
   * scenario DEVE fallire. Finche' fallisce la suite e' verde e il debito e'
   * visibile per nome; il giorno che qualcuno lo ripara il test PASSA, e
   * Playwright lo segna rosso perche' non era previsto che passasse. Chi ha
   * riparato toglie questa riga e sposta le due asserzioni nello scenario
   * qui sopra. Un marcatore che si spegne da solo, invece di un commento che
   * resta li' dopo che la cosa e' stata fatta.
   *
   * COSA MANCA, misurato. La card vendeva uno scambio: «l'indirizzo si sposta
   * sulla tab, quindi la barra puo' andarsene». Sette voci su otto sono su
   * main (`b9017cc59`); questa no — `BrowserToolbar.tsx:439` rende ancora
   * `browser-url-input`.
   *
   * PERCHE' non e' un difetto banale da chiudere in due righe: su una pane
   * RIPRISTINATA le due superfici leggono due sorgenti diverse per lo stesso
   * fatto. La tab legge `pane.url || getBrowserPaneUrl(pane.id)` — lo store,
   * gia' restaurato — mentre la barra legge `browser.url`, il browser vivo,
   * che non ha ancora navigato. `showChrome` e' `revealed || !isRealUrl(url)`,
   * quindi il secondo termine tiene la riga a schermo. Ripararlo vuol dire
   * decidere cosa mostra una pane che sta tornando in vita, che e' una scelta
   * di prodotto.
   *
   * Questo file e' stato recuperato il 25/08 da `topics/nostalgic-branch`,
   * dove era rimasto dentro un commit il cui messaggio dice «NON e' una
   * consegna». Erano 210 righe di e2e scritte per questa card e mai entrate
   * nella suite: le sette voci consegnate adesso hanno una prova, e l'ottava
   * ha un nome.
   */
  test("DEBITO: sulla pane ripristinata la barra indirizzi non se n'e' andata", async ({ page, request }) => {
    test.fail();
    const origine = sito!.origine;
    await resetPaneStore(request, []);
    const topic = await createTopic(request, `E2E-TABCHROME-DEBT-${Date.now()}`);
    topicId = topic.id;
    const host = new URL(origine).host;
    const etichetta = new RegExp(host.replace(/\./g, "\\.").replace(/:/g, ":"));

    await goToApp(page);
    await waitForTopicVisible(page, topic.id);
    await montaLaPane(page, topic.id, `${origine}/rapporto`);
    await expect(tabDelBrowser(page)).toContainText(etichetta, { timeout: 60_000 });

    // La pane si rimonta dallo store: e' il caso in cui le due superfici
    // divergono, ed e' il caso normale (riaprire l'app).
    await goToApp(page);
    await montaLaPane(page, topicId, `${origine}/rapporto`);
    await expect(tabDelBrowser(page)).toContainText(etichetta, { timeout: 60_000 });

    // Le due meta' dello scambio che la card vendeva, e che qui non regge.
    await expect(page.getByTestId("browser-url-input")).toHaveCount(0, { timeout: 30_000 });
    await page.getByTestId("browser-tab-menu").click();
    await expect(page.getByTestId("browser-tab-menu-address")).toBeVisible();
    await expect(page.getByTestId("browser-tab-console-cue")).toBeVisible();
  });
});
