/**
 * THE THREE RUNGS OF THE TAB BAR ARE A NUMBER, NOT AN OPINION.
 *
 * THE BUG THIS EXISTS FOR. The four tab fills were one colour at four alphas
 * (93 / 97 / 82 / 99 percent of `--tab-ink`), and `--tab-ink` is the surface the
 * bar floats over. Every alpha therefore composited back to almost exactly the
 * ground: measured on the running app, the selected tab stood off a resting one
 * by 1.0014:1 in light and 1.0077:1 in dark, against the 1.1:1 threshold of
 * perceptibility this project defends with numbers everywhere else. Reported as
 * "you can never tell which tab is selected, or whether the project is".
 *
 * WHY NO EXISTING GATE SAW IT. `chrome-bar-worst-case-contrast.spec.ts` measures
 * the LABEL against what scrolls under it, which was fine and stayed fine. The
 * requirement about surfaces, CHROME-05, asks for "fondi DIVERSI" - and 93 vs 99
 * percent alpha ARE different fills, on paper. Different is not distinguishable;
 * only a ratio says which.
 *
 * WHY THE DECLARED FILL AND NOT A SCREENSHOT. `helpers/chrome-contrast.ts`
 * screenshots because it asks about ink over a moving backdrop, where no
 * declared colour is the truth. The question here is the opposite one: whether
 * the SCALE between the three states is a scale at all. Two tabs sitting side by
 * side share the same page ground, so compositing each fill down to the first
 * opaque ancestor compares exactly what the CSS controls and nothing else. A
 * pixel capture would add the transcript underneath as noise on both terms and
 * make the verdict depend on where the chat happened to be scrolled.
 *
 * @covers CHROME-13
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { contrastRatio, effectiveBgOf } from "./helpers/contrast";
import { setTheme } from "./helpers/chrome-contrast";
import { splitViaContextMenu } from "./helpers/layout";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { mkdirSync, writeFileSync } from "fs";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** The threshold this project already uses for "the eye can see the step". */
const PERCEPTIBLE = 1.1;
/** Selection is not a step, it is THE step: it has to be read across the bar. */
const SELECTED_VS_RESTING = 1.25;

type Rgb = [number, number, number];

const tabSelector = (paneId: string) => `[role="tab"][data-pane-id="${paneId}"]`;

/** The fill of one tab, composited down to the first opaque ancestor. */
async function fillOf(page: Page, paneId: string): Promise<Rgb> {
  return effectiveBgOf(page, tabSelector(paneId));
}

/**
 * WAIT FOR THE FILLS TO STOP MOVING, and it is not a courtesy wait.
 *
 * A tab carries `transition-all`, so the surface CROSSFADES from one rung to
 * the next. Measuring right after the click reads a frame halfway down the
 * ramp: caught in the act, with the resting tab reported at 223,223,224, a
 * value that belongs to no state and sits between two of them. The failure is
 * intermittent by construction, which is the worst kind of gate.
 *
 * Two consecutive animation frames with identical fills is the end of the ramp,
 * and it is asked of the browser instead of guessed with a duration.
 */
async function fillsSettled(page: Page, paneIds: string[]): Promise<void> {
  await page.waitForFunction(
    (ids: string[]) => {
      const now = ids
        .map((id) => {
          const el = document.querySelector(`[role="tab"][data-pane-id="${id}"]`);
          return el ? getComputedStyle(el).backgroundColor : "assente";
        })
        .join("|");
      const w = window as unknown as { __tabFills?: string };
      const stable = w.__tabFills === now;
      w.__tabFills = now;
      return stable;
    },
    paneIds,
    { timeout: 10000 },
  );
}

let topics: { id: string; name: string }[] = [];

/** A real folder on disk: a project pane whose path does not exist dies before
 *  it can be looked at (see the note in `project-tabs.spec.ts`). */
const PROJECT_PATH = canonicalTmpDir("e2e-focus-hierarchy");
const PROJECT_PANE = `project:${encodeURIComponent(PROJECT_PATH)}`;

test.beforeAll(async ({ request }) => {
  const stamp = Date.now();
  topics = [];
  for (const suffix of ["a", "b", "c"]) {
    topics.push(await createTopic(request, `focus-hierarchy-${suffix}-${stamp}`));
  }
  mkdirSync(PROJECT_PATH, { recursive: true });
  writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-focus-hierarchy" }));
});

test.afterAll(async ({ request }) => {
  for (const t of topics) {
    if (t?.id) await deleteTopic(request, t.id).catch(() => {});
  }
  removeTmpDir(PROJECT_PATH);
});

test.beforeEach(async ({ request }) => {
  await resetPaneStore(request, topics.map((t) => t.id));
});

for (const dark of [false, true]) {
  const theme = dark ? "dark" : "light";

  test(`la scheda selezionata si stacca da una a riposo, in tema ${theme}`, async ({ page }) => {
    await goToApp(page);
    const first = page.locator(tabSelector(topics[0].id));
    const second = page.locator(tabSelector(topics[1].id));
    await expect(first).toBeVisible({ timeout: 20000 });
    await expect(second).toBeVisible({ timeout: 20000 });

    await setTheme(page, dark);
    await first.click();
    await expect(first).toHaveAttribute("data-active", "true", { timeout: 10000 });
    await expect(second).toHaveAttribute("data-active", "false");
    await fillsSettled(page, [topics[0].id, topics[1].id]);

    const selected = await fillOf(page, topics[0].id);
    const resting = await fillOf(page, topics[1].id);
    const ratio = contrastRatio(selected, resting);

    expect(
      ratio,
      `selezionata ${selected.map(Math.round)} contro riposo ${resting.map(Math.round)} in tema ${theme}`,
    ).toBeGreaterThanOrEqual(SELECTED_VS_RESTING);
  });
}

test("CHROME-13: l'attiva di una cella senza fuoco sta FRA le altre due", async ({ page }) => {
  await goToApp(page);
  const [uno, due, tre] = topics;
  await expect(page.locator(tabSelector(uno.id))).toBeVisible({ timeout: 20000 });
  await expect(page.locator(tabSelector(tre.id))).toBeVisible({ timeout: 20000 });

  // The second tab moves into a cell of its own: two tabs are left in the first
  // cell (one selected, one resting) and one in the second, which is active in
  // its group and does not hold focus. All three rungs in one shot.
  await splitViaContextMenu(page, "Dividi a destra", 1);

  // CLICK THE RESTING TAB, not the one already active in its cell.
  //
  // The click moves focus between cells, but `data-active` only carries "it is
  // the active one of its group": on an already-active tab that attribute is
  // true BEFORE the click, so awaiting it awaits nothing and the measurement
  // starts while focus is still in the other cell. Measured: the first draft of
  // this spec passed on the retry and not on the first run. Clicking an
  // inactive tab turns the attribute into a real barrier.
  const selectedTab = page.locator(tabSelector(tre.id));
  await expect(selectedTab).toHaveAttribute("data-active", "false");
  await selectedTab.click();
  await expect(selectedTab).toHaveAttribute("data-active", "true", { timeout: 10000 });

  const activeUnfocused = page.locator(tabSelector(due.id));
  await expect(activeUnfocused).toHaveAttribute("data-active", "true", { timeout: 10000 });
  await fillsSettled(page, [uno.id, due.id, tre.id]);

  const selectedFill = await fillOf(page, tre.id);
  const softFill = await fillOf(page, due.id);
  const restingFill = await fillOf(page, uno.id);

  // Every rung is visible, and the order is the order of focus: an inverted
  // scale keeps both ratios high while saying the opposite thing.
  expect(contrastRatio(selectedFill, softFill), `selezionata ${selectedFill.map(Math.round)} contro attiva-senza-fuoco ${softFill.map(Math.round)}`)
    .toBeGreaterThanOrEqual(PERCEPTIBLE);
  expect(contrastRatio(softFill, restingFill), `attiva-senza-fuoco ${softFill.map(Math.round)} contro riposo ${restingFill.map(Math.round)}`)
    .toBeGreaterThanOrEqual(PERCEPTIBLE);

  const ground = await effectiveBgOf(page, '[role="main"]');
  const offGround = (c: Rgb) => contrastRatio(c, ground);
  expect(offGround(selectedFill)).toBeGreaterThan(offGround(softFill));
  expect(offGround(softFill)).toBeGreaterThan(offGround(restingFill));
});

test("si legge se il progetto e' la scheda selezionata", async ({ request, page }) => {
  // A project tab goes through the same branch as a chat tab, and "the same
  // branch" is exactly the sentence that let the defect through: until someone
  // measures it, it stays a deduction. The tab measured here is the project
  // one, which is the surface that answers "is the project the selected one?".
  await resetPaneStore(request, [topics[0].id, PROJECT_PANE]);
  await goToApp(page);

  const projectTab = page.locator(tabSelector(PROJECT_PANE));
  const chatTab = page.locator(tabSelector(topics[0].id));
  await expect(projectTab).toBeVisible({ timeout: 20000 });
  await expect(chatTab).toBeVisible({ timeout: 20000 });

  await projectTab.click();
  await expect(projectTab).toHaveAttribute("data-active", "true", { timeout: 10000 });
  await expect(chatTab).toHaveAttribute("data-active", "false");
  await fillsSettled(page, [PROJECT_PANE, topics[0].id]);

  const projectFill = await fillOf(page, PROJECT_PANE);
  const chatFill = await fillOf(page, topics[0].id);
  expect(
    contrastRatio(projectFill, chatFill),
    `progetto ${projectFill.map(Math.round)} contro chat a riposo ${chatFill.map(Math.round)}`,
  ).toBeGreaterThanOrEqual(SELECTED_VS_RESTING);
});
