/**
 * The archive is off the boot path, and nothing is lost.
 *
 * Measured 2026-09-05 on the workspace of the person using the app: 1,554
 * topics, 1,535 archived, and `GET /api/topics` carried all of them - 872 KB,
 * 1.4 s on a loaded machine - for 19 rows the sidebar draws; `topics-cache`
 * rewrote the same 872 KB on every change of any topic. Now the boot list is
 * the live topics, the archive is `?archived=1` loaded after the first frame,
 * and the two halves have two caches.
 *
 * What this spec proves, in the real app against the test server:
 *  1. an archived topic is NOT in the boot payload, NOT in the sidebar, NOT in
 *     `topics-cache` - and IS in `topics-archived-cache` once the idle load ran;
 *  2. «Mostra archiviati» (allow-italian: the UI label) brings its row back and reopening it restores it
 *     (tab open, `archived:false` on the server) - the 2-state model intact;
 *  3. a surface that shows a closed chat with the toggle OFF - a pinned row -
 *     still resolves its name on a device that boots with empty caches.
 *
 * @covers TOPIC-01
 * @covers STORAGE-WAL-01
 */
import { test, expect } from "./fixtures/topic-management.fixture";
import { createTopic, archiveTopic, cleanupAll, fetchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const SIDEBAR_STATE_CLEAN = { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [] as string[] };

test.describe("Topics — the archive is off the boot path", () => {
  const ids: string[] = [];

  test.beforeAll(async ({ request }) => {
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, { data: SIDEBAR_STATE_CLEAN });
  });

  test.afterAll(async ({ request }) => {
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, { data: SIDEBAR_STATE_CLEAN });
    await cleanupAll(request, { topics: ids });
  });

  // The pane-store is one for the whole serial suite: start from nothing, the
  // test creates the topic it needs and createTopic opens its tab.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("ARCHIVE-BOOT-01: an archived topic leaves the boot list and the live cache; «Mostra archiviati» brings it back and reopening restores it", async ({
    topicPage,
    page,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-01" });
    const name = `E2E-ArchiveBoot-${Date.now()}`;
    const topic = await createTopic(request, name);
    ids.push(topic.id);

    await topicPage.goto();
    await expect(topicPage.findTopic(new RegExp(name))).toBeVisible({ timeout: 10000 });

    // Closed as another device would close it: the server flips the flag and
    // purges the tab from the shared pane state.
    await archiveTopic(request, topic.id);

    // Reload, and read the boot list the page itself fetches: the plain
    // `GET /api/topics`, not `?archived=1` and not a `/api/topics/...` route.
    const bootList = page.waitForResponse((r) => {
      const u = new URL(r.url());
      return r.request().method() === "GET" && u.pathname === "/api/topics" && u.search === "";
    });
    await topicPage.goto();
    const boot = (await (await bootList).json()) as { topics: Record<string, { archived: boolean }> };
    expect(boot.topics[topic.id], "the boot list must not carry an archived topic").toBeUndefined();
    expect(Object.values(boot.topics).some((t) => t.archived), "no archived row at all in the boot list").toBe(false);

    // Not in the sidebar with the toggle off.
    await expect(topicPage.findTopic(new RegExp(name))).toHaveCount(0, { timeout: 10000 });

    // The archive arrives after the first frame and goes to ITS cache; the
    // live cache never sees it again.
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("topics-archived-cache") ?? ""), { timeout: 15000 })
      .toContain(topic.id);
    expect(await page.evaluate(() => window.localStorage.getItem("topics-cache") ?? "")).not.toContain(topic.id);

    // «Mostra archiviati» (Topics ▾ menu; allow-italian: the UI label): the row is back.
    await page.locator('button[title="Settings & Tools"]').click();
    const archiveToggle = page.getByRole("button", { name: "Mostra archiviati" });
    await expect(archiveToggle).toBeVisible({ timeout: 3000 });
    await archiveToggle.click();
    await page.keyboard.press("Escape");
    const row = topicPage.findTopic(new RegExp(name));
    await expect(row).toBeVisible({ timeout: 10000 });

    // Reopening from the archive restores it: tab open, and the server agrees.
    await row.click();
    await expect(
      page.locator('[data-testid="panel-tab-bar"]').getByText(new RegExp(name)).first(),
    ).toBeVisible({ timeout: 10000 });
    await expect
      .poll(async () => (await fetchTopic(request, topic.id))?.archived, { timeout: 10000 })
      .toBe(false);
  });

  test("ARCHIVE-BOOT-02: a pinned closed chat keeps its name on a device that boots with empty caches", async ({
    topicPage,
    page,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-01" });
    // A pinned row is the one surface that draws a closed chat with the
    // toggle OFF (the pinnedIds escape in buildSidebarItems). Its name can only
    // come from the archive, which the boot list no longer carries.
    const name = `E2E-ArchivePin-${Date.now()}`;
    const topic = await createTopic(request, name);
    ids.push(topic.id);
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { ...SIDEBAR_STATE_CLEAN, pinnedItems: [topic.id] },
    });
    await archiveTopic(request, topic.id);

    // A device that never saw this topic: both caches empty before the app runs.
    await page.addInitScript(() => {
      try {
        window.localStorage.removeItem("topics-cache");
        window.localStorage.removeItem("topics-archived-cache");
      } catch { /* storage denied: the app boots from the server anyway */ }
    });
    await topicPage.goto();

    const row = topicPage.findTopic(new RegExp(name));
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row).toHaveAttribute("data-pinned", "true");
  });
});
