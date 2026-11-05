/**
 * THE PROJECT ROW WITH THE HUB'S DATA (hub-smistamento, HUBBR-16).
 *
 * Four Topics projects, three of which the fake hub knows: acme-web by the
 * same folder (38% of the week on a 40% budget, running), studio-x by name
 * only, the hub knowing no folder for it (27% on 25%, held by the brake),
 * acme-api by name with the hub's folder inside it, one of its worktrees (in
 * line). notes-lab the hub does not know. The rows carry the dot and the
 * pause on studio-x, the clock on acme-api, nothing on acme-web at rest and
 * nothing at all on notes-lab; on hover acme-web says «38% della settimana» (allow-italian: the UI copy asserted)
 * clear of the command rail. The menu says the same in words and writes the
 * priority and the budget to the hub's `project-settings`, showing them as
 * read back; a write the hub refuses shows its reason and keeps the old one.
 *
 * The hub is a fake (helpers/fake-hub.ts with `projects`) on the port the test
 * server reads; the real :3360 is never touched, the names are placeholders.
 *
 * Mutation: with the folder check left out of `matchHubProject`
 * (lib/projectHub.ts), any project named like a hub row takes its data, and
 * «a project the hub knows elsewhere shows nothing» is red; with the menu's
 * choice drawn from the click instead of the hub's answer, «a refused write
 * keeps the old priority» is red.
 *
 * Video on: the recording is the proof. Screenshots of the built surface go to
 * the test's output (`vero-riga-progetto-hub-*.png`, allow-italian: file names the docs expect).
 *
 * @covers HUBBR-16
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { longPress } from "./helpers/long-press";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const ROOT = `${canonicalTmpRoot()}/e2e-hubrow-${Date.now().toString(36)}`;
const NAMES = ["acme-web", "studio-x", "acme-api", "notes-lab"] as const;
const dirOf = (name: string) => `${ROOT}/${name}`;

async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: { projects?: Array<{ name: string }> } }>;
    return (snap.projects?.data?.projects ?? []).map((p) => p.name).includes("studio-x");
  }, { timeout: 30_000, message: "the live reader never read the fake hub's projects" }).toBe(true);
}

/** A tooltip as written: the app's tooltip layer moves `title` to `data-tip` once it is hovered. */
const tipOf = (l: Locator) => l.evaluate((el) => el.getAttribute("title") ?? el.getAttribute("data-tip"));

const projectRow = (page: Page, name: string) => page.locator(".group\\/proj").filter({ has: page.getByTestId(`project-toggle-${name}`) });

async function openRows(page: Page): Promise<void> {
  await goToApp(page);
  for (const n of NAMES) await expect(page.getByTestId(`project-toggle-${n}`)).toBeVisible({ timeout: 20_000 });
  await expect(projectRow(page, "studio-x").getByTestId("project-hub-mark")).toBeVisible({ timeout: 20_000 });
}

test.describe("project row with the hub", () => {
  let hub: FakeHub | null = null;
  const topicIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    for (const n of NAMES) {
      mkdirSync(dirOf(n), { recursive: true });
      topicIds.push((await createTopic(request, `Chat ${n}`, { projectPath: dirOf(n) })).id);
    }
    hub = await startFakeHub(undefined, {
      projects: { dirs: { "acme-web": dirOf("acme-web"), "acme-api": `${dirOf("acme-api")}/.claude/worktrees/fix`, "acme-docs": `${ROOT}/elsewhere/acme-docs` } },
    });
    await waitForHub(request);
  });
  test.afterAll(async ({ request }) => {
    await hub?.close();
    for (const id of topicIds) await deleteTopic(request, id).catch(() => {});
    removeTmpDir(ROOT);
  });
  test.beforeEach(async ({ request }) => {
    await request.post(`${E2E_BASE}/api/hub/e2e-reset`);
  });

  test("the rows: dot and pause on the held project, clock on the one in line, nothing on a project the hub does not know", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await openRows(page);

    const studio = projectRow(page, "studio-x").getByTestId("project-hub-mark");
    await expect(studio).toHaveAttribute("data-hold", "held");
    await expect(studio).toHaveAttribute("data-over", "true");
    const pause = studio.locator('[role="img"]');
    await expect.poll(() => tipOf(pause)).toMatch(/^Fermo: studio-x: 27% della settimana Claude, budget 25% · riparte alle \d\d:\d\d$/);

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
    await expect(week).toHaveText("38% della settimana");
    await expect.poll(() => tipOf(week)).toBe("38% della settimana su 40% di budget");
    // Clear of the command rail that shows on hover, and inside the row.
    const rail = projectRow(page, "acme-web").locator("> .row-actions");
    const [w, r, rowBox] = await Promise.all([week.boundingBox(), rail.boundingBox(), projectRow(page, "acme-web").boundingBox()]);
    expect(w!.x + w!.width).toBeLessThanOrEqual(r!.x);
    expect(w!.x).toBeGreaterThan(rowBox!.x);
    await page.screenshot({ path: testInfo.outputPath("vero-riga-progetto-hub-scuro.png") });
  });

  test("the menu: the facts in words, the priority written and read back, the budget too", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await openRows(page);

    await page.getByTestId("project-toggle-studio-x").click({ button: "right" });
    const studioMenu = page.getByTestId("project-hub-menu");
    await expect(studioMenu).toHaveAttribute("data-project-hub", "studio-x");
    await expect(studioMenu.getByTestId("project-hub-menu-week")).toHaveText("27% della settimana su 25% di budget");
    await expect(studioMenu.getByTestId("project-hub-menu-hold")).toHaveText(/^Fermo: studio-x: 27% della settimana Claude, budget 25% · riparte alle \d\d:\d\d$/);
    await page.keyboard.press("Escape");
    await expect(studioMenu).toHaveCount(0);

    await page.getByTestId("project-toggle-acme-web").click({ button: "right" });
    const menu = page.getByTestId("project-hub-menu");
    await expect(menu).toHaveAttribute("data-project-hub", "acme-web");
    await expect(menu.getByTestId("project-hub-menu-week")).toHaveText("38% della settimana su 40% di budget");
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
    await expect(menu.getByTestId("project-hub-menu-week")).toHaveText("38% della settimana su 50% di budget");
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
      await expect(menu.getByTestId("project-hub-menu-week")).toHaveText("27% della settimana su 25% di budget");
      await expect(menu.getByTestId("project-hub-priority")).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("vero-riga-progetto-hub-telefono-menu.png") });
    } finally {
      await ctx.close();
    }
  });

  test("a project the hub knows elsewhere shows nothing: same name, another folder", async ({ page, request }) => {
    const other = `${ROOT}/acme-docs`;
    mkdirSync(other, { recursive: true });
    const id = (await createTopic(request, "Chat acme-docs", { projectPath: other })).id;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openRows(page);
      await expect(page.getByTestId("project-toggle-acme-docs")).toBeVisible({ timeout: 20_000 });
      await projectRow(page, "acme-docs").hover();
      await expect(projectRow(page, "acme-docs").getByTestId("project-hub-week")).toHaveCount(0);
    } finally {
      await deleteTopic(request, id).catch(() => {});
    }
  });
});
