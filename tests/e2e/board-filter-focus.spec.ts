/**
 * board-filter-focus.spec.ts — the focus ring of a filter control stays INSIDE it.
 *
 * @covers KANBAN-68, KANBAN-69
 *
 * THE DEFECT, reported on 29/08: focusing the priority field draws a border
 * that sprouts off the control. The app has exactly one focus rule
 * (`index.css`, `@layer base`): `outline: 2px solid var(--primary)` with
 * `outline-offset: 2px` on every button and input. The input itself is exempt
 * (`filterInputClass` carries `outline-none`, which sits in `@layer utilities`
 * and beats `base`), so what collects it is the 12px remove button inside a
 * token pill - and an offset ring around a 12px button inside a 24px shell is
 * painted outside the rounded rectangle.
 *
 * WHY THIS MEASURES TWO THINGS. Removing an outline is easy and a test that
 * only checked its absence would pass on a control with NO focus affordance at
 * all - which is worse than the border. So the ring must also be PAINTED, and
 * be `inset`, which is what forbids it from sticking out.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-filter-focus-${Date.now()}`;
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0 && (await projectsSection.getAttribute("aria-expanded")) === "false") {
    await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-filter-focus/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  const count = await triggers.count();
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      await item.click();
      await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
      return;
    }
    await page.keyboard.press("Escape");
  }
  throw new Error("no + menu with a Board (kanban) entry found");
}

test.describe("il fuoco su un filtro della board", () => {
  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-filter-focus" }, null, 2));
    const topic = await createTopic(request, "E2E-FilterFocus", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: "un task da filtrare", status: "todo" },
    });
    expect(res.ok()).toBe(true);
    createdTasks.push(((await res.json()) as { id: string }).id);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdTasks) {
      await request.delete(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`).catch(() => {});
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("KANBAN-68: l'anello resta dentro il campo, e c'e'", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-68" });
    await page.goto("/");
    await openProjectBoard(page);

    const input = page.getByTestId("filter-token-input");
    await expect(input).toBeVisible({ timeout: 15000 });

    // A TOKEN FIRST: the remove button is the element that draws the escaping
    // ring, and without a token it does not exist.
    await input.click();
    const option = page.getByRole("option").first();
    await expect(option).toBeVisible({ timeout: 10000 });
    await option.click();
    await page.keyboard.press("Escape");

    const shell = page.getByTestId("filter-token-field");
    await expect(shell.locator("button[aria-label]")).toHaveCount(1);

    // (a) With the field focused, NO descendant may paint the global outline.
    await input.focus();
    const focused = await shell.evaluate((el) => {
      const s = getComputedStyle(el);
      const withOutline = Array.from(el.querySelectorAll("*")).filter((c) => {
        const cs = getComputedStyle(c);
        return cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
      }).length;
      return { boxShadow: s.boxShadow, outlineStyle: s.outlineStyle, withOutline };
    });
    expect(focused.withOutline, "un discendente del campo raccoglie ancora l'outline globale").toBe(0);
    expect(focused.outlineStyle, "il guscio stesso non deve disegnare un outline").toBe("none");

    // (b) And the ring IS painted, and is `inset` — the half that stops this
    // from passing on a control with no focus affordance at all.
    expect(focused.boxShadow, "nessun anello: il campo a fuoco sarebbe muto").not.toBe("none");
    expect(focused.boxShadow, `l'anello deve essere inset (${focused.boxShadow})`).toContain("inset");

    // (c) The affordance is still REACHABLE: the remove button takes focus,
    // carries its own inset ring and no outline. A fix by subtraction
    // (tabIndex=-1 on everything) would pass (a) and (b) and fail here.
    const x = shell.locator("button[aria-label]").first();
    await x.focus();
    const suX = await x.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { outlineStyle: cs.outlineStyle, boxShadow: cs.boxShadow };
    });
    expect(suX.outlineStyle, "la X del token disegna ancora l'outline globale").toBe("none");
    expect(suX.boxShadow, "la X a fuoco deve avere il suo anello").toContain("inset");
  });

  test("KANBAN-69: il catalogo si apre al volo, e non contraddice mai la board", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-69" });
    await page.goto("/");
    await openProjectBoard(page);

    const input = page.getByTestId("filter-token-input");
    await expect(input).toBeVisible({ timeout: 15000 });

    // (a) AT REST the catalogue is already there: clicking with nothing typed
    // shows WHAT can be filtered, grouped. This is the half a search box never
    // had - you cannot type towards something you do not know exists.
    await input.click();
    await expect(page.getByRole("option").first()).toBeVisible({ timeout: 10000 });
    const groups = await page.locator('[id^="bff-cap-"]').count();
    expect(groups, "il catalogo deve aprirsi raggruppato").toBeGreaterThanOrEqual(3);

    // (b) A CAP THAT DECLARES ITSELF. Truncating in silence reads as "there is
    // nothing else"; the caption carries what is left behind.
    const withRest = await page.locator('[id^="bff-cap-"]').filter({ hasText: /\+\d/ }).count();
    expect(withRest, "nessun gruppo dichiara quanto resta").toBeGreaterThan(0);

    // (c) THE INVARIANT THE WHOLE DESIGN RESTS ON: a query that matches no
    // catalogue entry must NOT mount the panel — while the board stays narrowed
    // on that same text. A panel saying "nothing found" over a board that DID
    // answer is a lie the user reads before they read the board.
    await input.fill("zzzqqqx");
    await expect(page.getByRole("option")).toHaveCount(0, { timeout: 10000 });
    await expect(input, "il testo deve restare a filtrare la board").toHaveValue("zzzqqqx");

    // (d) And a query that DOES match lifts the cap and offers the row.
    await input.fill("visib");
    await expect(page.getByRole("option", { name: "visibile", exact: true })).toBeVisible({ timeout: 10000 });
  });
});
