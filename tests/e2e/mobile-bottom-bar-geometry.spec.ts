/**
 * THE BOTTOM ROW, MEASURED BUTTON BY BUTTON — and the «Utilizzo Claude» band the list passes under.
 *
 * Asked from a phone (01/10): the buttons do not follow the bottom curve, the
 * first and the last are not the right height and their icons are not
 * centred. Every sentence is a number read off the DOM, on all five buttons:
 *
 * MOBILE-GEOM-01  the five buttons have the same height and the same bottom
 *                 edge (on the glass): none is lifted by the arc
 * MOBILE-GEOM-02  the centre of the icon is the centre of the button, both
 *                 horizontally and vertically, first and last included (±1px)
 * MOBILE-GEOM-03  the OUTER bottom corner of the first and the last carries the
 *                 screen radius (concentric, flush with the edge), the ones in
 *                 the middle stay standard
 * MOBILE-GEOM-04  with the «Utilizzo Claude» band on screen the list scrolls
 *                 UNDER the band (its ground is translucent, the scroller
 *                 reaches the glass) and at the end the last row sits above it
 * MOBILE-GEOM-05  the document runs under the home indicator (viewport-fit=cover),
 *                 keeps the OPAQUE status bar (`black`, see index.html), and its
 *                 ground is the chrome's: no empty band
 *
 * The bottom band and the radius are FORCED (`--sab`, `--screen-corner-radius`):
 * headless WebKit has no home indicator, but the code reads only those two
 * variables.
 *
 * @covers LAYOUT-02
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { waitForLayoutSettled } from "./helpers/layout";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const BAR = '[data-testid="mobile-chrome-bar"]';
const SCROLLER = '[aria-label="Topics sidebar"] .sidebar-column';
const SHOTS = process.env.GEOM_SHOTS_DIR;
const TAG = process.env.GEOM_TAG ?? "x";
/** Home-indicator band and corner radius of an iPhone with a Dynamic Island. */
const BAND = 34;
const RADIUS = 55;
const STANDARD = 12;
const CROWD = 14;

let ids: string[] = [];

test.beforeAll(async ({ request }) => {
  for (let i = 0; i < CROWD; i++) ids.push((await createTopic(request, `Geometria fila ${i}`)).id);
  await resetPaneStore(request, ids);
});

test.afterAll(async ({ request }) => {
  await request.post("/api/test/plan-usage", { data: { clear: true } });
  await resetPaneStore(request, []);
  for (const id of ids) await deleteTopic(request, id);
  ids = [];
});

async function open(page: Page) {
  await page.goto(E2E_BASE);
  await expect(page.locator(BAR)).toBeVisible();
  await page.evaluate(([band, radius]) => {
    const s = document.documentElement.style;
    s.setProperty("--sab", `${band}px`);
    s.setProperty("--screen-corner-radius", `${radius}px`);
    window.dispatchEvent(new Event("resize"));
  }, [BAND, RADIUS] as const);
  // The slabs grow by the band: wait for that, then for the row to stop moving.
  await expect
    .poll(() => page.evaluate((sel) => document.querySelector(`${sel} button`)?.getBoundingClientRect().height ?? 0, BAR))
    .toBeGreaterThanOrEqual(44 + BAND - 1);
  await waitForLayoutSettled(page, BAR);
}

/** Rect, centre and radii of every button, plus its glyph (the icon, not the label). */
async function buttons(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid="mobile-chrome-bar"]')!;
    return Array.from(bar.querySelectorAll<HTMLElement>("button")).map((b) => {
      const r = b.getBoundingClientRect();
      // The glyph: the svg (lucide), or the avatar/initials circle.
      const g = (b.querySelector("svg") ?? b.querySelector<HTMLElement>(".rounded-full")) as Element;
      const gr = g.getBoundingClientRect();
      const s = getComputedStyle(b);
      const px = (v: string) => parseFloat(v) || 0;
      return {
        id: b.getAttribute("data-testid") ?? b.getAttribute("title"),
        top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        height: r.height, width: r.width,
        fromBottom: window.innerHeight - r.bottom,
        dcx: gr.left + gr.width / 2 - (r.left + r.width / 2),
        dcy: gr.top + gr.height / 2 - (r.top + r.height / 2),
        glyph: { w: gr.width, h: gr.height },
        radii: { bottomLeft: px(s.borderBottomLeftRadius), bottomRight: px(s.borderBottomRightRadius), topLeft: px(s.borderTopLeftRadius), topRight: px(s.borderTopRightRadius) },
      };
    });
  });
}

async function shotBar(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${TAG}-${name}.png` });
  await page.screenshot({ path: `${SHOTS}/${TAG}-${name}-barra.png`, clip: { x: 0, y: 844 - 120, width: 390, height: 120 } });
}

test("MOBILE-GEOM-01/02/03 — cinque tasti alla stessa altezza, icone centrate, angoli concentrici", async ({ page }) => {
  await open(page);
  const t = await buttons(page);
  console.log("TASTI", JSON.stringify(t.map((x) => ({ id: x.id, h: x.height, w: Math.round(x.width), fromBottom: x.fromBottom, dcx: +x.dcx.toFixed(2), dcy: +x.dcy.toFixed(2), r: x.radii }))));
  await shotBar(page, "barra");
  expect(t.length).toBe(5);

  // 01 — same height, same top edge, same bottom edge, all on the glass.
  expect(new Set(t.map((x) => Math.round(x.height))).size, "altezze diverse").toBe(1);
  expect(new Set(t.map((x) => Math.round(x.top))).size, "bordi alti diversi").toBe(1);
  for (const x of t) expect(Math.round(x.fromBottom), `${x.id} non e' sul vetro`).toBe(0);

  // 02 — the centre of the glyph is the centre of the button, on both axes.
  for (const x of t) {
    expect(Math.abs(x.dcx), `${x.id} dcx`).toBeLessThanOrEqual(1);
    expect(Math.abs(x.dcy), `${x.id} dcy`).toBeLessThanOrEqual(1);
  }

  // 03 — first and last: outer corner concentric with the glass; the rest standard.
  const first = t[0]!;
  const last = t[4]!;
  expect(first.radii.bottomLeft).toBeCloseTo(RADIUS, 0);
  expect(last.radii.bottomRight).toBeCloseTo(RADIUS, 0);
  expect(first.radii.bottomRight).toBe(STANDARD);
  expect(last.radii.bottomLeft).toBe(STANDARD);
  for (const x of t.slice(1, -1)) {
    expect(x.radii.bottomLeft).toBe(STANDARD);
    expect(x.radii.bottomRight).toBe(STANDARD);
  }
});

test("MOBILE-GEOM-04 — con la banda «Utilizzo Claude» la lista scorre sotto la banda", async ({ page, request }) => {
  await request.post("/api/test/plan-usage", { data: { fiveHour: { utilization: 92, resetsAtMs: Date.now() + 3 * 3_600_000 } } });
  await open(page);
  const band = page.getByTestId("mobile-transport-band");
  await expect(band).toBeVisible();
  await expect(page.getByTestId("plan-usage-notice")).toBeVisible();
  await waitForLayoutSettled(page);

  const read = () => page.evaluate(() => {
    const column = document.querySelector('[aria-label="Topics sidebar"]')!;
    const scroller = column.querySelector<HTMLElement>(".sidebar-column")!;
    const b = document.querySelector<HTMLElement>('[data-testid="mobile-transport-band"]')!;
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const bs = getComputedStyle(b);
    // rgba(r, g, b, a) · rgb(r g b / a) · color(srgb r g b / a): alpha is the last number after the slash or the fourth comma.
    const alpha = (c: string) => { const m = c.match(/\/\s*([\d.]+%?)\s*\)/) ?? c.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/); if (!m) return 1; return m[1]!.endsWith("%") ? parseFloat(m[1]!) / 100 : parseFloat(m[1]!); };
    return {
      vh: window.innerHeight,
      scrollerBottom: scroller.getBoundingClientRect().bottom,
      bandTop: b.getBoundingClientRect().top,
      bandAlpha: alpha(bs.backgroundColor),
      bandBlur: (bs.backdropFilter || (bs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || "none"),
      lastBottom: rows.length ? rows[rows.length - 1]!.getBoundingClientRect().bottom : null,
      overflow: scroller.scrollHeight - scroller.clientHeight,
      rows: rows.length,
    };
  });
  await expect.poll(async () => (await read()).rows).toBeGreaterThan(8);
  const atRest = await read();
  console.log("BANDA-RIPOSO", JSON.stringify(atRest));
  await shotBar(page, "banda-riposo");
  // the scroller reaches the glass: the rows pass behind the band
  expect(atRest.scrollerBottom).toBeGreaterThanOrEqual(atRest.vh - 1);
  // and the band's ground lets what passes behind it show through
  expect(atRest.bandAlpha).toBeLessThan(1);
  expect(atRest.bandBlur).not.toBe("none");
  expect(atRest.overflow).toBeGreaterThan(0);

  await page.evaluate((sel) => {
    const s = document.querySelector<HTMLElement>(sel)!;
    s.scrollTop = s.scrollHeight;
  }, SCROLLER);
  await waitForLayoutSettled(page, SCROLLER);
  const atEnd = await read();
  console.log("BANDA-FONDO", JSON.stringify(atEnd));
  await shotBar(page, "banda-fondo");
  // at the end of the run the last row sits WHOLE above the band
  expect(atEnd.lastBottom!).toBeLessThanOrEqual(atEnd.bandTop + 1);
});

test("MOBILE-GEOM-05 — sotto status bar e home indicator, senza fasce vuote", async ({ page }) => {
  await page.goto(E2E_BASE);
  await expect(page.locator(BAR)).toBeVisible();
  const r = await page.evaluate(() => {
    const meta = (n: string) => document.querySelector(`meta[name="${n}"]`)?.getAttribute("content") ?? null;
    const root = document.querySelector<HTMLElement>("#root > div") ?? (document.body.firstElementChild as HTMLElement);
    const header = document.querySelector('[aria-label="Topics sidebar"]')!.firstElementChild as HTMLElement;
    const bar = document.querySelector<HTMLElement>('[data-testid="mobile-chrome-bar"]')!;
    const rr = root.getBoundingClientRect();
    const bg = (e: Element) => getComputedStyle(e).backgroundColor;
    return {
      viewport: meta("viewport"),
      statusBar: meta("apple-mobile-web-app-status-bar-style"),
      capable: meta("apple-mobile-web-app-capable"),
      rootTop: rr.top,
      rootBottom: rr.bottom,
      vh: window.innerHeight,
      chromeBg: (() => { const d = document.createElement("div"); d.style.background = "var(--chrome-bg)"; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; })(),
      htmlBg: bg(document.documentElement),
      bodyBg: bg(document.body),
      rootBg: bg(root),
      headerTop: header.getBoundingClientRect().top,
      barBottom: bar.getBoundingClientRect().bottom,
    };
  });
  console.log("PWA", JSON.stringify(r));
  expect(r.viewport).toContain("viewport-fit=cover");
  // TEST BUILD: `black-translucent` on purpose, see the comment in index.html.
  expect(r.statusBar).toBe("black-translucent");
  expect(r.capable).toBe("yes");
  // the container covers the whole screen, from the top edge to the bottom one
  expect(r.rootTop).toBeLessThanOrEqual(0.5);
  expect(r.rootBottom).toBeGreaterThanOrEqual(r.vh - 0.5);
  expect(r.barBottom).toBeGreaterThanOrEqual(r.vh - 0.5);
  // the ground behind the strips is the content's, not another colour
  expect(r.htmlBg).toBe(r.bodyBg);
  expect(r.htmlBg).toBe(r.chromeBg);
});
