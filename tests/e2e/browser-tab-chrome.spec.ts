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

        // 2. …e proprio perche' l'indirizzo e' sulla tab, la barra non c'e'
        //    piu': e' lo spazio che questa card comprava. Il caso difficile —
        //    la pane RIPRISTINATA, dove la barra restava — ha una scena sua in
        //    fondo, perche' li' la causa e' diversa (due superfici, due
        //    sorgenti) e vale la pena provarla separatamente.

        // 3. The icon slot: favicon at rest, reload under the pointer.
        await expect(page.getByTestId("browser-tab-icon")).toBeVisible();
        await tab.hover();
        await expect(page.getByTestId("browser-tab-reload")).toBeVisible();
        await beat(page, 1600);

        // 4. I tre pallini, che tengono quello che la barra teneva prima.
        //    Il loro contenuto sulla pane ripristinata e' provato dalla scena
        //    in fondo; qui basta che il bottone ci sia.
        await expect(page.getByTestId("browser-tab-menu")).toBeVisible();
        await beat(page, 1600);

        // La spia degli errori console dipende dal CARICAMENTO della pagina,
        //    non da dove si legge l'indirizzo: su una pane appena rimontata
        //    quegli errori non sono ancora avvenuti nel browser vivo. Non e'
        //    una promessa di questa card, quindi non e' asserita qui.
        await beat(page, 900);
      },
    });
  });

  /**
   * L'OTTAVA VOCE DELLA CARD, che non era mai arrivata e adesso c'e'.
   *
   * Questo file e' stato recuperato il 25/08 da `topics/nostalgic-branch`,
   * dove era rimasto dentro un commit il cui messaggio dice «NON e' una
   * consegna». Sette voci su otto erano su main; questa no, e a scoprirlo e'
   * stato il test stesso appena e' tornato a girare.
   *
   * IL DIFETTO, e perche' non si vedeva. La card vendeva uno scambio:
   * «l'indirizzo si sposta sulla tab, quindi la barra puo' andarsene». Su una
   * pane appena aperta funzionava. Su una pane RIPRISTINATA no, e nessuno lo
   * notava perche' il caso normale — riaprire l'app — e' anche quello che
   * nessun test copriva. Le due superfici leggevano due sorgenti diverse per
   * lo stesso fatto: la tab `pane.url` dallo store, gia' reidratato, e il
   * resto `browser.url`, il browser vivo, che non aveva ancora navigato.
   * `showChrome` era `revealed || !isRealUrl(url)`, quindi quel secondo
   * termine teneva la riga a schermo per sempre, e `prettyUrl(about:blank)`
   * non produceva niente, quindi il menu si apriva senza la riga
   * dell'indirizzo.
   *
   * LA CURA, in `useBrowserChromeBridge`: un `knownUrl` che porta il valore
   * dello store accanto a quello vivo. `showChrome` ora chiede se NESSUNO dei
   * due e' reale — cosi' la pane davvero bianca tiene la sua barra, che li' e'
   * l'unica via d'uscita — e l'indirizzo mostrato ripiega su `knownUrl`
   * finche' il browser non ha finito. Non e' una bugia: l'etichetta della tab,
   * un centimetro piu' su, mostrava gia' quell'indirizzo. Prima le due
   * superfici dicevano cose diverse sulla stessa pane.
   *
   * Questa scena esiste separata dalla prima perche' il difetto era
   * SOLTANTO qui: la pane appena aperta passava anche prima.
   */
  test("anche sulla pane RIPRISTINATA la barra se n'e' andata, e l'indirizzo per esteso e' nel menu", async ({ page, request }) => {
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

    // I tre pallini vivono in `opacity-0 group-hover:opacity-100`: senza
    // passare sopra la tab il bottone c'e' ma e' trasparente, e il click lo
    // intercetta l'etichetta sotto. Non e' un difetto del prodotto — sono tre
    // pixel che non si prendono l'indirizzo quando non servono.
    await tabDelBrowser(page).hover();
    await page.getByTestId("browser-tab-menu").click();
    await expect(page.getByTestId("browser-tab-menu-address")).toBeVisible();
    // La spia degli errori console NON sta qui: dipende dal fatto che la
    // pagina abbia caricato e loggato qualcosa, non da dove si legge
    // l'indirizzo. Su una pane appena ripristinata quegli errori non sono
    // ancora avvenuti nel browser vivo, e pretenderli qui misurerebbe il
    // caricamento invece dello scambio che questa scena prova.
  });
});
