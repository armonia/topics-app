import { test, expect } from "./fixtures/topic-management.fixture";
import { createTopic, cleanupAll } from "./helpers/api-fixtures";

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
    // Enable the NewTopicModal keyboard shortcut by faking Electron context
    await page.addInitScript(() => {
      (window as any).electronAPI = { isElectron: true };
    });

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
    const response = await request.get("http://localhost:3334/api/topics", {
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
  test("TOPIC-03: search filters topics by name in sidebar", async ({
    topicPage,
  }) => {
    await topicPage.goto();

    // Verify test topics are visible first
    await expect(
      topicPage.findTopic(new RegExp(`E2E-Alpha-${TS}`))
    ).toBeVisible({ timeout: 10000 });
    await expect(
      topicPage.findTopic(new RegExp(`E2E-Beta-${TS}`))
    ).toBeVisible({ timeout: 5000 });

    // Search for Alpha
    await topicPage.searchInput.fill("E2E-Alpha");

    // Alpha should be visible, Beta and Gamma should be hidden
    await expect(
      topicPage.findTopic(new RegExp(`E2E-Alpha-${TS}`))
    ).toBeVisible({ timeout: 5000 });
    await expect(
      topicPage.findTopic(new RegExp(`E2E-Beta-${TS}`))
    ).toBeHidden({ timeout: 5000 });
    await expect(
      topicPage.findTopic(new RegExp(`E2E-Gamma-${TS}`))
    ).toBeHidden({ timeout: 5000 });

    // Clear search and verify all visible again
    await topicPage.searchInput.fill("");
    await expect(
      topicPage.findTopic(new RegExp(`E2E-Alpha-${TS}`))
    ).toBeVisible({ timeout: 5000 });
    await expect(
      topicPage.findTopic(new RegExp(`E2E-Beta-${TS}`))
    ).toBeVisible({ timeout: 5000 });
  });

  // TOPIC-04: archive topic via context menu
  test("TOPIC-04: archive topic via context menu removes it from active list", async ({
    topicPage,
    request,
  }) => {
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

  // TOPIC-05: rename topic via context menu
  test("TOPIC-05: rename topic via context menu persists new name", async ({
    topicPage,
  }) => {
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
    // Enable the NewTopicModal keyboard shortcut by faking Electron context
    await page.addInitScript(() => {
      (window as any).electronAPI = { isElectron: true };
    });

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
    const response = await request.get("http://localhost:3334/api/topics", {
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
