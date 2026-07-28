import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

test.describe("Unread badge clearing", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `unread-test-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // Il badge di non-letto si conta sul tab APERTO del topic: il pane-store è
  // condiviso da tutta la suite seriale, quindi qui riportiamo lo stato al solo
  // tab seminato da createTopic — né più (pane altrui) né meno (il tab serve).
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("unread badge appears when message arrives for unfocused topic", async ({ page, request }) => {
    await goToApp(page);

    // Send a message to the topic via API (simulating an external message)
    await request.post(`${BASE}/api/topics/${topicId}/read`, {
      ignoreHTTPSErrors: true,
    });

    // Inject an unread count by posting a system message while topic is not focused
    await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
      data: { content: "Test unread message" },
      ignoreHTTPSErrors: true,
    });

    // Wait for unread badge to appear on the topic in the sidebar
    const topicItem = page.getByRole("treeitem", { name: new RegExp(topicName) });
    await expect(topicItem).toBeVisible({ timeout: 10000 });

    // Check for unread badge (a span with bg-primary class inside the topic item)
    const badge = topicItem.locator("span.bg-primary");
    await expect(badge).toBeVisible({ timeout: 10000 });
  });

  test("unread badge clears when topic is clicked", async ({ page }) => {
    await goToApp(page);

    // Open the topic (this should trigger markRead)
    await openTopic(page, new RegExp(topicName));

    // Wait a moment for the markRead API call to complete
    await page.waitForTimeout(1000);

    // Navigate away and back to sidebar to verify badge is gone
    // The badge should not be visible for a focused topic
    const topicItem = page.getByRole("treeitem", { name: new RegExp(topicName) });
    const badge = topicItem.locator("span.bg-primary");
    await expect(badge).not.toBeVisible({ timeout: 5000 });
  });
});
