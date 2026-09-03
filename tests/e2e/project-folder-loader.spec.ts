/**
 * A FOLDER SPEAKS FOR ITS CHILDREN ONLY WHILE IT IS SHUT.
 *
 * A project row rolls up "something in here is working" into one loader plus one
 * clock. That roll-up is the ONLY way to know while the accordion is closed, and
 * it is a DUPLICATE the moment the accordion opens: every child that is working
 * draws its own loader one row below, so the parent would say the same thing a
 * second time, one indent up, and the two are indistinguishable at a glance.
 *
 * The same rule is on the project TAB, where "shut" means the project window is
 * not the selected pane, so its inner tab bar is not on screen either.
 *
 * What this file proves, on the rendered DOM and on video:
 *   1. closed folder + a working child  -> the project ROW carries the loader
 *      and the live clock, and no child row is on screen to repeat them;
 *   2. open folder                      -> the project row loses BOTH, and the
 *      child row carries its own loader;
 *   3. closing it again brings them back, so what drives the gate is the
 *      accordion state and not the passing of time;
 *   4. the project TAB does the same against selection;
 *   5. the glyph is the ORBIT (a ring with a travelling sweep), and the live
 *      number wears the live voice (`.time-live`, `data-time-voice="live"`) that
 *      tells it apart from the grey receipt next to it.
 *
 * HOW THE WORK IS FAKED, and why this way. Two server snapshots are mocked and
 * nothing else:
 *   - `GET /api/topics/streaming` is the authoritative registry the client polls
 *     (useSignalsSync -> hydratedStreamTopics). Saying the child topic streams
 *     there is what lights `useProjectLoading` for its folder AND
 *     `useTopicLoading` for the child row, through the real code path, with no
 *     15 s cliff: a WS `stream:start` alone would be reconciled away as an
 *     orphan after two polls that the server does not confirm.
 *   - `GET /api/claude-sessions` is where the phase and `turnStartedAt` come
 *     from (useClaudeSessionState -> deriveSessionActivity -> useProjectWorkStart).
 *     A turn started five minutes ago is what makes the aggregate clock pass its
 *     one-minute threshold, which is the only way to see it at all.
 *
 * @covers LAYOUT-33
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { projectPanesKey } from "../../shared/project-keys";
import { goToApp } from "./helpers";
import {
  createTopic,
  deleteTopic,
  resetPaneStore,
  seedProjectInnerChats,
} from "./helpers/api-fixtures";
import { projectRow } from "./helpers/project-row";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { beat, didascalia } from "./helpers/evidence";

hermetic(test);

// The evidence IS the point of this file: the gate is a thing you watch appear
// and disappear, so every test records.
test.use({ video: "on" });

const TS = Date.now();
/** The folder under test. A fresh path per run: the inner layout of a project is
 *  persisted server-side and re-read on open, so reusing a path would let a
 *  retry start from the first attempt's tabs. */
const SEED_PATH = `/tmp/e2e-folder-loader-${TS}`;
const PROJECT_NAME = SEED_PATH.slice("/tmp/".length);
const CHILD_NAME = `e2e-folder-child-${TS}`;
const OTHER_NAME = `e2e-folder-outsider-${TS}`;

/**
 * The path the SERVER stored, which on macOS is not the one we asked for:
 * `/tmp` is a symlink to `/private/tmp` and the topic comes back resolved. Every
 * key that hangs off the project path is derived from THIS one, not from
 * `SEED_PATH`: the pane id the tab bar renders, the localStorage blob the
 * sidebar reads, and the `topic.projectPath === projectPath` comparison inside
 * useProjectLoading. Seeded from `SEED_PATH`, the localStorage hash pointed at a
 * project that does not exist and the folder came up childless.
 */
let projectPath = "";
let projectPaneId = "";

/** How long the fake turn has been running. Above WORK_ELAPSED_AFTER_MS (60 s),
 *  which is the threshold below which a folder shows no digit at all. */
const TURN_AGE_MS = 5 * 60_000;

let childId = "";
let childSessionKey = "";
/** A chat with NO project: the second top-level tab the project-tab test needs
 *  to select in order to deselect the project one. */
let outsiderId = "";

test.beforeAll(async ({ request }) => {
  mkdirSync(SEED_PATH, { recursive: true });
  const topic = await createTopic(request, CHILD_NAME, { projectPath: SEED_PATH });
  childId = topic.id;
  outsiderId = (await createTopic(request, OTHER_NAME)).id;

  // The sessionKey and the stored projectPath are both the SERVER's answer.
  // Reading them instead of rebuilding them means a change of convention breaks
  // this file loudly, instead of leaving it green while it feeds snapshots and
  // keys nobody matches.
  const res = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  const body = (await res.json()) as {
    topics: Record<string, { sessionKey?: string; projectPath?: string }>;
  };
  childSessionKey = body.topics?.[childId]?.sessionKey ?? "";
  projectPath = body.topics?.[childId]?.projectPath ?? "";
  if (!childSessionKey) throw new Error("the seeded topic has no sessionKey");
  if (!projectPath) throw new Error("the seeded topic kept no projectPath");
  projectPaneId = `project:${encodeURIComponent(projectPath)}`;

  // A project lists a child chat only when that chat has a tab open INSIDE the
  // project window (buildSidebarItems). Seed that inner layout server-side.
  await seedProjectInnerChats(request, projectPath, [childId]);
});

test.afterAll(async ({ request }) => {
  for (const id of [childId, outsiderId]) if (id) await deleteTopic(request, id).catch(() => {});
  rmSync(SEED_PATH, { recursive: true, force: true });
});

/**
 * Arm the two snapshots that make the child topic look busy, and pre-load the
 * project's inner-tab list into localStorage.
 *
 * The localStorage seed is not a shortcut around the product: it is the SAME
 * blob the app writes there itself (`topics-project-panes-<hash>`), and the
 * sidebar reads it directly (readProjectPaneEntries). The server copy is
 * hydrated into it only by a MOUNTED project window, which the sidebar tests
 * deliberately do not have: without this the folder would be childless and the
 * open-accordion half of the contract would have nothing to show.
 *
 * Must run before `goToApp`, or the first fetch of each snapshot escapes.
 */
async function armBusyChild(page: Page): Promise<void> {
  await page.route("**/api/topics/streaming", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [{ topicId: childId, sessionKey: childSessionKey, state: "streaming" }],
      }),
    }),
  );
  await page.route("**/api/claude-sessions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            sessionKey: childSessionKey,
            claudeSessionId: `e2e-folder-loader-${TS}`,
            phase: "running",
            // Fresh phase, old turn: a session that changed phase a moment ago
            // and has been on the same turn for five minutes. Keeping the phase
            // fresh also keeps the client's re-verify fetch out of the way.
            phaseUpdatedAt: Date.now(),
            turnStartedAt: Date.now() - TURN_AGE_MS,
            jsonlOffset: 0,
            rev: 1,
            createdAt: Date.now() - TURN_AGE_MS,
            updatedAt: Date.now(),
          },
        ],
      }),
    }),
  );
  await page.addInitScript(
    ([key, topicId]) => {
      localStorage.setItem(
        key as string,
        JSON.stringify({ nonChatPanes: [], openChatTopicIds: [topicId as string] }),
      );
    },
    [projectPanesKey(projectPath), childId],
  );
}

/** The project HEADER row: the element that owns the chevron, the name, the
 *  roll-up loader and the roll-up clock. The accordion children are siblings of
 *  it, so nothing below can leak into these locators. */
function projectHeader(page: Page) {
  return projectRow(page, PROJECT_NAME).locator("xpath=..");
}

test.describe("Project folder loader", () => {
  test("the roll-up lives on the CLOSED folder, and the open one leaves it to the child", async ({
    page,
    request,
  }) => {
    // NO top-level pane at all. Seeding the child's own id would not leave it
    // there: usePanelLifecycle purges a project-linked topic from openPanels and
    // opens the project WINDOW around it instead, and a project whose pane is
    // open auto-expands its accordion. That would hand the test the state it is
    // supposed to reach by clicking, and would also raise the "pinned active
    // child while collapsed" tile, which is a different rule. The folder still
    // has a row because its child has a tab open INSIDE it, which is what
    // `armBusyChild` seeds into the project's own pane list.
    await resetPaneStore(request, []);
    await armBusyChild(page);
    await goToApp(page);

    const header = projectHeader(page);
    await expect(header).toBeVisible({ timeout: 15_000 });
    const rollupLoader = header.locator("[data-loader-state]");
    const rollupClock = header.getByTestId("project-elapsed");
    const childRow = page.getByRole("treeitem", { name: CHILD_NAME });

    // 1. SHUT: the folder speaks. The glyph says "working" (not the frozen
    //    amber "your move" ring), and the clock says how long the oldest turn
    //    in there has been going.
    await expect(header.getByRole("button", { name: `Expand ${PROJECT_NAME}` })).toBeVisible();
    await didascalia(page, "Cartella CHIUSA: l'anello e il tempo vivo stanno sul progetto");
    await expect(rollupLoader).toBeVisible({ timeout: 15_000 });
    await expect(rollupLoader).toHaveAttribute("data-loader-state", "working");
    await beat(page);
    await expect(rollupClock).toBeVisible({ timeout: 15_000 });
    // A whole number of minutes, and at least the five the fake turn has been
    // running. Not the literal "5m": the clock keeps ticking while the test
    // runs, and pinning the digit would make a slow machine look like a bug.
    // What matters is that it CLEARED the one-minute threshold below which a
    // folder shows no digit at all.
    await expect(rollupClock).toHaveText(/^\d+m$/);
    const minutes = Number(((await rollupClock.textContent()) ?? "").replace("m", ""));
    expect(minutes).toBeGreaterThanOrEqual(TURN_AGE_MS / 60_000);
    // Nothing is repeating it one row below: the child is not on screen at all.
    await expect(childRow).toHaveCount(0);

    // The glyph is the ORBIT, not the old three-bar equaliser: inside the slot
    // there is ONE square element made of two round layers, the still track and
    // the sweep turning over it. An equaliser would be N oblong bars, and a
    // progress arc would be one layer, so the shape alone tells them apart.
    const orbit = await rollupLoader.evaluate((el) => {
      const glyph = el.firstElementChild as HTMLElement | null;
      if (!glyph) return null;
      const box = glyph.getBoundingClientRect();
      return {
        square: Math.round(box.width) === Math.round(box.height),
        layers: [...glyph.children].map((layer) => ({
          radius: getComputedStyle(layer).borderRadius,
          spinning: layer.classList.contains("animate-orbit-spin"),
        })),
      };
    });
    expect(orbit, "the loader slot holds a glyph").not.toBeNull();
    expect(orbit!.square, "a ring is square, a bar is not").toBe(true);
    expect(orbit!.layers.length, "track + sweep").toBe(2);
    expect(orbit!.layers.every((l) => l.radius === "50%")).toBe(true);
    expect(orbit!.layers.filter((l) => l.spinning).length, "only the sweep turns").toBe(1);

    // The live number wears the live voice, so it cannot be read as the grey
    // "agg. X fa" receipt sitting on the same row.
    await expect(rollupClock).toHaveAttribute("data-time-voice", "live");
    await expect(rollupClock).toHaveClass(/time-live/);

    // 2. OPEN: the folder goes quiet and the child speaks for itself.
    await didascalia(page, "Si apre: il padre tace, parla il figlio (niente doppione)");
    await header.getByRole("button", { name: `Expand ${PROJECT_NAME}` }).click();
    await expect(header.getByRole("button", { name: `Collapse ${PROJECT_NAME}` })).toBeVisible();
    await expect(childRow).toBeVisible({ timeout: 15_000 });
    await expect(rollupLoader, "the parent must not repeat the child").toHaveCount(0);
    await expect(rollupClock, "nor repeat its clock").toHaveCount(0);
    await expect(childRow.locator("[data-loader-state]")).toBeVisible({ timeout: 15_000 });
    await beat(page);

    // 3. SHUT AGAIN: both come back. What drives the gate is the accordion, not
    //    the turn ending or the passing of time.
    await didascalia(page, "Si richiude: il riepilogo torna");
    await header.getByRole("button", { name: `Collapse ${PROJECT_NAME}` }).click();
    await expect(rollupLoader).toBeVisible({ timeout: 15_000 });
    await expect(rollupClock).toBeVisible();
    await expect(childRow).toHaveCount(0);
    await beat(page);
  });

  test("the project TAB carries the roll-up only while it is NOT the selected pane", async ({
    page,
    request,
  }) => {
    // Two top-level panes: the project window, and a chat that belongs to no
    // project (a project-linked one would be pulled inside the project window
    // rather than staying a sibling tab). Selecting one deselects the other,
    // which is the whole experiment.
    await resetPaneStore(request, [projectPaneId, outsiderId]);
    await armBusyChild(page);
    await goToApp(page);

    const projectTab = page.locator(`[data-pane-id="${projectPaneId}"]`);
    const otherTab = page.locator(`[data-pane-id="${outsiderId}"]`);
    await expect(projectTab).toBeVisible({ timeout: 15_000 });
    await expect(otherTab).toBeVisible({ timeout: 15_000 });

    // SELECTED: the project window is on screen, its own tab bar shows a loader
    // per working child, so the parent aggregate would be a second voice.
    await projectTab.click();
    await expect(projectTab).toHaveAttribute("data-active", "true");
    await expect(projectTab.locator("[data-loader-state]")).toHaveCount(0);

    // NOT SELECTED: the children are behind it and the aggregate is the only
    // thing that can speak for them.
    await otherTab.click();
    await expect(projectTab).toHaveAttribute("data-active", "false");
    await expect(projectTab.locator("[data-loader-state]")).toBeVisible({ timeout: 15_000 });
    await expect(projectTab.locator("[data-loader-state]")).toHaveAttribute(
      "data-loader-state",
      "working",
    );
  });
});
