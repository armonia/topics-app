/**
 * Shared E2E test helpers.
 * CONVENTION: No waitForTimeout() or networkidle usage.
 * Use condition-based waits: waitForSelector, toBeVisible(), waitFor().
 * See tests/e2e/helpers/ for domain-specific utilities.
 */
import { type Page } from "@playwright/test";

/** Navigate to Topics app and wait for sidebar to load */
export async function goToApp(page: Page) {
  await page.goto("/");
  // Wait for sidebar navigation to appear (role="navigation" aria-label="Topics sidebar")
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
  // Ensure Chats section is expanded
  await ensureChatsExpanded(page);
}

/** Ensure the Chats section is expanded */
async function ensureChatsExpanded(page: Page) {
  const chatsSection = page.getByRole("button", { name: /Chats section/ });
  if (await chatsSection.count() === 0) return;

  // If there are no visible chat treeitems, the section may be collapsed — expand it
  const isExpanded = await chatsSection.getAttribute("aria-expanded");
  if (isExpanded === "false") {
    await chatsSection.click();
    // Wait for at least one treeitem to appear after expanding
    await page.getByRole("treeitem").first().waitFor({ state: "visible", timeout: 5000 });
  }
}

/** Open a specific chat topic by name */
export async function openTopic(page: Page, name: string | RegExp) {
  const item = page.getByRole("treeitem", { name });

  // Try to find the topic; if not found, expand Chats section and retry
  const found = await item.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
  if (!found) {
    const chatsSection = page.getByRole("button", { name: /Chats section/ });
    if (await chatsSection.count() > 0) {
      await chatsSection.click();
      // Wait for at least one treeitem to appear after expanding
      await page.getByRole("treeitem").first().waitFor({ state: "visible", timeout: 5000 });
    }
    await item.waitFor({ state: "visible", timeout: 10000 });
  }

  await item.click();
  // Wait for main content area to reflect the opened topic
  await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10000 });
}

/** Open the default test chat (Web Search Test) and wait for textarea */
export async function openTestChat(page: Page) {
  await openTopic(page, /Web Search Test/);
  const textarea = page.getByRole("textbox", { name: /Message input/ });
  await textarea.waitFor({ state: "visible", timeout: 10000 });
  return textarea;
}
