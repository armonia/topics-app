/**
 * Regression for card c2984ce2 "Ripristino dello split interno ai progetti":
 * the split inside a project was gone, while it still worked outside.
 *
 * ROOT CAUSE (confirmed): commit ec3110f0b (2026-09-02) made the server store a
 * topic's projectPath CANONICAL (realpathSync, resolves symlinks). A project
 * WINDOW opened from a persisted `project:<path>` pane kept the RAW path it was
 * saved with. When the two disagree (any symlinked path), useProjectChatSync
 * and onServerHydrate both filter the chat out with
 * `topic.projectPath === projectPath`, so the project window showed "No chats
 * open": nothing to split. Non-chat panes (browser/file) were unaffected.
 *
 * THE FIX is server-side (`server/lib/canonical-pane-state.ts`): `pane-store-v2`
 * is SERVED with every project pane renamed to its canonical path, the raw id
 * tombstoned, and the per-project `topics-project-panes-<hash>` row following
 * the pane. So a client that hydrates a RAW pane sees the CANONICAL one.
 *
 * On macOS /tmp is a symlink to /private/tmp, so /tmp/<x> reproduces the exact
 * mismatch a symlinked real project hits.
 *
 *  - RAW:   seed the project pane and its inner chat under the RAW /tmp path →
 *           the client must see the canonical pane only, its child chat as an
 *           inner tab, and the split must work. Red before the fix.
 *  - CANON: the same seeded canonical → control, proving the ONLY difference
 *           is the path.
 */
import { test } from "./fixtures/layout.fixture";
import { expect } from "@playwright/test";
import { goToApp } from "./helpers";
import {
  createTopic,
  deleteTopic,
  resetPaneStore,
  seedProjectPane,
  seedProjectInnerChats,
  resetProjectPanes,
} from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "fs";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

let childChatId: string | null = null;
const RAW_PATH = `/tmp/e2e-prj-split-single-${Date.now()}`;
// The canonical form the server stores the topic under (macOS: /private/tmp/...).
let CANON_PATH = RAW_PATH;

const paneId = (path: string) => `project:${encodeURIComponent(path)}`;

test.describe("In-project split (card c2984ce2)", () => {
  test.beforeAll(async ({ request }) => {
    mkdirSync(RAW_PATH, { recursive: true });
    writeFileSync(`${RAW_PATH}/package.json`, JSON.stringify({ name: "e2e-prj-split-single" }, null, 2));
    CANON_PATH = realpathSync(RAW_PATH);
    // Server canonicalises projectPath on create → topic stored under CANON_PATH.
    childChatId = (await createTopic(request, "E2E-SplitChild", { projectPath: RAW_PATH })).id;
  });

  test.afterAll(async ({ request }) => {
    if (childChatId) await deleteTopic(request, childChatId).catch(() => {});
    rmSync(RAW_PATH, { recursive: true, force: true });
  });

  function projectWindow(page: import("@playwright/test").Page) {
    return page.locator('[data-testid="project-window"]:visible').first();
  }

  /** Open the project by clicking its project pane (by exact path id). */
  async function openProjectPane(page: import("@playwright/test").Page, path: string) {
    const pane = page.locator(`[data-pane-id="${paneId(path)}"]`).first();
    await expect(pane).toBeVisible({ timeout: 10000 });
    await pane.click();
    await expect(projectWindow(page)).toBeVisible({ timeout: 10000 });
  }

  /** The seeded child chat must render as an inner project tab. */
  function innerChatTab(page: import("@playwright/test").Page) {
    return projectWindow(page)
      .locator('[data-testid="panel-tab-bar"][data-group-id^="group:"] [data-testid^="pane-tab-"]')
      .first();
  }

  async function splitFirstInnerTab(page: import("@playwright/test").Page) {
    const projectPane = projectWindow(page);
    const projectBars = projectPane.locator('[data-testid="panel-tab-bar"][data-group-id^="group:"]');
    await expect(projectBars.first()).toBeVisible({ timeout: 10000 });
    const before = await projectBars.count();

    const tab = projectBars.first().locator('[data-testid^="pane-tab-"]').first();
    await tab.click({ button: "right" });
    const menu = page.locator('[role="menu"]').first();
    await expect(menu).toBeVisible({ timeout: 5000 });
    const splitRight = menu.locator("button").filter({ hasText: /Dividi a destra/ }).first();
    await expect(splitRight, "the project tab menu must offer 'Dividi a destra'").toBeVisible({ timeout: 3000 });
    await splitRight.click();

    await expect
      .poll(() => projectBars.count(), { timeout: 6000, message: "'Dividi a destra' must carve a second inner group" })
      .toBe(before + 1);
    await page.waitForTimeout(1200);
    expect(await projectBars.count(), "the second inner group must not collapse back").toBe(before + 1);
  }

  test("PRJ-SPLIT-CHAT-RAW: a chat project persisted by its raw path is served canonical, renders its chat and splits", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PROJ-ID-04" });
    test.skip(CANON_PATH === RAW_PATH, "no symlink on this platform: RAW already is canonical");
    await resetPaneStore(page.request, []);
    // Only the RAW per-project row is reset: with the fix an EXISTING canonical
    // row wins over the raw one, so pre-creating an empty canonical row here
    // would hide the seeded inner chat and test the wrong thing.
    await resetProjectPanes(page.request, RAW_PATH).catch(() => {});
    await seedProjectPane(page.request, RAW_PATH);
    await seedProjectInnerChats(page.request, RAW_PATH, [childChatId!]);
    await goToApp(page);
    await openProjectPane(page, CANON_PATH);
    await expect(page.locator(`[data-pane-id="${paneId(RAW_PATH)}"]`), "the raw pane must not be rendered next to the canonical one").toHaveCount(0);
    await expect(innerChatTab(page), "the seeded child chat must render as an inner project tab").toBeVisible({
      timeout: 15000,
    });
    await splitFirstInnerTab(page);
  });

  test("PRJ-SPLIT-CHAT-CANON: the same project opened by its canonical path renders its chat and splits", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PROJ-ID-04" });
    test.skip(CANON_PATH === RAW_PATH, "no symlink on this platform: RAW already is canonical");
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, RAW_PATH).catch(() => {});
    await resetProjectPanes(page.request, CANON_PATH).catch(() => {});
    await seedProjectPane(page.request, CANON_PATH);
    await seedProjectInnerChats(page.request, CANON_PATH, [childChatId!]);
    await goToApp(page);
    await openProjectPane(page, CANON_PATH);
    await expect(innerChatTab(page), "the seeded child chat must render as an inner project tab").toBeVisible({
      timeout: 15000,
    });
    await splitFirstInnerTab(page);
  });
});
