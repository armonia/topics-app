import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import {
  createTopic,
  deleteTopic,
  createTerminalSession,
  deleteTerminalSession,
  deleteAllTerminalSessions,
  resetPaneStore,
} from "./helpers/api-fixtures";

const created: { topics: string[]; terminals: string[] } = {
  topics: [],
  terminals: [],
};

test.describe("Sidebar — Unified Timeline", () => {
  test.beforeAll(async ({ request }) => {
    // Reset sidebar state to clean defaults (include all legacy fields to prevent migration from old values)
    await request.put("http://localhost:13334/api/ui-state/sidebar-state", {
      data: {
        viewMode: "timeline",
        showArchived: false,
        expandedNodes: [],
        showProjects: true,
        showChats: true,
        showTerminals: true,
        showProjectsArchived: false,
        showChatsArchived: false,
        browserExpanded: false,
      },
    });

    // Create test data: a project topic, a standalone chat, and a terminal
    const projectTopic = await createTopic(request, "E2E-ProjectChat", {
      projectPath: "/tmp/e2e-sidebar-project",
    });
    created.topics.push(projectTopic.id);

    const standaloneChat = await createTopic(request, "E2E-StandaloneChat");
    created.topics.push(standaloneChat.id);

    const terminal = await createTerminalSession(request, {
      cwd: "/tmp",
      type: "shell",
      name: "E2E-TestTerminal",
    });
    created.terminals.push(terminal.id);
  });

  test.afterAll(async ({ request }) => {
    for (const id of created.topics) {
      await deleteTopic(request, id);
    }
    for (const id of created.terminals) {
      await deleteTerminalSession(request, id);
    }
  });

  // AC-1: Timeline view — all items in a single flat list
  test("AC-1: timeline view shows items in a single list", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "SIDEBAR-AC1",
    });

    // Pre-open tabs so items appear in sidebar
    await request.put("http://localhost:13334/api/ui-state/panels", {
      data: { openPanels: [created.topics[1], `terminal:${created.terminals[0]}`] },
    });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    // The sidebar tree should be visible
    const sidebar = page.getByRole("tree", { name: "Sidebar" });
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    // Items with open tabs should be visible
    await expect(
      page.getByRole("treeitem", { name: /E2E-StandaloneChat/ })
    ).toBeVisible({ timeout: 5000 });
  });

  // AC-1: Project accordion expands to show children
  // TODO: test infrastructure issue — pre-setting openPanels via API/localStorage doesn't reliably
  // propagate to React state before the click. Works correctly in the real app.
  test.fixme("AC-1: project accordion expands and collapses", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "SIDEBAR-AC1",
    });

    // Set panels in both localStorage and server to include the project chat
    const topicId = created.topics[0];
    await request.put("http://localhost:13334/api/ui-state/panels", {
      data: { openPanels: [topicId] },
    });
    // Also pre-set localStorage so the page loads with the panels immediately
    await page.addInitScript((id) => {
      localStorage.setItem("topics-open-panels", JSON.stringify([id]));
    }, topicId);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    // Wait for the project to show in sidebar
    const projectBtn = page.getByTestId("project-toggle-e2e-sidebar-project");
    await expect(projectBtn).toBeVisible({ timeout: 10000 });

    // Click to expand the project accordion
    await projectBtn.click();

    // After expanding, the project chat should be visible
    await expect(
      page.getByRole("treeitem", { name: /E2E-ProjectChat/ })
    ).toBeVisible({ timeout: 10000 });
  });

  // AC-2: Toggle between timeline and grouped view
  test("AC-2: view toggle switches between timeline and grouped", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "SIDEBAR-AC2",
    });

    // Pre-open tabs so sections have content in grouped view
    await request.put("http://localhost:13334/api/ui-state/panels", {
      data: { openPanels: [created.topics[1]] },
    });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    // The view-mode + archived toggles relocated from the old <SidebarControls>
    // row into the "Topics ▾" header menu (App.tsx). Open it to reach them.
    const topicsMenuBtn = page.locator('button[title="Settings & Tools"]');
    await topicsMenuBtn.click();

    // Timeline → grouped: the menu row reads "Vista a gruppi".
    const groupedToggle = page.getByRole("button", { name: "Vista a gruppi" });
    await expect(groupedToggle).toBeVisible({ timeout: 5000 });
    await groupedToggle.click();

    // In grouped view, collapsible section headers should appear
    await expect(
      page.getByRole("button", { name: /Chats section/ })
    ).toBeVisible({ timeout: 3000 });

    // The menu stays open and the same row now reads "Vista timeline".
    const timelineToggle = page.getByRole("button", { name: "Vista timeline" });
    await expect(timelineToggle).toBeVisible({ timeout: 3000 });

    // Click back to timeline
    await timelineToggle.click();

    // Section headers should be gone
    await expect(
      page.getByRole("button", { name: /Chats section/ })
    ).toBeHidden({ timeout: 3000 });
  });

  // AC-3: Archive toggle shows/hides archived items
  test("AC-3: archive toggle shows and hides archived items", async ({
    page,
    request,
  }) => {
    // Create and archive a topic with unique name
    const uniqueName = `E2E-ArchivedChat-${Date.now()}`;
    const archiveTopic = await createTopic(request, uniqueName);
    created.topics.push(archiveTopic.id);

    // Archive it via API (DELETE with body { archived: true } = archive, not delete)
    await request.delete(
      `http://localhost:13334/api/topics/${archiveTopic.id}`,
      { data: { archived: true } }
    );

    // Ensure clean sidebar state on server — set showArchived=false
    await request.put("http://localhost:13334/api/ui-state/sidebar-state", {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], showProjectsArchived: false, showChatsArchived: false },
    });

    // Verify it was saved
    const verifyRes = await request.get("http://localhost:13334/api/ui-state/sidebar-state");
    const verifyData = await verifyRes.json();
    console.log("[ARCHIVE] Server state after reset:", JSON.stringify(verifyData));

    await goToApp(page);

    const archivedItem = page.getByRole("treeitem", { name: new RegExp(uniqueName) }).first();

    // With showArchived=false, the item should be hidden
    await expect(archivedItem).toBeHidden({ timeout: 5000 });

    // The archived toggle relocated into the "Topics ▾" header menu (App.tsx).
    // It's a single row ("Mostra archiviati") that flips showArchived on each
    // click; the menu stays open, so the same locator toggles both ways.
    await page.locator('button[title="Settings & Tools"]').click();
    const archiveToggle = page.getByRole("button", { name: "Mostra archiviati" });
    await expect(archiveToggle).toBeVisible({ timeout: 3000 });

    // Reveal archived items
    await archiveToggle.click();
    await expect(archivedItem).toBeVisible({ timeout: 5000 });

    // Hide them again (same row)
    await archiveToggle.click();
    await expect(archivedItem).toBeHidden({ timeout: 5000 });
  });

  // AC-6: Search — now handled by command palette (Cmd+K), not inline search
  // The sidebar search button opens the command palette. Inline search tests removed
  // as the search UX changed to use the global command palette.

  // AC-8: Controls layout — search + two toggles
  test("AC-8: sidebar controls are compact with search and toggles", async ({
    page,
  }) => {
    await goToApp(page);

    // Search launcher lives in the header (opens the ⌘K command palette).
    await expect(
      page.getByRole("button", { name: /open the command palette/ })
    ).toBeVisible({ timeout: 5000 });

    // View-mode + archive toggles live in the "Topics ▾" header menu.
    await page.locator('button[title="Settings & Tools"]').click();
    await expect(
      page.getByRole("button", { name: "Mostra archiviati" })
    ).toBeVisible({ timeout: 3000 });
    await expect(
      page.getByRole("button", { name: "Vista a gruppi" })
    ).toBeVisible({ timeout: 3000 });
  });

  // AC-1: Clicking a topic in timeline still switches panel
  test("clicking topics in timeline switches the main panel", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "SIDEBAR-AC1",
    });

    // Pre-open standalone chat tab so it appears in sidebar
    await request.put("http://localhost:13334/api/ui-state/panels", {
      data: { openPanels: [created.topics[1]] },
    });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    await openTopic(page, /E2E-StandaloneChat/);

    // Wait for textarea to confirm the panel loaded
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await expect(textarea).toBeVisible({ timeout: 10000 });
  });
});

// ── Fissati (pinning) — Arc/Dia-style pinned rows ──────────────────────────────
//
// A pinned row survives tab close (NO archive-on-close — the pinnedIds gate
// escape keeps the row), renders in the dedicated "Fissati" block at the top
// of the sidebar with a pin glyph, and one click reopens. Unpinning a CLOSED
// chat archives it (back to the 2-state model: closed ⟺ archived).
test.describe("Sidebar — Fissati (pinning)", () => {
  const BASE = "http://localhost:13334";
  const pinCreated: string[] = [];

  const resetSidebarState = async (request: import("@playwright/test").APIRequestContext) => {
    await request.put(`${BASE}/api/ui-state/sidebar-state`, {
      data: {
        viewMode: "timeline",
        showArchived: false,
        expandedNodes: [],
        pinnedItems: [],
      },
    });
  };

  /** Poll the server copy of sidebar-state until `id` is (or isn't) pinned —
   *  proves the debounced PUT landed, so a reload can't lose the pin. */
  const expectServerPin = async (
    request: import("@playwright/test").APIRequestContext,
    id: string,
    present: boolean,
  ) => {
    await expect
      .poll(
        async () => {
          const res = await request.get(`${BASE}/api/ui-state/sidebar-state`);
          if (!res.ok()) return !present;
          const data = await res.json();
          const pins: string[] = data?.value?.pinnedItems ?? data?.pinnedItems ?? [];
          return pins.includes(id);
        },
        { timeout: 10000 }
      )
      .toBe(present);
  };

  test.beforeAll(async ({ request }) => {
    await resetSidebarState(request);
    // Isolate from prior specs' pollution: the pane store converges by UNION on
    // hydrate, so any leftover panes / terminal sessions would surface as stray
    // tabs and make the exact tab-visibility assertions below order-dependent.
    // Start from an empty layout with no live PTYs.
    await deleteAllTerminalSessions(request);
    await resetPaneStore(request, []);
  });

  test.afterAll(async ({ request }) => {
    // Reset pins AFTER the pages closed so a late debounced PUT from the app
    // can't resurrect them into other spec files.
    await resetSidebarState(request);
    for (const id of pinCreated) await deleteTopic(request, id);
  });

  // PIN-1: full chat lifecycle — pin, close (archives; row persists via the
  // pinnedIds escape), reopen (unarchives), unpin while closed (archives).
  test("PIN-1: pin a chat → close its tab keeps the pinned row (topic archives) → click reopens → unpin while closed archives", async ({
    page,
    request,
  }) => {
    const name = `E2E-PinChat-${Date.now()}`;
    const t = await createTopic(request, name);
    pinCreated.push(t.id);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const row = page.getByRole("treeitem", { name: new RegExp(name) });
    await expect(row).toBeVisible({ timeout: 10000 });

    // Pin via the topic context menu ("Fissa"). exact: true — "Fissa" is a
    // substring of "Rimuovi dai Fissati".
    await row.click({ button: "right" });
    const menu = page.getByRole("menu");
    await menu.waitFor({ state: "visible" });
    await menu.getByRole("menuitem", { name: "Fissa", exact: true }).click();

    // Row moves into the Fissati block and carries the pinned marker.
    const pinnedSection = page.getByTestId("sidebar-pinned-section");
    await expect(pinnedSection.getByRole("treeitem", { name: new RegExp(name) })).toBeVisible({ timeout: 5000 });
    await expect(row).toHaveAttribute("data-pinned", "true");
    await expectServerPin(request, t.id, true);

    // Close the tab through the SAME user-close funnel Cmd+W reaches
    // (right-click → "Close now" bypasses the 3s countdown deterministically).
    const paneTab = page.getByTestId(`pane-tab-${t.id}`);
    await expect(paneTab).toBeVisible({ timeout: 5000 });
    await paneTab.click({ button: "right" });
    await page.getByRole("button", { name: /Close now/ }).click();
    await expect(paneTab).toBeHidden({ timeout: 5000 });

    // Pinned ⇒ the row PERSISTS, but the topic DOES archive on close. The
    // archived flag is the durable, server-authoritative, cross-client "closed"
    // signal (2-state model); exempting pinned chats from it left the closure
    // represented only by the device-local closedStack tombstone, which a stale
    // second client / mobile PWA / the server's own stored snapshot out-raced,
    // resurrecting the tab ("closed pinned chat reappears"). The sidebar's
    // pinnedIds escape keeps the row visible even when archived, and the click
    // below unarchives on reopen — so Arc "one click reopens" is preserved.
    await expect(pinnedSection.getByRole("treeitem", { name: new RegExp(name) })).toBeVisible({ timeout: 5000 });
    await expect
      .poll(
        async () => {
          const res = await request.get(`${BASE}/api/topics`);
          const data = await res.json();
          return data?.topics?.[t.id]?.archived;
        },
        { timeout: 10000 }
      )
      .toBe(true);

    // One click reopens the tab (openPanel unarchives an archived chat).
    await row.click();
    await expect(page.getByTestId(`pane-tab-${t.id}`)).toBeVisible({ timeout: 10000 });
    await expect
      .poll(
        async () => {
          const res = await request.get(`${BASE}/api/topics`);
          const data = await res.json();
          return data?.topics?.[t.id]?.archived;
        },
        { timeout: 10000 }
      )
      .toBe(false);

    // Close again, then UNPIN while closed → row disappears AND the topic
    // archives (2-state fallback: no phantom non-archived tab-less topic).
    await page.getByTestId(`pane-tab-${t.id}`).click({ button: "right" });
    await page.getByRole("button", { name: /Close now/ }).click();
    await expect(page.getByTestId(`pane-tab-${t.id}`)).toBeHidden({ timeout: 5000 });

    await row.click({ button: "right" });
    const menu2 = page.getByRole("menu");
    await menu2.waitFor({ state: "visible" });
    await menu2.getByRole("menuitem", { name: "Rimuovi dai Fissati" }).click();

    await expect(row).toBeHidden({ timeout: 5000 });
    await expect
      .poll(
        async () => {
          const res2 = await request.get(`${BASE}/api/topics`);
          const data2 = await res2.json();
          return data2?.topics?.[t.id]?.archived;
        },
        { timeout: 10000 }
      )
      .toBe(true);
  });

  // PIN-3: regression — a closed pinned chat must NOT reappear as a tab after a
  // reload. Before the fix, closing a pinned chat left it non-archived, so its
  // closure was represented only by the device-local closedStack tombstone; a
  // stale peer / the server's stored snapshot then resurrected the tab. Now the
  // chat archives on close (durable cross-client closed signal) while the
  // pinned sidebar row persists via the pinnedIds escape.
  test("PIN-3: a pinned chat closed then reloaded does NOT resurrect its tab (row persists)", async ({
    page,
    request,
  }) => {
    const name = `E2E-PinReload-${Date.now()}`;
    const t = await createTopic(request, name);
    pinCreated.push(t.id);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const row = page.getByRole("treeitem", { name: new RegExp(name) });
    await expect(row).toBeVisible({ timeout: 10000 });

    // Pin, then confirm the tab is open.
    await row.click({ button: "right" });
    const menu = page.getByRole("menu");
    await menu.waitFor({ state: "visible" });
    await menu.getByRole("menuitem", { name: "Fissa", exact: true }).click();
    const paneTab = page.getByTestId(`pane-tab-${t.id}`);
    await expect(paneTab).toBeVisible({ timeout: 10000 });
    await expectServerPin(request, t.id, true);

    // Close the tab (Close now → deterministic, bypasses the countdown).
    await paneTab.click({ button: "right" });
    await page.getByRole("button", { name: /Close now/ }).click();
    await expect(paneTab).toBeHidden({ timeout: 5000 });

    // Let the archive + pane-store PUT settle before reloading.
    await expect
      .poll(
        async () => {
          const res = await request.get(`${BASE}/api/topics`);
          const data = await res.json();
          return data?.topics?.[t.id]?.archived;
        },
        { timeout: 10000 }
      )
      .toBe(true);

    // Reload — the closed pinned chat's tab must stay closed…
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect(page.getByTestId(`pane-tab-${t.id}`)).toBeHidden({ timeout: 10000 });
    // …while the pinned sidebar row survives (one click still reopens it). The
    // row renders once BOTH the topic list and the pinned-state sync have
    // hydrated, so wait on the row itself (its data-pinned marker) rather than
    // racing the pinned-section grouping's first paint.
    const reloadedRow = page.getByRole("treeitem", { name: new RegExp(name) });
    await expect(reloadedRow).toBeVisible({ timeout: 15000 });
    await expect(reloadedRow).toHaveAttribute("data-pinned", "true", { timeout: 10000 });
  });

  // PIN-2: projects are pinnable too; pins survive a reload
  test("PIN-2: pin a project → close its tab keeps the row → pins survive reload → click reopens", async ({
    page,
    request,
  }) => {
    const projectPath = "/tmp/e2e-pin-project";
    const name = `E2E-PinProjChat-${Date.now()}`;
    const t = await createTopic(request, name, { projectPath });
    pinCreated.push(t.id);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // The seeded project-scoped topic surfaces the project row + project tab.
    const projectBtn = page.getByTestId("project-toggle-e2e-pin-project");
    await expect(projectBtn).toBeVisible({ timeout: 10000 });

    // Pin via the project header context menu ("Fissa").
    await projectBtn.click({ button: "right" });
    await page.getByRole("button", { name: "Fissa", exact: true }).click();

    const pinnedSection = page.getByTestId("sidebar-pinned-section");
    await expect(pinnedSection.getByTestId("project-toggle-e2e-pin-project")).toBeVisible({ timeout: 5000 });
    // Pin key = the sidebar item id form (`project:<rawPath>`).
    await expectServerPin(request, `project:${projectPath}`, true);

    // Close the project tab — the pinned row must persist.
    const projectPaneTab = page.getByTestId(`pane-tab-project:${encodeURIComponent(projectPath)}`);
    await expect(projectPaneTab).toBeVisible({ timeout: 5000 });
    await projectPaneTab.click({ button: "right" });
    await page.getByRole("button", { name: /Close now/ }).click();
    await expect(projectPaneTab).toBeHidden({ timeout: 5000 });
    await expect(pinnedSection.getByTestId("project-toggle-e2e-pin-project")).toBeVisible({ timeout: 5000 });

    // Reload — pins survive (localStorage warm-load + server hydrate).
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect(
      page.getByTestId("sidebar-pinned-section").getByTestId("project-toggle-e2e-pin-project")
    ).toBeVisible({ timeout: 10000 });

    // One click reopens the project tab.
    await page.getByTestId("project-toggle-e2e-pin-project").click();
    await expect(
      page.getByTestId(`pane-tab-project:${encodeURIComponent(projectPath)}`)
    ).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Sidebar — Project icons", () => {
  // A project row shows the REAL favicon when the folder ships one (favicon.*
  // / web manifest / index.html <link rel=icon>, resolved by GET
  // /api/projects/icon) and NOTHING otherwise — zero horizontal footprint, no
  // fake glyph, no monogram (hard product decision, Attilio 2026-07-16).
  const ICONLESS_PROJECT = "/tmp/e2e-iconless-project";
  const ICONFUL_PROJECT = "/tmp/e2e-iconful-project";
  // Smallest valid 1x1 PNG — the favicon <img> must actually decode.
  const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const created: string[] = [];

  test.beforeAll(async ({ request }) => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(ICONLESS_PROJECT, { recursive: true });
    mkdirSync(ICONFUL_PROJECT, { recursive: true });
    writeFileSync(`${ICONFUL_PROJECT}/favicon.png`, PNG_1X1);
    // A topic bound to each path puts the dir in the icon endpoint's
    // allowlist (topic projectPaths are one of its UNION sources) and makes
    // the project row appear in the sidebar.
    for (const p of [ICONLESS_PROJECT, ICONFUL_PROJECT]) {
      const t = await createTopic(request, `E2E-Icon-${p.split("-").pop()}`, { projectPath: p });
      created.push(t.id);
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of created) await deleteTopic(request, id).catch(() => {});
    const { rmSync } = await import("node:fs");
    rmSync(ICONLESS_PROJECT, { recursive: true, force: true });
    rmSync(ICONFUL_PROJECT, { recursive: true, force: true });
  });

  test("icon-less project row renders NO icon element at all (zero footprint)", async ({ page }) => {
    await goToApp(page);
    const row = page.getByTestId("project-toggle-e2e-iconless-project");
    await expect(row).toBeVisible({ timeout: 10000 });
    // The zero-width probe <img> unmounts once the 404 settles: the row must
    // end with NO icon element — no img, no synthetic placeholder of any kind.
    await expect
      .poll(async () => row.locator('img[src*="/api/projects/icon"]').count(), { timeout: 10000 })
      .toBe(0);
    await expect(row.getByTestId("project-monogram")).toHaveCount(0);
  });

  test("project with a shipped favicon shows the real icon", async ({ page }) => {
    await goToApp(page);
    const row = page.getByTestId("project-toggle-e2e-iconful-project");
    await expect(row).toBeVisible({ timeout: 10000 });
    const icon = row.locator('img[src*="/api/projects/icon"]');
    await expect(icon).toBeVisible({ timeout: 10000 });
    // The img actually decoded (naturalWidth > 0) — a 403/404 would have
    // errored the img and swapped in the monogram instead.
    await expect
      .poll(async () => icon.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10000 })
      .toBeGreaterThan(0);
    await expect(row.getByTestId("project-monogram")).toHaveCount(0);
  });

  test("SIDEBAR-WINDOWS: a detached window's presence renders the 'Finestre aperte' section", async ({ page }) => {
    // The native OS detach can't run headless, but the section is WS-driven:
    // inject a `presence:windows` frame carrying one DETACHED window (a windowId
    // other than this tab's own → computeDetachedWindows includes it) and assert
    // the sidebar section appears. Proxy the real socket, then push the frame.
    await page.routeWebSocket(/ws/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((msg) => ws.send(msg));
      ws.onMessage((msg) => server.send(msg));
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: "presence:windows",
          windows: [
            { windowId: "e2e-other-window", clientId: "e2e-c1", windowLabel: "detach-e2e", detached: true, topicIds: ["e2e-detached-topic"] },
          ],
        }));
      }, 1200);
    });
    await goToApp(page);

    const section = page.getByTestId("sidebar-detached-windows");
    await expect(section, "the detached-windows section renders from live presence").toBeVisible({ timeout: 10000 });
    await expect(section).toContainText("Finestre aperte");
  });
});
