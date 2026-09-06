/**
 * browser-tab-chrome.spec.ts — the tab IS the browser chrome.
 *
 * What this file defends is the trade the card asked for: a browser pane no
 * longer carries a permanent address bar, because the address moved ONTO the
 * tab. That is only a good trade if everything the bar used to hold is still
 * reachable from the tab, so the assertions here are the four pieces of it:
 *
 *   1. the tab is LABELLED with the page title, falling back to the address
 *      when the page cannot name itself (which is this site's case: see the
 *      fixture below), and that address is also a click away, in the dropdown
 *      the tab opens under itself;
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
 * @covers BROWSER-01 @covers BROWSER-CHROME-HYDRATE-01 @covers BROWSER-CHROME-HYDRATE-01b @covers BROWSER-CHROME-INLINE-01
 */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import type { Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { E2E_BASE, E2E_DATA_DIR } from "./helpers/test-server";
import {
  createTopic,
  deleteTopic,
  waitForTopicVisible,
  resetPaneStore,
  seedPaneStore,
  resetProjectPanes,
  seedProjectPane,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
import { projectPanesKey } from "../../shared/project-keys";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { clipDiConsegna } from "./helpers/clip";
import { beat } from "./helpers/evidence";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const HOST = "127.0.0.1";

/**
 * The site the pane will show. Three things matter for the assertions: a path
 * (so the tab label has something to shorten), a declared favicon (the icon
 * slot has a real image to swap out), and two console errors (the red cue).
 *
 * IT DECLARES A `<title>` AND THE TAB STILL WRITES THE ADDRESS, which is not a
 * contradiction: this site is framable, so on the web the pane renders it in a
 * cross-origin `<iframe>` (`useIframe` in `RemoteBrowserPanel`) and no
 * server-side page ever loads it. There is no title to read from a cross-origin
 * document, and the address is exactly the fallback the rule prescribes for a
 * page that cannot name itself. The title half of the rule is proved by
 * BROWSER-TAB-LABEL-01, on a pane whose title is known.
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
    const label = new RegExp(host.replace(/\./g, "\\."));

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

        // 1. WHERE WE ARE is written on the tab. The rule is "page title, then
        //    the address": an iframed cross-origin page has no title anyone can
        //    read, so the address is what the tab has to say.
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
    const label = new RegExp(host.replace(/\./g, "\\."));

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
   * THE SAME TRADE, WITH HYDRATION ARRIVING LATE — and this is the case that
   * really falls over.
   *
   * The test above is red about one run in three under four shards, and always
   * green on its own: 34 consecutive reads of the locator with the element
   * still there, across 30 seconds. It does not arrive late, it does not
   * arrive. The reason is the ORDER: `knownUrl` reads the pane store
   * SYNCHRONOUSLY (`getBrowserPaneUrl`), and until hydration from the server
   * has landed that store knows nothing. `showChrome` was asking "is neither of
   * the two real?" and to an "I do not know yet" it answered YES.
   *
   * Here the delay is INJECTED instead of waiting for load to produce it:
   * hydration arrives after mount, every time. That way the defect gets a
   * deterministic red, and the cure gets a green that means something.
   *
   * "I do not know yet" is not "it is not real": until the store has spoken,
   * the bar is not an answer.
   */
  test("con l'idratazione IN RITARDO la barra non torna: «non lo so ancora» non e' «non e' reale»", async ({ page, request }) => {
    const origin = site!.origin;
    await resetPaneStore(request, []);
    const topic = await createTopic(request, `E2E-TABCHROME-HYDRATE-${Date.now()}`);
    topicId = topic.id;
    const host = new URL(origin).host;
    const label = new RegExp(host.replace(/\./g, "\\."));

    await goToApp(page);
    await waitForTopicVisible(page, topic.id);
    await mountPane(page, topic.id, `${origin}/rapporto`);
    await expect(tabDelBrowser(page)).toContainText(label, { timeout: 60_000 });

    // From here on the pane store answers LATE: it is the delay that under
    // four shards happens on its own, made repeatable.
    //
    // BOTH ROADS, and this is what the first version of this test missed.
    // Hydration reaches the tab two ways: the `/api/ui-state` GET (the bootstrap
    // fallback) and the `ui-state:init` / `:updated` frames on the WebSocket
    // (`syncWS.ts`, three separate `markServerHydrated()` calls). Delaying only
    // the GET leaves the WebSocket free, the flag flips within milliseconds, and
    // the case measures a page that HAS been hydrated — i.e. not the case it
    // claims to cover.
    //
    // Measured on 2026-08-26 with a probe: with the GET delayed, 12 requests
    // intercepted and still 1 `ui-state` frame delivered over the socket. That is
    // why the red persisted after the third-state fix landed: the fix is right,
    // the harness was only holding one of the two doors.
    let hits = 0;
    await page.route("**/api/ui-state**", async (route) => {
      hits++;
      await new Promise((r) => setTimeout(r, 4_000));
      await route.continue();
    });
    // The socket carries more than hydration (terminal output, presence): only
    // the `ui-state` frames are dropped, so the rest of the app keeps working and
    // this stays a test about hydration rather than about a broken connection.
    await page.addInitScript(() => {
      const OrigWS = window.WebSocket;
      class HydrationFilter extends OrigWS {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener('message', (ev: MessageEvent) => {
            if (typeof ev.data === 'string' && ev.data.includes('"ui-state:')) {
              ev.stopImmediatePropagation();
            }
          }, true);
        }
      }
      window.WebSocket = HydrationFilter as unknown as typeof WebSocket;
    });

    await goToApp(page);
    await mountPane(page, topicId, `${origin}/rapporto`);
    // The delay has to sit ON THE CRITICAL PATH, or this case is green on
    // nothing: without this line the proof below would pass even on a page that
    // never asked for hydration.
    expect(hits, "il ritardo non ha intercettato nessuna richiesta di idratazione").toBeGreaterThan(0);
    await expect(tabDelBrowser(page)).toContainText(label, { timeout: 60_000 });

    // The bar must NOT come back while the store stays silent. The cap is
    // below the injected delay, or one would measure the after instead of the
    // during.
    await expect(
      page.getByTestId("browser-url-input"),
      "la barra e' tornata mentre il negozio non aveva ancora parlato",
    ).toHaveCount(0, { timeout: 3_000 });
  });
  test("BROWSER-CHROME-HYDRATE-01b: dentro una finestra di progetto la pane ripristinata non rimette la barra sotto la tab", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-CHROME-HYDRATE-01b" });
    // A project browser pane lives in the project layout, not in the pane
    // store: seeded there with its url, exactly as a restart leaves it.
    const origin = site!.origin;
    const project = join(realpathSync(tmpdir()), `e2e-tab-chrome-project-${Date.now()}`);
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "e2e-tab-chrome-project" }));
    const ctx = `e2e-chrome-${Date.now()}`;
    try {
      await resetPaneStore(request, []);
      await resetProjectPanes(request, project).catch(() => {});
      await seedProjectPane(request, project);
      const put = await request.put(`${E2E_BASE}/api/ui-state/${projectPanesKey(project)}`, {
        data: { nonChatPanes: [{ id: `browser:${ctx}`, type: "browser", title: "Rapporto", url: `${origin}/rapporto` }], openChatTopicIds: [] },
        ignoreHTTPSErrors: true,
      });
      expect(put.ok(), "seeding the project browser pane").toBe(true);
      await goToApp(page);
      const projectTab = page.getByTestId(`pane-tab-project:${encodeURIComponent(project)}`);
      await expect(projectTab).toBeVisible({ timeout: 15000 });
      await projectTab.click();
      // The pane was seeded with `title: "Rapporto"`, so here the tab names the
      // PAGE rather than the address: the same rule, the other branch of it.
      await expect(tabDelBrowser(page)).toContainText(/Rapporto/, { timeout: 60_000 });
      // The claim is a negative one - the URL row must NOT come back on its own
      // once the store has spoken - and `toHaveCount(0)` is true the instant it
      // is asked. The condition that makes it mean something is not a fixed
      // window but SETTLEMENT: the row's presence has stopped changing. A row
      // that reappears restarts the quiet period and is then read as present,
      // which is the failure we want; a clean run stops as soon as it is quiet.
      const rowSettled = await page.waitForFunction(
        (quiet) => {
          const w = window as unknown as { __rowSeen?: number; __rowSince?: number };
          const now = performance.now();
          const count = document.querySelectorAll('[data-testid="browser-url-input"]').length;
          if (w.__rowSeen !== count) {
            w.__rowSeen = count;
            w.__rowSince = now;
            return null;
          }
          // An OBJECT, not the number: `waitForFunction` reads the return value
          // as "am I done?", and a settled count of zero - the good case - is
          // falsy, so returning it plainly would poll until the timeout.
          return now - (w.__rowSince ?? now) >= quiet ? { count } : null;
        },
        2000,
        { timeout: 30_000, polling: "raf" },
      );
      // The handle's type still admits the not-settled sentinel, which cannot
      // reach here: `waitForFunction` only resolves on a truthy value. The
      // fallback names that impossible case with a count no run can produce,
      // so it would fail loudly instead of being asserted away.
      const settledRow = (await rowSettled.jsonValue()) ?? { count: -1 };
      expect(settledRow.count, "the URL row must not come back on its own").toBe(0);
      await expect(page.getByTestId("browser-url-input")).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await resetProjectPanes(request, project).catch(() => {});
      rmSync(project, { recursive: true, force: true });
    }
  });
  /**
   * THE LABEL STAYS, THE ADDRESS DROPS DOWN.
   *
   * Until 2026-09-06 the click on the active tab swapped the label for an
   * input, in place. Two things were wrong with that, and neither is cosmetic:
   * the tab you were typing in stopped naming its page (on a blank pane, which
   * opens the editor by itself, the tab had no text at all - measured in
   * `chrome-bar-surface-inventory`, whose contrast sweep collected nothing),
   * and the field was as wide as a tab while an address is not.
   *
   * So the label is never replaced. The address opens in a panel anchored under
   * the tab, and the assertions below are the four halves of that: the tab
   * names the page, the panel opens UNDER it seeded with the address, there is
   * exactly ONE address field in the pane, and Enter still navigates.
   */
  test("BROWSER-CHROME-INLINE-01: the tab keeps its name and the address opens in a dropdown under it", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-CHROME-INLINE-01" });
    const origin = site!.origin;
    await resetPaneStore(request, []);
    const topic = await createTopic(request, `E2E-TABCHROME-INLINE-${Date.now()}`);
    topicId = topic.id;
    const host = new URL(origin).host;
    const label = new RegExp(host.replace(/\./g, "\\."));
    await goToApp(page);
    await waitForTopicVisible(page, topic.id);
    await mountPane(page, topic.id, `${origin}/rapporto`);

    const tab = tabDelBrowser(page);
    await expect(tab).toContainText(label, { timeout: 60_000 });
    await expect(page.getByTestId("browser-url-input")).toHaveCount(0, { timeout: 30_000 });

    // (b) The click on the tab you are ALREADY in opens the dropdown, seeded
    //     with the address, and the label is still there underneath.
    await tab.getByTestId("pane-tab-label").click();
    const dropdown = page.getByTestId("browser-address-dropdown");
    await expect(dropdown, "the dropdown opens under the tab").toBeVisible({ timeout: 10_000 });
    await expect(tab, "the label is not replaced by the field").toContainText(label);
    const editor = page.getByTestId("browser-tab-address-input");
    await expect(editor).toHaveValue(`${origin}/rapporto`);

    // ...UNDER the tab, which is a geometric claim and is checked as one: the
    // panel's top edge is at or below the tab's bottom edge.
    const tabBox = (await tab.boundingBox())!;
    const panelBox = (await dropdown.boundingBox())!;
    expect(
      panelBox.y,
      "the panel is anchored to the bottom edge of the tab",
    ).toBeGreaterThanOrEqual(tabBox.y + tabBox.height - 2);
    // ...and it is at least as wide as the tab it hangs from.
    expect(panelBox.width).toBeGreaterThanOrEqual(Math.min(tabBox.width, 480) - 1);

    // EXACTLY ONE ADDRESS FIELD IN THE PANE. The toolbar's own input only
    // exists on a console/downloads reveal (`useBrowserChromeBridge`), so
    // opening the dropdown must not produce a second one.
    await expect(page.getByTestId("browser-url-input"), "no second address field").toHaveCount(0);
    await expect(page.getByTestId("browser-tab-address-input")).toHaveCount(1);

    // Escape closes it and gives nothing back but the label.
    await editor.press("Escape");
    await expect(dropdown).toHaveCount(0);
    await expect(tab).toContainText(label);

    // Enter navigates, and the tab follows.
    await tab.getByTestId("pane-tab-label").click();
    await expect(dropdown).toBeVisible({ timeout: 10_000 });
    await editor.fill(`${origin}/seconda-pagina`);
    await editor.press("Enter");
    await expect(tab, "the tab writes where it went").toContainText(/seconda-pagina/, { timeout: 60_000 });
    await expect(page.getByTestId("browser-tab-address-input")).toHaveCount(0);
    await expect(page.getByTestId("browser-url-input")).toHaveCount(0);
  });

  /**
   * (a) A PAGE THAT HAS A NAME IS CALLED BY IT, on the ACTIVE tab too.
   *
   * This is the half of the rule the scenes above cannot show: their site is
   * framable, so the pane iframes it cross-origin and no page title ever
   * reaches the client (see the site fixture at the top). Here the pane is seeded
   * the way a load leaves it - `title` + `titleSource: 'auto'`, which is what
   * `persistBrowserPaneTitle` writes - and the claim is the one that changed on
   * 2026-09-06: the tab you are working in says WHICH PAGE it is, not where it
   * is. Until then the selected tab swapped its label for the address, so the
   * page with a perfectly good name was the one tab that would not use it.
   *
   * The second pane in the same bar has no title, and answers the other half:
   * the address is the FALLBACK, not the rule.
   */
  test("BROWSER-TAB-LABEL-01: the active tab writes the page title, and only a nameless page shows the address", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-TAB-LABEL-01" });
    const origin = site!.origin;
    const host = new URL(origin).host;
    const openedAt = Date.now();
    const named = `browser:named-${openedAt}`;
    const nameless = `browser:nameless-${openedAt}`;
    await seedPaneStore(request, () => ({
      panes: {
        [named]: { id: named, type: "browser", title: "Rapporto", titleSource: "auto", url: `${origin}/rapporto`, openedAt },
        [nameless]: { id: nameless, type: "browser", url: `${origin}/unnamed-page`, openedAt },
      },
      groups: {
        "group:default": { id: "group:default", paneIds: [named, nameless], splitRatio: 1, splitAxis: "horizontal" },
      },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
    }));
    await goToApp(page);

    const namedTab = page.locator(`[data-pane-id="${named}"]`);
    const namelessTab = page.locator(`[data-pane-id="${nameless}"]`);
    await expect(namedTab).toBeVisible({ timeout: 30_000 });

    // The tab that has a name uses it - including while it is the ACTIVE one,
    // which is the case that used to write the address instead.
    await namedTab.click();
    await expect(namedTab).toHaveAttribute("data-active", "true", { timeout: 15_000 });
    await expect(namedTab).toContainText(/Rapporto/, { timeout: 30_000 });
    await expect(namedTab, "the active tab must not be labelled with the host")
      .not.toContainText(new RegExp(host.replace(/\./g, "\\.")));

    // The tab that has none falls back to the address.
    await expect(namelessTab).toContainText(/unnamed-page/, { timeout: 30_000 });
  });

  /**
   * THE DELIVERY CLIP, and it is a film because the claim needs more than one
   * frame: the label has to STAY the page's name while the address appears
   * under it and then goes away again. A still picture of the open dropdown
   * would not say whether the tab kept its name, which is the whole point.
   *
   * The pane is a PROJECT pane seeded with its title, the way a restart
   * leaves it (same recipe as BROWSER-CHROME-HYDRATE-01b): it is the only
   * setup where a title is known to the client AND the pane is a real mounted
   * panel, because this fixture site is framable and an iframed cross-origin
   * document has no title anyone can read.
   */
  test("BROWSER-TAB-LABEL-01b: the tab keeps its name while the address opens and closes under it", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-TAB-LABEL-01" });
    const origin = site!.origin;
    const hostPattern = new RegExp(new URL(origin).host.replace(/\./g, "\\."));
    const project = join(realpathSync(tmpdir()), `e2e-tab-label-clip-${Date.now()}`);
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "e2e-tab-label-clip" }));
    const ctx = `e2e-label-${Date.now()}`;
    try {
      await resetPaneStore(request, []);
      await resetProjectPanes(request, project).catch(() => {});
      await seedProjectPane(request, project);
      const put = await request.put(`${E2E_BASE}/api/ui-state/${projectPanesKey(project)}`, {
        data: {
          nonChatPanes: [{ id: `browser:${ctx}`, type: "browser", title: "Rapporto", titleSource: "auto", url: `${origin}/rapporto` }],
          openChatTopicIds: [],
        },
        ignoreHTTPSErrors: true,
      });
      expect(put.ok(), "seeding the project browser pane").toBe(true);

      const openProject = async (p: Page) => {
        await goToApp(p);
        const projectTab = p.getByTestId(`pane-tab-project:${encodeURIComponent(project)}`);
        await expect(projectTab).toBeVisible({ timeout: 30_000 });
        await projectTab.click();
        await expect(p.locator(`[data-browser-pane="${ctx}"]`)).toBeVisible({ timeout: 30_000 });
      };

      await clipDiConsegna({
        nome: "browser-tab-dropdown",
        context: {
          baseURL: E2E_BASE,
          locale: "it-IT",
          viewport: { width: 1180, height: 760 },
          reducedMotion: "reduce",
        },
        // Bringing the app up and waiting for the server-side context is setup,
        // not scene: it runs on a page whose video is thrown away.
        prologo: openProject,
        scena: async (page) => {
          await openProject(page);
          const tab = tabDelBrowser(page);

          // 1. THE TAB SAYS WHICH PAGE IT IS, and it is the active one.
          await expect(tab).toContainText(/Rapporto/, { timeout: 60_000 });
          await expect(tab, "the active tab is not labelled with the host").not.toContainText(hostPattern);
          await beat(page, 1400);

          // 2. THE ADDRESS AT REST: the hover card, which is where it is read
          //    without opening anything. It is not the system tooltip
          //    (`TooltipDelegate` redraws it), so the film can show it.
          await tab.hover();
          const hoverCard = page.getByTestId("app-tooltip");
          await expect(hoverCard).toBeVisible({ timeout: 15_000 });
          await expect(hoverCard, "the hover card carries the whole address").toContainText(hostPattern);
          await beat(page, 1600);

          // 3. THE CLICK ON THE TAB YOU ARE ALREADY IN opens the dropdown under
          //    it, seeded with the address, and the label goes on naming the
          //    page: it is never replaced by the field.
          await tab.getByTestId("pane-tab-label").click();
          const dropdown = page.getByTestId("browser-address-dropdown");
          await expect(dropdown).toBeVisible({ timeout: 15_000 });
          await expect(page.getByTestId("browser-tab-address-input")).toHaveValue(`${origin}/rapporto`);
          await expect(tab, "the label is not replaced by the field").toContainText(/Rapporto/);
          // ONE address field in the pane: the toolbar does not show a second.
          await expect(page.getByTestId("browser-url-input")).toHaveCount(0);
          await beat(page, 1800);

          // 4. Escape gives the pane back, and the tab is where it was.
          await page.getByTestId("browser-tab-address-input").press("Escape");
          await expect(dropdown).toHaveCount(0);
          await expect(tab).toContainText(/Rapporto/);
          await beat(page, 1200);
        },
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  /**
   * (c) THE FIRST CLICK ON ANOTHER TAB ONLY BRINGS YOU THERE.
   *
   * The guard is `isFullyActive` in `PaneTabBar`: the label opens the address
   * only on the tab you are already looking at. Without it, reaching a browser
   * tab would drop a panel in your face every time.
   *
   * Two panes are seeded into one tab bar (the dashboard and a browser already
   * on a page) rather than opened through the chat event, because a browser
   * opened that way is soloed into a cell of its own - a bar with a single tab,
   * where "another tab" does not exist.
   */
  test("BROWSER-TAB-LABEL-02: the first click on a browser tab activates it and opens nothing", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-TAB-LABEL-02" });
    const origin = site!.origin;
    const ctx = `tabguard-${Date.now()}`;
    const paneId = `browser:${ctx}`;
    const openedAt = Date.now();
    await seedPaneStore(request, () => ({
      panes: {
        __dashboard__: { id: "__dashboard__", type: "dashboard", title: "", openedAt },
        [paneId]: { id: paneId, type: "browser", title: "Rapporto", titleSource: "auto", url: `${origin}/rapporto`, openedAt },
      },
      groups: {
        "group:default": { id: "group:default", paneIds: ["__dashboard__", paneId], splitRatio: 1, splitAxis: "horizontal" },
      },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
    }));
    await goToApp(page);

    const browserTab = page.locator(`[data-pane-id="${paneId}"]`);
    const dashboardTab = page.locator('[data-pane-id="__dashboard__"]');
    await expect(browserTab).toBeVisible({ timeout: 30_000 });
    await expect(dashboardTab).toBeVisible({ timeout: 30_000 });

    // Park the focus somewhere else, so the browser tab is the one you are NOT in.
    await dashboardTab.click();
    await expect(browserTab).toHaveAttribute("data-active", "false", { timeout: 15_000 });
    await expect(page.getByTestId("browser-address-dropdown")).toHaveCount(0);

    // The first click brings you there, and only that.
    await browserTab.getByTestId("pane-tab-label").click();
    await expect(browserTab).toHaveAttribute("data-active", "true", { timeout: 15_000 });
    await expect(
      page.getByTestId("browser-address-dropdown"),
      "reaching a tab must not open its address",
    ).toHaveCount(0);

    // The SECOND click, on the tab you are now in, is the one that opens it.
    //
    // The pane has to be MOUNTED first, and this is not a decorative wait: the
    // label asks the pane for `commands.editAddress`, which the pane publishes
    // from an effect on mount (`useBrowserChromeBridge`), and a click that
    // arrives before that finds no command and does nothing. The tab has only
    // just been brought to the front, so the panel behind it is still coming
    // up. Measured: one run in two red here without it, green on retry.
    await expect(page.locator(`[data-browser-pane="${ctx}"]`)).toBeVisible({ timeout: 30_000 });
    await browserTab.getByTestId("pane-tab-label").click();
    await expect(page.getByTestId("browser-address-dropdown")).toBeVisible({ timeout: 15_000 });
  });

  /**
   * (d) A BLANK PANE OPENS THE DROPDOWN BY ITSELF, and still has no second field.
   *
   * `RemoteBrowserPanel` auto-focuses the address of a pane that has nowhere to
   * go. That used to blank the tab's label (the label WAS the input); now the
   * tab says "New tab" and the panel hangs under it.
   */
  test("BROWSER-TAB-LABEL-03: a blank pane opens its address by itself, and the toolbar stays away", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-TAB-LABEL-03" });
    const paneId = `browser:blank-${Date.now()}`;
    // Seeded WITHOUT a title, which is what the product actually writes: a
    // browser pane is opened as `{id, type}` and nothing else
    // (`usePaneOrdering.persistBrowserPane`). The shared `resetPaneStore`
    // fixture stamps "Browser" on it, and that stamp would be the thing under
    // test rather than the rule.
    const openedAt = Date.now();
    await seedPaneStore(request, () => ({
      panes: { [paneId]: { id: paneId, type: "browser", openedAt } },
      groups: {
        "group:default": { id: "group:default", paneIds: [paneId], splitRatio: 1, splitAxis: "horizontal" },
      },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
    }));
    await goToApp(page);

    const tab = page.locator(`[data-pane-id="${paneId}"]`);
    await expect(tab).toBeVisible({ timeout: 30_000 });
    // The tab names itself before anyone types anything, which is the half the
    // in-place editor could not do: it left the label blank.
    // In the app's language: the e2e project runs `it-IT`, and a fresh settings
    // row follows the browser locale.
    await expect(tab).toContainText(/New tab|Nuova scheda/, { timeout: 30_000 });
    await expect(page.getByTestId("browser-address-dropdown")).toBeVisible({ timeout: 30_000 });
    // The pane's ONLY address field is the one in the dropdown.
    await expect(page.getByTestId("browser-url-input"), "no second address field").toHaveCount(0);
    await expect(page.getByTestId("browser-tab-address-input")).toHaveCount(1);
    // And the tab is still readable while the panel is open.
    await expect(tab).toContainText(/New tab/);
  });

  /**
   * IT SHOWS ONE THING AND COPIES ANOTHER, which is the whole defect.
   *
   * The tab menu wrote the address through `prettyUrl` and eleven lines above
   * copied a different one, the raw transport: the line read
   * `file:///…/documento.html` while the paste gave
   * `http://127.0.0.1:PORT/api/media?path=%2F…`. A LOCAL FILE is the scene that
   * shows it, because that is the one case where the two strings differ; on an
   * http site they coincide and the test would pass over the defect.
   *
   * The clipboard is replaced by a recorder because the real one needs a
   * permission headless does not grant: what is measured is the string the
   * component hands over, not the browser's permission.
   */
  test("«Copia indirizzo» copia esattamente l'indirizzo che il menu mostra", async ({ page, request }) => {
    await resetPaneStore(request, []);
    const topic = await createTopic(request, `E2E-TABCHROME-COPY-${Date.now()}`);
    topicId = topic.id;

    // `/api/media` serves an allowlist, and `${OPENCLAW_DIR}/media/` is in it
    // (helpers/test-server.ts holds the data dir of the test server).
    const mediaDir = join(E2E_DATA_DIR, ".openclaw", "media", "tab-chrome-copy");
    mkdirSync(mediaDir, { recursive: true });
    const file = join(realpathSync(mediaDir), `documento-${Date.now()}.html`);
    writeFileSync(file, "<!doctype html><html lang=\"en\"><title>Documento</title><p>ok</p>");
    const transport = `${E2E_BASE}/api/media?path=${encodeURIComponent(file)}`;

    await page.addInitScript(() => {
      const store: string[] = [];
      (window as unknown as { __copied: string[] }).__copied = store;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (t: string) => { store.push(t); } },
      });
    });

    await goToApp(page);
    await waitForTopicVisible(page, topic.id);
    await mountPane(page, topic.id, transport);

    await tabDelBrowser(page).hover();
    await page.getByTestId("browser-tab-menu").click();
    const address = page.getByTestId("browser-tab-menu-address");
    await expect(address).toHaveText(`file://${file}`, { timeout: 60_000 });

    await page.getByTestId("browser-tab-copy-url").click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied))
      .toEqual([`file://${file}`]);

    rmSync(mediaDir, { recursive: true, force: true });
  });
});
