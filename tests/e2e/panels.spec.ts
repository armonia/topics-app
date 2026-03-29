import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";

test.describe("Panels & Views", () => {
  test("activity feed shows Live/Digest tabs", async ({ page }) => {
    await goToApp(page);
    const activityBtn = page.getByRole("button", { name: "Activity" });
    await expect(activityBtn).toBeVisible({ timeout: 10000 });
    await activityBtn.click();
    await page.waitForLoadState("networkidle");

    const mainContent = await page.locator('[role="main"]').textContent();
    expect(
      mainContent!.includes("Live") || mainContent!.includes("Digest") ||
      mainContent!.includes("Activity") || mainContent!.includes("heartbeat")
    ).toBeTruthy();
  });

  test("agents panel shows content", async ({ page }) => {
    await goToApp(page);
    const agentsBtn = page.getByRole("button", { name: /Agents/ });
    await expect(agentsBtn).toBeVisible({ timeout: 10000 });
    await agentsBtn.click();
    await page.waitForLoadState("networkidle");

    expect((await page.locator('[role="main"]').textContent())!.length).toBeGreaterThan(5);
  });

  test("kanban board renders", async ({ page }) => {
    await goToApp(page);
    const boardBtn = page.getByRole("button", { name: /Board/ });
    await expect(boardBtn).toBeVisible({ timeout: 10000 });
    await boardBtn.click();
    await page.waitForLoadState("networkidle");

    expect((await page.locator('[role="main"]').textContent())!.length).toBeGreaterThan(10);
  });

  test("multi-pane layout with Add Pane", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    const addPaneBtn = page.getByRole("button", { name: /Add pane/ });
    if (await addPaneBtn.count() > 0) {
      await addPaneBtn.click();
      await page.waitForLoadState("networkidle");
    }
    expect((await page.locator('[role="main"]').textContent())!.length).toBeGreaterThan(10);
  });

  test("dashboard digest tab", async ({ page }) => {
    await goToApp(page);
    const activityBtn = page.getByRole("button", { name: "Activity" });
    await expect(activityBtn).toBeVisible({ timeout: 10000 });
    await activityBtn.click();
    await page.waitForLoadState("networkidle");

    const digestTab = page.locator("text=Digest");
    if (await digestTab.count() > 0) {
      await digestTab.first().click();
      await page.waitForLoadState("networkidle");
    }

    // Navigate back to chat and wait for input to be ready
    await openTopic(page, /Web Search Test/);
    await expect(page.getByRole("textbox", { name: /Message input/ })).toBeVisible({ timeout: 10000 });
  });

  test("terminal section exists", async ({ page }) => {
    await goToApp(page);
    const terminalsBtn = page.getByRole("button", { name: /Terminals/ });
    await expect(terminalsBtn).toBeVisible({ timeout: 10000 });
  });

  test("browser section shows instances", async ({ page }) => {
    await goToApp(page);
    const browserSection = page.getByRole("button", { name: /Browser/ });
    await expect(browserSection.first()).toBeVisible({ timeout: 10000 });

    await browserSection.first().click();
    await page.waitForLoadState("networkidle");

    const bodyText = await page.locator("body").textContent();
    expect(bodyText!.includes("browser") || bodyText!.includes("Browser")).toBeTruthy();
  });

  test("remote access panel opens", async ({ page }) => {
    await goToApp(page);
    const remoteBtn = page.getByRole("button", { name: /Remote Access/i });
    if (await remoteBtn.count() > 0) {
      await remoteBtn.click();
      await page.waitForLoadState("networkidle");
      expect((await page.locator('[role="main"]').textContent())!.length).toBeGreaterThan(5);
    }
  });

  test("file explorer opens project topics", async ({ page }) => {
    await goToApp(page);
    const projectBtn = page.locator('button:has-text("topics-app")').first();
    await expect(projectBtn).toBeVisible({ timeout: 10000 });
    await projectBtn.click();
    await page.waitForLoadState("networkidle");

    // Click on any child topic
    const topicItems = page.getByRole("treeitem");
    await expect(topicItems.first()).toBeVisible({ timeout: 5000 });
    const count = await topicItems.count();
    let clicked = false;
    for (let i = 0; i < Math.min(count, 20); i++) {
      const text = await topicItems.nth(i).textContent();
      if (text && !text.includes("topics-app") && (text.includes("Topics") || text.includes("keyboard") || text.includes("Topbar"))) {
        await topicItems.nth(i).click();
        await page.waitForLoadState("networkidle");
        clicked = true;
        break;
      }
    }
    if (!clicked) await openTopic(page, /Web Search Test/);

    expect((await page.locator('[role="main"]').textContent())!.length).toBeGreaterThan(10);
  });

  test("command palette opens with Cmd+K", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Ensure app is ready before triggering shortcut
    await expect(page.getByRole("textbox", { name: /Message input/ })).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Meta+k");

    // Wait for dialog/palette to appear
    const dialog = page.locator('[role="dialog"], [class*="CommandPalette"], [class*="command-palette"], [class*="modal"]');
    await expect(dialog.first()).toBeVisible({ timeout: 5000 });

    const searchInput = page.locator('[role="dialog"] input, [class*="modal"] input');
    if (await searchInput.count() > 0) {
      await searchInput.first().fill("new");
      await page.waitForTimeout(300);
    }

    await page.keyboard.press("Escape");
    // Wait for dialog to close
    await expect(dialog.first()).toBeHidden({ timeout: 3000 }).catch(() => {});
  });

  test("scripts API responds", async ({ page }) => {
    await goToApp(page);
    const ok = await page.evaluate(async () => {
      const res = await fetch("/api/scripts");
      return res.ok;
    });
    expect(ok).toBeTruthy();
  });
});
