import { test, expect } from "./fixtures/topic-management.fixture";
import { createTopic, patchTopic, cleanupAll } from "./helpers/api-fixtures";

test.describe("Topic Management", () => {
  const TS = Date.now();
  const topicIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const alpha = await createTopic(request, `E2E-Alpha-${TS}`, {
      color: "#dc2626",
    });
    const beta = await createTopic(request, `E2E-Beta-${TS}`, {
      color: "#059669",
    });
    const gamma = await createTopic(request, `E2E-Gamma-${TS}`, {
      color: "#7c3aed",
    });
    topicIds.push(alpha.id, beta.id, gamma.id);
  });

  test.afterAll(async ({ request }) => {
    await cleanupAll(request, { topics: topicIds });
  });

  // TOPIC-01: create new topic via sidebar and it appears in topic list
  test("TOPIC-01: create new topic via sidebar and it appears in topic list", async ({
    topicPage,
    request,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-01" });
    // NewTopicModal (Meta+Shift+N) is gated behind enableNewChat (default off,
    // useKeyboardShortcuts.ts:185) — seed the flag before navigating.
    await page.addInitScript(() => localStorage.setItem('app-settings', JSON.stringify({ enableNewChat: true })));
    await topicPage.goto();

    // Open the NewTopicModal via Cmd+Shift+N keyboard shortcut
    await page.keyboard.press("Meta+Shift+n");

    // Wait for the new topic dialog to appear
    const dialog = topicPage.newTopicDialog;
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Fill in topic name
    const topicName = `E2E-Created-${Date.now()}`;
    const nameInput = dialog.locator('input[placeholder="Enter topic name..."]');
    await nameInput.fill(topicName);

    // Click Create Topic
    const createBtn = dialog.locator("button", { hasText: "Create Topic" });
    await expect(createBtn).toBeEnabled();
    await createBtn.click();

    // Dialog should close
    await expect(dialog).toBeHidden({ timeout: 5000 });

    // Topic should appear in sidebar as a treeitem
    await expect(
      topicPage.findTopic(new RegExp(topicName))
    ).toBeVisible({ timeout: 10000 });

    // Clean up: find the created topic via API
    const response = await request.get("http://localhost:13334/api/topics", {
      ignoreHTTPSErrors: true,
    });
    const data = (await response.json()) as {
      topics: Record<string, { id: string; name: string }>;
    };
    const newTopic = Object.values(data.topics).find(
      (t) => t.name === topicName && !topicIds.includes(t.id)
    );
    if (newTopic) topicIds.push(newTopic.id);
  });

  // TOPIC-02: switch between topics and main panel content changes
  test("TOPIC-02: switch between topics changes main panel content", async ({
    topicPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-01" });
    await topicPage.goto();
    await topicPage.openTopic(new RegExp(`E2E-Alpha-${TS}`));
    await expect(topicPage.mainPanel).toContainText("E2E-Alpha", {
      timeout: 10000,
    });

    await topicPage.openTopic(new RegExp(`E2E-Beta-${TS}`));
    await expect(topicPage.mainPanel).toContainText("E2E-Beta", {
      timeout: 10000,
    });
  });

  // TOPIC-03: search/filter topics by name
  test("TOPIC-03: command palette search filters topics by name", async ({
    topicPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-01" });
    await topicPage.goto();

    // Verify test topics are visible in sidebar first
    await expect(
      topicPage.findTopic(new RegExp(`E2E-Alpha-${TS}`))
    ).toBeVisible({ timeout: 10000 });
    await expect(
      topicPage.findTopic(new RegExp(`E2E-Beta-${TS}`))
    ).toBeVisible({ timeout: 5000 });

    // Open command palette (sidebar search redirects here since c9d168e refactor)
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    const paletteInput = page.getByPlaceholder(/Cerca.*topic/i);
    await expect(paletteInput).toBeVisible({ timeout: 5000 });

    // Scope to the palette's result list (role=listbox / option, with the input's
    // aria-controls pointing at it) so assertions don't leak into the sidebar.
    // Structure per CommandPalette.tsx: overlay contains the search input +
    // an options container; palette items live under a div with fixed positioning.
    const palette = page.locator('[data-testid="command-palette"]');

    // Search for Alpha
    await paletteInput.fill(`E2E-Alpha-${TS}`);
    // Alpha must appear inside the palette container
    await expect(palette.getByText(new RegExp(`E2E-Alpha-${TS}`)).first()).toBeVisible({ timeout: 5000 });
    // Beta and Gamma must NOT appear inside the palette container
    await expect(palette.getByText(new RegExp(`E2E-Beta-${TS}`))).toHaveCount(0);
    await expect(palette.getByText(new RegExp(`E2E-Gamma-${TS}`))).toHaveCount(0);

    // Clear query and close palette
    await paletteInput.fill("");
    await expect(paletteInput).toHaveValue("");
    await page.keyboard.press("Escape");
  });

  // TOPIC-04: archive topic via context menu
  test("TOPIC-04: archive topic via context menu removes it from active list", async ({
    topicPage,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-01" });
    // Create a disposable topic via API
    const disp = await createTopic(
      request,
      `E2E-Disposable-${Date.now()}`
    );
    topicIds.push(disp.id);

    // Load the app to see the new topic
    await topicPage.goto();
    await expect(topicPage.findTopic(/E2E-Disposable/)).toBeVisible({
      timeout: 10000,
    });

    // Open context menu via right-click
    const menu = await topicPage.openContextMenu(/E2E-Disposable/);

    // Click "Archive / Delete" menu item
    await topicPage.clickMenuItem(menu, /Archive/);

    // Confirmation submenu appears with topic name
    await expect(menu.getByText(/Delete topic/)).toBeVisible({ timeout: 3000 });
    await expect(menu).toContainText("E2E-Disposable");

    // Click "Delete" to confirm archival
    await menu.locator("button", { hasText: "Delete" }).click();

    // Topic should disappear from active list
    await expect(topicPage.findTopic(/E2E-Disposable/)).toBeHidden({
      timeout: 5000,
    });
  });

  // TOPIC-04b: unarchive (reopen) round-trip — the reverse half of the 2-state
  // invariant (open ⟺ non-archived). Opening an archived topic must BOTH re-show
  // it as active AND flip archived→false server-side. Previously uncovered: the
  // suite only tested archive, never the de-archive-on-open path.
  test("TOPIC-04b: opening an archived topic unarchives it (active + archived:false)", async ({
    topicPage,
    page,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-01" });
    // Seed an archived (= closed) topic via API.
    const name = `E2E-Reopen-${Date.now()}`;
    const disp = await createTopic(request, name);
    topicIds.push(disp.id);
    await patchTopic(request, disp.id, { archived: true });

    await topicPage.goto();
    // Wait for the app to be interactive before the ⌘K chord (a keypress fired
    // before the sidebar mounts is dropped). Alpha is seeded in beforeAll.
    await expect(topicPage.findTopic(new RegExp(`E2E-Alpha-${TS}`))).toBeVisible({
      timeout: 15000,
    });
    // NB: archived topics still render in the sidebar's closed ("Chiusi") section
    // — the 2-state model hides them from the OPEN tabs, not the sidebar — so we
    // assert on the open-tab transition + the server flag, not sidebar presence.

    // Open it from the ⌘K palette — it lists archived topics (labeled "chiuso")
    // and unarchives + opens on click (usePanelLifecycle de-archive-on-open).
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    const paletteInput = page.getByPlaceholder(/Cerca.*topic/i);
    await expect(paletteInput).toBeVisible({ timeout: 5000 });
    await paletteInput.fill(name);
    const palette = page.locator('[data-testid="command-palette"]');
    const option = palette.getByText(new RegExp(name)).first();
    await expect(option).toBeVisible({ timeout: 5000 });
    await option.click();

    // (a) It opens as an active tab in a panel tab bar (not merely listed).
    await expect(
      page.locator('[data-testid="panel-tab-bar"]').getByText(new RegExp(name)).first()
    ).toBeVisible({ timeout: 10000 });

    // (b) The server record is archived:false — the de-archive half of the
    // invariant. Polled because the unarchive PATCH is fire-and-forget client-side.
    await expect
      .poll(
        async () => {
          const res = await request.get("http://localhost:13334/api/topics", {
            ignoreHTTPSErrors: true,
          });
          const data = await res.json();
          return data?.topics?.[disp.id]?.archived;
        },
        { timeout: 10000 }
      )
      .toBe(false);
  });

  // TOPIC-05: rename topic via context menu
  test("TOPIC-05: rename topic via context menu persists new name", async ({
    topicPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-01" });
    await topicPage.goto();
    await expect(
      topicPage.findTopic(new RegExp(`E2E-Gamma-${TS}`))
    ).toBeVisible({ timeout: 10000 });

    // Open context menu on Gamma topic
    const menu = await topicPage.openContextMenu(
      new RegExp(`E2E-Gamma-${TS}`)
    );

    // Click "Rename"
    await topicPage.clickMenuItem(menu, /Rename/);

    // Rename submenu appears with input pre-filled with current name
    const input = menu.locator("input[type='text']");
    await expect(input).toBeVisible({ timeout: 3000 });

    // Clear and type new name
    const newName = `E2E-Renamed-${TS}`;
    await input.fill(newName);

    // Click Save
    await menu.locator("button", { hasText: "Save" }).click();

    // Verify renamed topic appears
    await expect(topicPage.findTopic(new RegExp(newName))).toBeVisible({
      timeout: 5000,
    });

    // Verify old name is gone
    await expect(
      topicPage.findTopic(new RegExp(`E2E-Gamma-${TS}`))
    ).toBeHidden({ timeout: 3000 });
  });

  // TOPIC-06: delete topic with confirmation dialog showing topic name (DEDICATED test)
  test("TOPIC-06: delete confirmation shows topic name and Cancel works", async ({
    topicPage,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-01" });
    // Create a dedicated disposable topic
    const disp2 = await createTopic(
      request,
      `E2E-DeleteMe-${Date.now()}`
    );
    topicIds.push(disp2.id);

    // Load the app to see the topic
    await topicPage.goto();
    await expect(topicPage.findTopic(/E2E-DeleteMe/)).toBeVisible({
      timeout: 10000,
    });

    // Open context menu and click Archive / Delete
    let menu = await topicPage.openContextMenu(/E2E-DeleteMe/);
    await topicPage.clickMenuItem(menu, /Archive/);

    // Verify confirmation shows topic name (per D-06)
    await expect(menu).toContainText("E2E-DeleteMe");
    await expect(menu).toContainText("Delete topic");

    // Click Cancel -- topic should remain visible
    await menu.locator("button", { hasText: "Cancel" }).click();

    // Menu closes (Cancel calls onClose), topic still visible
    await expect(topicPage.findTopic(/E2E-DeleteMe/)).toBeVisible({
      timeout: 5000,
    });

    // Re-open context menu and this time confirm delete
    menu = await topicPage.openContextMenu(/E2E-DeleteMe/);
    await topicPage.clickMenuItem(menu, /Archive/);
    await expect(menu).toContainText("E2E-DeleteMe");
    await menu.locator("button", { hasText: "Delete" }).click();

    // Topic should disappear
    await expect(topicPage.findTopic(/E2E-DeleteMe/)).toBeHidden({
      timeout: 5000,
    });
  });

  // TOPIC-08: create topic from template via NewTopicModal
  test("TOPIC-08: new topic from template pre-fills name and creates topic", async ({
    topicPage,
    page,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-01" });
    // NewTopicModal (Meta+Shift+N) is gated behind enableNewChat (default off,
    // useKeyboardShortcuts.ts:185) — seed the flag before navigating.
    await page.addInitScript(() => localStorage.setItem('app-settings', JSON.stringify({ enableNewChat: true })));
    await topicPage.goto();

    // Open the NewTopicModal via Cmd+Shift+N
    await page.keyboard.press("Meta+Shift+n");

    // Wait for dialog to appear
    const dialog = topicPage.newTopicDialog;
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Click the "Code Review" template
    await dialog.getByText("Code Review").first().click();

    // Verify the name input is pre-filled with template name
    const nameInput = dialog.locator('input[placeholder="Enter topic name..."]');
    await expect(nameInput).toHaveValue("Code Review", { timeout: 3000 });

    // Create Topic button should be enabled (template selected)
    const createBtn = dialog.locator("button", { hasText: "Create Topic" });
    await expect(createBtn).toBeEnabled();

    // Click Create Topic
    await createBtn.click();

    // Dialog should close
    await expect(dialog).toBeHidden({ timeout: 5000 });

    // New topic should appear in sidebar
    await expect(
      topicPage.findTopic(/Code Review/).first()
    ).toBeVisible({ timeout: 10000 });

    // Clean up: find the created topic via API
    const response = await request.get("http://localhost:13334/api/topics", {
      ignoreHTTPSErrors: true,
    });
    const topicData = (await response.json()) as {
      topics: Record<string, { id: string; name: string }>;
    };
    const templateTopic = Object.values(topicData.topics).find(
      (t) => t.name === "Code Review" && !topicIds.includes(t.id)
    );
    if (templateTopic) topicIds.push(templateTopic.id);
  });
});

// ── Fissati (pinning) × archive interplay ──────────────────────────────────────
//
// Closing a pinned chat's tab does NOT archive it (covered in sidebar.spec.ts
// PIN-1 — the "Close now" path exercises the same handleClosePanel funnel
// Cmd+W reaches). Here: the EXPLICIT archive action still archives a pinned
// chat, but the row stays listed (the pinnedIds escape bypasses the archived
// filter), and reopening self-heals the archived flag.
test.describe("Topic Management — Fissati archive interplay", () => {
  const BASE = "http://localhost:13334";
  const pinIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    // Clean pin slate — pins ride the server ui-state `sidebar-state` key.
    await request.put(`${BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [] },
    });
  });

  test.afterAll(async ({ request }) => {
    await request.put(`${BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [] },
    });
    await cleanupAll(request, { topics: pinIds });
  });

  test("PIN-ARCHIVE: explicit Archive on a pinned chat still archives, but its row stays; reopening self-heals", async ({
    topicPage,
    page,
    request,
  }) => {
    const name = `E2E-PinArchive-${Date.now()}`;
    const disp = await createTopic(request, name);
    pinIds.push(disp.id);

    await topicPage.goto();
    const row = topicPage.findTopic(new RegExp(name));
    await expect(row).toBeVisible({ timeout: 10000 });

    // Pin it ("Fissa" — exact regex: "Fissa" is a substring of "Rimuovi dai
    // Fissati").
    const pinMenu = await topicPage.openContextMenu(new RegExp(name));
    await topicPage.clickMenuItem(pinMenu, /^Fissa$/);
    await expect(row).toHaveAttribute("data-pinned", "true", { timeout: 5000 });

    // Explicit archive via the context menu (Archive / Delete → confirm).
    const menu = await topicPage.openContextMenu(new RegExp(name));
    await topicPage.clickMenuItem(menu, /Archive/);
    await expect(menu.getByText(/Delete topic/)).toBeVisible({ timeout: 3000 });
    await menu.locator("button", { hasText: "Delete" }).click();

    // The topic IS archived server-side (explicit archive is not blocked by
    // the pin — only the close-tab funnel is)…
    await expect
      .poll(
        async () => {
          const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
          const data = await res.json();
          return data?.topics?.[disp.id]?.archived;
        },
        { timeout: 10000 }
      )
      .toBe(true);

    // …but the pinned row STAYS listed with showArchived=false (pinnedIds
    // escape bypasses the archived filter).
    await expect(row).toBeVisible({ timeout: 5000 });
    await expect(row).toHaveAttribute("data-pinned", "true");

    // Reopening from the pinned row self-heals: tab opens + archived:false
    // (openPanel's de-archive-on-open).
    await row.click();
    await expect(
      page.locator('[data-testid="panel-tab-bar"]').getByText(new RegExp(name)).first()
    ).toBeVisible({ timeout: 10000 });
    await expect
      .poll(
        async () => {
          const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
          const data = await res.json();
          return data?.topics?.[disp.id]?.archived;
        },
        { timeout: 10000 }
      )
      .toBe(false);
  });
});
