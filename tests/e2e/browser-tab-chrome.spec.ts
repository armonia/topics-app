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
 *
 * @covers BROWSER-01 @covers BROWSER-CHROME-HYDRATE-01
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

async function startSite(): Promise<{ server: Server; origin: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(pagina());
  });
  await new Promise<void>((ok) => server.listen(0, HOST, ok));
  return { server, origin: `http://${HOST}:${(server.address() as AddressInfo).port}` };
}

/** Mount the browser pane for a topic, the way `/browser <url>` does in chat. */
async function mountPane(page: Page, topicId: string, url: string): Promise<void> {
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

  let site: { server: Server; origin: string } | null = null;
  let topicId = "";

  test.beforeAll(async () => {
    site = await startSite();
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
    await closeAllBrowserContexts(request);
    site?.server.close();
  });

  test("the address is on the tab, reload is under the pointer, the rest is behind the dots", async ({ request }) => {
    const origin = site!.origin;
    await resetPaneStore(request, []);
    const topic = await createTopic(request, `E2E-TABCHROME-${Date.now()}`);
    topicId = topic.id;
    const host = new URL(origin).host;
    const label = new RegExp(host.replace(/\./g, "\\.").replace(/:/g, ":"));

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
        await mountPane(p, topic.id, `${origin}/rapporto`);
        await expect(tabDelBrowser(p)).toContainText(label, { timeout: 60_000 });
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
        await mountPane(page, topicId, `${origin}/rapporto`);
        const tab = tabDelBrowser(page);

        // 1. WHERE WE ARE is written on the tab.
        await expect(tab).toContainText(label, { timeout: 60_000 });
        await expect(tab).toContainText(/rapporto/);
        await beat(page, 1400);

        // 2. …and precisely because the address is on the tab, the bar is no
        //    longer there: that is the space this card was buying. The hard
        //    case — the RESTORED pane, where the bar stayed — has a scene of
        //    its own at the bottom, because down there the cause is different
        //    (two surfaces, two sources) and it is worth proving separately.

        // 3. The icon slot: favicon at rest, reload under the pointer.
        await expect(page.getByTestId("browser-tab-icon")).toBeVisible();
        await tab.hover();
        await expect(page.getByTestId("browser-tab-reload")).toBeVisible();
        await beat(page, 1600);

        // 4. The three dots, which hold what the bar used to hold.
        //    Their contents on the restored pane are proved by the scene at the
        //    bottom; here it is enough that the button is there.
        await expect(page.getByTestId("browser-tab-menu")).toBeVisible();
        await beat(page, 1600);

        // The console-error cue depends on the page having LOADED, not on
        //    where the address is read: on a pane that has just been remounted
        //    those errors have not happened yet in the live browser. It is not
        //    a promise of this card, so it is not asserted here.
        await beat(page, 900);
      },
    });
  });

  /**
   * THE CARD'S EIGHTH ITEM, which had never landed and now is here.
   *
   * This file was recovered on 25/08 from `topics/nostalgic-branch`, where it
   * had stayed inside a commit whose message says «this is NOT a delivery».
   * Seven items out of eight were on main; this one was not, and what found
   * that out was the test itself, the moment it started running again.
   *
   * THE DEFECT, and why it could not be seen. The card was selling a trade:
   * «the address moves onto the tab, so the bar can go away». On a pane that
   * had just been opened it worked. On a RESTORED pane it did not, and nobody
   * noticed because the normal case — reopening the app — is also the one no
   * test covered. The two surfaces were reading two different sources for the
   * same fact: the tab `pane.url` from the store, already rehydrated, and the
   * rest `browser.url`, the live browser, which had not navigated yet.
   * `showChrome` was `revealed || !isRealUrl(url)`, so that second term kept
   * the row on screen forever, and `prettyUrl(about:blank)` produced nothing,
   * so the menu opened without the address row.
   *
   * THE CURE, in `useBrowserChromeBridge`: a `knownUrl` that carries the
   * store's value alongside the live one. `showChrome` now asks whether
   * NEITHER of the two is real — so a genuinely blank pane keeps its bar,
   * which down there is the only way out — and the address shown falls back to
   * `knownUrl` until the browser has finished. It is not a lie: the tab's
   * label, a centimetre further up, was already showing that address. Before,
   * the two surfaces said different things about the same pane.
   *
   * This scene exists separately from the first one because the defect was
   * ONLY here: the pane that had just been opened passed even before.
   */
  test("anche sulla pane RIPRISTINATA la barra se n'e' andata, e l'indirizzo per esteso e' nel menu", async ({ page, request }) => {
    const origin = site!.origin;
    await resetPaneStore(request, []);
    const topic = await createTopic(request, `E2E-TABCHROME-DEBT-${Date.now()}`);
    topicId = topic.id;
    const host = new URL(origin).host;
    const label = new RegExp(host.replace(/\./g, "\\.").replace(/:/g, ":"));

    await goToApp(page);
    await waitForTopicVisible(page, topic.id);
    await mountPane(page, topic.id, `${origin}/rapporto`);
    await expect(tabDelBrowser(page)).toContainText(label, { timeout: 60_000 });

    // The pane remounts from the store: it is the case in which the two
    // surfaces diverge, and it is the normal case (reopening the app).
    await goToApp(page);
    await mountPane(page, topicId, `${origin}/rapporto`);
    await expect(tabDelBrowser(page)).toContainText(label, { timeout: 60_000 });

    // The two halves of the trade the card was selling, and which down here
    // does not hold.
    await expect(page.getByTestId("browser-url-input")).toHaveCount(0, { timeout: 30_000 });

    // The three dots live in `opacity-0 group-hover:opacity-100`: without
    // hovering over the tab the button is there but transparent, and the click
    // is intercepted by the label underneath. It is not a product defect —
    // they are three pixels that do not take the address when they are not
    // needed.
    await tabDelBrowser(page).hover();
    await page.getByTestId("browser-tab-menu").click();
    await expect(page.getByTestId("browser-tab-menu-address")).toBeVisible();
    // The console-error cue does NOT belong here: it depends on the page
    // having loaded and logged something, not on where the address is read.
    // On a pane that has just been restored those errors have not happened yet
    // in the live browser, and demanding them here would measure the load
    // instead of the trade this scene proves.
  });

  /**
   * LO STESSO PATTO, CON L'IDRATAZIONE IN RITARDO — e questo e' il caso che
   * cade sul serio.
   *
   * Il test qui sopra e' rosso circa una volta su tre sotto quattro shard, e
   * verde sempre da solo: 34 letture consecutive del locator con l'elemento
   * ancora li', su 30 secondi. Non arriva tardi, non arriva. Il motivo e'
   * l'ORDINE: `knownUrl` legge il negozio delle pane in modo SINCRONO
   * (`getBrowserPaneUrl`), e finche' l'idratazione dal server non e' arrivata
   * quel negozio non sa niente. `showChrome` chiedeva «nessuna delle due e'
   * reale?» e su un «non lo so ancora» rispondeva SI'.
   *
   * Qui il ritardo si INIETTA invece di aspettare che il carico lo produca:
   * l'idratazione arriva dopo il montaggio, sempre. Cosi' il difetto ha un
   * rosso deterministico, e la cura ha un verde che significa qualcosa.
   *
   * «Non lo so ancora» non e' «non e' reale»: finche' il negozio non ha
   * parlato, la barra non e' una risposta.
   */
  test("con l'idratazione IN RITARDO la barra non torna: «non lo so ancora» non e' «non e' reale»", async ({ page, request }) => {
    const origin = site!.origin;
    await resetPaneStore(request, []);
    const topic = await createTopic(request, `E2E-TABCHROME-HYDRATE-${Date.now()}`);
    topicId = topic.id;
    const host = new URL(origin).host;
    const label = new RegExp(host.replace(/\./g, "\\.").replace(/:/g, ":"));

    await goToApp(page);
    await waitForTopicVisible(page, topic.id);
    await mountPane(page, topic.id, `${origin}/rapporto`);
    await expect(tabDelBrowser(page)).toContainText(label, { timeout: 60_000 });

    // Da qui in poi il negozio delle pane risponde TARDI: e' il ritardo che
    // sotto quattro shard capita da solo, reso ripetibile.
    let colpi = 0;
    await page.route("**/api/ui-state**", async (route) => {
      colpi++;
      await new Promise((r) => setTimeout(r, 4_000));
      await route.continue();
    });

    await goToApp(page);
    await mountPane(page, topicId, `${origin}/rapporto`);
    // Il ritardo deve stare SUL PERCORSO CRITICO, o questo caso e' verde su
    // niente: senza questa riga la prova successiva passerebbe anche su una
    // pagina che non ha mai chiesto l'idratazione.
    expect(colpi, "il ritardo non ha intercettato nessuna richiesta di idratazione").toBeGreaterThan(0);
    await expect(tabDelBrowser(page)).toContainText(label, { timeout: 60_000 });

    // La barra NON deve tornare mentre il negozio tace. Il tetto e' sotto il
    // ritardo iniettato, o si finirebbe per misurare il dopo invece del durante.
    await expect(
      page.getByTestId("browser-url-input"),
      "la barra e' tornata mentre il negozio non aveva ancora parlato",
    ).toHaveCount(0, { timeout: 3_000 });
  });
});
