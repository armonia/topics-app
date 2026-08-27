/**
 * The harness behind `board-topbar-legibility.spec.ts`.
 *
 * WHY IT MOVED OUT. The spec grew past the 800-line ceiling `check:bloat`
 * enforces, and of its 856 lines a third were setup: four throwaway projects
 * on disk, the stubbed system probes, and the geometry readers that turn the
 * bar into numbers. Recording a higher baseline was the other option the gate
 * offers, and it was the wrong one here — the size was not bought by the two
 * new scenarios, it was setup that had always been shared and never named.
 *
 * WHAT LIVES HERE. Everything that describes the WORLD the bar is measured in;
 * what stays in the spec is what the bar must be TRUE of. The probes are
 * stubbed on purpose: making them tell the truth would mean putting the machine
 * under load and creating real worktrees, i.e. measuring the environment
 * instead of the UI.
 *
 * The mutable bookkeeping (which topics and tasks were created, so they can be
 * torn down) deliberately did NOT move: it belongs to the spec's own lifecycle,
 * and a helper module that owns cleanup state is a helper module two specs can
 * quietly corrupt for each other. `apiCreateTask` therefore RETURNS the key it
 * created instead of pushing it somewhere, and the caller records it.
 */
import { projectRow } from "./project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./api-fixtures";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { E2E_BASE } from "./test-server";
import { projectIdForPath as boardIdForPath } from "../../../shared/board";


const AUDIT_JS = readFileSync(join(__dirname, "ui-audit.js"), "utf8");
export const SHOTS = join(process.cwd(), "test-results", "topbar");
export const STAMP = Date.now();
/** A single root, SHORT project names: the chip shows the basename, and four
 *  `e2e-topbar-alpha-1765...` would not fit in any bar - they would measure the
 *  length of the test name, not the space in the row. */
export const ROOT = `/tmp/e2e-topbar-${STAMP}`;
export const PROJECTS = ["alfa", "beta", "gamma", "delta"] as const;
export const dirOf = (name: string) => `${ROOT}/${name}`;

/** The two closed tasks the stubs will make show up as "not on main". */
export const unlandedTitles = [`Consegna A ${STAMP}`, `Consegna B ${STAMP}`];


export async function apiCreateTask(
  request: import("@playwright/test").APIRequestContext,
  projectId: string,
  text: string,
  status: string,
): Promise<string> {
  // `done` cannot be created: the service refuses a task that is born already
  // closed (`cannot create a task already done`). You get there the way a human
  // gets there - by creating it and then closing it.
  const bornStatus = status === "done" ? "backlog" : status;
  const res = await request.post(`${E2E_BASE}/api/boards/${projectId}/tasks`, { data: { text, status: bornStatus } });
  expect(res.ok(), `creazione task «${text}»`).toBe(true);
  const task = (await res.json()) as { id: string };
  if (status === "done") {
    const patch = await request.patch(`${E2E_BASE}/api/boards/${projectId}/tasks/${task.id}`, { data: { status: "done" } });
    expect(patch.ok(), `chiusura task «${text}»`).toBe(true);
  }
  return `${projectId}:${task.id}`;
}

/**
 * The system probes, stubbed.
 *
 * `running` is the term the load chip uses to decide whether to exist at all:
 * 4 in flight against 2 recommended = a gap that can be acted on, so the chip
 * is there. The opposite case (low `running`) is TOPBAR-04b.
 */
export async function stubProbes(page: Page, opts?: { running?: number }) {
  const running = opts?.running ?? 4;
  await page.route((url) => url.pathname === "/api/system/dispatch-capacity", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recommended: 2, cores: 12, totalMemGB: 32, load1: 15.4, running,
        oursCores: 6.2, budgetCores: 6,
        reason: "12 core → base 4, ridotto a 2: gli agent tengono 6.2 core sui 6 di quota",
      }),
    }));
  await page.route((url) => url.pathname === "/api/worktrees", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ worktrees: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }, { id: 7 }] }),
    }));
  await page.route((url) => url.pathname === "/api/worktrees/branches", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ summary: { total: 5, orphan: 2, onOpenTasks: 3 } }),
    }));
  // `landing_state` has no HTTP door that writes it (the periodic audit stamps
  // it after a land): the two closed tasks are marked in the RESPONSE, which is
  // exactly the entrance the bar reads them from.
  //
  // The delivery commit is needed TOO: `showsLandingDebt` (shared/board.ts) is
  // silent on an `unlanded` with no snapshot of the delivery, because without
  // that commit there is no question the verdict would be answering. A task
  // closed via the API does not have one, so the debt has to be built in full
  // here.
  await page.route((url) => /\/api\/(all-boards|boards\/[^/]+)\/tasks$/.test(url.pathname), async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { tasks?: Array<{ text?: string; status?: string; landingState?: string | null; deliveryCommit?: string | null }> };
    for (const t of body.tasks ?? []) {
      if (t.status === "done" && unlandedTitles.includes(t.text ?? "")) {
        t.landingState = "unlanded";
        t.deliveryCommit = "0ff1ce5";
      }
    }
    await route.fulfill({ response: res, body: JSON.stringify(body) });
  });
}

export async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
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
  // The project filters only exist where there is more than one project to
  // filter: the "all projects" mode of the project board (which is also the
  // most crowded bar there is - it still has the project's work folders).
  await page.getByRole("button", { name: "Tutti i progetti" }).click();
  await expect(page.getByTestId("filter-project-chip")).toBeVisible({ timeout: 10000 });
}

/**
 * The GLOBAL BOARD from the standalone bar.
 *
 * It is the surface on which the question "do the projects fit in the bar?"
 * makes sense: no mode toggle, no work folders of ONE project, and by
 * construction more projects to filter. The PROJECT board in "all projects"
 * mode carries ~400px more controls, and with those the free space is already
 * zero at 1440 - which is the fallback, and that is what TOPBAR-07 measures.
 */
export async function openGlobalBoard(page: Page) {
  await page.getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu-board").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("filter-project-chip")).toBeVisible({ timeout: 10000 });
}

/** The project chips that are REALLY visible (those past the cut are `invisible`). */
export async function inlineChips(page: Page) {
  return page.locator('[data-testid^="project-filter-chip-"]:visible').count();
}

/** The bar's row: a single row, and no chip past the right edge. */
export async function toolbarGeometry(page: Page) {
  return page.getByTestId("board-toolbar").evaluate((el) => {
    const strip = el.querySelector('[data-testid="project-filter-strip"]');
    const stripRight = strip ? strip.getBoundingClientRect().right : 0;
    const spill = Array.from(el.querySelectorAll('[data-testid^="project-filter-chip-"]'))
      .filter((c) => getComputedStyle(c).visibility !== "hidden")
      .map((c) => c.getBoundingClientRect().right - stripRight)
      .filter((over) => over > 0.5);
    return {
      height: Math.round(el.getBoundingClientRect().height),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      stripWidth: strip ? Math.round(strip.getBoundingClientRect().width) : -1,
      // COULD ONE MORE HAVE FITTED? Asked of the layout, not of a constant.
      //
      // Every chip is laid out, in order, inside a `w-max` row; the ones that
      // do not fit keep their box and only lose `visibility`. So the first
      // hidden chip knows exactly how much room it wanted: its right edge
      // measured from the strip's left. If that is beyond the strip, it really
      // did not fit and the menu is where it belongs. If it is inside, the
      // calculation hid something that had room, and that is a bug.
      //
      // This replaces «at least 3 chips», which was not a property of this
      // code: it was how many chips fit in 245px with the font on the author's
      // Mac. The CI runner draws wider glyphs, fits two, and reported the bar
      // as broken while it was packing correctly.
      firstHiddenOverhang: (() => {
        if (!strip) return null;
        const left = strip.getBoundingClientRect().left;
        const width = strip.getBoundingClientRect().width;
        const hidden = Array.from(el.querySelectorAll('[data-testid^="project-filter-chip-"]'))
          .find((c) => getComputedStyle(c).visibility === "hidden");
        if (!hidden) return null;
        return Math.round(hidden.getBoundingClientRect().right - left - width);
      })(),
      chain: (() => {
        const out: string[] = [];
        let n: Element | null = strip;
        while (n && n !== el) {
          const cs = getComputedStyle(n);
          out.push(`${n.className.toString().slice(0, 24)} w=${Math.round(n.getBoundingClientRect().width)} flex=${cs.flexGrow}/${cs.flexShrink}/${cs.flexBasis} min=${cs.minWidth}`);
          n = n.parentElement;
        }
        return out;
      })(),
      spill,
    };
  });
}

export async function audit(page: Page) {
  await page.addScriptTag({ content: AUDIT_JS });
  return page.evaluate(() => {
    const fn = (window as unknown as { __uiAudit: (o: unknown) => string }).__uiAudit;
    return JSON.parse(fn({ scope: '[data-testid="board-toolbar"]', minTap: 24 })) as {
      overflowX: { present: boolean; offenders: unknown[] };
      findings: { overlap: unknown[]; offscreen: unknown[] };
    };
  });
}

