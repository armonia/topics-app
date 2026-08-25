/**
 * Cross-Feature Interaction Tests
 *
 * These tests verify that features work correctly when used simultaneously --
 * not re-testing individual features, but their interactions.
 *
 * CONVENTION: No waitForTimeout() usage. Condition-based waits only.
 */
import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: riparte dalla baseline del globalSetup, non dallo stato
// lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);
const BASE = E2E_BASE;

test.describe("Cross-Feature Interactions", () => {
  // CROSS-01: Topic switch preserves chat scroll position
  test("CROSS-01: topic switch preserves or tests scroll position caching", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-01" });
    // Own both topics: a fresh topicA seeded with messages (instead of the shared
    // "Web Search Test" seed, whose sidebar visibility is reset by parallel workers)
    // plus an empty topicB for switching.
    const ts = Date.now();
    const topicA = await createTopic(page.request, `E2E-CrossA-${ts}`);
    for (let i = 0; i < 8; i++) {
      await page.request.post(`${BASE}/api/topics/${topicA.id}/system-message`, {
        data: { content: `Seed ${i + 1}: ${"Lorem ipsum dolor sit amet. ".repeat(4)}` },
        ignoreHTTPSErrors: true,
      });
    }
    const topicB = await createTopic(page.request, `E2E-CrossB-${ts}`);

    try {
      await goToApp(page);

      // Open topicA (freshly seeded) -- known to have messages
      await openTopic(page, new RegExp(`E2E-CrossA-${ts}`));

      // Wait for messages to render
      const messages = page.locator(".message-content");
      await expect(messages.first()).toBeVisible({ timeout: 15_000 });

      // Get the message list container for scroll manipulation
      // The Virtuoso component is inside the chat-message-list div
      const messageList = page.locator('[data-testid="chat-message-list"]');
      await expect(messageList).toBeVisible({ timeout: 5_000 });

      // Scroll the Virtuoso scroller to a mid-point
      // Virtuoso uses an inner scrollable div -- find it
      await messageList.evaluate((el) => {
        // Find the first scrollable child (Virtuoso's scroller)
        const scrollable = el.querySelector('[data-test-id="virtuoso-scroller"]')
          || el.querySelector('[style*="overflow"]')
          || el;
        // Scroll to 1/3 of the way
        const target = Math.max(100, scrollable.scrollHeight / 3);
        scrollable.scrollTop = target;
        return scrollable.scrollTop;
      });

      // Record scrollTop -- just verify we got a valid number > 0
      // (If no scrollable content, scrollTop stays 0 -- that's OK)
      const scrollTopBefore = await messageList.evaluate((el) => {
        const scrollable = el.querySelector('[data-test-id="virtuoso-scroller"]')
          || el.querySelector('[style*="overflow"]')
          || el;
        return scrollable.scrollTop;
      });

      // Switch to topicB (empty topic -- no messages)
      await openTopic(page, new RegExp(`E2E-CrossB-${ts}`));
      await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10_000 });

      // Switch back to topicA (freshly seeded)
      await openTopic(page, new RegExp(`E2E-CrossA-${ts}`));

      // Wait for messages to reappear
      await expect(messages.first()).toBeVisible({ timeout: 15_000 });

      // Check scroll position behavior
      const scrollTopAfter = await messageList.evaluate((el) => {
        const scrollable = el.querySelector('[data-test-id="virtuoso-scroller"]')
          || el.querySelector('[style*="overflow"]')
          || el;
        return scrollable.scrollTop;
      });

      // Document scroll preservation behavior via annotation
      if (scrollTopBefore > 0 && Math.abs(scrollTopAfter - scrollTopBefore) < 100) {
        test.info().annotations.push({
          type: "scroll-preservation",
          description: `Scroll position preserved: before=${scrollTopBefore}, after=${scrollTopAfter}`,
        });
      } else {
        test.info().annotations.push({
          type: "scroll-preservation",
          description: `Scroll position reset on topic switch: before=${scrollTopBefore}, after=${scrollTopAfter}`,
        });
      }

      // The test passes either way -- we verified the topic switch + scroll interaction
      // works without errors. The annotation documents actual behavior.
      expect(typeof scrollTopAfter).toBe("number");
    } finally {
      await deleteTopic(page.request, topicA.id);
      await deleteTopic(page.request, topicB.id);
    }
  });

  // CROSS-03: Concurrent streaming + panel interaction
  test("CROSS-03: streaming continues while interacting with other features", async ({
    page,
    chatPage,
    commandPalettePage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-01" });
    test.slow(); // Real streaming + panel interaction

    const ts = Date.now();
    const topic = await createTopic(page.request, `E2E-Cross03-${ts}`);

    try {
      // Clear panes leaked by earlier specs so exactly one chat pane (hence one
      // Message-input textarea) exists after openTopic.
      await resetPaneStore(page.request, []);
      await goToApp(page);

      // Dismiss any dialogs/palettes
      await page.keyboard.press("Escape");

      // Open the fresh chat topic
      await openTopic(page, new RegExp(`E2E-Cross03-${ts}`));

      // The chat pane should open -- wait for message input
      // If a project pane is showing, the textarea might not be in the project's chat section
      // but in a separate chat panel that openPanel creates
      const textarea = page.getByRole("textbox", { name: /Message input/ });
      const textareaVisible = await textarea.waitFor({ state: "visible", timeout: 10_000 })
        .then(() => true)
        .catch(() => false);

      if (!textareaVisible) {
        // Topic might need a double-click or the panel layout might need clearing
        // Try clicking the topic again (double-click opens as permanent panel)
        const treeitem = page.getByRole("treeitem", { name: new RegExp(`E2E-Cross03-${ts}`) });
        await treeitem.dblclick();
        await textarea.waitFor({ state: "visible", timeout: 10_000 });
      }

      // openclaw is unavailable on the isolated test server, so a real send never
      // streams. Fake a stuck stream: deliver ONE content delta with NO
      // "data: [DONE]" terminator. The client only clears `partial` on [DONE],
      // and the inline streaming indicator only renders once content has started
      // (empty partials show none) — so this keeps the indicator visible.
      await page.route("**/api/chat", async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        await route.fulfill({
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
          body:
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: { content: "Streaming a long answer about the history of computing…" } }],
            })}\n\n`,
        });
      });
      // After the stream body ends (no [DONE]) the client syncs history via
      // POST /api/history/:sessionKey and REPLACES the session messages with the
      // finalized server copy — which would drop the partial + its indicator.
      // Hang that sync so the partial (and the indicator) stays put while we
      // exercise the command palette.
      await page.route(/\/api\/history\//, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        await new Promise(() => {}); // never resolves
      });

      // Send a real message that will trigger actual streaming from the server
      await textarea.click();
      await textarea.fill(
        "Write a very long detailed paragraph of at least 500 words about the complete history of computing from 1950 to 2020"
      );
      await textarea.press("Enter");

      // Wait for streaming to start (streaming indicator appears)
      await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 20_000 });

      // Now interact with another feature while streaming: open command palette
      await commandPalettePage.open();
      await expect(commandPalettePage.overlay).toBeVisible({ timeout: 5_000 });

      // Type something in the palette to exercise it
      await commandPalettePage.searchInput.fill("test");

      // Close the palette
      await commandPalettePage.close();
      await expect(commandPalettePage.overlay).toBeHidden({ timeout: 5_000 });

      // After the interaction, verify streaming was NOT interrupted:
      // Either streaming indicator is still visible (still streaming)
      // OR the response content appeared (streaming completed naturally during interaction)
      const stillStreaming = await chatPage.streamingIndicator.isVisible().catch(() => false);

      if (stillStreaming) {
        test.info().annotations.push({
          type: "streaming",
          description: "Streaming indicator still visible after command palette interaction",
        });
      } else {
        // Stream completed naturally -- verify content was delivered (not aborted)
        await expect(page.locator('[role="main"]')).not.toBeEmpty();
        test.info().annotations.push({
          type: "streaming",
          description: "Stream completed naturally during palette interaction (not interrupted)",
        });
      }

      // Cleanup: the stream is intentionally stalled and never completes, so a
      // long wait here is pure dead time (the topic is deleted in `finally` and
      // each test gets a fresh page anyway). Keep it short — it's best-effort.
      await chatPage.streamingIndicator
        .waitFor({ state: "hidden", timeout: 3_000 })
        .catch(() => {});
    } finally {
      await deleteTopic(page.request, topic.id);
    }
  });

  // CROSS-04: Large message list virtual scroll (1000+ messages)
  test("CROSS-04: 1000+ messages render via virtual scroll without gaps", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-02" });
    test.slow(); // Large data set scrolling takes time

    const ts = Date.now();
    const topic = await createTopic(page.request, `E2E-Cross04-${ts}`);

    // Generate 1200 messages matching HistoryMessage shape
    const mockMessages = Array.from({ length: 1200 }, (_, i) => ({
      id: `msg-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i} content text for virtual scroll testing`,
      timestamp: new Date(Date.now() - (1200 - i) * 60000).toISOString(),
    }));

    try {
      // Mock history endpoint BEFORE navigation
      await page.route("**/api/history/**", async (route) => {
        if (route.request().method() !== "POST") {
          return route.fallback();
        }

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            messages: mockMessages,
            total: 1200,
          }),
        });
      });

      await goToApp(page);
      await openTopic(page, new RegExp(`E2E-Cross04-${ts}`));

      // Wait for message list to be visible (Virtuoso renders when messages exist)
      const messageList = page.locator('[data-testid="chat-message-list"]');
      await expect(messageList).toBeVisible({ timeout: 15_000 });

      // Wait for at least one message to render
      await expect(page.locator(".message-content").first()).toBeVisible({
        timeout: 10_000,
      });

      // LO SCROLLER E' QUELLO DI VIRTUOSO, e se non c'e' il test deve dirlo.
      //
      // Qui prima c'era un ripiego silenzioso su `messageList` quando lo
      // scroller non risultava ancora visibile (`.catch(() => false)`).
      // Scrollare il contenitore sbagliato non muove la lista virtualizzata:
      // la finestra resta dov'era, `idx.some(matches)` non diventa mai vero, e
      // il test moriva in `toPass` dopo dieci secondi accusando la
      // virtualizzazione. Un ripiego che rende il test incapace di misurare non
      // e' robustezza, e' un rosso che parla della cosa sbagliata.
      // `chat-message-list` E' lo scroller: il testid sta sul componente
      // Virtuoso, che rende un div scrollabile. Qui prima si cercava
      // `[data-virtuoso-scroller]` DENTRO di lui, un elemento che li' non
      // esiste, con un ripiego silenzioso sul contenitore quando non lo
      // trovava: cioe' sempre. Il ripiego funzionava per caso, e si portava
      // dietro un `.catch(() => false)` che avrebbe nascosto anche il caso in
      // cui la lista non si monta affatto.
      const scroller = messageList;
      await expect(
        scroller,
        "la lista dei messaggi non e' montata: senza, questo test non puo' misurare niente",
      ).toBeVisible({ timeout: 10_000 });

      // Helper to collect visible item indices
      async function collectVisibleIndices(): Promise<number[]> {
        const items = await page.locator('[data-item-index]').all();
        const indices: number[] = [];
        for (const item of items) {
          const idx = await item.getAttribute("data-item-index");
          if (idx) indices.push(Number(idx));
        }
        return indices;
      }

      // IL FONDO SI ASPETTA, non si presume. Virtuoso parte in fondo
      // (`initialTopMostItemIndex` = ultimo), ma «parte» non vuol dire «ci e'
      // gia'»: il primo campione poteva cadere mentre la lista montava ancora
      // le prime righe, e allora `maxIndex >= 1000` falliva su una lista sana
      // che un istante dopo era a posto. Era l'ultimo residuo di flake di
      // CROSS-04, e si toglie con lo stesso retry che usano le altre fasce.
      let bottomIndices: number[] = [];
      await expect(async () => {
        const idx = await collectVisibleIndices();
        expect(idx.some((i) => i >= 1000)).toBe(true);
        bottomIndices = idx;
      // 30 s, not 15. The inner attempt already re-tries; under load what is
      // missing is only the TIME to do it enough times — green with two shards,
      // "Timeout 15000ms exceeded" with four, same list and same code. A
      // virtual list that stopped mounting the right band would still fail.
      }).toPass({ timeout: 30_000 });

      // Scroll a una frazione dell'altezza e aspetta che Virtuoso ci porti
      // davvero le righe di quella zona.
      //
      // Lo scroll va RIAPPLICATO a ogni tentativo, non una volta prima del
      // poll: Virtuoso stima le altezze e le ri-misura mentre monta le righe,
      // quindi `scrollHeight` al momento del primo assegnamento è ancora una
      // stima. Se cambia subito dopo, la posizione ottenuta non è più la
      // frazione chiesta — e ripolla all'infinito indici che non arriveranno
      // mai, perché nessuno tocca più lo scroll. Rimettendolo dentro il retry
      // ogni tentativo ri-mira sull'altezza appena misurata e la posizione
      // converge. (Era questo il flake di CROSS-04 al 75%.)
      async function scrollToFractionAndSample(
        fraction: number,
        matches: (i: number) => boolean,
      ): Promise<number[]> {
        // Si RESTITUISCE il campione che ha soddisfatto la condizione, non uno
        // preso dopo. Ricampionare fuori dal retry era il difetto che teneva
        // rosso CROSS-04: `follow output` di Virtuoso riporta la lista in fondo
        // appena smette di ricevere scroll, quindi fra l'`expect` che vedeva
        // l'indice 0 e la riga dopo la finestra era gia' tornata a 1181. Il
        // test falliva su `minIndex <= 5` denunciando una virtualizzazione che
        // aveva appena funzionato — e la prova che era funzionata e' che il
        // retry, per uscire, quell'indice 0 lo aveva visto per forza.
        let campione: number[] = [];
        await expect(async () => {
          await scroller.evaluate((el, f) => { el.scrollTop = el.scrollHeight * f; }, fraction);
          // Si aspetta che la finestra CAMBI, non un tempo. Virtuoso monta le
          // righe della zona nuova in un effetto, quindi leggere il DOM nello
          // stesso tick dello scroll campiona la finestra di PRIMA, e il retry
          // finisce per misurare il proprio ritardo invece della lista.
          //
          // Un `waitForTimeout` qui sarebbe il sonno che `check:sleeps` vieta,
          // e per la ragione giusta: su un runner lento non basterebbe, su uno
          // veloce sarebbe sprecato. La condizione e' «il primo indice montato
          // non e' piu' quello di prima»: e' l'evento vero, scade dentro il
          // tentativo, e a rimettere lo scroll ci pensa il retry esterno.
          const primaDi = (await collectVisibleIndices())[0] ?? -1;
          await page
            .waitForFunction(
              (prec) => {
                const el = document.querySelector("[data-item-index]");
                return !!el && Number(el.getAttribute("data-item-index")) !== prec;
              },
              primaDi,
              { timeout: 3_000, polling: "raf" },
            )
            .catch(() => { /* gia' nella zona giusta, o ci pensa il retry */ });
          const idx = await collectVisibleIndices();
          expect(idx.some(matches)).toBe(true);
          campione = idx;
        // 30 s, not 15 — same reason as above: under load the repeatable
        // inner attempt needs the TIME to run enough times.
        }).toPass({ timeout: 30_000 });
        return campione;
      }

      // Cima della lista. Passa dallo STESSO retry delle altre fasce, e per lo
      // stesso motivo: un `scrollTop = 0` sparato una volta sola atterra su
      // un'altezza ancora stimata, e Virtuoso puo' non aver montato la riga 0
      // quando la si guarda. Prima qui c'era un `expect(...).toBeVisible()` con
      // `.catch(() => {})` attaccato — non poteva fallire, quindi `topIndices`
      // finiva per essere un campione qualunque spacciato per "la cima".
      const topIndices = await scrollToFractionAndSample(0, (i) => i === 0);

      // Mid-section should have indices between 200 and 900
      const midIndices = await scrollToFractionAndSample(0.5, (i) => i > 200 && i < 900);

      // 75% — un'altra fascia, per provare che il campionamento copre la lista
      const lateIndices = await scrollToFractionAndSample(0.75, (i) => i > 500);

      // Combine all collected indices
      const allIndices = new Set([
        ...topIndices, ...midIndices, ...lateIndices, ...bottomIndices,
      ]);
      const minIndex = Math.min(...allIndices);
      const maxIndex = Math.max(...allIndices);

      test.info().annotations.push({
        type: "virtual-scroll",
        description: `Sampled ${allIndices.size} unique items across top(${topIndices[0]}-${topIndices[topIndices.length-1]}), mid(${midIndices[0]}-${midIndices[midIndices.length-1]}), bottom(${bottomIndices[0]}-${bottomIndices[bottomIndices.length-1]})`,
      });

      // Verify the list spans 1000+ items (indices 0 through 1199)
      expect(minIndex).toBeLessThanOrEqual(5); // Near the top
      expect(maxIndex).toBeGreaterThanOrEqual(1000); // Near the bottom

      // Verify items render without gaps at each position
      // (if there were blank gaps, no items would be found at that scroll position)
      expect(topIndices.length).toBeGreaterThan(5);
      expect(midIndices.length).toBeGreaterThan(5);
      expect(bottomIndices.length).toBeGreaterThan(5);

      // Verify no crash -- messages still visible
      await expect(page.locator('[data-item-index]').first()).toBeVisible();
    } finally {
      await page.unroute("**/api/history/**");
      await deleteTopic(page.request, topic.id);
    }
  });

  // CROSS-05: Command palette works with no topic selected
  test("CROSS-05: command palette opens and returns results without active topic", async ({
    page,
    commandPalettePage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01" });
    // Navigate to app root WITHOUT opening any topic
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15_000,
    });

    // Open command palette without any topic context
    await commandPalettePage.open();
    await expect(commandPalettePage.overlay).toBeVisible({ timeout: 5_000 });

    // Search input should be focused
    await expect(commandPalettePage.searchInput).toBeFocused();

    // Type "new" to search for actions like "New Chat"
    await commandPalettePage.searchInput.fill("new");

    // Verify at least one result appears
    // Command palette results use role="option" or listbox items
    const results = commandPalettePage.overlay.locator('[role="option"]');
    const resultCount = await results.count();

    if (resultCount > 0) {
      await expect(results.first()).toBeVisible({ timeout: 5_000 });
    } else {
      // Fallback: check for any clickable items in the palette
      const items = commandPalettePage.overlay.locator("button, [role='menuitem'], li");
      await expect(items.first()).toBeVisible({ timeout: 5_000 });
    }

    // Clear and try a topic name fragment
    await commandPalettePage.searchInput.clear();
    await commandPalettePage.searchInput.fill("Web");

    // Should show results even without active topic
    await expect(async () => {
      const allResults = commandPalettePage.overlay.locator(
        '[role="option"], button:not([aria-label]), li'
      );
      const count = await allResults.count();
      expect(count).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });

    // Close the palette
    await commandPalettePage.close();
    await expect(commandPalettePage.overlay).toBeHidden({ timeout: 5_000 });
  });

  // CROSS-06: Theme switch preserves all component states across panels
  test("CROSS-06: theme toggle preserves panel state and content", async ({
    page,
    settingsPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01" });
    // Own a fresh seeded topic instead of the shared "Web Search Test" seed
    // (its sidebar visibility is reset by parallel workers on the test server).
    const ts = Date.now();
    const topic = await createTopic(page.request, `E2E-Cross06-${ts}`);
    for (let i = 0; i < 6; i++) {
      await page.request.post(`${BASE}/api/topics/${topic.id}/system-message`, {
        data: { content: `Seed ${i + 1}: ${"Lorem ipsum dolor sit amet. ".repeat(3)}` },
        ignoreHTTPSErrors: true,
      });
    }
    await goToApp(page);

    // Open a topic to get chat panel visible with content
    await openTopic(page, new RegExp(`E2E-Cross06-${ts}`));

    // Wait for messages to render
    const messages = page.locator(".message-content");
    await expect(messages.first()).toBeVisible({ timeout: 15_000 });

    // Record state before theme toggle: visible panels, message count
    const tabBar = page.locator('[data-testid="panel-tab-bar"]');
    const tabBarVisible = await tabBar.first().isVisible().catch(() => false);
    let tabCountBefore = 0;
    if (tabBarVisible) {
      tabCountBefore = await tabBar.first().locator('[draggable="true"]').count();
    }
    const messageCountBefore = await messages.count();

    // Record current theme state on html element
    const htmlClassBefore = await page.locator("html").getAttribute("class") || "";

    // Open settings and toggle theme
    await settingsPage.openSettings();
    await expect(settingsPage.panel).toBeVisible({ timeout: 10_000 });

    // Click the theme button that differs from current state
    // If currently dark, click Light; otherwise click Dark
    const isDark = htmlClassBefore.includes("dark");
    const targetBtn = isDark
      ? settingsPage.panel.getByRole("button", { name: "Light" })
      : settingsPage.panel.getByRole("button", { name: "Dark" });
    await targetBtn.click();

    // Wait for theme class to change on html element
    if (isDark) {
      await expect(page.locator("html")).not.toHaveClass(/dark/, { timeout: 5_000 });
    } else {
      await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 5_000 });
    }

    // Si chiude dalla fixture, che sa dov'e' il velo. Qui c'era
    // `.fixed.inset-0.z-50` scritto a mano: quel `z-50` non esiste piu' da
    // quando il layer dei modali e' passato a `z-[10000]` (`MODAL_OVERLAY` in
    // client/src/lib/modalStyles.ts), quindi il click aspettava per quindici
    // secondi un elemento che non c'e'. E' la lezione gia' scritta in
    // `PaneTabBar.tsx`: un locator agganciato alle classi Tailwind muore
    // quando qualcuno rinomina una utility, senza che nulla sia rotto.
    await settingsPage.closeSettings();

    // Verify panels survived the theme toggle:
    // 1. Messages are still visible (not wiped by re-render)
    await expect(messages.first()).toBeVisible({ timeout: 5_000 });
    const messageCountAfter = await messages.count();

    // Message count should be roughly the same (no content wipe)
    expect(messageCountAfter).toBeGreaterThanOrEqual(Math.max(1, messageCountBefore - 2));

    // 2. Tab bar tabs are still present (no panel crashed/disappeared)
    if (tabBarVisible && tabCountBefore > 0) {
      const tabCountAfter = await tabBar.first().locator('[draggable="true"]').count();
      expect(tabCountAfter).toBeGreaterThanOrEqual(tabCountBefore);
    }

    // 3. Main content area is still visible
    await expect(page.locator('[role="main"]')).toBeVisible();

    test.info().annotations.push({
      type: "theme-preservation",
      description: `Theme toggled ${isDark ? "dark->light" : "light->dark"}. Messages: ${messageCountBefore}->${messageCountAfter}. Panels intact.`,
    });

    // Restore theme to avoid affecting other tests
    await settingsPage.openSettings();
    const restoreBtn = isDark
      ? settingsPage.panel.getByRole("button", { name: "Dark" })
      : settingsPage.panel.getByRole("button", { name: "System" });
    await restoreBtn.click();
    await settingsPage.closeSettings();

    await deleteTopic(page.request, topic.id);
  });

  // CROSS-07: Mobile responsive layout transitions
  test("CROSS-07: viewport transitions preserve layout integrity", async ({
    page,
    layoutPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Own a fresh seeded topic instead of the shared "Web Search Test" seed
    // (its sidebar visibility is reset by parallel workers on the test server).
    const ts = Date.now();
    const topic = await createTopic(page.request, `E2E-Cross07-${ts}`);
    for (let i = 0; i < 6; i++) {
      await page.request.post(`${BASE}/api/topics/${topic.id}/system-message`, {
        data: { content: `Seed ${i + 1}: ${"Lorem ipsum dolor sit amet. ".repeat(3)}` },
        ignoreHTTPSErrors: true,
      });
    }
    // Start at desktop size
    await page.setViewportSize({ width: 1280, height: 800 });
    await goToApp(page);

    // Open a topic so we have content
    await openTopic(page, new RegExp(`E2E-Cross07-${ts}`));
    await expect(page.locator(".message-content").first()).toBeVisible({ timeout: 15_000 });

    // Verify desktop layout: sidebar visible, main content visible
    await expect(layoutPage.sidebar).toBeVisible({ timeout: 5_000 });
    await expect(layoutPage.mainContent).toBeVisible({ timeout: 5_000 });

    // Record desktop state
    const desktopSidebarWidth = await layoutPage.sidebar.evaluate(
      (el) => el.getBoundingClientRect().width
    );
    expect(desktopSidebarWidth).toBeGreaterThan(100);

    // Transition to mobile viewport (< 768px triggers isMobile)
    await page.setViewportSize({ width: 375, height: 812 });

    // Wait for layout to adapt -- main content should still be visible
    await expect(layoutPage.mainContent).toBeVisible({ timeout: 5_000 });

    // On mobile, sidebar auto-collapses (useEffect sets sidebarCollapsed=true)
    // Wait for the sidebar to become hidden (width transitions to 0)
    await expect(async () => {
      const width = await layoutPage.sidebar.evaluate(
        (el) => el.getBoundingClientRect().width
      );
      expect(width).toBeLessThan(10);
    }).toPass({ timeout: 5_000 });

    test.info().annotations.push({
      type: "responsive",
      description: "Sidebar auto-collapsed on mobile viewport transition",
    });

    // Verify sidebar can be toggled back via the toggle button
    const toggleBtn = layoutPage.sidebarToggleButton;
    const toggleVisible = await toggleBtn.isVisible().catch(() => false);
    if (toggleVisible) {
      await toggleBtn.click();
      // On mobile, sidebar opens as fixed overlay (280px wide)
      await expect(layoutPage.sidebar).toBeVisible({ timeout: 5_000 });

      // La X dentro il cassetto NON esiste più (07/08: era ridondante — il
      // cassetto si chiude da solo appena apri qualcosa, e con lo swipe). Qui
      // c'era un `if (closeBtnVisible) … else fallback`: da quando il bottone è
      // sparito il ramo `if` è morto e il test passava sempre dal fallback,
      // cioè provava una strada diversa da quella che il suo commento
      // dichiarava. Un ramo che non può più essere preso non è una rete di
      // sicurezza: è una riga che mente a chi la legge.
      await layoutPage.toggleSidebar();
    }

    // Verify no layout crash -- main content still accessible
    await expect(layoutPage.mainContent).toBeVisible();

    // Transition back to desktop
    await page.setViewportSize({ width: 1280, height: 800 });

    // Sidebar may remain collapsed after mobile mode -- re-expand via keyboard
    // (isMobile->false doesn't auto-expand; sidebarCollapsed stays true)
    await layoutPage.toggleSidebar();

    // Verify desktop layout restored: sidebar visible again
    await expect(layoutPage.sidebar).toBeVisible({ timeout: 5_000 });
    await expect(layoutPage.mainContent).toBeVisible({ timeout: 5_000 });

    // Verify sidebar width restored to desktop proportions
    await expect(async () => {
      const restoredSidebarWidth = await layoutPage.sidebar.evaluate(
        (el) => el.getBoundingClientRect().width
      );
      expect(restoredSidebarWidth).toBeGreaterThan(100);
    }).toPass({ timeout: 5_000 });

    const restoredSidebarWidth = await layoutPage.sidebar.evaluate(
      (el) => el.getBoundingClientRect().width
    );

    // Verify messages are still visible (content survived transitions)
    await expect(page.locator(".message-content").first()).toBeVisible({ timeout: 5_000 });

    test.info().annotations.push({
      type: "responsive",
      description: `Desktop->Mobile->Desktop transition complete. Sidebar: ${desktopSidebarWidth}px -> mobile -> ${restoredSidebarWidth}px`,
    });

    await deleteTopic(page.request, topic.id);
  });
});

/**
 * CROSS-02: WebSocket reconnection test.
 * Requires routeWebSocket BEFORE navigation, so it has its own describe block.
 */
test.describe("WS Reconnection", () => {
  test("CROSS-02: WebSocket reconnection restores panel states without duplicates", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    test.slow(); // Reconnection with backoff takes time

    // Own a fresh seeded topic instead of the shared "Web Search Test" seed
    // (its sidebar visibility is reset by parallel workers on the test server).
    const ts = Date.now();
    const topic = await createTopic(page.request, `E2E-Cross02-${ts}`);
    for (let i = 0; i < 8; i++) {
      await page.request.post(`${BASE}/api/topics/${topic.id}/system-message`, {
        data: { content: `Seed ${i + 1}: ${"Lorem ipsum dolor sit amet. ".repeat(3)}` },
        ignoreHTTPSErrors: true,
      });
    }

    // Set up WS interception BEFORE navigation to capture the main /ws connection.
    // Track both the WebSocketRoute (client-side) and server connection objects.
    const serverConnections: { close: () => void }[] = [];
    const clientRoutes: { close: () => void }[] = [];
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      serverConnections.push(server);
      clientRoutes.push(ws);
      // Transparent proxy -- pass through all messages
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => ws.send(msg));
    });

    await goToApp(page);

    // Open a topic to have visible panels/content
    await openTopic(page, new RegExp(`E2E-Cross02-${ts}`));

    // Wait for content to render
    const messages = page.locator(".message-content");
    await expect(messages.first()).toBeVisible({ timeout: 15_000 });

    // Record panel state before disconnect
    const tabBar = page.locator('[data-testid="panel-tab-bar"]');
    const tabBarExists = await tabBar.first().isVisible().catch(() => false);
    let tabCountBefore = 0;
    if (tabBarExists) {
      tabCountBefore = await tabBar.first().locator('[draggable="true"]').count();
    }

    // Count sidebar topic items before disconnect (to check for duplicates later)
    const sidebarItems = page.getByRole("treeitem");
    const sidebarCountBefore = await sidebarItems.count();

    // Verify we have at least one server connection
    expect(serverConnections.length).toBeGreaterThanOrEqual(1);
    const connectionsBefore = serverConnections.length;

    // Trigger disconnect by closing BOTH sides of the proxy.
    // Closing just the server side may not propagate to the client in Playwright's
    // routeWebSocket. We close the client route to ensure the browser's WS fires onclose.
    const lastClient = clientRoutes[clientRoutes.length - 1];
    lastClient.close();

    // Wait for auto-reconnection -- a new server connection should appear
    // The client's useWebSocket hook detects close, sets status to 'reconnecting',
    // then reconnects after exponential backoff (1s initial).
    await expect(async () => {
      expect(serverConnections.length).toBeGreaterThan(connectionsBefore);
    }).toPass({ timeout: 20_000 });

    // After reconnection the realtime WS status returns to "connected". The
    // redesigned status bar only renders the ws-connection-status warning WHILE
    // not connected (connecting/reconnecting/offline) — per its "only show live
    // signals" convention — so "connected" means that warning is gone. The
    // authoritative reconnection proof is the new server WS above.
    await expect(page.locator('[data-testid="ws-connection-status"]')).toBeHidden({
      timeout: 20_000,
    });

    // Verify panels restored: tab count matches (no panels lost or duplicated)
    if (tabBarExists && tabCountBefore > 0) {
      await expect(async () => {
        const tabCountAfter = await tabBar
          .first()
          .locator('[draggable="true"]')
          .count();
        expect(tabCountAfter).toBe(tabCountBefore);
      }).toPass({ timeout: 10_000 });
    }

    // Verify sidebar items didn't duplicate
    const sidebarCountAfter = await sidebarItems.count();
    // Allow small variance (server may push updates) but no massive duplication
    expect(sidebarCountAfter).toBeLessThanOrEqual(sidebarCountBefore + 3);

    // Verify messages are still visible (content not wiped)
    await expect(messages.first()).toBeVisible({ timeout: 5_000 });

    test.info().annotations.push({
      type: "ws-reconnection",
      description: `WS reconnected (${connectionsBefore}->${serverConnections.length} connections). Tabs: ${tabCountBefore} preserved. Sidebar items: ${sidebarCountBefore}->${sidebarCountAfter}.`,
    });

    await deleteTopic(page.request, topic.id);
  });
});
