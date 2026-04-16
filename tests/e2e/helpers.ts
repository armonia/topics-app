/**
 * Shared E2E test helpers.
 * CONVENTION: No waitForTimeout() or networkidle usage.
 * Use condition-based waits: waitForSelector, toBeVisible(), waitFor().
 * See tests/e2e/helpers/ for domain-specific utilities.
 */
import { type Page } from "@playwright/test";

const BASE_URL = "http://localhost:13334";
const SEEDED_TOPIC_NAMES = ["Web Search Test", "Best Ramen"];
// Tag used on test-injected system messages so cleanup can identify them.
// Keep this short; it shows up as content in the seeded topics during runs.
const VISIBILITY_MARKER = "_test_visibility_marker";

/**
 * Ensure each named seed topic has unread > 0 so it appears in the
 * tab-driven sidebar. Idempotent: skipped if unread already > 0.
 * Appends a marker system message so the DB doesn't grow unboundedly —
 * subsequent runs short-circuit because unread remains > 0.
 */
async function ensureSeedTopicsVisible(page: Page): Promise<void> {
  try {
    const res = await page.request.get(`${BASE_URL}/api/topics`);
    if (!res.ok()) return;
    const data = (await res.json()) as { topics?: Record<string, { id: string; name: string }> };
    if (!data.topics) return;
    const unreadRes = await page.request.get(`${BASE_URL}/api/unread`);
    const unread = unreadRes.ok() ? (await unreadRes.json()) as Record<string, { unreadCount?: number }> : {};
    for (const name of SEEDED_TOPIC_NAMES) {
      const topic = Object.values(data.topics).find((t) => t.name === name);
      if (!topic) continue;
      const current = unread[topic.id]?.unreadCount ?? 0;
      if (current > 0) continue;
      await page.request.post(`${BASE_URL}/api/topics/${topic.id}/system-message`, {
        data: { content: VISIBILITY_MARKER },
      }).catch(() => {});
    }
  } catch {
    // Caller's waitFor will fail with a clearer error if visibility isn't restored
  }
}

/** Navigate to Topics app and wait for sidebar to load */
export async function goToApp(page: Page) {
  // Reset panel-order only. Do NOT reset /api/ui-state/panels: since the sidebar
  // redesign (commit c9d168e) the unified timeline only shows topics with an
  // open tab or unread messages. createTopic() in api-fixtures pre-seeds the
  // topic into openPanels/pane-store-v2 — wiping that here hides test-created topics.
  await page.request.put(`${BASE_URL}/api/ui-state/panel-order`, {
    data: { order: [], pinned: [] },
  }).catch(() => {});
  // Ensure baseline seed topics are visible via unread-marker (belt-and-suspenders
  // alongside createTopic's pane-store-v2 seeding — covers topics that weren't
  // created through createTopic, e.g. legacy Web Search Test).
  await ensureSeedTopicsVisible(page);
  await page.goto("/");
  // Wait for sidebar navigation to appear
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
}

/**
 * Ensure a topic matching `name` is visible in the tab-driven sidebar.
 * The sidebar only shows topics with an open tab OR unread > 0. Tests that
 * look up topics by sidebar name (especially newly-created ones with no
 * messages yet) need this guarantee.
 *
 * Idempotent: skips if a treeitem already matches, or if unread > 0. Only
 * posts ONE marker message per topic that needs it, so the DB doesn't grow
 * unboundedly across runs (the guard keeps the count at exactly 1).
 *
 * Caller's subsequent waitFor will surface a clear error if visibility still
 * isn't restored (e.g., because a regex is anchored and matches nothing).
 */
async function ensureTopicVisible(page: Page, name: string | RegExp): Promise<void> {
  const item = page.getByRole("treeitem", { name });
  const alreadyVisible = await item.first().isVisible().catch(() => false);
  if (alreadyVisible) return;
  try {
    const [topicsRes, unreadRes] = await Promise.all([
      page.request.get(`${BASE_URL}/api/topics`),
      page.request.get(`${BASE_URL}/api/unread`),
    ]);
    if (!topicsRes.ok()) return;
    const data = (await topicsRes.json()) as { topics?: Record<string, { id: string; name: string }> };
    if (!data.topics) return;
    const unread = unreadRes.ok() ? (await unreadRes.json()) as Record<string, { unreadCount?: number }> : {};
    const matcher = typeof name === "string" ? (n: string) => n.includes(name) : (n: string) => name.test(n);
    for (const t of Object.values(data.topics)) {
      if (!matcher(t.name)) continue;
      if ((unread[t.id]?.unreadCount ?? 0) > 0) continue;
      await page.request.post(`${BASE_URL}/api/topics/${t.id}/system-message`, {
        data: { content: VISIBILITY_MARKER },
      }).catch(() => {});
    }
  } catch {
    // Caller's waitFor will fail with a clearer error if visibility isn't restored
  }
}

/** Open a specific chat topic by name */
export async function openTopic(page: Page, name: string | RegExp) {
  await ensureTopicVisible(page, name);
  const item = page.getByRole("treeitem", { name });

  // In the unified timeline sidebar, topics are directly visible (no section to expand)
  await item.waitFor({ state: "visible", timeout: 10000 });
  await item.click();
  // Wait for main content area to reflect the opened topic
  await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10000 });
}

/** Single-click a topic in the sidebar (opens as preview/transient tab) */
export async function openTopicByClick(page: Page, name: string | RegExp) {
  await ensureTopicVisible(page, name);
  const item = page.getByRole("treeitem", { name });
  await item.waitFor({ state: "visible", timeout: 10000 });
  await item.click();
  await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10000 });
}

/** Double-click a topic in the sidebar (opens and pins the tab) */
export async function openTopicByDoubleClick(page: Page, name: string | RegExp) {
  await ensureTopicVisible(page, name);
  const item = page.getByRole("treeitem", { name });
  await item.waitFor({ state: "visible", timeout: 10000 });
  await item.dblclick();
  await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10000 });
}

/** Open the default test chat (Web Search Test) and wait for textarea */
export async function openTestChat(page: Page) {
  await openTopic(page, /Web Search Test/);
  const textarea = page.getByRole("textbox", { name: /Message input/ });
  await textarea.waitFor({ state: "visible", timeout: 10000 });
  return textarea;
}
