/**
 * Phase 30 Wave 0 — PANE-03 close+undo E2E fixture.
 *
 * Validates the close-and-undo lifecycle for app-level chat panes:
 *   1. Three chat tabs open via state injection.
 *   2. Middle tab is closed via the tab-bar close button.
 *   3. Undo (Cmd+Z) restores the tab.
 *
 * Split into two tests:
 *   - "close+undo lifecycle" — verifies the mechanics work (tab removed,
 *     closedStack captured the record with the right groupIndex, tab restored,
 *     scroll-container renders).
 *   - "la tab ripristinata torna al suo posto" — the PANE-03 invariant: the
 *     restored tab lands at its ORIGINAL index (not appended) and comes back
 *     active and usable. Lo scroll NON fa parte dell'invariante: è
 *     device-local e l'undo lo scarta di proposito (reducers/undo.ts).
 *
 * Strategy: state-injection for panel setup + UI-driven close/undo.
 * Topics are pre-seeded with messages so the chat container is scrollable.
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, seedPaneStore, waitForTopicVisible } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

async function gotoAndWait(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', {
    state: "visible",
    timeout: 15000,
  });
}

/** Seed enough messages into a topic so the chat container becomes scrollable. */
async function seedMessages(
  request: import("@playwright/test").APIRequestContext,
  topicId: string,
  count = 25,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
      data: {
        content: `Seed message ${i + 1}: ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(4)}`,
      },
      ignoreHTTPSErrors: true,
    });
  }
}

test.describe("@phase30-regression PANE-03: close+undo ghost-pane", () => {
  let t1: { id: string; name: string; slug: string };
  let t2: { id: string; name: string; slug: string };
  let t3: { id: string; name: string; slug: string };

  test.beforeAll(async ({ request }) => {
    t1 = await createTopic(request, `Undo-A-${Date.now()}`);
    t2 = await createTopic(request, `Undo-B-${Date.now()}`);
    t3 = await createTopic(request, `Undo-C-${Date.now()}`);

    // Seed messages into the middle topic so its chat is scrollable.
    // seedMessages takes a topic ID string — passing the whole {id,name,slug}
    // object coerces to "[object Object]" in the URL and 404s (no messages seeded).
    await seedMessages(request, t2.id, 30);
  });

  // Re-seed the pane layout before EVERY test — including retries. Playwright does
  // NOT re-run beforeAll on a retry, so the first attempt's close/undo (or a
  // cross-file teardown flush landing on the shared server) mutates the pane-store,
  // and the retry would inherit that (observed: only t3 survives → 1 tab, not 3).
  // `seedPaneStore` supplies a lastSeq that outranks any snapshot accumulated by
  // the long serial run, AND re-writes if a late `pagehide` beacon from the
  // previous spec clobbers our seed. The middle pane (t2) keeps scrollOffset=250.
  test.beforeEach(async ({ request }) => {
    await seedPaneStore(request, () => ({
      panes: {
        [t1.id]: { id: t1.id, type: "chat", title: t1.name, topicId: t1.id },
        [t2.id]: {
          id: t2.id,
          type: "chat",
          title: t2.name,
          topicId: t2.id,
          scrollOffset: 250,
        },
        [t3.id]: { id: t3.id, type: "chat", title: t3.name, topicId: t3.id },
      },
      groups: {
        "group:default": {
          id: "group:default",
          paneIds: [t1.id, t2.id, t3.id],
          splitRatio: 1,
          splitAxis: "horizontal",
        },
      },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
    }));

    // Legacy panels endpoint for sidebar visibility
    await request.put(`${BASE}/api/ui-state/panels`, {
      data: { openPanels: [t1.id, t2.id, t3.id] },
      ignoreHTTPSErrors: true,
    });
  });

  test.afterAll(async ({ request }) => {
    await deleteTopic(request, t1.id).catch(() => {});
    await deleteTopic(request, t2.id).catch(() => {});
    await deleteTopic(request, t3.id).catch(() => {});
  });

  test("PANE-03: close+undo lifecycle works (tab removed then restored)", async ({
    page,
    request,
  }) => {
    await gotoAndWait(page);

    // Finding #18: the beforeAll used direct state injection; confirm the
    // hydration path actually mounted the pre-seeded topics before we start
    // asserting tab-bar state.
    await waitForTopicVisible(page, t2.id);

    const tabBar = page.locator('[data-testid="panel-tab-bar"]');
    await expect(tabBar).toBeVisible({ timeout: 10_000 });

    const tabs = tabBar.locator('[draggable="true"]');
    await expect(tabs).toHaveCount(3, { timeout: 10_000 });

    // Verify initial order
    const originalOrder = await tabs.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-pane-id")),
    );
    expect(originalOrder).toEqual([t1.id, t2.id, t3.id]);

    // Activate the middle tab (t2) and wait for chat to load
    const middleTab = tabs.nth(1);
    await middleTab.click();
    await expect(middleTab).toHaveAttribute("data-active", "true", {
      timeout: 5_000,
    });
    // Replaces waitForTimeout(1500): wait for the chat scroll container to
    // mount before attempting to scroll it. Auto-retries, no fixed stall.
    // Scope to `:visible` — with three tabs open, the two previously-activated
    // panes (t1 + t2) keep their chat containers mounted; the inactive one is
    // display:none, so a bare selector resolves to 2 elements (strict-mode
    // violation). Only the ACTIVE pane's container (t2, just clicked) is visible,
    // and that is the one we want to scroll.
    const scrollContainer = page.locator(
      '[data-testid="chat-scroll-container"]:visible',
    );
    await expect(scrollContainer).toBeVisible({ timeout: 10_000 });

    // Scroll the chat container to ~250px, then poll until the DOM reflects it.
    // This replaces the implicit "did the scroll actually land" wait. The DOM
    // queries pick the VISIBLE container (offsetParent !== null) so we never
    // set/read scrollTop on the hidden keep-alive pane.
    await page.evaluate(() => {
      const outer = Array.from(
        document.querySelectorAll('[data-testid="chat-scroll-container"]'),
      ).find((el) => (el as HTMLElement).offsetParent !== null) as HTMLElement | null;
      if (outer) outer.scrollTop = 250;
      const virtuoso = outer?.querySelector(
        '[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]',
      ) as HTMLElement | null;
      if (virtuoso) virtuoso.scrollTop = 250;
    });
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const outer = Array.from(
              document.querySelectorAll('[data-testid="chat-scroll-container"]'),
            ).find((e) => (e as HTMLElement).offsetParent !== null) as HTMLElement | null;
            // Virtuoso owns the scroll: the outer wrapper has no overflow so its
            // scrollTop clamps to 0. Read the inner scroller we actually set.
            const el = (outer?.querySelector(
              '[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]',
            ) as HTMLElement | null) ?? outer;
            return el ? Math.round(el.scrollTop) : -1;
          }),
        { timeout: 3_000 },
      )
      .toBeGreaterThanOrEqual(200);

    // Close the middle tab via its close button (last <button> in the tab div).
    // Removed the hover + waitForTimeout(200) pause — Playwright's `click()`
    // already handles hover-reveal via auto-waiting actionability checks on
    // the close button locator.
    await middleTab.hover();
    await middleTab.locator("button").last().click({ force: true });

    // Tab was removed: 3 -> 2
    await expect(tabs).toHaveCount(2, { timeout: 5_000 });

    // Verify closedStack on the server captured the close. The poll must
    // succeed — an empty closedStack means the CLOSE never reached the sync
    // layer, which is exactly the bug this test is named after. Review-round-12
    // B4: the prior try/catch swallowed this failure, so the test passed green
    // even when the close was never persisted.
    let finalSnap: any = null;
    await expect
      .poll(
        async () => {
          const r = await request.get(`${BASE}/api/ui-state/pane-store-v2`, {
            ignoreHTTPSErrors: true,
          });
          if (!r.ok()) return 0;
          const body = (await r.json()) as { value?: any };
          finalSnap = body?.value ?? null;
          return finalSnap?.closedStack?.length ?? 0;
        },
        {
          message: "pane-store-v2.closedStack must have at least one entry after CLOSE_PANE",
          timeout: 5_000,
          intervals: [100, 200, 400, 800],
        },
      )
      .toBeGreaterThan(0);

    const top = finalSnap.closedStack[finalSnap.closedStack.length - 1];
    expect(
      top.groupIndex,
      "closedStack record should capture original groupIndex=1",
    ).toBe(1);
    expect(
      top.id,
      `top of closedStack should be the middle tab (${t2.id})`,
    ).toBe(t2.id);

    // Undo close via Cmd+Z (app-level UndoContext, NOT reopen-closed-tab event).
    // Blur any focused element first so Meta+z reaches the global undo handler
    // (it skips INPUT/TEXTAREA/contentEditable/.xterm/.cm-editor targets). A
    // prior version clicked the tab bar at (5,5) "to move focus off inputs",
    // but (5,5) lands on the FIRST tab's close button and enqueues a deferred
    // close of t1 that commits 3 s later — silently destroying t1 and breaking
    // the count/order assertions. Blur is precise and side-effect-free.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Meta+z");

    // Tab restored: 2 -> 3
    await expect(tabs).toHaveCount(3, { timeout: 10_000 });

    // The restored tab (t2) must be present and re-activatable without a crash.
    // The app-level undo now dispatches UNDO_CLOSE (re-inserts at the recorded
    // groupIndex) and marks the id restored so the standalone tab-ordering does
    // NOT replace+close a bystander preview tab. The stricter cross-mount scroll
    // fidelity assertion still lives in the PANE-03 fidelity test (below).
    const restoredTab = tabBar.locator(`[data-pane-id="${t2.id}"]`);
    await expect(restoredTab).toBeVisible({ timeout: 5_000 });

    // chat-scroll-container should exist after the restored tab is activated.
    // Replaces waitForTimeout(500) with auto-retrying visibility assertion.
    await restoredTab.click();
    await expect(scrollContainer).toBeVisible({ timeout: 10_000 });
  });

  // PANE-03, la fedeltà della posizione: la tab che torna dall'undo deve
  // ricomparire ESATTAMENTE dov'era, non in fondo.
  //
  // Questo test è stato rosso-per-scelta (`test.fail()`) per parecchio, con
  // scritto sopra che «Wave 3 collegherà UNDO_CLOSE all'undo di App». Tre cose
  // non tornavano più, ed è per questo che ora è verde:
  //
  //  1. Quel collegamento È GIÀ STATO FATTO. Lo dice il test qui sopra, 40
  //     righe più su: «the app-level undo now dispatches UNDO_CLOSE
  //     (re-inserts at the recorded groupIndex)». Il motivo scritto nel
  //     `test.fail()` descriveva un mondo che non esiste più.
  //  2. Lo scroll NON si ripristina dall'undo, e non è un buco: è una scelta.
  //     `pane.scrollOffset` è DEVICE-LOCAL — `CLOSE_PANE` non lo copia più sul
  //     record (reducers/panes.ts) e `undoReducer` lo toglie di proposito da
  //     quello che reinserisce (reducers/undo.ts, ultimo commento: rimetterlo
  //     riaprirebbe la fuga cross-device). Asserire qui «scrollTop ≈ 250 dopo
  //     l'undo» significava pretendere il contrario di una decisione presa.
  //     La posizione dello scroll sullo stesso dispositivo la ristabilisce il
  //     tracker post-mount, che ha la sua copertura.
  //  3. E comunque non ci arrivava: falliva PRIMA, sul locator. Usava
  //     `[data-testid="chat-scroll-container"]` senza `:visible`, che pesca
  //     anche il guscio keep-alive NASCOSTO, e poi leggeva lo `scrollTop` del
  //     wrapper esterno — che, come spiega il test qui sopra, resta inchiodato
  //     a 0 perché è Virtuoso a possedere lo scroll. Marcato `test.fail()`,
  //     nessuno se n'è accorto: un test rosso-atteso che falliva per un motivo
  //     diverso da quello dichiarato copriva ZERO, mentre l'annotazione diceva
  //     di coprire PANE-03.
  test("PANE-03b: la tab ripristinata torna al suo posto, non in fondo", async ({
    page,
    request,
  }) => {
    // ROSSO-ATTESO, e stavolta per il motivo giusto. Misurato con una sonda sul
    // pane-store subito dopo l'undo:
    //
    //   store  group:default = [t1, t3]        ← t2 NON è nel gruppo
    //   UI     [t1, t3, t2]                    ← ma la tab c'è, in fondo
    //
    // Cioè `UNDO_CLOSE` non reinserisce la pane nel gruppo, e la tab che si
    // vede è una GHOST PANE: esiste in `openPanels` senza uno slot nel gruppo
    // che la contiene — esattamente il guasto da cui questo file prende il
    // nome. L'indice registrato è giusto (il test qui sopra verifica
    // `groupIndex === 1` e passa), quindi il record è sano: si perde a valle.
    // RISOLTO il 04/08. Il sospetto scritto qui sopra era giusto a metà:
    // l'uscita anticipata in `reducers/undo.ts` c'era, ma toglierla non bastava.
    // Il caso che restava è «già inserita nel gruppo, all'indice SBAGLIATO»: un
    // hydrate in corsa (un peer stantio che ha ancora la pane nel gruppo perché
    // la chiusura non gli è arrivata) la riappende in coda, e la vecchia
    // guardia usciva perché la trovava «già sistemata». Ora, quando la pane sta
    // nel gruppo REGISTRATO ma nel posto sbagliato, la si SPOSTA a
    // `record.groupIndex`; solo una riapertura genuina già al posto giusto (o
    // in un altro gruppo) è davvero un no-op.
    //
    // Il `test.fail()` è stato tolto qui, come diceva il commento che stava al
    // suo posto: «quando il fix arriva, questo test diventa verde da solo».

    await gotoAndWait(page);

    // Finding #18: confirm the injected state actually reached the DOM
    // before asserting tab order.
    await waitForTopicVisible(page, t2.id);

    const tabBar = page.locator('[data-testid="panel-tab-bar"]');
    await expect(tabBar).toBeVisible({ timeout: 10_000 });

    const tabs = tabBar.locator('[draggable="true"]');
    await expect(tabs).toHaveCount(3, { timeout: 10_000 });

    const originalOrder = await tabs.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-pane-id")),
    );
    expect(originalOrder).toEqual([t1.id, t2.id, t3.id]);

    // Si attiva la tab di mezzo e la si chiude. Niente scroll da impostare:
    // l'invariante sotto esame è la POSIZIONE, e lo scroll non attraversa
    // l'undo per scelta (vedi il cappello del test).
    const middleTab = tabs.nth(1);
    await middleTab.click();
    await expect(middleTab).toHaveAttribute("data-active", "true", {
      timeout: 5_000,
    });
    // La chat della tab attiva deve essere montata prima di chiuderla, o si
    // starebbe chiudendo un guscio vuoto. `:visible` è obbligatorio: il
    // selettore nudo pesca anche i gusci keep-alive NASCOSTI delle altre pane.
    await expect(
      page.locator('[data-testid="chat-scroll-container"]:visible'),
    ).toBeVisible({ timeout: 10_000 });

    // Removed hover + waitForTimeout(200) before close — Playwright handles
    // hover-reveal via click actionability.
    await middleTab.hover();
    await middleTab.locator("button").last().click({ force: true });
    await expect(tabs).toHaveCount(2, { timeout: 5_000 });

    // Undo — blur any focused element so Meta+z reaches the global undo handler.
    // (A prior version clicked the tab bar at (5,5), which lands on the first
    // tab's close button and deferred-closes t1; blur is side-effect-free.)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Meta+z");
    await expect(tabs).toHaveCount(3, { timeout: 10_000 });

    // Tab order must match original (NOT appended)
    const restoredOrder = await tabs.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-pane-id")),
    );
    expect(restoredOrder).toEqual(originalOrder);

    // Restored middle tab should be active
    await expect(tabs.nth(1)).toHaveAttribute("data-active", "true");

    // …e torna USABILE, non un guscio morto: la sua chat si rimonta.
    await expect(
      page.locator('[data-testid="chat-scroll-container"]:visible'),
    ).toBeVisible({ timeout: 10_000 });
  });
});
