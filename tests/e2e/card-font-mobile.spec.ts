/**
 * card-font-mobile.spec.ts — Acceptance for the Kanban-card mobile legibility fix.
 *
 * Finding (audit mobile Kanban, 2026-07-20): secondary card text bottomed out at
 * 10px (id chip, priority label, timestamp) — below the ~12px mobile legibility
 * floor. This spec is the acceptance criterion itself, not an eyeball check: it
 * opens a real card, shrinks to a 390px phone viewport, and MEASURES the
 * computed font-size of every text node inside the card. Nothing may be < 12px.
 *
 * Desktop is asserted unchanged: at ≥ md the same card keeps its 10/11px chips.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-cardfont-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function apiCreateTask(
  request: import("@playwright/test").APIRequestContext,
  body: { text: string; status?: string; priority?: number; description?: string },
): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  return task;
}

async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-cardfont/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
}

async function openProjectBoard(page: Page) {
  await openTestProject(page);
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    const clicked = await t.click({ timeout: 3000 }).then(() => true, () => false);
    if (!clicked) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      opened = true;
      break;
    }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

/** Every text-bearing element inside the card + its computed font-size in px. */
type FontSample = { text: string; px: number; tag: string; cls: string };
async function measureCardFonts(page: Page, taskId: string): Promise<FontSample[]> {
  const card = page.locator(`[data-task-card="${taskId}"]`).first();
  await expect(card).toBeVisible({ timeout: 10000 });
  return card.evaluate((root) => {
    const out: { text: string; px: number; tag: string; cls: string }[] = [];
    const els = [root, ...Array.from(root.querySelectorAll("*"))] as HTMLElement[];
    for (const el of els) {
      // Only elements that render their OWN text (a direct, non-empty text node).
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent ?? "").trim())
        .join(" ")
        .trim();
      if (!own) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      out.push({ text: own.slice(0, 40), px, tag: el.tagName.toLowerCase(), cls: el.className.toString().slice(0, 60) });
    }
    return out;
  });
}

test.describe("Kanban card — mobile font legibility", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-cardfont" }, null, 2));
    const topic = await createTopic(request, "E2E-CardFont", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    // A card that exercises the small-font sites: id chip (always), timestamp
    // (always), priority "Alta" chip (priority 3, hand-set → renders inline),
    // and a description preview.
    await apiCreateTask(request, {
      text: "Card di prova per la leggibilità mobile",
      status: "todo",
      priority: 3,
      description: "Descrizione di prova per popolare l'anteprima testuale della card.",
    });
  });

  test.afterAll(async ({ request }) => {
    for (const tid of createdTasks) await deleteTask(request, PROJECT_ID, tid);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("CARDFONT-01: no card text below 12px at a 390px mobile viewport", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-48" });
    // The sidebar/project-window flow needs desktop width to reach the board;
    // open there, then shrink to a phone viewport before measuring.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const taskId = createdTasks[0];
    await expect(page.locator(`[data-task-card="${taskId}"]`).first()).toBeVisible({ timeout: 10000 });

    await page.setViewportSize({ width: 390, height: 844 });
    // let Tailwind's responsive classes re-apply after the resize
    await page.waitForTimeout(150);

    const samples = await measureCardFonts(page, taskId);
    expect(samples.length).toBeGreaterThan(0);

    const tooSmall = samples.filter((s) => s.px < 12);
    expect(
      tooSmall,
      `Testi sotto i 12px a 390px:\n${tooSmall.map((s) => `  ${s.px}px  <${s.tag}> "${s.text}"`).join("\n")}`,
    ).toEqual([]);

    // Sanity: the small chips are present and sit exactly at the 12px floor.
    const min = Math.min(...samples.map((s) => s.px));
    expect(min).toBeGreaterThanOrEqual(12);
  });

  test("CARDFONT-02: desktop keeps the compact 10/11px chips (unchanged)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const taskId = createdTasks[0];
    const samples = await measureCardFonts(page, taskId);
    // On desktop the md: overrides restore sub-12px chips — proof desktop is
    // untouched by the mobile fix.
    const hasSmall = samples.some((s) => s.px < 12);
    expect(hasSmall, "il desktop deve conservare i chip a 10/11px").toBe(true);
  });
});
