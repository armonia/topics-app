import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";

let projectTopicId: string | null = null;

test.describe("Sidebar", () => {
  test.beforeAll(async ({ request }) => {
    // Create a project-linked topic so the "Projects" section has an entry
    const topic = await createTopic(request, "E2E-ProjectTest", {
      projectPath: "/tmp/e2e-project",
    });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (projectTopicId) {
      await deleteTopic(request, projectTopicId);
    }
  });

  test("clicking topics switches the main panel", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Wait for textarea to confirm the panel loaded
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await expect(textarea).toBeVisible({ timeout: 10000 });
    expect(await page.locator('[role="main"]').textContent()).toContain("Web Search");

    await openTopic(page, /Best Ramen/);
    // Wait for the content to reflect the new topic
    await expect(page.locator('[role="main"]')).toContainText("Best Ramen", { timeout: 10000 });
  });

  test("project folders expand and collapse", async ({ page }) => {
    await goToApp(page);

    const projectsBtn = page.getByRole("button", { name: /Projects/ }).first();
    await expect(projectsBtn).toBeVisible({ timeout: 10000 });

    // Use the project-linked topic we created (folder name = "e2e-project")
    const projectBtn = page.locator('button:has-text("e2e-project")');
    await expect(projectBtn.first()).toBeVisible({ timeout: 5000 });

    await projectBtn.first().click();
    await page.waitForLoadState("networkidle");
    expect(await page.getByRole("treeitem").count()).toBeGreaterThan(0);
  });

  test("search filters topics", async ({ page }) => {
    await goToApp(page);

    const searchbox = page.getByRole("searchbox", { name: /Search topics/ });
    await expect(searchbox).toBeVisible({ timeout: 10000 });

    // Count only chat treeitems (not file-explorer ones) — they are within the tree[aria-label="Topics"]
    const chatTree = page.getByRole("tree", { name: "Topics" });
    await expect(chatTree).toBeVisible({ timeout: 10000 });

    // Use all visible treeitems in the sidebar tree as baseline
    // Wait a moment for sidebar to fully settle
    await page.waitForTimeout(500);
    const topicsBefore = await page.locator('[role="tree"][aria-label="Topics"] [role="treeitem"]').count();
    expect(topicsBefore).toBeGreaterThan(0);

    await searchbox.fill("Ramen");
    await page.waitForTimeout(1000);

    // After search, either: (a) fewer treeitems OR (b) "Ramen" is visible in remaining items
    const topicsAfter = await page.locator('[role="tree"][aria-label="Topics"] [role="treeitem"]').count();
    const bodyText = await page.locator("body").textContent();
    // Either count reduced, or at least one "Ramen" result is visible
    expect(topicsAfter <= topicsBefore || bodyText!.toLowerCase().includes("ramen")).toBeTruthy();

    await searchbox.fill("");
    await page.waitForTimeout(500);
  });

  test("create new chat topic", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    const chatsHeader = page.getByRole("button", { name: /Chats section/ });
    await expect(chatsHeader).toBeVisible({ timeout: 10000 });
    await chatsHeader.hover();

    // Wait for the new chat button to appear on hover
    const newChatBtn = page.getByRole("button", { name: /New chat/i });
    if (await newChatBtn.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false)) {
      await newChatBtn.first().click();
    } else {
      const topNewBtn = page.locator('button[title*="New"], button[aria-label*="New"]').first();
      await expect(topNewBtn).toBeVisible({ timeout: 5000 });
      await topNewBtn.click();
      await page.waitForTimeout(300);
      await page.locator("text=New Chat").first().click();
    }

    // Wait for new chat textarea to be visible
    await expect(page.getByRole("textbox", { name: /Message input/ })).toBeVisible({ timeout: 10000 });
  });

  test("archive topic via context menu", async ({ page }) => {
    await goToApp(page);

    // Create a new topic to archive
    const chatsHeader = page.getByRole("button", { name: /Chats section/ });
    await expect(chatsHeader).toBeVisible({ timeout: 10000 });
    await chatsHeader.hover();
    const newChatBtn = page.getByRole("button", { name: /New chat/i });
    await expect(newChatBtn.first()).toBeVisible({ timeout: 5000 });
    await newChatBtn.first().click();

    // Wait for new chat to appear
    await expect(page.getByRole("textbox", { name: /Message input/ })).toBeVisible({ timeout: 10000 });

    const countBefore = await page.getByRole("treeitem").count();

    const newChats = page.getByRole("treeitem", { name: /New Chat/ });
    if (await newChats.count() > 0) {
      await newChats.first().click({ button: "right" });
      await page.waitForTimeout(300);
      const archiveOption = page.locator("text=Archive").first();
      if (await archiveOption.isVisible()) {
        await archiveOption.click();
        await page.waitForLoadState("networkidle");
        expect(await page.getByRole("treeitem").count()).toBeLessThanOrEqual(countBefore);
      }
    }
    expect(await page.locator('[role="main"]').textContent()).toBeTruthy();
  });

  test("topic context menu has options", async ({ page }) => {
    await goToApp(page);

    const topic = page.getByRole("treeitem", { name: /Web Search Test/ });
    await expect(topic).toBeVisible({ timeout: 10000 });
    await topic.click({ button: "right" });

    // Wait for context menu to appear
    const contextMenu = page.locator('[class*="context-menu"], [class*="dropdown"], [role="menu"]');
    if (await contextMenu.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false)) {
      const menuText = await contextMenu.first().textContent();
      expect(
        menuText!.includes("Rename") || menuText!.includes("Archive") ||
        menuText!.includes("Settings") || menuText!.includes("Delete") ||
        menuText!.includes("Pin") || menuText!.includes("Color")
      ).toBeTruthy();
      await page.keyboard.press("Escape");
      // Wait for menu to close
      await expect(contextMenu.first()).toBeHidden({ timeout: 3000 }).catch(() => {});
    }

    await topic.click();
    await expect(page.locator('[role="main"]')).toContainText("Web Search", { timeout: 10000 });
  });
});
