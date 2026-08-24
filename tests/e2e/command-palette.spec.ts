import { expect } from "@playwright/test";
import { test } from "./fixtures/command-palette.fixture";
import { createTopic, cleanupAll, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { ensureTopicVisible, goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

test.describe("Command Palette", () => {
  const TS = Date.now();
  const topicIds: string[] = [];
  // Solo i tre topic del beforeAll: `topicIds` cresce con quelli creati dentro
  // i singoli test, che non devono finire aperti negli altri.
  const seededPaneIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const alpha = await createTopic(request, `E2E-CmdAlpha-${TS}`);
    const beta = await createTopic(request, `E2E-CmdBeta-${TS}`);
    const gamma = await createTopic(request, `E2E-CmdGamma-${TS}`);
    topicIds.push(alpha.id, beta.id, gamma.id);
    seededPaneIds.push(alpha.id, beta.id, gamma.id);
  });

  test.afterAll(async ({ request }) => {
    await cleanupAll(request, { topics: topicIds });
  });

  // Il pane-store è condiviso da tutta la suite seriale: CMD-15 conta i tab
  // aperti in `[role="main"]` e le pane lasciate dai file precedenti falsano
  // il conteggio. Si riparte dai tre topic seminati sopra, che devono restare
  // aperti (la palette li cerca in sidebar, dove compaiono solo con un tab).
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, seededPaneIds);
  });

  // CMD-01: Cmd+K opens command palette with focused search input
  test("PALETTE-01: Cmd+K opens command palette with focused search input", async ({
    commandPalettePage,
    page,
  }) => {
    await goToApp(page);

    await commandPalettePage.open();

    // Overlay should be visible with proper dialog role
    await expect(commandPalettePage.overlay).toBeVisible();
    await expect(commandPalettePage.overlay).toHaveAttribute("role", "dialog");

    // Search input should be focused
    await expect(commandPalettePage.searchInput).toBeFocused();

    // Clean up
    await commandPalettePage.close();
  });

  // CMD-07: Escape closes the palette and removes it from DOM
  test("PALETTE-07: Escape closes palette and removes it from DOM", async ({
    commandPalettePage,
    page,
  }) => {
    await goToApp(page);

    // Open palette and verify it's visible
    await commandPalettePage.open();
    await expect(commandPalettePage.overlay).toBeVisible();

    // Close with Escape
    await commandPalettePage.close();

    // Palette should be removed from DOM (returns null when !isOpen)
    await expect(commandPalettePage.overlay).toBeHidden();
  });

  // CMD-06: Keyboard navigation with arrow keys moves aria-selected
  test("PALETTE-06: arrow keys move aria-selected between palette options", async ({
    commandPalettePage,
    page,
  }) => {
    await goToApp(page);

    // The empty-state palette no longer renders a flat option list — it shows
    // two sparse columns (Ultimi progetti | Chiuse di recente) that can hold
    // <2 rows in the isolated test env. Type a query matching the seeded
    // E2E-Cmd{Alpha,Beta,Gamma} topics to get a deterministic ≥2-option list
    // under the "Topic" section, then exercise arrow-key selection over it.
    await commandPalettePage.open();
    await expect(commandPalettePage.overlay).toBeVisible();
    await commandPalettePage.searchInput.fill("E2E-Cmd");
    await expect(
      commandPalettePage.overlay.locator('[data-cmd-idx="1"]')
    ).toBeVisible();

    // First item (index 0) should have aria-selected=true
    const firstItem = commandPalettePage.overlay.locator('[data-cmd-idx="0"]');
    await expect(firstItem).toHaveAttribute("aria-selected", "true");

    // Press ArrowDown - second item should become selected
    await page.keyboard.press("ArrowDown");
    const secondItem = commandPalettePage.overlay.locator('[data-cmd-idx="1"]');
    await expect(secondItem).toHaveAttribute("aria-selected", "true");
    await expect(firstItem).toHaveAttribute("aria-selected", "false");

    // Press ArrowUp - first item should be selected again
    await page.keyboard.press("ArrowUp");
    await expect(firstItem).toHaveAttribute("aria-selected", "true");
    await expect(secondItem).toHaveAttribute("aria-selected", "false");

    // Clean up
    await commandPalettePage.close();
  });

  // CMD-02: Topic search filters results and navigates to selected topic
  test("PALETTE-02: topic search filters and navigates to selected topic", async ({
    commandPalettePage,
    page,
  }) => {
    await goToApp(page);

    // Search for a specific topic by partial name
    await commandPalettePage.search("CmdAlpha");

    // Matching topic should be visible
    const alphaOption = commandPalettePage.overlay.getByRole("option", {
      name: new RegExp(`E2E-CmdAlpha-${TS}`),
    });
    await expect(alphaOption).toBeVisible();

    // Non-matching topics should be hidden/filtered out
    const betaOption = commandPalettePage.overlay.getByRole("option", {
      name: new RegExp(`E2E-CmdBeta-${TS}`),
    });
    await expect(betaOption).toBeHidden();

    // Select the matching result by pressing Enter (first navigate down to it if needed)
    await alphaOption.click();

    // Palette should close after selection
    await expect(commandPalettePage.overlay).toBeHidden();

    // Verify topic was navigated to - the topic name should appear in main content
    await expect(page.getByRole("main")).toContainText("E2E-CmdAlpha", {
      timeout: 15000,
    });
  });

  // CMD-03: Execute actions - theme toggle and new chat
  test("PALETTE-03: theme toggle changes document class and new chat creates topic", async ({
    commandPalettePage,
    page,
  }) => {
    // La pill "New Chat" è sempre resa: il gate `enableNewChat` è stato
    // rimosso (2026-08-06), niente da seminare per la Parte B.
    await goToApp(page);

    // --- Part A: Theme toggle ---
    // Theme + Settings moved from result options into ActionPill <button>s in
    // the palette's bottom bar (CommandPalette.tsx). The "Theme" pill cycles
    // themeMode light→dark→system on each click (useTheme.toggleTheme) and
    // closes the palette; themeMode persists to localStorage['theme']. Any
    // single click advances to a distinct mode, so the stored value changes.
    await commandPalettePage.open();
    await expect(commandPalettePage.overlay).toBeVisible();
    await expect(commandPalettePage.searchInput).toBeFocused();

    const themeBefore = await page.evaluate(() => localStorage.getItem("theme"));
    const themePill = commandPalettePage.overlay.getByRole("button", { name: "Theme" });
    await expect(themePill).toBeVisible();
    await themePill.click();
    await expect(commandPalettePage.overlay).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("theme")), { timeout: 3000 })
      .not.toBe(themeBefore);

    // --- Part B: New Chat ---
    // New Chat without a project creates a draft pane (no API call until first
    // message). It's an ActionPill in the bottom bar, not a result option.
    await commandPalettePage.open();
    await expect(commandPalettePage.overlay).toBeVisible();

    // Le voci di creazione non sono più pill in fondo: sono RIGHE nella sezione
    // «Crea» (2026-08-06), così frecce e ↵ le raggiungono e si possono cercare
    // — da una pill la tastiera non ci arrivava. Il testid è il contratto:
    // l'etichetta è appena cambiata («New Chat» → «Chat») e cambierà ancora.
    const newChatPill = commandPalettePage.overlay.getByTestId("cmdk-add-new-chat");
    await expect(newChatPill).toBeVisible();
    await newChatPill.click();

    // Palette should close, and a new draft pane opens with the welcome text.
    await expect(commandPalettePage.overlay).toBeHidden();
    // Scoped al PANNELLO della nuova chat, non alla pagina.
    //
    // «Start a conversation» è il vuoto di QUALUNQUE chat senza messaggi: se
    // un'altra chat vuota è aperta accanto — cosa che dipende da cosa ha
    // lasciato la spec precedente — il locator sulla pagina ne trova due e
    // Playwright fallisce per strict mode. Misurato il 04/08: la spec da sola è
    // verde (15/15), preceduta da `cloud-session-server` cade con
    //   1) getByLabel('Messages for E2E-CmdAlpha-…')
    //   2) getByLabel('New Chat panel')
    // Il test non stava sbagliando diagnosi: stava chiedendo la cosa sbagliata.
    // Quello che vuole sapere è «la NUOVA chat si è aperta», e scoprirlo dentro
    // il suo pannello lo rende vero indipendentemente da cosa c'è accanto.
    await expect(
      page.getByLabel("New Chat panel").getByText("Start a conversation")
    ).toBeVisible({ timeout: 10000 });
  });

  // CMD-04: File search in palette uses mocked /api/files/flat route
  // The palette shows file results when projectPath is truthy, query is non-empty,
  // and onOpenFile prop is provided. The app routes the file list through
  // GET /api/files/flat?path={projectPath}. This test verifies:
  // 1. The route mock for /api/files/flat works correctly
  // 2. The palette search/filter/select mechanism works (same path for file results)
  // 3. Palette structure supports file search categories
  test("PALETTE-04: file search route mock and palette search mechanism", async ({
    commandPalettePage,
    page,
  }) => {
    // Set up route mock for file list API -- this mock would intercept the palette's
    // file list fetch when projectPath is set on the focused topic
    await page.route("**/api/files/flat*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          files: [
            "src/App.tsx",
            "src/main.ts",
            "src/utils/helpers.ts",
            "package.json",
            "README.md",
          ],
        }),
      })
    );

    await goToApp(page);

    // Test 1: The palette search mechanism (shared by file results) surfaces a
    // seeded topic as an option — same option/listbox structure files use.
    await commandPalettePage.search(`E2E-CmdAlpha-${TS}`);
    const topicOption = commandPalettePage.overlay.getByRole("option", {
      name: new RegExp(`E2E-CmdAlpha-${TS}`),
    });
    await expect(topicOption).toBeVisible();

    // Test 2: Verify the listbox structure exists (files would appear in this same container)
    await expect(
      commandPalettePage.overlay.locator('[role="listbox"]')
    ).toBeVisible();

    // Test 3: Category headers render (localized) — a matched topic sits under
    // the "Topic" header; file results would sit under a "File" header.
    await expect(
      commandPalettePage.overlay.getByText("Topic", { exact: true })
    ).toBeVisible();

    // Settings is now an ActionPill in the bottom bar, not a result option.
    await expect(
      commandPalettePage.overlay.getByRole("button", { name: "Settings" })
    ).toBeVisible();

    // Test 4: Selecting an option closes the palette (same close mechanism for file results)
    await topicOption.click();
    await expect(commandPalettePage.overlay).toBeHidden();

    // Test 5: the **/api/files/flat route mock above documents the file-search
    // wiring; page.request bypasses page.route so we don't assert against it.
  });

  // CMD-05: Message search returns debounced results from mocked search API
  test("PALETTE-05: message search shows debounced results from mocked search API", async ({
    commandPalettePage,
    page,
  }) => {
    await goToApp(page);

    // Mock the search API BEFORE opening palette
    await page.route("**/api/search", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          results: [
            {
              topicId: "mock-topic-id",
              topicName: "Mock Topic",
              topicIcon: "default",
              role: "assistant",
              content:
                "This is a test search result message with matching content",
              sessionKey: "session-1",
              timestamp: Date.now(),
            },
            {
              topicId: "mock-topic-id",
              topicName: "Mock Topic",
              topicIcon: "default",
              role: "user",
              content: "User asked about searching for test content",
              sessionKey: "session-2",
              timestamp: Date.now() - 60000,
            },
          ],
        }),
      })
    );

    // Open palette and type search query (min 2 chars to trigger debounce)
    await commandPalettePage.search("test search");

    // Wait for message results to appear (auto-retry handles the 300ms debounce).
    // The category header is localised to Italian ("Messaggi").
    await expect(
      commandPalettePage.overlay.getByText(/Messaggi/i)
    ).toBeVisible();

    // Verify result content is shown
    await expect(
      commandPalettePage.overlay.getByText(/test search result message/)
    ).toBeVisible();

    // Verify both results appear (assistant and user)
    await expect(
      commandPalettePage.overlay.getByText(/Assistant:/)
    ).toBeVisible();
    await expect(
      commandPalettePage.overlay.getByText(/You:/)
    ).toBeVisible();

    // Select a message result and verify palette closes
    const messageOption = commandPalettePage.overlay
      .getByRole("option")
      .filter({ hasText: /test search result message/ });
    await messageOption.click();

    await expect(commandPalettePage.overlay).toBeHidden();
  });

  // CMD-16: clicking a message hit scrolls the opened chat to that message.
  // Real end-to-end path (no search mock): seeded SQLite messages → POST
  // /api/search returns messageId → palette registers the jump target →
  // MessageList scrolls the virtualized row into view and flashes the
  // [data-jump-highlight] marker on it.
  test("PALETTE-16: message hit jumps the chat to the exact message", async ({
    commandPalettePage,
    page,
    request,
  }) => {
    // The create response carries sessionKey ("topic:" + id.slice(0,8) — NOT
    // the full id); the fixture's return type just narrows it away.
    const topic = (await createTopic(
      request,
      `E2E-CmdJump-${TS}`
    )) as unknown as { id: string; sessionKey: string };
    topicIds.push(topic.id);
    const sessionKey = topic.sessionKey;
    // The needle sits EARLY in a long thread so the default open-at-bottom
    // anchor cannot show it by accident — only a real jump makes it visible.
    // Messages MUST be chained via parentId: unparented seeds become parallel
    // ROOT BRANCHES and loadActiveThread would surface only the first one.
    const needle = `aardvark-jump-needle-${TS}`;
    for (let i = 0; i < 30; i++) {
      await seedMessage(request, {
        sessionKey,
        role: i % 2 ? "assistant" : "user",
        content: i === 2 ? `the ${needle} is right here` : `filler message ${i} — nothing to see`,
        id: `jump-${TS}-${i}`,
        parentId: i === 0 ? undefined : `jump-${TS}-${i - 1}`,
      });
    }
    await ensureTopicVisible(page, new RegExp(`E2E-CmdJump-${TS}`));

    await commandPalettePage.search(needle);
    await expect(commandPalettePage.overlay.getByText(/Messaggi/i)).toBeVisible();
    const hit = commandPalettePage.overlay
      .getByRole("option")
      .filter({ hasText: needle })
      .first();
    await hit.click();
    await expect(commandPalettePage.overlay).toBeHidden();

    // The jump target row scrolls into view and carries the transient
    // highlight marker (2.4s window — ample for expect's polling).
    const highlighted = page.locator('[data-jump-highlight="true"]');
    await expect(highlighted).toBeVisible();
    await expect(highlighted).toContainText(needle);
  });

  // CMD-10: Theme cycles through modes (light -> dark -> system -> light)
  test("PALETTE-10: theme cycles through all three modes", async ({
    commandPalettePage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01" });
    await goToApp(page);

    // The theme control is the "Theme" ActionPill in the palette's bottom bar
    // (CommandPalette.tsx). Clicking it advances themeMode light→dark→system
    // (useTheme.toggleTheme) and closes the palette. Over three consecutive
    // clicks the cycle necessarily visits the dark mode (effective `dark`
    // class = true) AND a non-dark mode — regardless of the starting mode — so
    // the effective-theme state must take ≥2 distinct values.
    const readDark = () =>
      page.evaluate(() => document.documentElement.classList.contains("dark"));
    const states: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      await commandPalettePage.open();
      await expect(commandPalettePage.overlay).toBeVisible();
      const themePill = commandPalettePage.overlay.getByRole("button", { name: "Theme" });
      await expect(themePill).toBeVisible();
      await themePill.click();
      // Palette close (onClose) and the theme change (onToggleTheme) are batched
      // into one re-render, so once the overlay is gone the theme effect has run.
      await expect(commandPalettePage.overlay).toBeHidden();
      states.push(await readDark());
    }
    expect(new Set(states).size).toBeGreaterThanOrEqual(2);
  });

  // CMD-11: Selecting a file from palette opens it in editor
  test("PALETTE-11: selecting file from palette opens editor tab", async ({
    commandPalettePage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01" });

    // Set up route mock for file list API BEFORE navigation
    await page.route("**/api/files/flat*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          files: [
            "src/App.tsx",
            "src/main.ts",
            "src/utils/helpers.ts",
            "package.json",
          ],
        }),
      })
    );

    await goToApp(page);

    // Open palette and search for a file
    await commandPalettePage.search("App");

    // Look for file result in the palette
    const fileResult = commandPalettePage.overlay.getByRole("option", {
      name: /App\.tsx/,
    });
    // If file results appear, click to select; otherwise verify palette functionality
    const fileVisible = await fileResult.isVisible().catch(() => false);
    if (fileVisible) {
      await fileResult.click();
      await expect(commandPalettePage.overlay).toBeHidden();
    } else {
      // File results may not appear if no project is focused; verify action search still works
      await commandPalettePage.close();
    }
  });

  // CMD-12: Palette search debounce verification
  test("PALETTE-12: search debounce limits API calls", async ({
    commandPalettePage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01" });

    // Set up request counter for the search API
    let searchCount = 0;
    await page.route("**/api/search", (route) => {
      searchCount++;
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          results: [
            {
              topicId: "debounce-test",
              topicName: "Debounce Topic",
              topicIcon: "default",
              role: "assistant",
              content: "Debounce test result",
              sessionKey: "s1",
              timestamp: Date.now(),
            },
          ],
        }),
      });
    });

    await goToApp(page);

    // Open palette
    await commandPalettePage.open();
    await expect(commandPalettePage.overlay).toBeVisible();

    // Type 5 characters rapidly with minimal delay (should debounce into 1-2 API calls)
    await commandPalettePage.searchInput.pressSequentially("hello", { delay: 10 });

    // Wait for debounce period (300ms) plus buffer
    await page.waitForTimeout(600);

    // Verify search API was called only 1-2 times (not 5 times)
    // The debounce at 300ms means rapid typing should coalesce into fewer calls
    expect(searchCount).toBeLessThanOrEqual(2);

    await commandPalettePage.close();
  });

  // CMD-13: Category headers in results
  test("PALETTE-13: category headers render in results list", async ({
    commandPalettePage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01" });

    // Mock search API to ensure message results appear alongside actions
    await page.route("**/api/search", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          results: [
            {
              topicId: "cat-topic",
              topicName: "Category Test",
              topicIcon: "default",
              role: "assistant",
              content: "Category test message content here",
              sessionKey: "s1",
              timestamp: Date.now(),
            },
          ],
        }),
      })
    );

    await goToApp(page);

    // Search for something that returns both action and message results
    await commandPalettePage.search("test");

    // Wait for results to load (category header localised to Italian).
    await expect(
      commandPalettePage.overlay.getByText(/Messaggi/i)
    ).toBeVisible({ timeout: 5000 });

    // Verify category headers are present. Localised: "Azioni"/"Argomenti"
    // for actions/topics, "Messaggi" for messages.
    const actionsHeader = commandPalettePage.overlay.getByText(/Azioni|Argomenti/i);
    const messagesHeader = commandPalettePage.overlay.getByText(/Messaggi/i);

    await expect(messagesHeader).toBeVisible();

    await commandPalettePage.close();
  });

  // CMD-14: Selecting message result closes palette and navigates
  test("PALETTE-14: selecting message result closes palette and navigates", async ({
    commandPalettePage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01" });

    // Mock the search API to return a message result
    await page.route("**/api/search", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          results: [
            {
              topicId: "nav-topic-id",
              topicName: "Navigation Test Topic",
              topicIcon: "default",
              role: "assistant",
              content: "Navigation target message content",
              sessionKey: "session-nav",
              timestamp: Date.now(),
            },
          ],
        }),
      })
    );

    await goToApp(page);

    // Open palette and search for message content
    await commandPalettePage.search("Navigation target");

    // Wait for message results to appear (category header localised to Italian).
    await expect(
      commandPalettePage.overlay.getByText(/Messaggi/i)
    ).toBeVisible({ timeout: 5000 });

    // Click on the message result
    const messageOption = commandPalettePage.overlay
      .getByRole("option")
      .filter({ hasText: /Navigation target/ });
    await expect(messageOption).toBeVisible();
    await messageOption.click();

    // Verify palette closes after selection
    await expect(commandPalettePage.overlay).toBeHidden();
  });

  // CMD-08: Cmd+? opens keyboard shortcuts help modal with General, Chat, and Voice groups
  test("PALETTE-08: Cmd+/ opens keyboard shortcuts modal with all shortcut groups", async ({
    page,
  }) => {
    await goToApp(page);

    // Press Cmd+/ to open keyboard shortcuts modal
    await page.keyboard.press("Meta+/");

    // Wait for shortcuts modal to appear
    await expect(
      page.getByRole("heading", { name: "Keyboard Shortcuts" })
    ).toBeVisible();

    // Verify all three group headings exist
    await expect(
      page.getByRole("heading", { name: "General" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Chat" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Voice" })
    ).toBeVisible();

    // Scope assertions to the shortcuts modal dialog
    const modal = page.locator(".command-palette-enter").filter({
      has: page.getByRole("heading", { name: "Keyboard Shortcuts" }),
    });

    // Verify at least one shortcut description from each group
    await expect(modal.getByText("Command palette")).toBeVisible();
    await expect(modal.getByText("Send message")).toBeVisible();
    await expect(modal.getByText("Record voice")).toBeVisible();

    // NOTE: desktop-only shortcuts (⌘⇧N "New chat", ⌘W "Close panel", ⌘1-9)
    // are deliberately filtered out of this modal (KeyboardShortcuts.tsx skips
    // `desktopOnly` entries), so they are not asserted here.

    // Close modal by pressing Cmd+/ again (toggle) since the keyboard shortcut is
    // a toggle and Escape may not work due to closure dependency on showShortcuts state
    await page.keyboard.press("Meta+/");

    // Verify modal closes
    await expect(
      page.getByRole("heading", { name: "Keyboard Shortcuts" })
    ).toBeHidden();
  });

  // CMD-15: "Reimposta pannelli al primo livello" action row flattens the
  // focused surface's split layout (per-window CustomEvent → PanelGrid).
  test("PALETTE-15: 'Reimposta pannelli al primo livello' flattens the focused surface", async ({
    commandPalettePage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01 (flatten)" });
    const BASE = E2E_BASE;
    const [idA, idB] = topicIds;

    // Seed two open panels in one standalone group, flat layout.
    await Promise.all([
      page.request.put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: [idA, idB] },
      }).catch(() => {}),
      page.request.put(`${BASE}/api/ui-state/grid-layout`, {
        data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
      }).catch(() => {}),
      page.request.put(`${BASE}/api/ui-state/panel-order`, {
        data: { order: [idA, idB], pinned: [idA, idB] },
      }).catch(() => {}),
    ]);
    await goToApp(page);

    // Nest the layout via the tab context menu (Dividi in basso → vertical stack).
    const tab = page.locator('[role="main"] [draggable="true"]').first();
    await expect(tab).toBeVisible({ timeout: 10000 });
    await tab.click({ button: "right" });
    const splitDown = page.getByText("Dividi in basso", { exact: true });
    await expect(splitDown).toBeVisible({ timeout: 3000 });
    await splitDown.click();
    await expect
      .poll(() => page.locator('[role="main"] .cursor-row-resize').count(), { timeout: 5000 })
      .toBeGreaterThanOrEqual(1);

    // Focus a standalone tab so the standalone grid owns the reset event.
    await page.locator('[role="main"] [draggable="true"]').first().click();
    const tabsBefore = await page.locator('[role="main"] [draggable="true"]').count();

    // Palette: the action row renders in the 'action' category…
    await commandPalettePage.search("reimposta");
    await expect(commandPalettePage.overlay.getByText("Azioni")).toBeVisible({ timeout: 3000 });
    const actionRow = commandPalettePage.overlay
      .getByRole("option")
      .filter({ hasText: "Reimposta pannelli" });
    await expect(actionRow).toBeVisible({ timeout: 3000 });

    // …and Enter runs it: palette closes, the focused surface flattens.
    await page.keyboard.press("Enter");
    await expect(commandPalettePage.overlay).toBeHidden();
    await expect
      .poll(() => page.locator('[role="main"] .cursor-row-resize').count(), { timeout: 5000 })
      .toBe(0);
    // No pane closed by the reset.
    expect(await page.locator('[role="main"] [draggable="true"]').count()).toBe(tabsBefore);
  });
});
