/**
 * A SPLIT MADE INSIDE A PROJECT IS STILL THERE WHEN YOU COME BACK.
 *
 * Reported as "the split inside a project is completely gone: it has to be
 * there both outside projects and inside them".            allow-italian: n/a
 *
 * Splitting the ONLY pane of a group has to leave a companion in the group it
 * empties, or the orphan pass deletes that group and undoes the split in the
 * same breath. The standalone grid puts a DRAFT there and gets away with it:
 * its pool cell is permanent and it knows how to draw a draft. A project window
 * does not -- it has no topic to render for a draft (the cell read "Topic not
 * found") and nothing persists one, so the cell was gone on the next load, the
 * group with it, and the split collapsed back to a single cell.
 *
 * The companion is now a REAL chat of the project, the one "+ new chat"
 * creates, and the split waits for it instead of running on a hole. This file
 * is the proof of the property that follows: two cells before the reload, two
 * cells after -- the same as outside a project.
 *
 * @covers DNDSPLIT-03
 */
import { mkdirSync, realpathSync } from "fs";
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import {
  resetPaneStore,
  resetProjectPanes,
  seedProjectPane,
  createTopic,
  deleteTopic,
} from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * The project, by its RESOLVED path. On macOS `/tmp` is a symlink to
 * `/private/tmp` and the server stores a topic's `projectPath` resolved, so a
 * project pane seeded under the symlinked name never matches its own chats:
 * the window opens on its empty state and draws no tree at all.
 */
const PROJECT_PATH = (() => {
  const dir = `/tmp/e2e-prjsplit-${Date.now()}`;
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
})();

test.describe("Split inside a project: it survives the return", () => {
  let seedTopicId = "";

  test.beforeAll(async ({ request }) => {
    // A topic of this project, so the window has something of its own to hold
    // even before the test opens a chat in it.
    seedTopicId = (await createTopic(request, `prj-split-${Date.now()}`, { projectPath: PROJECT_PATH })).id;
  });

  test.afterAll(async ({ request }) => {
    if (seedTopicId) await deleteTopic(request, seedTopicId).catch(() => {});
    await resetProjectPanes(request, PROJECT_PATH).catch(() => {});
  });

  test("PRJSPLIT-1: the split of a lone pane is a chat, and it is still there after a reload", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-03" });
    await resetPaneStore(request, []);
    await resetProjectPanes(request, PROJECT_PATH).catch(() => {});
    await seedProjectPane(request, PROJECT_PATH);
    await goToApp(page);

    // The project window draws its OWN tiling surface, inside a cell of the
    // standalone grid. Everything here is scoped to that surface by name: the
    // outer grid has leaves of its own, and counting them all is how a test
    // ends up asserting the wrong split (measured: without the scope this row
    // passed on the standalone grid while the project window sat empty).
    const projectWindow = page.locator('[data-testid="project-window"]');
    const projectCells = projectWindow.locator("[data-split-surface] [data-split-leaf]");
    const projectTabs = projectWindow.locator('[data-testid="panel-tab-bar"] [draggable="true"]');

    // Focus the project's own tab first: the window has to be the one in front
    // before its buttons mean anything.
    await page.locator('[data-pane-id^="project:"]').first().click();
    await projectWindow.waitFor({ state: "visible", timeout: 15000 });

    // A project with no OPEN chat draws its empty state and no tree at all, so
    // the window gets one the way a person would: the button it offers.
    const newChat = projectWindow.getByRole("button", { name: "New Chat" }).first();
    await newChat.waitFor({ state: "visible", timeout: 15000 });
    await newChat.click();
    await expect
      .poll(() => projectCells.count(), { timeout: 15000, message: "the project opens with one cell" })
      .toBe(1);

    // The gesture, from the menu that tab offers. The companion chat is created
    // on the server, so the second cell appears a few frames after the click --
    // that wait is the deferred split of DNDSPLIT-03, not slowness.
    await projectTabs.first().click({ button: "right" });
    await page.getByText("Dividi a destra", { exact: true }).click();
    await expect
      .poll(() => projectCells.count(), { timeout: 15000, message: "the split must add a cell inside the project" })
      .toBe(2);

    // What the old draft companion put on screen. A cell that says this holds
    // nothing at all, and it is how the defect announced itself.
    expect(
      await projectWindow.getByText("Topic not found").count(),
      "the companion cell holds a chat, not an error card",
    ).toBe(0);

    // THE POINT OF THE ROW: come back to it. Two real chats persist through
    // their own channel, so the layout has something to hold on to.
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect
      .poll(() => projectCells.count(), { timeout: 15000, message: "the split must survive the reload" })
      .toBe(2);
  });
});
