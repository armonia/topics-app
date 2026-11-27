/**
 * THE TOP ROW WITH THE TABS AT THE SIDE: ONE STEP ON ALL FOUR SIDES.
 *
 * 26/11, the owner: "the icons like sidebar, search, add in the top sidebar,
 * and also the open project's tab, have no spacing between them and at the
 * sides that is consistent on all 4 sides". Measured on the live window
 * before the change: the header's 34 buttons in a 40 row (3 above and below,
 * 6 at the sides) and the project's commands 28 wide with 2 between them.
 *
 * Every number here is read from the DOM, with the Mac chrome forced
 * (`?windowChrome=mac`) and a git project with changes in front, so the title
 * row holds the project's four commands. The row shot of every width is
 * written first, then judged: the same file captures the before and the after
 * (`TABROW_SHOTS` names the folder).
 *
 * @covers TABROW-01
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createTopic, deleteTopic, resetPaneStore, seedProjectInnerChats, seedProjectPane } from "./helpers/api-fixtures";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { projectRow } from "./helpers/project-row";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
const SIDE_TABS = { cookies: [], origins: [{ origin: E2E_BASE, localStorage: [{ name: "app-settings", value: JSON.stringify({ tabsPosition: "side" }) }] }] };
test.use({ storageState: SIDE_TABS });

const STEP = 6;
const BOX = 34;
const WIDTHS = [
  { w: 375, h: 812 },
  { w: 768, h: 1024 },
  { w: 1440, h: 900 },
  { w: 3440, h: 1440 },
];
const SHOTS = process.env.TABROW_SHOTS;

interface R { name: string; top: number; bottom: number; left: number; right: number; h: number }

/** The rows and what they hold, in viewport pixels. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element, name: string) => {
      const r = el.getBoundingClientRect();
      return { name, top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height };
    };
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const header = document.querySelector(".sidebar-header");
    // The header's commands, by the group they sit in (its two ends).
    const groups = header
      ? Array.from(header.children).map((g, i) =>
          Array.from(g.querySelectorAll("button")).filter(visible)
            .filter((b) => !b.closest('[data-testid="traffic-lights-box"]'))
            .map((b) => rect(b, `${i}:${b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent?.trim() || "?"}`)))
      : [];
    const lights = document.querySelector('[data-testid="traffic-lights-box"]');
    const bar = Array.from(document.querySelectorAll("[data-split-card] .pane-chrome-bar")).find(visible);
    const title = document.querySelector('[data-testid="cell-title-tab"] [role="tab"]');
    const tools = document.querySelector('[data-testid="title-project-tools"]');
    const commands = tools
      ? Array.from(tools.querySelectorAll('[data-testid="project-card"], [data-testid="project-rail-button"]')).filter(visible)
          .map((b) => rect(b, b.getAttribute("aria-label") || b.getAttribute("title") || "?"))
      : [];
    return {
      header: header ? rect(header, "header") : null,
      groups,
      lights: lights ? rect(lights, "lights") : null,
      bar: bar ? rect(bar, "bar") : null,
      title: title && visible(title) ? rect(title, "title") : null,
      commands,
    };
  });
}

/** A row's content: as tall as a tab button, one step from its top and bottom. */
function expectFourSides(row: R, items: R[], what: string) {
  for (const it of items) {
    expect(Math.round(it.h), `${what} «${it.name}» is a tab button tall`).toBe(BOX);
    expect(Math.round(it.top - row.top), `${what} «${it.name}»: air above`).toBe(STEP);
    expect(Math.round(row.bottom - it.bottom), `${what} «${it.name}»: air below`).toBe(STEP);
  }
  const sorted = [...items].sort((a, b) => a.left - b.left);
  for (let i = 1; i < sorted.length; i++) {
    expect(Math.round(sorted[i].left - sorted[i - 1].right), `${what}: between «${sorted[i - 1].name}» and «${sorted[i].name}»`).toBe(STEP);
  }
}

test.describe("the top row with the tabs at the side", () => {
  const made: string[] = [];
  let projectPath = "";
  let projectName = "";
  let chat = { id: "", name: "" };

  test.beforeAll(async ({ request }) => {
    // A real-looking project: the shot goes in front of a person (25/11, no
    // ids in names). Uniqueness lives in the folder above it.
    projectPath = join(canonicalTmpDir("e2e-tabrow"), "sito-armonia");
    projectName = "sito-armonia";
    mkdirSync(projectPath, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: projectPath, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=e2e@e.test", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "start");
    // Changes, so the git command is on the row with its badge.
    for (const f of ["index.html", "styles.css", "app.js"]) writeFileSync(join(projectPath, f), f);
    const inner = await createTopic(request, "Rifinire la landing", { projectPath, provider: "claude-code" });
    chat = { id: inner.id, name: "Rifinire la landing" };
    made.push(inner.id);
  });

  test.afterAll(async ({ request }) => {
    for (const id of made) await deleteTopic(request, id).catch(() => {});
    if (projectPath) removeTmpDir(join(projectPath, ".."));
  });

  for (const { w, h } of WIDTHS) {
    test(`${w}px: one step above, below, between and at the ends`, async ({ page, request }) => {
      await page.setViewportSize({ width: w, height: h });
      await resetPaneStore(request, []);
      await seedProjectPane(request, projectPath);
      await seedProjectInnerChats(request, projectPath, [chat.id]);
      await page.goto("/?windowChrome=mac");
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "attached", timeout: 20_000 });
      if (w >= 768) {
        const project = projectRow(page, projectName);
        await expect(project).toBeVisible({ timeout: 20_000 });
        await project.click();
        await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10_000 });
        await expect(page.getByTestId("title-project-tools").getByTestId("project-rail-button")).toHaveCount(3, { timeout: 15_000 });
      }
      // Pointer away and colours settled: the shot is the row at rest.
      await page.mouse.move(w / 2, h - 10);
      await page.waitForFunction(() => document.getAnimations()
        .every((a) => !(a instanceof CSSTransition) || a.playState !== "running"));
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, `riga-${w}.png`), clip: { x: 0, y: 0, width: w, height: Math.min(h, 120) } });
        await page.screenshot({ path: join(SHOTS, `finestra-${w}.png`) });
      }
      // The phone has its own top row (56/44 with 44 commands): shot only.
      if (w < 768) return;

      const m = await measure(page);
      test.info().annotations.push({ type: "misure", description: JSON.stringify(m) });
      expect(m.header, "the sidebar header").not.toBeNull();
      expect(m.bar, "the cell's chrome row").not.toBeNull();
      const header = m.header!;
      const bar = m.bar!;
      expect(Math.round(header.h), "the header is a tab and a step above and below").toBe(BOX + 2 * STEP);
      expect(Math.round(bar.h), "the title row is the same row").toBe(BOX + 2 * STEP);
      expect(Math.round(bar.bottom), "and they end on the same line").toBe(Math.round(header.bottom));
      // The lights centre on the row.
      expect(m.lights, "the Mac chrome is forced").not.toBeNull();
      expect(Math.round((m.lights!.top + m.lights!.bottom) / 2 - header.top), "the lights' centre").toBe((BOX + 2 * STEP) / 2);

      for (const group of m.groups) expectFourSides(header, group, "header");
      const last = m.groups.flat().sort((a, b) => b.right - a.right)[0];
      expect(Math.round(header.right - last.right), "the last header button from the row's end").toBe(STEP);

      expect(m.title, "the project's title tab").not.toBeNull();
      expectFourSides(bar, [m.title!], "title");
      expect(m.commands.length, "the project's four commands on the title row").toBe(4);
      expectFourSides(bar, m.commands, "command");
      const lastCommand = [...m.commands].sort((a, b) => b.right - a.right)[0];
      expect(Math.round(bar.right - lastCommand.right), "the last command from the row's end").toBe(STEP);
    });
  }
});
