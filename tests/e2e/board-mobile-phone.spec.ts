/**
 * THE BOARD ON A PHONE, MEASURED (asked on 05/10/2026).
 *
 * The user's four complaints (quoted in openspec/specs/kanban/spec.md,
 * KANBAN-MOBILE-01..04): the board's top bar scrolls vertically, its search
 * field is too small, the columns should fill the height unless the cards
 * overflow, and a scrolled column must keep room under its last card. Each
 * sentence is a number read from the DOM here, on the engine the
 * app ships in (WebKit), on a 390x844 phone with a finger and the iPhone's
 * safe-area bands forced (`--sat`/`--sab`, the variables the app reads).
 *
 *  KANBAN-MOBILE-01  the top bar never scrolls vertically (phone, landscape, iPad)
 *  KANBAN-MOBILE-02  under a finger the search field and every control of the
 *                    bar are 44 tall, and on a phone the field is the row
 *  KANBAN-MOBILE-03  a column fills the height whatever it holds, and scrolls
 *                    only when its cards overflow
 *  KANBAN-MOBILE-04  scrolled to its end, the last card keeps room above the
 *                    composer and the buttons - also when the band grows
 *  KANBAN-MOBILE-05  the card chips read in the light theme (4.5:1)
 *
 * @covers KANBAN-MOBILE-01 KANBAN-MOBILE-02 KANBAN-MOBILE-03 KANBAN-MOBILE-04 KANBAN-MOBILE-05 KANBAN-12
 */
import { test, expect, type Page } from "@playwright/test";
import { deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { waitForLayoutSettled } from "./helpers/layout";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";
import { auditSurface } from "./helpers/usability-audit";

hermetic(test);

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const STAMP = `mk${Date.now().toString(36)}`;
const PROJECT_ID = projectIdForPath(`${canonicalTmpRoot()}/e2e-board-phone-${STAMP}`);
const SHOTS = process.env.BOARD_PHONE_SHOTS;
const taskIds: string[] = [];

/** The iPhone 14's bands, the way the app reads them (index.css `--sat`/`--sab`). */
const PORTRAIT = { t: 47, b: 34, l: 0, r: 0 };
/** Below this the last card reads as glued to what floats under it. */
const MIN_BREATH = 12;

test.beforeAll(async ({ request }) => {
  const seed: Array<[string, string, number]> = [];
  // Backlog OVERFLOWS a phone; Todo holds two cards and must still fill.
  for (let i = 0; i < 14; i++) seed.push([`${STAMP} backlog ${i} con un titolo che va a capo su due righe`, "backlog", 2]);
  seed.push([`${STAMP} todo alta`, "todo", 3], [`${STAMP} todo media`, "todo", 2]);
  for (const [text, status, priority] of seed) {
    const res = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text, status, priority, description: "Accettazione misurata." } });
    expect(res.ok(), await res.text()).toBe(true);
    taskIds.push(((await res.json()) as { id: string }).id);
  }
  await resetPaneStore(request, []);
});

test.afterAll(async ({ request }) => {
  for (const id of taskIds) await deleteTask(request, PROJECT_ID, id).catch(() => {});
  await resetPaneStore(request, []);
});

async function openBoard(page: Page, inset = PORTRAIT) {
  await page.addInitScript((i) => {
    const apply = () => {
      const s = document.documentElement.style;
      s.setProperty("--sat", `${i.t}px`); s.setProperty("--sab", `${i.b}px`);
      s.setProperty("--sal", `${i.l}px`); s.setProperty("--sar", `${i.r}px`);
    };
    if (document.documentElement) apply();
    document.addEventListener("DOMContentLoaded", apply);
  }, inset);
  await page.goto(E2E_BASE);
  const door = page.locator('[data-testid="mobile-chrome-board"]');
  if (await door.isVisible({ timeout: 5000 }).catch(() => false)) await door.tap();
  else await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "board" } })));
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.locator('[data-testid="kanban-column-body-backlog"] [data-task-card]').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(14);
  await waitForLayoutSettled(page, '[data-testid="kanban-board"]');
}

/** Narrows the board to this file's cards, through the search field itself. */
async function onlyOurCards(page: Page) {
  await page.getByTestId("filter-token-input").tap();
  await page.keyboard.type(STAMP);
  await page.keyboard.press("Escape");
  await page.getByTestId("filter-token-input").blur();
  await expect.poll(() => page.locator('[data-testid="kanban-column-body-todo"] [data-task-card]').count()).toBe(2);
  await waitForLayoutSettled(page, '[data-testid="kanban-board"]');
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** The bar's two axes, as the browser computed them. */
async function toolbarAxes(page: Page) {
  return page.getByTestId("board-toolbar").evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      overflowY: cs.overflowY,
      clientH: el.clientHeight,
      scrollH: el.scrollHeight,
      // A user can scroll an axis only when it is a scroll axis AND something overflows it.
      scrollsVertically: (cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight,
    };
  });
}

test.describe("La board sul telefono", () => {
  test.describe.configure({ timeout: 90_000 });

  for (const vp of [
    { name: "telefono", w: 390, h: 844, inset: PORTRAIT },
    { name: "orizzontale", w: 844, h: 390, inset: { t: 0, b: 21, l: 47, r: 47 } },
    { name: "ipad", w: 820, h: 1180, inset: { t: 24, b: 20, l: 0, r: 0 } },
  ]) {
    test(`KANBAN-MOBILE-01 ${vp.name}: la barra in alto non scorre in verticale`, async ({ page }) => {
      test.info().annotations.push({ type: "spec", description: "KANBAN-MOBILE-01" });
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await openBoard(page, vp.inset);
      const axes = await toolbarAxes(page);
      console.log("TOOLBAR", vp.name, JSON.stringify(axes));
      await shot(page, `barra-${vp.name}`);
      expect(axes.scrollsVertically, `la barra scorre in verticale: ${JSON.stringify(axes)}`).toBe(false);
    });
  }

  test("KANBAN-MOBILE-02: col dito il campo di ricerca e i controlli della barra sono alti 44, e il campo e' la riga", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-MOBILE-02" });
    test.info().annotations.push({ type: "spec", description: "KANBAN-12" });
    await openBoard(page);
    const m = await page.evaluate(() => {
      const box = (el: Element | null) => { const r = el!.getBoundingClientRect(); return { x: r.x, w: Math.round(r.width), h: Math.round(r.height) }; };
      const bar = document.querySelector('[data-testid="board-toolbar"]')!;
      // Every control of the bar: the outermost rounded box that takes the pointer.
      const controls: Array<{ label: string; h: number }> = [];
      const walk = (el: Element) => {
        for (const c of Array.from(el.children)) {
          const cs = getComputedStyle(c); const r = c.getBoundingClientRect();
          if (cs.visibility === "hidden" || cs.display === "none" || r.width < 1 || cs.pointerEvents === "none") continue;
          if ((parseFloat(cs.borderTopLeftRadius) || 0) > 0) {
            controls.push({ label: c.getAttribute("data-testid") || c.getAttribute("aria-label") || (c.textContent || "").trim().slice(0, 20), h: Math.round(r.height) });
            continue;
          }
          walk(c);
        }
      };
      walk(bar);
      return {
        vw: window.innerWidth,
        field: box(document.querySelector('[data-testid="filter-token-field"]')),
        input: box(document.querySelector('[data-testid="filter-token-input"]')),
        controls,
      };
    });
    console.log("SEARCH", JSON.stringify(m));
    await shot(page, "ricerca");
    expect(m.field.h, "il campo di ricerca e' un bersaglio da dito").toBeGreaterThanOrEqual(44);
    expect(m.input.h, "e l'<input> lo riempie: e' lui che riceve il tocco").toBeGreaterThanOrEqual(44);
    expect(m.field.w, `sul telefono il campo prende la riga: ${m.field.w} su ${m.vw}`).toBeGreaterThanOrEqual(Math.round(m.vw * 0.75));
    const short = m.controls.filter((c) => c.h < 44);
    expect(m.controls.length).toBeGreaterThanOrEqual(3);
    expect(short, `controlli della barra sotto i 44px col dito: ${JSON.stringify(short)}`).toEqual([]);
  });

  test("KANBAN-MOBILE-03: la colonna riempie l'altezza con due card, e scorre solo quando le card sforano", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-MOBILE-03" });
    await openBoard(page);
    await onlyOurCards(page);
    const g = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('[data-testid="kanban-columns-row"]')!;
      const cs = getComputedStyle(row);
      const inner = row.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const col = (s: string) => {
        const c = document.querySelector<HTMLElement>(`[data-testid="kanban-column-${s}"]`)!;
        const b = document.querySelector<HTMLElement>(`[data-testid="kanban-column-body-${s}"]`)!;
        return { h: c.getBoundingClientRect().height, bodyClient: b.clientHeight, bodyScroll: b.scrollHeight };
      };
      return { inner, todo: col("todo"), backlog: col("backlog") };
    });
    console.log("COLUMNS", JSON.stringify(g));
    await shot(page, "colonne");
    expect(Math.abs(g.todo.h - g.inner), `Todo con due card non riempie l'altezza: ${JSON.stringify(g)}`).toBeLessThanOrEqual(1);
    expect(Math.abs(g.backlog.h - g.inner)).toBeLessThanOrEqual(1);
    expect(g.todo.bodyScroll, "con due card Todo non deve scorrere").toBeLessThanOrEqual(g.todo.bodyClient);
    expect(g.backlog.bodyScroll, "quattordici card sforano: Backlog scorre").toBeGreaterThan(g.backlog.bodyClient);
  });

  test("KANBAN-MOBILE-04: in fondo alla colonna l'ultima card ha spazio sotto, anche quando la banda cresce", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-MOBILE-04" });
    await openBoard(page);
    await onlyOurCards(page);
    const atEnd = async () => {
      await page.evaluate(() => { const b = document.querySelector<HTMLElement>('[data-testid="kanban-column-body-backlog"]')!; b.scrollTop = b.scrollHeight; });
      await waitForLayoutSettled(page, '[data-testid="kanban-column-body-backlog"]');
      return page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('[data-testid="kanban-column-body-backlog"] [data-task-card]'));
        const last = cards[cards.length - 1]!.getBoundingClientRect();
        const composer = document.querySelector('[data-testid="board-task-composer"]')!.getBoundingClientRect();
        const bar = document.querySelector('[data-testid="mobile-chrome-bar"]')?.getBoundingClientRect();
        return { lastBottom: Math.round(last.bottom), composerTop: Math.round(composer.top), barTop: bar ? Math.round(bar.top) : null };
      });
    };
    const rest = await atEnd();
    console.log("FONDO", JSON.stringify(rest));
    await shot(page, "fondo-colonna");
    expect(rest.barTop, "la fila dei tasti del telefono deve esserci").not.toBeNull();
    expect(rest.composerTop - rest.lastBottom, `l'ultima card e' incollata al composer: ${JSON.stringify(rest)}`).toBeGreaterThanOrEqual(MIN_BREATH);
    expect(rest.lastBottom).toBeLessThan(rest.barTop!);

    // The band over the buttons grows (the «Utilizzo Claude» notice publishes
    // `--mobile-transport-h`): the composer rises with it, and the room under the
    // last card has to follow - a constant cannot.
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--mobile-transport-h", "48px");
      window.dispatchEvent(new Event("resize"));
    });
    await waitForLayoutSettled(page, '[data-testid="kanban-board"]');
    const grown = await atEnd();
    console.log("FONDO-BANDA", JSON.stringify(grown));
    await shot(page, "fondo-colonna-banda");
    expect(grown.composerTop, "il composer deve essersi alzato con la banda").toBeLessThan(rest.composerTop);
    expect(grown.composerTop - grown.lastBottom, `con la banda piu' alta l'ultima card finisce sotto il composer: ${JSON.stringify(grown)}`).toBeGreaterThanOrEqual(MIN_BREATH);
  });

  test("KANBAN-MOBILE-05: nel tema chiaro i chip delle card si leggono", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-MOBILE-05" });
    await page.emulateMedia({ colorScheme: "light" });
    await openBoard(page);
    await onlyOurCards(page);
    // Todo is the second slide: bring it in, the chips under test live there.
    await page.evaluate(() => document.querySelector('[data-testid="kanban-column-todo"]')!.scrollIntoView({ inline: "center", block: "nearest" }));
    await waitForLayoutSettled(page, '[data-testid="kanban-column-todo"]');
    await shot(page, "chip-tema-chiaro");
    const audit = await auditSurface(page, '[data-testid="kanban-column-todo"]', 44);
    const failing = [
      ...audit.axe.filter((v) => v.id === "color-contrast").flatMap((v) => v.nodes.map((n) => `${n.target} :: ${n.summary}`)),
      ...audit.contrastDecided.filter((c) => !c.exempt && c.ratio != null && c.needed != null && c.ratio < c.needed).map((c) => `${c.text} ${c.ratio}:1 < ${c.needed}`),
    ];
    console.log("CONTRASTO", JSON.stringify(failing));
    expect(failing, "testo dei chip sotto il contrasto minimo nel tema chiaro").toEqual([]);
  });
});
