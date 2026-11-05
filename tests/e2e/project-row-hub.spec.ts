/**
 * THE PROJECT ROW WITH THE HUB'S DATA (hub-smistamento, HUBBR-16).
 *
 * Four Topics projects, three of which the fake hub knows by their folder's
 * name, as the hub names a project: acme-web (30% of the Claude week, 38% with
 * Codex and Muse, on a 40% budget, running), studio-x (25% of the Claude week
 * on 25%, held by the brake), acme-api (in line). The budget is on the Claude
 * share alone, and reached at equality, as the hub's brake reads it.
 * The hub's folder for a row is the last agent's, never the project's: the
 * fixture puts acme-web's in a board worktree, acme-api's in a sibling repo,
 * and misc-a's (held, a cross-project row) right in notes-lab's folder.
 * notes-lab the hub does not know by name, so it shows nothing, misc-a's brake
 * included. The rows carry the dot and the pause on studio-x, the clock on
 * acme-api, nothing on acme-web at rest; on hover acme-web says its share,
 * the number always and the words only whole (never a half word), with the
 * name whole, clear of the command rail, and a long name keeps its letters
 * before the hint keeps its words. The menu says the same in words
 * and writes the priority and the budget to the hub's `project-settings`,
 * showing them as read back; a write the hub refuses shows its reason and
 * keeps the old one.
 *
 * The hub is a fake (helpers/fake-hub.ts with `projects`) on the port the test
 * server reads; the real :3360 is never touched, the names are placeholders.
 *
 * Mutation: matching by the hub's folder again (`matchHubProject`,
 * lib/projectHub.ts) puts misc-a's pause on notes-lab and drops acme-web and
 * acme-api, and the first test is red; with the name's button allowed to
 * shrink on hover again (index.css), the name check of the first test is red; with the
 * menu's choice drawn from the click instead of the hub's answer, «a refused
 * write keeps the old priority» is red; with the budget compared on the
 * total again, or with `>` where the hub brakes at `>=` (`overBudget`), the
 * first test is red (the hint's 38%, the missing dot on studio-x).
 *
 * Video on: the recording is the proof. Screenshots of the built surface go to
 * the test's output (`vero-riga-progetto-hub-*.png`, allow-italian: file names the docs expect),
 * taken in the mockups' workspace (helpers/shot-scene.ts): each project open
 * on its chats, and the Dashboard's Consumi beside the rows, as the mockup
 * draws them.
 *
 * @covers HUBBR-16
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { seedScene, type Scene } from "./helpers/shot-scene";
import { longPress } from "./helpers/long-press";
import { canonicalTmpRoot } from "./helpers/file-project";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const ROOT = `${canonicalTmpRoot()}/e2e-hubrow-${Date.now().toString(36)}`;
const NAMES = ["acme-web", "studio-x", "acme-api", "notes-lab"] as const;
/** The chats each project is open on, as in the mockup's sidebar. */
const CHATS: Record<(typeof NAMES)[number], string[]> = {
  "acme-web": ["Firma della release v1.1", "Revisione checkout"],
  "studio-x": ["Migrazione listino"],
  "acme-api": ["Paginazione degli ordini"],
  "notes-lab": ["Note sparse"],
};
const dirOf = (name: string) => `${ROOT}/${name}`;
/** A real icon, as most projects have: the row then carries its glyph slot, and the name has that much less room. */
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#3b82f6"/></svg>';

async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: { projects?: Array<{ name: string }> } }>;
    return (snap.projects?.data?.projects ?? []).map((p) => p.name).includes("studio-x");
  }, { timeout: 30_000, message: "the live reader never read the fake hub's projects" }).toBe(true);
}

/** A tooltip as written: the app's tooltip layer moves `title` to `data-tip` once it is hovered. */
const tipOf = (l: Locator) => l.evaluate((el) => el.getAttribute("title") ?? el.getAttribute("data-tip"));

/**
 * Whether a name is drawn whole. Not `scrollWidth <= clientWidth`: both are
 * rounded to whole pixels, and a box a fraction of a pixel short of its text
 * passes that check while it draws the ellipsis.
 */
const drawnWhole = (l: Locator) => l.evaluate((el) => {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getBoundingClientRect().width <= el.getBoundingClientRect().width + 0.01;
});

/** Whether the hint's words are on its visible line: they wrap below it, out of sight, when they do not fit whole. */
const wordsShown = (week: Locator) => week.evaluate((el) => {
  const words = el.querySelector(".project-hub-hint-words");
  if (!words) return false;
  const box = el.getBoundingClientRect();
  const w = words.getBoundingClientRect();
  return w.top < box.bottom - 0.5 && w.right <= box.right + 0.5;
});

/** The hint never draws a half word: its words are inside it whole, or wholly below its line. */
async function expectWordsWholeOrHidden(week: Locator): Promise<void> {
  const [inside, below] = await week.evaluate((el) => {
    const words = el.querySelector(".project-hub-hint-words")!;
    const box = el.getBoundingClientRect();
    const w = words.getBoundingClientRect();
    return [w.top < box.bottom - 0.5 && w.right <= box.right + 0.5 && w.bottom <= box.bottom + 0.5, w.top >= box.bottom - 0.5];
  });
  expect(inside || below).toBe(true);
}

const projectRow = (page: Page, name: string) => page.locator(".group\\/proj").filter({ has: page.getByTestId(`project-toggle-${name}`) });

/** The Dashboard in the main area, as the mockup shows it beside the rows. */
async function openDashboard(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "dashboard" } }));
    return document.querySelector('[data-testid="dashboard-pane"]') !== null;
  }), { timeout: 20_000 }).toBe(true);
  await expect(page.getByTestId("dashboard-pane").getByTestId("hub-usage-section")).toBeVisible({ timeout: 20_000 });
}

async function openRows(page: Page): Promise<void> {
  await goToApp(page);
  for (const n of NAMES) await expect(page.getByTestId(`project-toggle-${n}`)).toBeVisible({ timeout: 20_000 });
  await expect(projectRow(page, "studio-x").getByTestId("project-hub-mark")).toBeVisible({ timeout: 20_000 });
}

test.describe("project row with the hub", () => {
  let hub: FakeHub | null = null;
  let scene: Scene | null = null;

  test.beforeAll(async ({ request }) => {
    scene = await seedScene(request, ROOT, NAMES.map((name) => ({ name, chats: CHATS[name] })));
    writeFileSync(`${dirOf("acme-web")}/favicon.svg`, ICON);
    hub = await startFakeHub(undefined, {
      projects: { dirs: { "acme-web": `${ROOT}/.topics/worktrees/acme-web/k3f9`, "acme-api": `${ROOT}/acme-api-brand-kit/studio`, "misc-a": dirOf("notes-lab") } },
    });
    await waitForHub(request);
  });
  test.afterAll(async ({ request }) => {
    await hub?.close();
    await scene?.cleanup(request);
  });
  test.beforeEach(async ({ request }) => {
    await request.post(`${E2E_BASE}/api/hub/e2e-reset`);
  });

  test("the rows: dot and pause on the held project, clock on the one in line, nothing on a project the hub does not know", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await openRows(page);
    await openDashboard(page);

    const studio = projectRow(page, "studio-x").getByTestId("project-hub-mark");
    await expect(studio).toHaveAttribute("data-hold", "held");
    await expect(studio).toHaveAttribute("data-over", "true");
    const pause = studio.locator('[role="img"]');
    // The budget brake, said once: the numbers are the dot's, the project's own name is not repeated.
    await expect.poll(() => tipOf(pause)).toMatch(/^Fermo per il budget · riparte alle \d\d:\d\d$/);
    await expect.poll(() => tipOf(studio.locator('[aria-label="Oltre il budget della settimana"]'))).toBe("Oltre il budget della settimana: 25% della settimana Claude su 25% di budget");

    const api = projectRow(page, "acme-api").getByTestId("project-hub-mark");
    await expect(api).toHaveAttribute("data-hold", "queued");
    await expect(api).not.toHaveAttribute("data-over", "true");
    await expect.poll(() => tipOf(api.locator('[role="img"]'))).toBe("In coda: 2 lavori in attesa di partire");

    // acme-web is inside its budget and running: nothing at rest, the share on hover.
    await expect(projectRow(page, "acme-web").getByTestId("project-hub-mark")).toHaveCount(0);
    const week = projectRow(page, "acme-web").getByTestId("project-hub-week");
    await expect(week).toBeHidden();
    // notes-lab is not the hub's: nothing of the hub at all.
    await expect(projectRow(page, "notes-lab").getByTestId("project-hub-mark")).toHaveCount(0);
    await expect(projectRow(page, "notes-lab").getByTestId("project-hub-week")).toHaveCount(0);

    await projectRow(page, "acme-web").hover();
    await expect(week).toBeVisible();
    // The Claude share (the budget's figure), never the 38% of all providers; the words whole or not at all.
    await expect(week.locator("> span").first()).toHaveText("30%");
    await expect(week.locator(".project-hub-hint-words")).toHaveText("\u00a0della settimana Claude");
    await expectWordsWholeOrHidden(week);
    // The name stays whole beside the hint, its icon included.
    await expect(projectRow(page, "acme-web").locator('[data-row-glyph-slot="favicon"] img, [data-row-glyph-slot="favicon"] svg').first()).toBeVisible({ timeout: 20_000 });
    const name = projectRow(page, "acme-web").locator('[data-row-name="project"]');
    const nameWhole = () => drawnWhole(name);
    await expect.poll(nameWhole).toBe(true);
    await expect.poll(() => tipOf(week)).toBe("30% della settimana Claude su 40% di budget");
    // Clear of the command rail that shows on hover, and inside the row.
    const rail = projectRow(page, "acme-web").locator("> .row-actions");
    const [w, r, rowBox] = await Promise.all([week.boundingBox(), rail.boundingBox(), projectRow(page, "acme-web").boundingBox()]);
    expect(w!.x + w!.width).toBeLessThanOrEqual(r!.x);
    expect(w!.x).toBeGreaterThan(rowBox!.x);
    // The picture is taken on a settled row: the project glyph slot can still land while the page settles.
    await expect.poll(nameWhole).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("vero-riga-progetto-hub-scuro.png") });
    expect(await nameWhole()).toBe(true);
  });

  test("the menu: the facts in words, the priority written and read back, the budget too", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await openRows(page);
    await openDashboard(page);

    await page.getByTestId("project-toggle-studio-x").click({ button: "right" });
    const studioMenu = page.getByTestId("project-hub-menu");
    await expect(studioMenu).toHaveAttribute("data-project-hub", "studio-x");
    await expect(studioMenu.getByTestId("project-hub-menu-week")).toHaveText("25% della settimana Claude su 25% di budget");
    await expect(studioMenu.getByTestId("project-hub-menu-hold")).toHaveText(/^Fermo per il budget · riparte alle \d\d:\d\d$/);
    await page.keyboard.press("Escape");
    await expect(studioMenu).toHaveCount(0);

    // Opened from the row's bottom edge, so the menu falls below the row and the picture shows the name too.
    const toggle = page.getByTestId("project-toggle-acme-web");
    const tBox = (await toggle.boundingBox())!;
    await toggle.click({ button: "right", position: { x: 8, y: tBox.height - 1 } });
    const menu = page.getByTestId("project-hub-menu");
    await expect(menu).toHaveAttribute("data-project-hub", "acme-web");
    await expect(menu.getByTestId("project-hub-menu-week")).toHaveText("30% della settimana Claude su 40% di budget");
    await expect(menu.getByTestId("project-hub-menu-hold")).toHaveCount(0);
    await expect(menu.getByTestId("project-hub-priority-normale")).toHaveAttribute("aria-checked", "true");
    // The budget in force (40) is not a step: it is offered beside them.
    await expect(menu.getByTestId("project-hub-budget-40")).toHaveAttribute("aria-checked", "true");
    await page.screenshot({ path: testInfo.outputPath("vero-riga-progetto-hub-chiaro.png") });

    await menu.getByTestId("project-hub-priority-alta").click();
    await expect.poll(() => hub!.posts.filter((p) => p.path === "project-settings")).toEqual([{ path: "project-settings", name: "acme-web", priority: "alta" }]);
    await expect(menu.getByTestId("project-hub-priority-alta")).toHaveAttribute("aria-checked", "true");
    expect(hub!.priorities["acme-web"]).toBe("alta");

    await menu.getByTestId("project-hub-budget-50").click();
    await expect(menu.getByTestId("project-hub-menu-week")).toHaveText("30% della settimana Claude su 50% di budget");
    await expect(menu.getByTestId("project-hub-budget-50")).toHaveAttribute("aria-checked", "true");
    expect(hub!.budgets["acme-web"]).toBe(50);
    // The priority written before is untouched by the budget's write.
    expect(hub!.priorities["acme-web"]).toBe("alta");
    await expect(menu.getByTestId("project-hub-priority-alta")).toHaveAttribute("aria-checked", "true");
  });

  test("a refused write keeps the old priority and says why", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openRows(page);
    hub!.refuseSettings = "file dei budget non scrivibile";
    await page.getByTestId("project-toggle-acme-web").click({ button: "right" });
    const menu = page.getByTestId("project-hub-menu");
    await menu.getByTestId("project-hub-priority-bassa").click();
    await expect(menu.getByTestId("project-hub-menu-error")).toHaveText("Non salvato: file dei budget non scrivibile");
    await expect(menu.getByTestId("project-hub-priority-normale")).toHaveAttribute("aria-checked", "true");
    await expect(menu.getByTestId("project-hub-priority-bassa")).toHaveAttribute("aria-checked", "false");
  });

  test("phone, 390 px: the signals on the rows, the menu from a long press", async ({ browser, browserName }, testInfo) => {
    const ctx = await browser.newContext({
      baseURL: E2E_BASE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "dark", locale: "it-IT",
      recordVideo: { dir: testInfo.outputPath("phone-video"), size: { width: 390, height: 844 } },
    });
    const page = await ctx.newPage();
    try {
      await page.goto("/");
      await expect(page.getByTestId("mobile-chrome-bar")).toBeVisible({ timeout: 30_000 });
      await expect(projectRow(page, "studio-x").getByTestId("project-hub-mark")).toBeVisible({ timeout: 20_000 });
      await expect(projectRow(page, "acme-api").getByTestId("project-hub-mark")).toHaveAttribute("data-hold", "queued");
      // No hover on a finger: the share is in the menu, never a hint left on the row.
      await expect(projectRow(page, "acme-web").getByTestId("project-hub-week")).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.screenshot({ path: testInfo.outputPath("vero-riga-progetto-hub-telefono.png") });
      const menu = page.getByTestId("project-hub-menu");
      // The finger stays down until the menu is there; WebKit has no `Touch`
      // constructor, so there the hold is the `contextmenu` the app
      // synthesises (`openContextMenuAt`), at the finger's point.
      if (browserName === "webkit") {
        await page.getByTestId("project-toggle-studio-x").evaluate((el) => {
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
        });
      } else await longPress(page, '[data-testid="project-toggle-studio-x"]', { until: menu });
      await expect(menu.getByTestId("project-hub-menu-week")).toHaveText("25% della settimana Claude su 25% di budget");
      await expect(menu.getByTestId("project-hub-priority")).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("vero-riga-progetto-hub-telefono-menu.png") });
    } finally {
      await ctx.close();
    }
  });

  test("a long name keeps its letters before the hint keeps its words", async ({ page, request }, testInfo) => {
    const long = `${ROOT}/acme-brand-guidelines`;
    mkdirSync(long, { recursive: true });
    writeFileSync(`${long}/favicon.svg`, ICON);
    const id = (await createTopic(request, "Chat acme-brand-guidelines", { projectPath: long })).id;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: "dark" });
      await openRows(page);
      const row = projectRow(page, "acme-brand-guidelines");
      await expect(page.getByTestId("project-toggle-acme-brand-guidelines")).toBeVisible({ timeout: 20_000 });
      await row.hover();
      const week = row.getByTestId("project-hub-week");
      await expect(week).toBeVisible();
      await expect(week).toContainText("4%");
      // Either the name is whole, or the hint's words already gave all their room.
      const nameClipped = !(await drawnWhole(row.locator('[data-row-name="project"]')));
      if (nameClipped) expect(await wordsShown(week)).toBe(false);
      await expectWordsWholeOrHidden(week);
      const rail = row.locator("> .row-actions");
      const [w, r] = await Promise.all([week.boundingBox(), rail.boundingBox()]);
      expect(w!.x + w!.width).toBeLessThanOrEqual(r!.x);
      await page.screenshot({ path: testInfo.outputPath("vero-riga-progetto-hub-nome-lungo.png") });
    } finally {
      await deleteTopic(request, id).catch(() => {});
    }
  });
});
