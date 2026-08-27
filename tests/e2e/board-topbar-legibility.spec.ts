/**
 * board-topbar-legibility.spec.ts - the kanban top bar reads on its own.
 *
 * The bar was made of NUMBERS WITHOUT A SENTENCE: "Carico critico - max 1"
 * (what am I supposed to do?), "7 worktree" (a number of what?), "3 non su main"  allow-italian: the bar's own words
 * at the opposite end of the bar from "Pubblica", which talks about the same
 * thing. The explanation existed, but it lived entirely in the `title`s:
 * on a phone the tooltip does not exist, and with a mouse it has to be hunted.
 *
 * This spec measures the four properties that make the bar legible - no
 * tooltip, no eyeballing: geometry from the DOM and visible text.
 *
 *  - TOPBAR-01/02/03  the projects become FILTER CHIPS in the space that is
 *    left over, and when the space runs out they go back into the menu: never
 *    wrapping (it would push the board down), never a chip cut in half. Three
 *    widths: 1440 - 1000 - 390.
 *  - TOPBAR-04  the load chip appears ONLY when there is something to do
 *    (agents in flight > recommended) and it states the action, not the
 *    adjective.
 *  - TOPBAR-05  delivery is ONE control only: "not on main" and "on main, not
 *    published" are two sections of the same panel (they used to be two
 *    adjacent badges, read as the same alarm written twice), and the click
 *    opens the LIST of tasks, not the first one in it.
 *  - TOPBAR-06  the work-folder counter says what it is a count of, and on
 *    click explains what they are and how to free them (the GC lives in there).
 *  - TOPBAR-08  the project filter chips carry the PER-STATUS count, with the
 *    same glyphs as the "Board" row in the sidebar.
 *  - TOPBAR-09  the settings panel has sections with a title instead of ten
 *    identical rows, and the first one says that switch is global.
 *  - TOPBAR-10  THIS board's brake lives in its own settings, not among the
 *    global ones: the POSITION is what gets measured, because the position is
 *    what says whose lever it is.
 *  - TOPBAR-11  whoever is about to publish reads that the release goes out to
 *    everyone.
 *  - TOPBAR-12  the project chips have ONE width and ONE indent: with the
 *    favicon and without it, the row stays straight.
 *  - TOPBAR-13  no hairline runs under the bar: the chain from the bar to the
 *    root is inspected, because the border could have been on a wrapper.
 *  - TOPBAR-14  settings are entered from one place only, and the auto-dispatch
 *    state has a single copy (the menu used to keep one of its own).
 *  - TOPBAR-07  layout audit (`helpers/ui-audit.js`) at the three widths: no
 *    horizontal overflow, no overlap, nothing offscreen, a 40px row (the
 *    chrome's `h-10` contract).
 *
 * The system probes (dispatch capacity, worktrees, branches) are STUBBED via
 * `page.route`: the subject here is the bar, and making them tell the truth
 * would mean putting the machine under load and creating real worktrees - that
 * is, measuring the environment instead of the UI.
 */import { test } from "./fixtures/layout.fixture";
import { expect } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";
// The world the bar is measured in — four throwaway projects, the stubbed
// system probes, and the readers that turn the bar into numbers.
import {
  SHOTS, STAMP, ROOT, PROJECTS, dirOf, unlandedTitles,
  apiCreateTask, stubProbes, openProjectBoard, openGlobalBoard,
  inlineChips, toolbarGeometry, audit,
} from "./helpers/board-topbar";

hermetic(test);

/**
 * The bar has stopped redistributing when two consecutive reads of the chip
 * count agree.
 *
 * A ResizeObserver decides that count, so the honest wait is its OUTPUT going
 * quiet — not a stopwatch. This used to be spelled out inline with a fixed
 * 120 ms nap inside the poll, and guessed at with a flat 400 ms before the
 * layout audit; both are the same condition, so it lives in one place now.
 *
 * @covers KANBAN-12
 */
async function chipsSettled(page: import("@playwright/test").Page): Promise<number> {
  let previous = -1;
  let settled = -1;
  await expect
    .poll(
      async () => {
        const now = await inlineChips(page);
        const quiet = now === previous;
        previous = now;
        if (quiet) settled = now;
        return quiet;
      },
      { timeout: 8000, message: "la riga di chip non ha mai smesso di ridistribuirsi" },
    )
    .toBe(true);
  return settled;
}

/** Created here, torn down here: cleanup state belongs to the spec, not to a
 *  helper module two specs could quietly corrupt for each other. */
const topicIds: string[] = [];
const createdTasks: string[] = [];

test.describe("Top bar della kanban — si legge da sola", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(SHOTS, { recursive: true });
    for (const name of PROJECTS) {
      mkdirSync(dirOf(name), { recursive: true });
      writeFileSync(`${dirOf(name)}/package.json`, JSON.stringify({ name }, null, 2));
      const topic = await createTopic(request, `topbar-${name}-${STAMP}`, { projectPath: dirOf(name) });
      topicIds.push(topic.id);
    }
    // One open task per project (so every project is filterable) + two CLOSED
    // tasks, which the stubs will make show up as not landed on main.
    for (const name of PROJECTS) {
      createdTasks.push(await apiCreateTask(request, boardIdForPath(dirOf(name)), `Lavoro ${name} ${STAMP}`, "todo"));
    }
    for (const title of unlandedTitles) {
      createdTasks.push(await apiCreateTask(request, boardIdForPath(dirOf(PROJECTS[0])), title, "done"));
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

  test("TOPBAR-01/02/03: i progetti sono filtri quando c'è spazio, e tornano nel menu quando manca", async ({ page }) => {
    // `running: 1` = no load chip, that is the bar in its NORMAL state. With
    // the chip lit (246px of sentence) plus the work folders, at 1440 the row
    // is already full and the free space is zero: that is the fallback
    // working, and it is the case TOPBAR-07 measures - but it is not the width
    // at which you look at whether the projects know how to become filters.
    await stubProbes(page, { running: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openGlobalBoard(page);

    const conteggi: Record<string, number> = {};
    // The geometry travels in the messages: a "0 chips" without the width of
    // the free space does not say whether the calculation is broken or the
    // space was not there.
    const geometrie: Record<string, unknown> = {};
    for (const [etichetta, width] of [["larga", 1440], ["media", 1000], ["stretta", 390]] as const) {
      await page.setViewportSize({ width, height: 900 });
      // A ResizeObserver decides the count: wait for it to SETTLE, instead of
      // measuring the frame in which the row is still redistributing itself.
      conteggi[etichetta] = await chipsSettled(page);

      const g = await toolbarGeometry(page);
      geometrie[etichetta] = g;
      expect(g.spill, `${etichetta}: nessun chip deve sporgere dal contenitore (mai tagliato a metà)`).toEqual([]);
      // 36px, MEASURED: the board's bar is `py-1.5` around controls 24 high
      // (6+24+6), and it was that way before this round too. The `h-10` (40px)
      // contract belongs to the window's CHROME row, which is another row -
      // here it would be 40 only by changing the height of the board's header,
      // that is, a change nobody asked for. The fact that counts is that the
      // height does NOT change and the row stays one: if these 36 turn into 72,
      // the project chips have wrapped.
      expect(g.height, `${etichetta}: la barra resta UNA riga, alta 36px come prima`).toBe(36);

      await page.getByTestId("board-toolbar").screenshot({ path: join(SHOTS, `topbar-${etichetta}.png`) });
    }

    // The numbers travel with the verdict: without them, "wide >= medium"
    // would stay true even with 0 chips everywhere, that is, a green that
    // proves nothing.
    test.info().attach("geometria-e-conteggi", {
      contentType: "application/json",
      body: JSON.stringify({ conteggi, geometrie }, null, 2),
    });
    // AT 1440px THE PROJECTS BECOME FILTERS, and the bar is full: one more
    // would not have fitted.
    //
    // This used to read `>= 3`, which is not a property of this code: it is how
    // many chips fit in 245px with the font on the author's Mac. On the very
    // same tree the CI runner lays out two, and the red said "the projects do
    // not know how to become filters" about a bar that was packing them just
    // fine.
    //
    // The real property is that the packing is GREEDY: show everything that
    // fits, send back to the menu only what does not. And it is measurable
    // without knowing how many, because the excluded chips stay laid out and
    // only lose their visibility - so the first of them can be asked how far
    // it overhung. The gate can still fail, and that is the case that matters:
    // if the calculation hid a project that had room, that chip would sit
    // INSIDE the bar and the overhang would be negative.
    const g = geometrie.larga as { firstHiddenOverhang: number | null };
    expect(conteggi.larga, `a 1440px almeno un progetto e' un filtro — ${JSON.stringify(geometrie)}`).toBeGreaterThanOrEqual(1);
    if (g.firstHiddenOverhang !== null) {
      expect(
        g.firstHiddenOverhang,
        `a 1440px il primo progetto rimasto nel menu doveva sporgere dalla barra, invece ci stava per ${-g.firstHiddenOverhang}px — ${JSON.stringify(geometrie)}`,
      ).toBeGreaterThan(0);
    }
    expect(conteggi.media, "restringendo, i chip che non entrano tornano nel menu").toBeLessThan(conteggi.larga!);
    expect(conteggi.stretta, `a 390px la barra è già piena: nessun chip fuori dal menu — ${JSON.stringify(geometrie)}`).toBe(0);

    // ...and the menu remains the complete door: at 390px ALL the projects are there.
    await page.getByTestId("filter-project-chip").click();
    for (const name of PROJECTS) {
      await expect(page.getByRole("option", { name: new RegExp(`^${name}`) }), `«${name}» nel menu a 390px`).toBeVisible();
    }
  });

  test("TOPBAR-04: il chip del carico dice l'AZIONE, e non c'è quando non c'è niente da fare", async ({ page }) => {
    await stubProbes(page, { running: 4 }); // 4 in flight, 2 recommended
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const chip = page.getByTestId("load-advice-chip");
    await expect(chip).toBeVisible({ timeout: 20000 });
    // The VISIBLE text - not the `title` - has to say what is worth doing, and
    // say it in two words: the bar is a row of controls, not a place where a
    // sentence gets read. The rest lives in the popover, below.
    await expect(chip).toHaveText(/^Fermane 2$/);
    await chip.click();
    await expect(page.getByText("4 agent al lavoro, ne reggo 2")).toBeVisible();
    // The popover carries the REAL measure (the fleet's CPU), not the load average.
    await expect(page.getByText(/6\.2 core sui 6 che spettano loro/)).toBeVisible();
    await expect(page.getByText(/consiglio/)).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "popover-carico.png"), clip: { x: 0, y: 0, width: 1440, height: 320 } });
    await page.keyboard.press("Escape");

    // Same load, but no gap to act on -> the chip does not exist.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await stubProbes(page, { running: 1 });
    await page.reload();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
    // DELIBERATE FIXED WAIT: the assertion is that the chip NEVER appears, and
    // `toHaveCount(0)` is true of a board that has not finished loading too.
    // This is the window in which the chip would have had time to light up.
    await page.waitForTimeout(1000);
    await expect(chip, "senza scarto il chip non deve comparire").toHaveCount(0);
  });

  test("TOPBAR-05: la consegna è UN controllo con due gradini, e il click apre l'elenco", async ({ page }) => {
    await stubProbes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    // ONE button only: "N not on main" and "Publish M" were two adjacent badges
    // that read as the same alarm written twice.
    const badge = page.getByTestId("delivery-badge");
    await expect(badge).toBeVisible({ timeout: 20000 });
    await expect(badge).toContainText("Consegna");
    await expect(page.getByTestId("delivery-unlanded-count")).toHaveText("2");
    await expect(
      page.locator('[data-testid="delivery-badge"], button:has-text("Pubblica")'),
      "in barra non resta un secondo bottone di consegna",
    ).toHaveCount(1);

    // The click opens the WHOLE SET, not the first task. And the two steps have
    // two titles that say how they differ.
    await badge.click();
    const voci = page.getByTestId("unlanded-item");
    await expect(voci).toHaveCount(2);
    await expect(page.getByText("Non su main", { exact: true })).toBeVisible();
    await expect(page.getByText(/non ancora pubblicato/i)).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "popover-consegna.png"), clip: { x: 0, y: 0, width: 1440, height: 460 } });
    await expect(page.getByTestId("task-detail-drawer"), "l'elenco non apre nessun task da solo").toHaveCount(0);
    await voci.first().click();
    await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 10000 });
  });

  test("TOPBAR-06: le cartelle di lavoro dicono di cosa sono, e come si liberano", async ({ page }) => {
    await stubProbes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const badge = page.getByTestId("worktree-count-badge");
    await expect(badge).toBeVisible({ timeout: 20000 });
    await expect(badge, "il numero dice di che cosa è").toHaveText(/7 cartelle di lavoro/);
    await expect(badge, "i due accumuli restano distinti").toHaveText(/2 rami orfani/);

    await badge.click();
    await expect(page.getByText(/COPIA del repo/)).toBeVisible();
    await expect(page.getByTestId("worktree-branches-line")).toContainText("5 rami");
    await expect(page.getByTestId("worktree-gc-button"), "l'azione sta dove sta la spiegazione").toBeVisible();
    await page.screenshot({ path: join(SHOTS, "popover-cartelle.png"), clip: { x: 0, y: 0, width: 1440, height: 400 } });
  });

  test("TOPBAR-08: i filtri progetto dicono quanto lavoro c'è, e le impostazioni hanno sezioni", async ({ page, request }) => {
    // The lead project gets one task per status: without that, "per-status
    // count" would be tested on a single number, that is, not tested.
    const alfa = boardIdForPath(dirOf(PROJECTS[0]));
    createdTasks.push(await apiCreateTask(request, alfa, `Da guardare ${STAMP}`, "review"));
    createdTasks.push(await apiCreateTask(request, alfa, `In corso ${STAMP}`, "in_progress"));

    await stubProbes(page, { running: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    // The GLOBAL BOARD, for the same reason as TOPBAR-01: it is the surface on
    // which the project chips really sit in the bar. On the PROJECT board in
    // "all" mode the ~400px of extra controls leave zero free space, and the
    // chips stay behind the menu (which is the intended fallback, measured there).
    await openGlobalBoard(page);

    // 1. The count is ON the chip, not only inside the menu: the name alone
    //    does not say whether that project is waiting for somebody.
    const chipAlfa = page.getByTestId(`project-filter-chip-${alfa}`);
    await expect(chipAlfa).toBeVisible({ timeout: 15000 });
    const conteggi = chipAlfa.getByTestId("project-task-counts");
    await expect(conteggi).toBeVisible();
    // review 1 - in progress 1 - queued 1 (the "todo" seeded in the beforeAll).
    await expect(conteggi).toHaveText("111");
    // The two closed ones are not among the open ones, but the detail is in the
    // tooltip. NOT a native `title`: that one is drawn by the operating system,
    // arrives after more than a second and sits on a single line. Now it is a
    // component, and the test really opens it with the mouse instead of reading
    // an attribute.
    await expect(chipAlfa).not.toHaveAttribute("title", /./);
    await chipAlfa.hover();
    const tip = page.getByTestId("app-tooltip");
    await expect(tip).toBeVisible({ timeout: 3000 });
    await expect(tip).toContainText("Review: 1");
    await expect(tip).toContainText("Done: 2");
    // The project's LOCATION: it is what tells apart two projects with the same
    // name, and in the old tooltip it was simply absent. The test projects live
    // in /tmp, so here `homeTilde` shortens nothing and the path comes out
    // whole: that is fine, the assertion is that the path IS THERE.
    await expect(tip).toContainText(dirOf(PROJECTS[0]));
    // It stays inside the window: a tooltip half offscreen cannot be read.
    const box = await tip.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
    // And it goes away on its own when the mouse leaves: a tooltip that sticks
    // covers the board.
    await page.mouse.move(720, 700);
    await expect(tip).toBeHidden({ timeout: 3000 });

    // 2. The same count, in the same shape, inside the "Project" menu.
    await page.getByTestId("filter-project-chip").click();
    await expect(page.getByTestId("project-task-counts").first()).toBeVisible();
    await page.keyboard.press("Escape");

    await page.screenshot({ path: join(SHOTS, "chip-conteggi.png"), clip: { x: 0, y: 0, width: 1440, height: 200 } });

    // 3. And the delivery control: two steps, one panel. From here too - the
    //    global board sees them all together, which is the case in which the
    //    two separate numbers looked most alike.
    await page.getByTestId("delivery-badge").click();
    await expect(page.getByTestId("unlanded-item").first()).toBeVisible();
    await expect(page.getByText(/non ancora pubblicato/i)).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "barra-e-consegna.png"), clip: { x: 0, y: 0, width: 1440, height: 560 } });
  });

  /**
   * TOPBAR-12: the row of project chips is ONE row.
   *
   * It used to be two of everything. The chip that opens the menu was cut at
   * `11rem` and the suggestions next to it at `13rem`: the SAME name, on the
   * same row, truncated at two different points. And the icon box: a project
   * with the favicon on disk took 12px of it, one without it a 6px dot, so the
   * names behind them started from two different indents. Neither of the two
   * chips is wrong on its own: what gets noticed is the result, that is, a
   * crooked row.
   *
   * Here it is measured on the DOM, with a project THAT HAS the icon and one
   * that does not: that is the pair that threw the row out of line, and without
   * both of them the case does not come up.
   */
  test("TOPBAR-12: i chip progetto hanno una sola larghezza e un solo rientro", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-12" });
    // The icon on ONE project only. The fallback (no icon) stays on the other
    // three: it is the comparison between the two branches that made the defect
    // visible.
    writeFileSync(`${dirOf(PROJECTS[0])}/favicon.svg`,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#4f46e5"/></svg>');

    await stubProbes(page, { running: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openGlobalBoard(page);

    const firstChip = page.getByTestId(`project-filter-chip-${boardIdForPath(dirOf(PROJECTS[0]))}`);
    await expect(firstChip).toBeVisible({ timeout: 15000 });

    // The name's INDENT: where the text starts inside the chip, measured from
    // the chip's edge. It is the distance that changed between a project with
    // an icon and one without, and it is what reads as a "crooked row".
    const indents = await page.evaluate(() => {
      const out: Array<{ id: string; rientro: number; larghezzaMax: string }> = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="project-filter-chip-"]'))) {
        if (el.getBoundingClientRect().width === 0) continue;
        const nome = el.querySelector("span.truncate") ?? el.querySelector("span");
        if (!nome) continue;
        out.push({
          id: el.dataset.testid ?? "",
          rientro: Math.round(nome.getBoundingClientRect().x - el.getBoundingClientRect().x),
          larghezzaMax: getComputedStyle(el).maxWidth,
        });
      }
      return out;
    });

    expect(indents.length, "servono almeno due chip progetto in barra").toBeGreaterThan(1);
    // ONE INDENT ONLY, icon or no icon.
    const soli = [...new Set(indents.map((r) => r.rientro))];
    expect(soli, `rientri diversi: ${JSON.stringify(indents)}`).toHaveLength(1);
    // And ONE MAXIMUM WIDTH ONLY, including the chip that opens the menu, which
    // is the other half of the pair that diverged (11rem against 13rem).
    const openerMaxWidth = await page.getByTestId("filter-project-chip").evaluate((el) => getComputedStyle(el).maxWidth);
    const maxWidths = [...new Set([...indents.map((r) => r.larghezzaMax), openerMaxWidth])];
    expect(maxWidths, `larghezze massime diverse: ${maxWidths.join(" vs ")}`).toHaveLength(1);

    await page.screenshot({ path: join(SHOTS, "chip-fila-allineata.png"), clip: { x: 0, y: 0, width: 1440, height: 120 } });
  });

  test("TOPBAR-09: le impostazioni della board sono sezioni con un titolo", async ({ page }) => {
    await stubProbes(page, { running: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    // Sections with a title, not ten rows in a row. The first one says the
    // switch below it is GLOBAL: at the top of a flat list it read as a setting
    // of this board, which is the opposite of what it does.
    await page.getByTitle("Impostazioni auto-dispatch").click();
    const pannello = page.getByTestId("board-settings-panel");
    await expect(pannello).toBeVisible();
    for (const titolo of ["Vale per tutte le board", "Come lavora l'agente", "Dove lavora", "Quando parte", "Alla consegna"]) {
      await expect(pannello.getByText(titolo, { exact: true })).toBeVisible();
    }
    await page.screenshot({ path: join(SHOTS, "impostazioni-sezioni.png"), clip: { x: 0, y: 0, width: 1440, height: 620 } });
  });

  test("TOPBAR-11: chi sta per pubblicare legge che la release esce a tutti", async ({ page }) => {
    // On this repo main is shipped: the push fires the CI and, if it is green,
    // the installers reach the auto-updater of anyone who has Topics open. The
    // panel listed the commits and offered "Publish" without saying so: whoever
    // pressed it was deciding a publication no screen ever named.
    await stubProbes(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // The "to publish" step reads this route: with no project ahead the row
    // must not appear, so seeing it requires declaring one.
    //
    // And the route is armed BEFORE the navigation. It used to sit after
    // `openProjectBoard`, that is, after the board had already made its first
    // call: that one went out BARE, came back "no project ahead", and the row
    // was never born. The test passed only when a later polling round happened
    // to fall inside the stub - that is, by luck. The red that came out of it
    // ("publish-consequence not found") accused the row, which was not at fault
    // at all: nobody had ever given it the data it needed to exist.
    await page.route((url) => url.pathname.endsWith("/all-boards/publish-status"), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          projects: [{
            projectId: "topics-app", name: "topics-app", branch: "main", ahead: 3,
            commits: [{ hash: "abc1234", subject: "cancello CI prima della release", author: "jarvis", when: "2h fa" }],
          }],
        }),
      }));

    await page.goto("/");
    await openProjectBoard(page);

    await page.getByTestId("delivery-badge").click();
    const riga = page.getByTestId("publish-consequence");
    await expect(riga).toBeVisible();
    // It names WHO receives it: "publishes the branch" would be true and useless.
    await expect(riga).toContainText(/tutti/i);

    // And it sits ABOVE the button: a consequence written below the gesture
    // gets read after the gesture has been made.
    //
    // The two measurements live inside a `toPass`, and the `!` is gone. The
    // delivery panel redraws when the `publish-status` response arrives - which
    // here is STUBBED with a `route` registered after the board has loaded, so
    // the first round may already be under way and the row appears, disappears
    // and reappears. In that window `boundingBox()` returns `null`, and
    // `(...)!.y` did not fail on an assertion: it blew up with "Cannot read
    // properties of null (reading 'y')", that is, a TypeError that names
    // neither the row nor the button. Measuring a geometry is only legitimate
    // once the layout has settled: here it is retaken until both rectangles
    // exist.
    const bottonePubblica = page.getByRole("button", { name: "Pubblica" }).first();
    await expect(async () => {
      const [boxRiga, boxBottone] = await Promise.all([
        riga.boundingBox(),
        bottonePubblica.boundingBox(),
      ]);
      expect(boxRiga, "la riga della conseguenza deve avere un rettangolo").not.toBeNull();
      expect(boxBottone, "il bottone «Pubblica» deve avere un rettangolo").not.toBeNull();
      expect(boxRiga!.y, "la conseguenza sta sopra il bottone").toBeLessThan(boxBottone!.y);
    }).toPass({ timeout: 10000 });

    // And it has to be LEGIBLE: an amber notice on a light background is
    // exactly the place where contrast goes away, and a notice that cannot be
    // read is not a notice. Measured against the colour actually painted behind
    // it (an ancestor with a background changes the result), not against the
    // one in the stylesheet.
    const contrasto = await riga.evaluate((el) => {
      // The app's colours are in oklch: a regex over the numbers reads them as
      // if they were rgb and returns an invented contrast (the first draft of
      // this case said 11.7 on a light amber painted on white, and passed). The
      // only honest way is to have the browser paint them and read the pixels
      // back: colour space, alpha and compositing are done by whoever draws them.
      const dipingi = (colore: string, sotto?: string) => {
        const c = document.createElement("canvas"); c.width = c.height = 1;
        const g = c.getContext("2d")!;
        if (sotto) { g.fillStyle = sotto; g.fillRect(0, 0, 1, 1); }
        g.fillStyle = colore; g.fillRect(0, 0, 1, 1);
        const d = g.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      const canale = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const lum = (p: number[]) =>
        0.2126 * canale(p[0] / 255) + 0.7152 * canale(p[1] / 255) + 0.0722 * canale(p[2] / 255);
      // The background is the one actually painted behind: an ancestor with a
      // background changes the result, so we walk up until an opaque one is found.
      let sfondo = "rgb(255,255,255)";
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && c !== "transparent" && !c.startsWith("rgba(0, 0, 0, 0)")) { sfondo = c; break; }
      }
      const bg = dipingi(sfondo);
      const fg = dipingi(getComputedStyle(el).color, sfondo);
      const l = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return { rapporto: (l[0] + 0.05) / (l[1] + 0.05), fg, bg };
    });
    expect(contrasto.rapporto, "l'avviso di pubblicazione deve reggere WCAG AA su testo piccolo").toBeGreaterThanOrEqual(4.5);

    await page.screenshot({ path: join(SHOTS, "pubblica-conseguenza.png"), clip: { x: 0, y: 0, width: 1440, height: 460 } });
  });

  test("TOPBAR-10: il freno di QUESTA board sta nelle sue impostazioni, non fra le globali", async ({ page }) => {
    // The panel has two levers that look alike and are not the same thing: the
    // GLOBAL auto-dispatch (it applies to all of them) and this board's pause.
    // If they ended up in the same section, the second would read as a
    // duplicate of the first - which is the defect this panel deliberately
    // avoids by keeping the "applies to all boards" section separate from the rest.
    await stubProbes(page, { running: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);
    await page.getByTitle("Impostazioni auto-dispatch").click();

    const pannello = page.getByTestId("board-settings-panel");
    await expect(pannello).toBeVisible();
    const pausa = page.getByTestId("board-dispatch-paused");
    await expect(pausa).toBeVisible();

    // It is born NOT paused: no board pauses itself.
    await expect(pausa).not.toBeChecked();

    // And it sits under "how the agent works", not under the global ones: the
    // POSITION is what gets measured, because the position is what says whose
    // lever it is.
    const globali = pannello.getByText("Vale per tutte le board", { exact: true });
    const agente = pannello.getByText("Come lavora l'agente", { exact: true });
    const yGlobali = (await globali.boundingBox())!.y;
    const yAgente = (await agente.boundingBox())!.y;
    const yPausa = (await pausa.boundingBox())!.y;
    expect(yPausa).toBeGreaterThan(yGlobali);
    expect(yPausa).toBeGreaterThan(yAgente);

    await page.screenshot({ path: join(SHOTS, "board-pausa.png"), clip: { x: 0, y: 0, width: 1440, height: 620 } });
  });

  test("TOPBAR-07: audit di layout alle tre larghezze (niente overflow, niente sovrapposizioni)", async ({ page }) => {
    await stubProbes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    for (const [etichetta, width] of [["larga", 1440], ["media", 1000], ["stretta", 390]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await chipsSettled(page);
      const a = await audit(page);
      expect(a.overflowX.present, `${etichetta}: overflow orizzontale del documento — ${JSON.stringify(a.overflowX.offenders)}`).toBe(false);
      expect(a.findings.overlap, `${etichetta}: controlli sovrapposti`).toEqual([]);
      expect(a.findings.offscreen, `${etichetta}: controlli fuori dal bordo sinistro`).toEqual([]);
      // Targets: the WCAG 2.2 AA minimum is 24x24, and it is also the maximum a
      // 36px chrome row can give without breaking the row's height (the 44px of
      // Apple's HIG do not fit by construction - see the note at the top of the
      // file). The NEW controls of this round have to fit inside it; the rest of
      // the bar is as it was.
      //
      // Measured by TESTID and not from the audit's result: `ui-audit.js`
      // identifies elements by tag+class (`button.flex.items-center`), and a
      // testid filter over those strings would NEVER match - it would be an
      // assertion that cannot fail.
      const piccoli = await page.evaluate(() => {
        const sel = '[data-testid="load-advice-chip"],[data-testid="delivery-badge"],[data-testid="worktree-count-badge"],[data-testid^="project-filter-chip-"]';
        return Array.from(document.querySelectorAll(sel))
          .filter((el) => getComputedStyle(el).visibility !== "hidden")
          .map((el) => ({ id: el.getAttribute("data-testid"), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }))
          .filter((b) => b.w < 24 || b.h < 24);
      });
      expect(piccoli, `${etichetta}: bersagli nuovi sotto 24px`).toEqual([]);
    }
  });

  /**
   * TOPBAR-13: no hairline runs under the bar.
   *
   * The line was there, and it drew a boundary that was already visible on its
   * own: below the bar the board begins, which has a different background and
   * the columns. The strips that appear in between (error, drop notice,
   * archive, settings) carry their own border when they are needed, so the
   * fixed hairline was redundant exactly when it served no purpose.
   *
   * Today the rule lives in a COMMENT above the node in `KanbanBoardPane.tsx`,
   * and a comment stops nothing: whoever adds a `border-b` to the wrapper does
   * not read it. Here the rule becomes a measurement, and the CHAIN from the
   * bar to the board's root is inspected - the hairline could have been on any
   * one of the wrappers, not only on the bar.
   */
  test("TOPBAR-13: sotto la barra non c'e' nessun filetto", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-12" });
    await stubProbes(page, { running: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    /** The bottom borders of the whole bar -> root chain, read from the computed style. */
    const bottomBorders = () =>
      page.evaluate(() => {
        const barra = document.querySelector('[data-testid="board-toolbar"]');
        const root = document.querySelector('[data-testid="kanban-board"]');
        if (!barra || !root) return null;
        const out: { nodo: string; larghezza: string; stile: string; colore: string }[] = [];
        let el: Element | null = barra;
        while (el) {
          const cs = getComputedStyle(el);
          out.push({
            nodo: el.getAttribute("data-testid") ?? el.tagName.toLowerCase(),
            larghezza: cs.borderBottomWidth,
            stile: cs.borderBottomStyle,
            colore: cs.borderBottomColor,
          });
          if (el === root) break;
          el = el.parentElement;
        }
        return out;
      });

    /**
     * Visible = it has a width, it has a style, and it is not transparent.
     *
     * Transparency is read ONLY from `rgba(...)` with a zero alpha. The first
     * version looked for a comma-zero at the end of the string, and that filter
     * threw away `rgb(255, 0, 0)` too: pure red ends in ", 0)" because its BLUE
     * channel is zero. The non-vacuous half below caught it, by putting in a red
     * hairline and never finding it again - that is, the sieve was blind in
     * exactly the direction in which it was supposed to bite.
     */
    const isTransparent = (colore: string) =>
      colore === "transparent" || /^rgba\([^)]*,\s*0(\.0+)?\s*\)$/.test(colore);
    const visibleBorders = (catena: NonNullable<Awaited<ReturnType<typeof bottomBorders>>>) =>
      catena.filter((n) => parseFloat(n.larghezza) > 0 && n.stile !== "none" && !isTransparent(n.colore));

    const catena = await bottomBorders();
    expect(catena, "barra o radice della board non trovate").not.toBeNull();
    expect(
      visibleBorders(catena!),
      `un filetto sotto la barra: ${JSON.stringify(visibleBorders(catena!))}`,
    ).toEqual([]);

    // THE SIEVE BITES. Without this second half, a mistake in the walk over the
    // nodes (wrong selector, a chain that does not climb) would give an empty
    // list and a green for the wrong reason: a hairline put in by hand has to be
    // found.
    await page.evaluate(() => {
      const barra = document.querySelector('[data-testid="board-toolbar"]') as HTMLElement;
      barra.style.borderBottom = "1px solid rgb(255, 0, 0)";
    });
    const withHairline = visibleBorders((await bottomBorders())!);
    expect(withHairline.length, "la misura non riconosce nemmeno un filetto messo a mano").toBeGreaterThan(0);
  });

  /**
   * TOPBAR-14: one single door to the settings.
   *
   * There were two of them, half a centimetre apart: the gear at the end of the
   * bar and a caret menu next to the board's title. They were not two roads to
   * the same room - the caret kept a COPY OF ITS OWN of the auto-dispatch
   * state, so the two doors could say different things about the same switch,
   * and which of the two was right depended on which had been opened last.
   *
   * The oracle is therefore double, and the second half is the one that counts:
   * it is not enough for the BUTTONS to be one, the COPY of the state has to be
   * one too. With the panel closed, no auto-dispatch control is visible in the
   * board; with it open, exactly one is.
   */
  test("TOPBAR-14: alle impostazioni si entra da un posto solo, e lo stato ha una copia sola", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-12" });
    await stubProbes(page, { running: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const board = page.getByTestId("kanban-board");
    const porta = board.getByTitle("Impostazioni auto-dispatch");
    const dispatchState = board.getByTestId("global-cap-control");
    const pannello = page.getByTestId("board-settings-panel");

    // ONE door, not two.
    await expect(porta, "le porte alle impostazioni non sono una").toHaveCount(1);

    // With the panel closed the auto-dispatch state is nowhere to be seen: it
    // was precisely the caret's copy that made it visible in the bar.
    await expect(pannello).toHaveCount(0);
    await expect(dispatchState, "lo stato dell'auto-dispatch e' fuori dal pannello").toHaveCount(0);

    // Once the door is opened: the panel is there, and the copy of the state is ONE.
    await porta.click();
    await expect(pannello).toBeVisible();
    await expect(dispatchState, "due copie dello stato dell'auto-dispatch").toHaveCount(1);

    // THE SIEVE BITES: `dispatchState` can recognise the control when it really
    // is there - the zero count above is a measured absence, not a selector that
    // never finds anything.
    await expect(dispatchState).toBeVisible();

    await page.screenshot({ path: join(SHOTS, "porta-unica.png"), clip: { x: 0, y: 0, width: 1440, height: 620 } });
  });
});
