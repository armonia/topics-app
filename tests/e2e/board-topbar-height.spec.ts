/**
 * board-topbar-height.spec.ts - every control in the kanban top bar is the SAME height.
 *
 * @covers KANBAN-12
 *
 * THE DEFECT. Half the row already stood at 24px, because `filterFieldClass`
 * spells the height for the filter shells and three chips had copied the same
 * literal by hand. The other half stated no height at all and let padding
 * decide: the project/all toggle and the missions button came out at 20px
 * (`py-0.5` around a 16px line box), the archive and settings glyphs at 22px
 * (`p-1` around a 14px icon). Three heights, all vertically centred on the same
 * line, which is why the fault reads as "the row looks ragged" instead of as a
 * control being wrong. Nothing overlaps and nothing overflows, so
 * `board-topbar-legibility.spec.ts` - which measures the ROW - stayed green
 * through all of it: it asks whether the bar is one line and 36px tall, never
 * whether the things inside it agree with each other.
 *
 * WHAT IS MEASURED. Not a class name: the rendered bounding box of every
 * control, at 1440 and at 390 (the two widths the bar is designed for), read
 * from the DOM. A test that asserted `h-6` in the source would go green on a
 * control that wears the token and is stretched by its own padding.
 *
 * WHICH ELEMENTS COUNT AS CONTROLS. The rule is the one the eye uses: a control
 * is the OUTERMOST element in the bar that draws a rounded box and can be
 * pointed at. So the token field is one control, not the input plus the pills
 * inside it; the group wrappers (which draw nothing) are descended through; the
 * decorative backdrop behind the project strip and the mobile overflow fade are
 * skipped, both being `pointer-events: none`. This is deliberately not a list
 * of testids: a list would go green the day someone adds a fourth height next
 * to the three that are fixed here.
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { hermetic } from "./fixtures/hermetic";
import { projectRow } from "./helpers/project-row";
import { apiCreateTask, stubProbes } from "./helpers/board-topbar";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

/** The height the whole row wears: `TOOLBAR_CONTROL_H` = `h-6` = 24px, which is
 *  also the minimum target size WCAG 2.2 AA asks for. */
const CONTROL_H = 24;
/** Sub-pixel layout (zoom, fractional scaling) may land a box on 23.5px. */
const TOLERANCE = 1;

const STAMP = Date.now();
const SHOTS = join(process.cwd(), "test-results", "topbar-height");
const ROOT = `/tmp/e2e-topbar-height-${STAMP}`;
const PROJECTS = ["uno", "due"] as const;
const dirOf = (name: string) => `${ROOT}/${name}`;

const topicIds: string[] = [];
const createdTasks: string[] = [];

interface ControlBox { label: string; height: number; top: number }

/**
 * The controls of the bar, as boxes.
 *
 * Walks down from the toolbar and stops at the first element that DRAWS a
 * control (a rounded box that is not decoration), so a shell is measured once
 * instead of once per widget nested inside it.
 */
async function toolbarControls(page: Page): Promise<ControlBox[]> {
  return page.getByTestId("board-toolbar").evaluate((bar) => {
    const out: { label: string; height: number; top: number }[] = [];
    const walk = (el: Element) => {
      for (const child of Array.from(el.children)) {
        const cs = getComputedStyle(child);
        const rect = child.getBoundingClientRect();
        // Laid out but hidden (the project chips past the cut), collapsed, or
        // pure decoration: none of them is a control on the row.
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        if (rect.width < 1 || rect.height < 1) continue;
        if (cs.pointerEvents === "none") continue;
        const radius = parseFloat(cs.borderTopLeftRadius) || 0;
        if (radius > 0) {
          const label =
            child.getAttribute("data-testid") ||
            child.getAttribute("aria-label") ||
            (child.textContent || "").trim().slice(0, 24) ||
            child.tagName.toLowerCase();
          out.push({ label, height: Math.round(rect.height * 100) / 100, top: Math.round(rect.top * 100) / 100 });
          continue;
        }
        walk(child);
      }
    };
    walk(bar);
    return out;
  });
}

/** The bar has stopped redistributing when two consecutive reads agree on how
 *  many controls it draws (a ResizeObserver decides the project chips). */
async function controlsSettled(page: Page): Promise<ControlBox[]> {
  let previous = -1;
  let settled: ControlBox[] = [];
  await expect
    .poll(
      async () => {
        const now = await toolbarControls(page);
        const quiet = now.length === previous && now.length > 0;
        previous = now.length;
        if (quiet) settled = now;
        return quiet;
      },
      { timeout: 8000, message: "la barra non ha mai smesso di ridistribuirsi" },
    )
    .toBe(true);
  return settled;
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0 && (await projectsSection.getAttribute("aria-expanded")) === "false") {
    await projectsSection.click();
  }
  const btn = projectRow(page, PROJECTS[0]);
  await expect(btn).toBeVisible({ timeout: 15000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 15000 });

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  const count = await triggers.count();
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) { opened = true; break; }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
  // The project board is the CROWDED bar: it is the only one that carries the
  // project/all toggle and the archive switch, i.e. three of the controls that
  // were off by two or four pixels.
  await expect(page.getByTestId("board-archived-toggle")).toBeVisible({ timeout: 10000 });
}

/**
 * One reading of the bar: settle it, photograph it, and hold it to the single
 * height. Called once per width and once per mode, because no single state of
 * the bar carries every control - the archive switch only exists on a project
 * board, the project chips only in "all projects" mode.
 */
async function assertOneHeight(page: Page, etichetta: string, minControls: number): Promise<ControlBox[]> {
  const controls = await controlsSettled(page);
  await page.getByTestId("board-toolbar").screenshot({ path: join(SHOTS, `topbar-${etichetta}.png`) });

  // A vacuous green is the real risk here: with two controls on the row, "they
  // all agree" says nothing.
  expect(controls.length, `${etichetta}: la barra deve avere i suoi controlli - ${JSON.stringify(controls)}`).toBeGreaterThanOrEqual(minControls);

  const wrong = controls.filter((c) => Math.abs(c.height - CONTROL_H) > TOLERANCE);
  expect(
    wrong,
    `${etichetta}: ogni controllo della barra deve essere alto ${CONTROL_H}px - fuori misura: ${JSON.stringify(wrong)}`,
  ).toEqual([]);

  // Same height is not the same line: a control could be the right size and
  // still sit two pixels lower. The bar centres them, so the tops coincide.
  const tops = controls.map((c) => c.top);
  expect(
    Math.max(...tops) - Math.min(...tops),
    `${etichetta}: i controlli devono stare sulla stessa linea - ${JSON.stringify(controls)}`,
  ).toBeLessThanOrEqual(TOLERANCE);
  return controls;
}

test.describe("Top bar della kanban — una sola altezza", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(SHOTS, { recursive: true });
    for (const name of PROJECTS) {
      mkdirSync(dirOf(name), { recursive: true });
      writeFileSync(`${dirOf(name)}/package.json`, JSON.stringify({ name }, null, 2));
      const topic = await createTopic(request, `topbar-h-${name}-${STAMP}`, { projectPath: dirOf(name) });
      topicIds.push(topic.id);
      createdTasks.push(await apiCreateTask(request, boardIdForPath(dirOf(name)), `Lavoro ${name} ${STAMP}`, "todo"));
    }
  });

  test.afterAll(async ({ request }) => {
    for (const key of createdTasks) {
      const [projectId, id] = key.split(":");
      await deleteTask(request, projectId!, id!).catch(() => {});
    }
    for (const id of topicIds) await deleteTopic(request, id).catch(() => {});
    rmSync(ROOT, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, dirOf(PROJECTS[0]));
    await seedProjectPane(page.request, dirOf(PROJECTS[0]));
    await page.addInitScript(() => {
      try { localStorage.removeItem("board:filters-all"); } catch { /* private mode */ }
    });
  });

  test("KANBAN-12: i controlli della barra hanno tutti la stessa altezza, a 1440 e a 390", async ({ page }) => {
    // The load chip and the work-folder badge only exist when the machine has
    // something to say, and they are two of the controls being measured: the
    // stubs put them on the row on purpose (making them tell the truth would
    // mean loading the machine, i.e. measuring the environment).
    await stubProbes(page, { running: 4 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const misure: Record<string, ControlBox[]> = {};
    for (const [etichetta, width] of [["larga", 1440], ["stretta", 390]] as const) {
      await page.setViewportSize({ width, height: 900 });
      misure[etichetta] = await assertOneHeight(page, etichetta, 6);
    }

    // AND THE OTHER HALF OF THE BAR. "All projects" mode swaps the archive
    // switch for the project chip and its inline strip: controls that live on
    // the same row and are measured by nobody in project mode.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Tutti i progetti" }).click();
    await expect(page.getByTestId("filter-project-chip")).toBeVisible({ timeout: 10000 });
    misure["tutti-i-progetti"] = await assertOneHeight(page, "tutti-i-progetti", 6);

    test.info().attach("altezze-controlli", {
      contentType: "application/json",
      body: JSON.stringify(misure, null, 2),
    });
  });
});
