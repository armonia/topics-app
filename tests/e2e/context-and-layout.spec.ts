import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";

/** Open the first available chat topic from the sidebar */
async function openAnyTopic(page: import("@playwright/test").Page) {
  const treeItems = page.getByRole("treeitem");
  const count = await treeItems.count();
  for (let i = 0; i < Math.min(count, 30); i++) {
    const item = treeItems.nth(i);
    const text = await item.textContent();
    // Skip section headers (Projects, Chats, Terminals, etc.)
    if (!text || text.length < 2) continue;
    if (/^(Projects|Chats|Terminals|Browser|Archived)/i.test(text.trim())) continue;
    await item.click();
    await page.waitForTimeout(1500);
    // Check if a textarea appeared (confirming a chat opened)
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    if (await textarea.isVisible().catch(() => false)) return textarea;
  }
  return null;
}

test.describe("Layout Persistence", () => {
  test("open panels are restored after reload", async ({ page }) => {
    await goToApp(page);
    const textarea = await openAnyTopic(page);
    if (!textarea) { test.skip(); return; }

    // Wait for panel state to persist (debounced 2s)
    await page.waitForTimeout(3000);

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(4000);

    // Check that something rendered in main content (panel restored)
    const mainContent = await page.locator('[role="main"]').textContent();
    expect(mainContent).toBeTruthy();
    expect(mainContent!.length).toBeGreaterThan(5);
  });

  test("panels state saved to server", async ({ page }) => {
    await goToApp(page);
    const textarea = await openAnyTopic(page);
    if (!textarea) { test.skip(); return; }
    await page.waitForTimeout(3000); // Wait for debounced server save

    const serverState = await page.evaluate(async () => {
      const res = await fetch("/api/ui-state/panels");
      if (!res.ok) return null;
      return res.json();
    });
    expect(serverState).not.toBeNull();
    expect(serverState.openPanels).toBeDefined();
    expect(Array.isArray(serverState.openPanels)).toBeTruthy();
    expect(serverState.openPanels.length).toBeGreaterThan(0);
  });

  test("panel order persisted to server", async ({ page }) => {
    await goToApp(page);
    const textarea = await openAnyTopic(page);
    if (!textarea) { test.skip(); return; }
    await page.waitForTimeout(2000);

    const serverState = await page.evaluate(async () => {
      const res = await fetch("/api/ui-state/panel-order");
      if (!res.ok) return null;
      return res.json();
    });
    expect(serverState).not.toBeNull();
    if (serverState.order) {
      expect(Array.isArray(serverState.order)).toBeTruthy();
    }
  });
});

test.describe("Project Context", () => {
  test("project topic has context in analyze API", async ({ page }) => {
    await goToApp(page);

    // Find a project topic whose projectPath actually exists on disk
    const topic = await page.evaluate(async () => {
      const res = await fetch("/api/topics");
      if (!res.ok) return null;
      const data = await res.json();
      const topics = Object.values(data.topics || {}) as any[];
      // Prefer topics with real project paths (not /tmp/test)
      return topics.find((t) => t.projectPath && !t.projectPath.startsWith("/tmp/")) || null;
    });

    if (!topic) { test.skip(); return; }

    const analysis = await page.evaluate(async (topicId: string) => {
      const res = await fetch(`/api/context/analyze?topicId=${topicId}`);
      if (!res.ok) return null;
      return res.json();
    }, topic.id);

    expect(analysis).not.toBeNull();
    expect(analysis.sources).toBeDefined();

    const projectSource = analysis.sources.find((s: any) => s.id === "project:awareness");
    expect(projectSource).toBeDefined();
    expect(projectSource.enabled).toBeTruthy();
  });

  test("project template files are toggleable in context API", async ({ page }) => {
    await goToApp(page);

    const topic = await page.evaluate(async () => {
      const res = await fetch("/api/topics");
      if (!res.ok) return null;
      const data = await res.json();
      return (Object.values(data.topics || {}) as any[]).find((t) => t.projectPath) || null;
    });

    if (!topic) { test.skip(); return; }

    const analysis = await page.evaluate(async (topicId: string) => {
      const res = await fetch(`/api/context/analyze?topicId=${topicId}`);
      if (!res.ok) return null;
      return res.json();
    }, topic.id);

    expect(analysis).not.toBeNull();
    const templateSources = analysis.sources.filter((s: any) => s.id?.startsWith("template:") && s.id !== "project:awareness");
    // Template files should have enabled field (boolean, not hardcoded)
    for (const src of templateSources) {
      expect(typeof src.enabled).toBe("boolean");
    }
  });
});

test.describe("Message Content Rendering", () => {
  test("app renders messages without errors", async ({ page }) => {
    await goToApp(page);
    const textarea = await openAnyTopic(page);
    if (!textarea) { test.skip(); return; }

    const messages = page.locator("div.message-appear");
    await messages.first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});

    // Verify no JS errors crashed the page
    const mainContent = await page.locator('[role="main"]').textContent();
    expect(mainContent).toBeTruthy();
    expect(mainContent!.length).toBeGreaterThan(10);
  });

  test("chat API is healthy", async ({ page }) => {
    await goToApp(page);
    const ok = await page.evaluate(async () => {
      const res = await fetch("/api/topics");
      return res.ok;
    });
    expect(ok).toBeTruthy();
  });
});
