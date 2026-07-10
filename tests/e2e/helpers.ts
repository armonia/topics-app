/**
 * Shared E2E test helpers.
 * CONVENTION: No waitForTimeout() or networkidle usage.
 * Use condition-based waits: waitForSelector, toBeVisible(), waitFor().
 * See tests/e2e/helpers/ for domain-specific utilities.
 */
import { expect, type Page } from "@playwright/test";
import { seedTopicIntoSidebar, unarchiveTopic } from "./helpers/api-fixtures";

const BASE_URL = "http://localhost:13334";

/** Read the authoritative pane-store and report whether group:default already
 *  contains every id — i.e. whether our seed is (still) the last write to win. */
async function paneStoreContainsAll(page: Page, ids: string[]): Promise<boolean> {
  const res = await page.request.get(`${BASE_URL}/api/ui-state/pane-store-v2`, { ignoreHTTPSErrors: true });
  if (!res.ok()) return false;
  const body = (await res.json().catch(() => null)) as
    | { value?: { groups?: Record<string, { paneIds?: string[] }> } }
    | null;
  const paneIds = body?.value?.groups?.["group:default"]?.paneIds ?? [];
  return ids.every((id) => paneIds.includes(id));
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
  // NOTE: seed-topic visibility is NOT primed here. Unread is a WS-PUSH-ONLY
  // signal on the client — useWebSocket seeds unreadData={} and the server
  // never emits an `unread:init` snapshot on connect, so any system-message
  // posted BEFORE page.goto() broadcasts to a not-yet-connected client and is
  // lost. Worse, it leaves server unread>0, which made the old ensureTopicVisible
  // skip its (post-connect, actually-delivered) re-post → the row never showed.
  // Visibility is now driven per-topic by ensureTopicVisible AFTER the WS is up.
  await page.goto("/");
  // Wait for sidebar navigation to appear
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
}

/**
 * Ensure a topic matching `name` is visible in the tab-driven sidebar.
 *
 * The unified timeline sidebar shows a standalone chat only if it is NON-archived
 * AND has an OPEN TAB (or a pending notification). Two independent gates trip up
 * the baseline "Web Search Test" / "Best Ramen" topics:
 *   1. ARCHIVED. The e2e test DB in /tmp/topics-test-data/ PERSISTS across runs,
 *      and any prior spec that closed the topic left it archived. buildSidebarItems
 *      hard-skips archived standalone chats (line ~437) regardless of pane-store
 *      state — so seeding a tab is not enough. In the real UI, reopening a closed
 *      topic unarchives it (openPanel's self-heal); we replicate that with a PATCH.
 *   2. NO TAB. global-setup creates these via a raw POST that never opens a tab,
 *      and unread is WS-PUSH-ONLY (no `unread:init` snapshot on connect), so a
 *      fresh load shows no row.
 *
 * Fix: (a) unarchive the topic, then (b) seed its pane into the AUTHORITATIVE
 * pane-store exactly like createTopic does, then reload. The server snapshot wins
 * the hydrate LWW by server_seq (its PUT lands after the client's), so no
 * about:blank detach is needed. addInitScript / page.route mocks survive reload.
 */
export async function ensureTopicVisible(page: Page, name: string | RegExp): Promise<void> {
  const item = page.getByRole("treeitem", { name });
  if (await item.first().isVisible().catch(() => false)) return;
  // Resolve the topic id(s) whose name matches so we can open their tab.
  let ids: string[] = [];
  try {
    const res = await page.request.get(`${BASE_URL}/api/topics`);
    if (res.ok()) {
      const data = (await res.json()) as { topics?: Record<string, { id: string; name: string }> };
      const matcher = typeof name === "string" ? (n: string) => n.includes(name) : (n: string) => name.test(n);
      ids = Object.values(data.topics ?? {}).filter((t) => matcher(t.name)).map((t) => t.id);
    }
  } catch { /* fall through — waitFor below surfaces a clear error */ }
  if (ids.length === 0) return;
  // Detach the live client BEFORE seeding, then CONFIRM the seed won the LWW.
  //
  // A client that ran goToApp keeps a keepalive pane-store flush (syncServer.ts —
  // visibilitychange→hidden / pagehide) that fires on the about:blank nav. On the
  // shared, heavily-polluted test server (a single 500-test serial run accumulates
  // hundreds of panes) that fire-and-forget flush can land AFTER our seed PUT and
  // clobber it, so the reload hydrates an EMPTY sidebar. about:blank makes the
  // outgoing "/" page emit exactly one such flush, so we (a) detach, (b) re-seed
  // until a read-back proves the pane-store actually contains the ids (our write is
  // last), then (c) reload. If a late flush still wins the reload, retry the whole
  // detach+seed — each pass strictly narrows the race. page.request is
  // context-level, so it keeps working across the navigations.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto("about:blank");
    for (const id of ids) {
      // Unarchive first — an archived standalone chat is filtered out of the
      // sidebar upstream of any pane-store signal (mirrors openPanel's unarchive).
      await unarchiveTopic(page.request, id);
    }
    await expect
      .poll(
        async () => {
          for (const id of ids) await seedTopicIntoSidebar(page.request, id).catch(() => {});
          return paneStoreContainsAll(page, ids);
        },
        { timeout: 8000, intervals: [150, 250, 400, 600, 800] },
      )
      .toBe(true);

    // Reload so the client hydrates the freshly-opened tab from the pane store.
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const shown = await item
      .first()
      .waitFor({ state: "visible", timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    if (shown) return;
  }
  // Exhausted retries — surface a clear, standard failure.
  await item.first().waitFor({ state: "visible", timeout: 10000 });
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
