/**
 * NEWTAB-ARC — the empty browser tab works like Arc's: its field takes the
 * focus on open, typing filters local suggestions (open tabs, recent pages,
 * top sites, commands), and submitting classifies — a url navigates, a
 * `/command` fills back as a suggestion, a long text offers a note in the
 * topic's project folder, written and opened in the editor.
 *
 * The tab under test lives inside a project window: the project gives the
 * note its folder and the editor its surface. The two open-tab fixtures live
 * in the top-level store instead — the tabs list reads the store, not the
 * DOM, so they never need to be the visible tab. History arrives through the
 * same localStorage keys the app reads, before the first script runs.
 *
 * @covers NEWTAB-ARC-01, NEWTAB-ARC-02, NEWTAB-ARC-03, NEWTAB-ARC-04
 */
import { test, expect } from "./fixtures/browser-v2.fixture";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { goToApp } from "./helpers";
import { waitForLayoutSettled } from "./helpers/layout";
import {
  createTopic,
  deleteTopic,
  resetProjectPanes,
  seedPaneStore,
  seedProjectInnerPanes,
  seedProjectPane,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { hermetic } from "./fixtures/hermetic";

// Hermetic boundary: this file starts from the globalSetup baseline, not from
// whatever the previous specs left behind. See fixtures/hermetic.ts.
hermetic(test);

const TAB_GUIDE = { id: "browser:arc-tab-guide", url: "https://example.com/guide", title: "Example Guide" };
const TAB_DOCS = { id: "browser:arc-tab-docs", url: "https://docs.arc.test/x", title: "Arc Docs" };
const EMPTY_INNER_ID = "browser:arc-newtab";
const EMPTY_CONTEXT = "arc-newtab";

interface FixtureSnapshot {
  sites: { host: string; url: string; title: string; favicon: string; visits: number; lastVisit: number }[];
  pages: { url: string; title: string; favicon: string; at: number }[];
}

function fixtureSnapshot(): FixtureSnapshot {
  const now = Date.now();
  return {
    sites: [
      // Excluded from the top list by the tabs rule: its url is an open tab.
      { host: "example.com", url: TAB_GUIDE.url, title: "Example Guide", favicon: "", visits: 9, lastVisit: now - 2000 },
      { host: "example.net", url: "https://example.net/", title: "Example Net", favicon: "", visits: 5, lastVisit: now - 1000 },
      { host: "other.test", url: "https://other.test/", title: "Other", favicon: "", visits: 1, lastVisit: now - 3_600_000 },
    ],
    pages: [
      // The dedupe witness: the same url as an open tab, shown once, in tabs.
      { url: TAB_GUIDE.url, title: "Example Guide", favicon: "", at: now - 1000 },
      { url: "https://example.org/news", title: "Example News", favicon: "", at: now - 2000 },
      { url: "https://unrelated.test/x", title: "Unrelated", favicon: "", at: now - 3000 },
    ],
  };
}

test.describe("newtab-arc", () => {
  let topicId = "";
  let tmpDir = "";

  test.beforeAll(async ({ request }) => {
    tmpDir = canonicalTmpDir("e2e-newtab-arc");
    mkdirSync(tmpDir, { recursive: true });
    const topic = await createTopic(request, `E2E-NewtabArc-${Date.now()}`, { projectPath: tmpDir });
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    await closeAllBrowserContexts(request);
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
    if (tmpDir) removeTmpDir(tmpDir);
  });

  test.beforeEach(async ({ request }) => {
    await resetProjectPanes(request, tmpDir);
    await seedProjectInnerPanes(request, tmpDir, [{ id: EMPTY_INNER_ID, type: "browser", title: "Browser" }]);
    const openedAt = Date.now();
    await seedPaneStore(request, () => ({
      panes: {
        [TAB_GUIDE.id]: { id: TAB_GUIDE.id, type: "browser", title: TAB_GUIDE.title, titleSource: "user", url: TAB_GUIDE.url, openedAt },
        [TAB_DOCS.id]: { id: TAB_DOCS.id, type: "browser", title: TAB_DOCS.title, titleSource: "user", url: TAB_DOCS.url, openedAt },
      },
      groups: {
        "group:default": { id: "group:default", paneIds: [TAB_GUIDE.id, TAB_DOCS.id], splitRatio: 1, splitAxis: "horizontal" },
      },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
    }));
    await seedProjectPane(request, tmpDir);
  });

  /**
   * Mocks, history, project open, new-tab visible — scoped to the empty pane.
   * Every navigate the pane issues is captured on BOTH channels it can take:
   * the mocked WS records `nav` messages, and the interact route below (last
   * registered, so it wins over the fixture's broader mock with the same
   * shape) records the REST fallback. Returns the scope plus the recording.
   */
  async function openNewTab(
    page: Page,
    mocks: { mockBrowserWs: () => Promise<void>; mockBrowserContexts: (c: never[]) => Promise<void>; mockRemoteBrowserPane: () => Promise<void> },
  ) {
    await mocks.mockBrowserWs();
    await mocks.mockBrowserContexts([]);
    await mocks.mockRemoteBrowserPane();
    const restNavigates: { action?: unknown; url?: unknown }[] = [];
    await page.route("**/api/browsers/*/interact", async (route) => {
      try {
        restNavigates.push(route.request().postDataJSON() as { action?: unknown; url?: unknown });
      } catch {
        /* a body that is not JSON is not a navigation either */
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });
    const history = fixtureSnapshot();
    await page.addInitScript(({ sites, pages }) => {
      localStorage.setItem("topics:browser-sites:v1", JSON.stringify(sites));
      localStorage.setItem("topics:browser-pages:v1", JSON.stringify(pages));
    }, history);
    await goToApp(page);
    // The project is a top-level tab once seeded: open it there, not through
    // the sidebar, whose section toggle has no language-free handle.
    const projectPaneId = `project:${encodeURIComponent(tmpDir)}`;
    await page.locator(`[data-pane-id="${projectPaneId}"]`).click({ timeout: 15_000 });
    const scope = page.locator(`[data-browser-pane="${EMPTY_CONTEXT}"]`);
    await expect(scope.getByTestId("browser-new-tab-input")).toBeVisible({ timeout: 15_000 });
    return { scope, restNavigates };
  }

  test("NEWTAB-ARC-01: a fresh tab focuses its field and typing suggests", async ({ page, browserProcessPageV2 }) => {
    test.info().annotations.push({ type: "spec", description: "NEWTAB-ARC-01" });
    const { scope } = await openNewTab(page, browserProcessPageV2);
    // The sheet the fresh pane auto-opens is still required (TOPIC-BROWSER-02):
    // the point here is that the field wins the focus while it stands.
    await expect(page.getByTestId("tab-sheet")).toBeVisible({ timeout: 15_000 });
    // …and the focus is read once the layout has settled, so the sample lands
    // after the sheet's own focus effect instead of in the frame before it.
    await waitForLayoutSettled(page, '[data-testid="browser-new-tab"]');
    await expect
      .poll(
        () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("data-testid")),
        { timeout: 5_000 },
      )
      .toBe("browser-new-tab-input");
    await scope.getByTestId("browser-new-tab-input").fill("example");
    await expect(scope.getByTestId("browser-new-tab-suggestions")).toBeVisible();
  });

  test("NEWTAB-ARC-02: two tabs plus history show every section, once each", async ({ page, browserProcessPageV2 }) => {
    test.info().annotations.push({ type: "spec", description: "NEWTAB-ARC-02" });
    const { scope } = await openNewTab(page, browserProcessPageV2);
    const section = (id: string) => scope.locator(`[data-testid="browser-new-tab-section"][data-section="${id}"]`);
    const row = (kind: string, value: string) =>
      scope.locator(`[data-testid="browser-new-tab-suggestion"][data-kind="${kind}"][data-value="${value}"]`);

    // Empty query: tabs, recent and commands list; the grid says the top.
    await expect(section("tabs")).toBeVisible();
    await expect(row("tab", TAB_GUIDE.url)).toBeVisible();
    await expect(row("tab", TAB_DOCS.url)).toBeVisible();
    await expect(section("recent")).toBeVisible();
    await expect(row("recent", "https://example.org/news")).toBeVisible();
    await expect(section("commands")).toBeVisible();
    await expect(row("command", "/status")).toBeVisible();
    await expect(row("command", "/model")).toBeVisible();
    await expect(section("top")).toHaveCount(0);
    await expect(scope.getByTestId("browser-new-tab-sites")).toBeVisible();
    // The dedupe: the guide url is a tab AND a history row, shown once.
    await expect(scope.locator(`[data-testid="browser-new-tab-suggestion"][data-value="${TAB_GUIDE.url}"]`)).toHaveCount(1);

    // Filtering: one row per section, the grid gone, commands out.
    await scope.getByTestId("browser-new-tab-input").fill("example");
    await expect(row("tab", TAB_GUIDE.url)).toBeVisible();
    await expect(row("tab", TAB_DOCS.url)).toHaveCount(0);
    await expect(row("recent", "https://example.org/news")).toBeVisible();
    await expect(row("recent", "https://unrelated.test/x")).toHaveCount(0);
    await expect(section("top")).toBeVisible();
    await expect(row("top", "https://example.net/")).toBeVisible();
    await expect(section("commands")).toHaveCount(0);
    await expect(scope.getByTestId("browser-new-tab-sites")).toHaveCount(0);

    // A slash query is commands alone.
    await scope.getByTestId("browser-new-tab-input").fill("/sta");
    await expect(section("commands")).toBeVisible();
    await expect(row("command", "/status")).toBeVisible();
    await expect(section("tabs")).toHaveCount(0);
    await expect(section("recent")).toHaveCount(0);
    await expect(section("top")).toHaveCount(0);
  });

  test("NEWTAB-ARC-03: a bare host navigates under the bar rule", async ({ page, browserProcessPageV2 }) => {
    test.info().annotations.push({ type: "spec", description: "NEWTAB-ARC-03" });
    const { scope, restNavigates } = await openNewTab(page, browserProcessPageV2);
    // Mount noise out: a fixture tab coming up navigates over these same
    // channels, and what is measured below is the submit alone.
    browserProcessPageV2.drainInputMessages();
    restNavigates.length = 0;
    const input = scope.getByTestId("browser-new-tab-input");
    await input.fill("example.it");
    await input.press("Enter");
    // The exact url, on whichever channel the pane took: `example.it` is a
    // bare public host, so the bar rule says `https://example.it`.
    await expect
      .poll(
        () => {
          for (const m of browserProcessPageV2.drainInputMessages()) {
            const o = m as { type?: unknown; url?: unknown } | null;
            if (typeof o === "object" && o !== null && o.type === "nav") restNavigates.push({ action: "navigate", url: o.url });
          }
          return restNavigates.filter((b) => b.action === "navigate").map((b) => b.url);
        },
        { timeout: 10_000 },
      )
      .toContain("https://example.it");
    // …and the pane left the new tab for it.
    await expect(scope.getByTestId("browser-new-tab")).toHaveCount(0);
  });

  test("NEWTAB-ARC-03b: a /command fills back instead of navigating", async ({ page, browserProcessPageV2 }) => {
    test.info().annotations.push({ type: "spec", description: "NEWTAB-ARC-03" });
    const { scope } = await openNewTab(page, browserProcessPageV2);
    const input = scope.getByTestId("browser-new-tab-input");
    await input.fill("/status");
    const row = scope.locator(
      '[data-testid="browser-new-tab-suggestion"][data-kind="command"][data-value="/status"]',
    );
    await expect(row).toBeVisible();
    await row.click();
    // A command suggests: it fills the field (`/status` takes no argument,
    // so no trailing space) and the tab stays a new tab.
    await expect(input).toHaveValue("/status");
    await expect(scope.getByTestId("browser-new-tab")).toBeVisible();
    await input.press("Enter");
    // Read settled: a navigation would have cleared the field and unmounted
    // the page within these frames.
    await waitForLayoutSettled(page, '[data-testid="browser-new-tab"]');
    await expect(input).toHaveValue("/status");
    await expect(scope.getByTestId("browser-new-tab")).toBeVisible();
  });

  test("NEWTAB-ARC-03c: a long text offers a note that opens in the editor", async ({ page, browserProcessPageV2 }) => {
    test.info().annotations.push({ type: "spec", description: "NEWTAB-ARC-03" });
    // Cold editor chunk plus CodeMirror on webkit: the condition is real, the
    // budget covers the slowest legitimate load rather than the usual one.
    test.setTimeout(90_000);
    const { scope } = await openNewTab(page, browserProcessPageV2);
    const marker = `arc-nota-${Date.now()}`;
    // Multiline AND over the 500-character door, so either half of the rule
    // would offer the note on its own.
    await scope.getByTestId("browser-new-tab-input").fill(`${marker}\n${"riga di appunto ".repeat(40)}`);
    const fileRow = scope.getByTestId("browser-new-tab-create-file");
    await expect(fileRow).toBeVisible();
    const name = await fileRow.getAttribute("data-value");
    expect(name?.endsWith(".md")).toBe(true);
    await fileRow.click();
    // The editor tab opens on the note, with the same content.
    const editor = page.locator('[data-testid="file-pane"] .cm-content');
    await expect(editor).toContainText(marker, { timeout: 20_000 });
    await expect(page.locator('[data-testid="panel-tab-bar"]').last()).toContainText(name ?? marker);
  });

  test("NEWTAB-ARC-04: deleting the note removes it from the project", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "NEWTAB-ARC-04" });
    // Self-sufficient on purpose: a retry re-runs beforeAll with a fresh
    // folder, orphaning whatever the creation test wrote, so this test writes
    // its own note first — the same bytes a new-tab note is, through the same
    // save route the page uses — plus any note the creation test left behind
    // in this same folder. What is measured is the deletion, through the same
    // route the explorer deletes with; the tree refreshing itself is FILE-01
    // territory, already held elsewhere.
    const own = `arc-nota-b4-${Date.now()}.md`;
    const saved = await request.post("/api/files/save", {
      data: { path: `${tmpDir}/${own}`, content: "nota da cancellare" },
    });
    expect(saved.ok()).toBe(true);
    const flat = await request.get(`/api/files/flat?path=${encodeURIComponent(tmpDir)}&maxFiles=2000`);
    expect(flat.ok()).toBe(true);
    const notes = [own, ...((await flat.json()) as { files: string[] }).files.filter(
      (f) => f.startsWith("arc-nota-") && f.endsWith(".md") && f !== own,
    )];
    for (const note of notes) {
      const deleted = await request.delete("/api/files/delete", { data: { path: `${tmpDir}/${note}` } });
      expect(deleted.ok()).toBe(true);
    }
    // Gone from the listing…
    await expect
      .poll(async () => {
        const again = await request.get(`/api/files/flat?path=${encodeURIComponent(tmpDir)}&maxFiles=2000`);
        if (!again.ok()) return ["unlisted"];
        return ((await again.json()) as { files: string[] }).files.filter(
          (f) => f.startsWith("arc-nota-") && f.endsWith(".md"),
        );
      }, { timeout: 10_000 })
      .toEqual([]);
    // …and unreadable.
    await expect
      .poll(
        async () =>
          (await request.get(`/api/files/content?path=${encodeURIComponent(`${tmpDir}/${own}`)}`)).status(),
        { timeout: 10_000 },
      )
      .toBe(404);
  });
});
