import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";

const MOCK_CHECKPOINTS = [
  {
    idx: 0,
    description: "Initial setup",
    messageCount: 5,
    gitHash: "abc1234",
    timestamp: "2026-03-28T09:00:00Z",
  },
  {
    idx: 1,
    description: "Auth module done",
    messageCount: 12,
    gitHash: null as string | null,
    timestamp: "2026-03-28T10:00:00Z",
  },
  {
    idx: 2,
    description: "Final review",
    messageCount: 20,
    gitHash: "def5678",
    timestamp: "2026-03-28T11:00:00Z",
  },
];

const NEW_CHECKPOINT = {
  idx: 3,
  description: "Auto checkpoint",
  messageCount: 25,
  gitHash: "ghi9012",
  timestamp: "2026-03-31T12:00:00Z",
};

test.describe("Chat Checkpoints (CHAT-05)", () => {
  let topicId: string;
  const topicName = `e2e-checkpoints-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // Il pane-store è condiviso da tutta la suite seriale: senza reset la chat
  // di questo file si apre in mezzo alle pane lasciate dai file precedenti e i
  // controlli della chat (input, barra checkpoint) risolvono a più elementi.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  async function mockCheckpoints(page: import("@playwright/test").Page, checkpoints: typeof MOCK_CHECKPOINTS) {
    await page.route(`**/api/topics/${topicId}/checkpoints`, async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ checkpoints }),
        });
      } else if (method === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ checkpoint: NEW_CHECKPOINT }),
        });
      } else {
        await route.fallback();
      }
    });
  }

  test("CHAT-05-01: checkpoint bar shows count and timeline dots", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-05" });

    await mockCheckpoints(page, MOCK_CHECKPOINTS);
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    // Verify compact bar shows "3 checkpoints" text
    const bar = page.locator("button", { hasText: /3 checkpoint/ });
    await expect(bar).toBeVisible({ timeout: 10_000 });

    // Verify timeline dots render (up to 8 colored dots)
    const dots = bar.locator("div.rounded-full");
    await expect(dots).toHaveCount(3);

    // Verify dots with gitHash have primary color (bg-primary)
    // idx 0 and 2 have gitHash, idx 1 does not
    await expect(dots.nth(0)).toHaveClass(/bg-primary/);
    await expect(dots.nth(1)).toHaveClass(/bg-app-placeholder/);
    await expect(dots.nth(2)).toHaveClass(/bg-primary/);
  });

  test("CHAT-05-02: checkpoint bar hidden when no checkpoints", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-05" });

    await mockCheckpoints(page, []);
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    // Wait for main content to load, then verify no checkpoint bar
    await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10_000 });
    // The checkpoint component returns null when empty — no bar should be visible
    const bar = page.locator("button", { hasText: /checkpoint/ });
    await expect(bar).toHaveCount(0);
  });

  test("CHAT-05-03: clicking bar expands timeline with details", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-05" });

    await mockCheckpoints(page, MOCK_CHECKPOINTS);
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    // Click the compact bar to expand
    const bar = page.locator("button", { hasText: /3 checkpoint/ });
    await expect(bar).toBeVisible({ timeout: 10_000 });
    // Verify "Show" label is present before clicking
    await expect(bar.locator("text=Show")).toBeVisible();
    await bar.click();

    // Verify expanded timeline shows checkpoint descriptions
    await expect(page.locator("text=Initial setup")).toBeVisible();
    await expect(page.locator("text=Auth module done")).toBeVisible();
    await expect(page.locator("text=Final review")).toBeVisible();

    // Verify message counts are shown
    await expect(page.locator("text=5 msgs")).toBeVisible();
    await expect(page.locator("text=12 msgs")).toBeVisible();
    await expect(page.locator("text=20 msgs")).toBeVisible();

    // Verify label changed to "Hide"
    await expect(bar.locator("text=Hide")).toBeVisible();
  });

  test("CHAT-05-04: save button creates new checkpoint", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-05" });

    let postCalled = false;
    await page.route(`**/api/topics/${topicId}/checkpoints`, async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ checkpoints: MOCK_CHECKPOINTS }),
        });
      } else if (method === "POST") {
        postCalled = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ checkpoint: NEW_CHECKPOINT }),
        });
      } else {
        await route.fallback();
      }
    });

    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    // Expand timeline
    const bar = page.locator("button", { hasText: /3 checkpoint/ });
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await bar.click();

    // Click the Save button (contains Plus icon)
    const saveBtn = page.locator("button", { hasText: "Save" }).last();
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    // Verify POST was called
    expect(postCalled).toBe(true);

    // Verify new checkpoint appears in list
    await expect(page.locator("text=Auto checkpoint")).toBeVisible({ timeout: 5_000 });
  });

  test("CHAT-05-05: rollback shows confirmation and truncates", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-05" });

    let rollbackCalled = false;
    await page.route(`**/api/topics/${topicId}/checkpoints`, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ checkpoints: MOCK_CHECKPOINTS }),
        });
      } else {
        await route.fallback();
      }
    });
    await page.route(`**/api/topics/${topicId}/checkpoints/1/rollback`, async (route) => {
      rollbackCalled = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ git: {} }),
      });
    });

    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    // Expand timeline
    const bar = page.locator("button", { hasText: /3 checkpoint/ });
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await bar.click();

    // Hover over the middle checkpoint (idx 1: "Auth module done")
    const entries = page.locator(".space-y-1 > div");
    const middleEntry = entries.nth(1);
    await middleEntry.hover();

    // Accept the confirm dialog
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Auth module done");
      expect(dialog.message()).toContain("12");
      await dialog.accept();
    });

    // Click rollback button (rotate-ccw icon, shown on hover)
    const rollbackBtn = middleEntry.locator('button[title="Roll back to this checkpoint"]');
    await expect(rollbackBtn).toBeVisible({ timeout: 3_000 });
    await rollbackBtn.click();

    // Verify rollback API was called
    expect(rollbackCalled).toBe(true);
  });

  test("CHAT-05-06: cancel rollback preserves state", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-05" });

    await mockCheckpoints(page, MOCK_CHECKPOINTS);
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    // Expand timeline
    const bar = page.locator("button", { hasText: /3 checkpoint/ });
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await bar.click();

    // Hover over the middle checkpoint
    const entries = page.locator(".space-y-1 > div");
    const middleEntry = entries.nth(1);
    await middleEntry.hover();

    // Dismiss the dialog
    page.once("dialog", async (dialog) => {
      await dialog.dismiss();
    });

    // Click rollback button
    const rollbackBtn = middleEntry.locator('button[title="Roll back to this checkpoint"]');
    await expect(rollbackBtn).toBeVisible({ timeout: 3_000 });
    await rollbackBtn.click();

    // Verify all 3 checkpoints still present
    await expect(page.locator("text=Initial setup")).toBeVisible();
    await expect(page.locator("text=Auth module done")).toBeVisible();
    await expect(page.locator("text=Final review")).toBeVisible();
  });
});
