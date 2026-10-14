import { test, expect, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore } from "./helpers/api-fixtures";
import { hostNativePage, type NativeHostPage } from "./helpers/native-host-page";
import { hermetic } from "./fixtures/hermetic";
import { closeTabSheet, revealInTabSheet, tabSheet } from "./helpers/tab-sheet";

hermetic(test);

/**
 * Each device keeps its own layout of a page the Mac hosts.
 *
 * Before (14/10, Attilio: "the last browser I open resizes the other to its
 * size"): using the page on the iPad laid the Mac's page out at the iPad's
 * size (TOPIC-BROWSER-05), and the Mac showed it scaled down. Now the Mac
 * keeps its size, the iPad lays its copy out at its own, and what crosses is
 * content: the element a tap landed on, the element at the reading line of a
 * scroll.
 *
 * The Mac is the real host module driving a WebKit page (helpers/native-host-page.ts).
 * Its page has a breakpoint between the two sizes, a bar fixed across the
 * reading line, cards that sit in four columns on the Mac and in one on the
 * iPad, and rows in pairs, side by side on the Mac and one above the other on
 * the iPad: the same pixel is a different element on each side, and what the
 * Mac has at its reading point is often the other row of the pair.
 *
 * @covers BROWSER-DOM-LAYOUT-01
 * @covers BROWSER-DOM-LAYOUT-02
 * @covers BROWSER-DOM-LAYOUT-03
 * @covers BROWSER-DOM-LAYOUT-04
 */

const MAC = { width: 1200, height: 800 };
/** Narrower than this, the page lays itself out for a narrow screen. */
const NARROW_BELOW = 1100;
/** The mirror holds the page's echoes this long after its last move (DomCoBrowse). */
const HOLD_MS = 600;
/** Where the reading line of a scroll is, down the visible height (lib/mirrorLayout). */
const READING_LINE = 0.25;

const CARDS = Array.from({ length: 12 }, (_, i) => `<div class="card" data-k="card-${i}">Card ${i}</div>`).join("");
const ROWS = Array.from({ length: 100 }, (_, i) =>
  `<div class="pair"><p class="row" data-k="row-${2 * i}">Row ${2 * i}</p><p class="row" data-k="row-${2 * i + 1}">Row ${2 * i + 1}</p></div>`).join("");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Layout host</title><style>
body{margin:0;font:16px sans-serif}
#menu{display:none;height:48px;width:100%}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:8px}
.card{height:60px;border:1px solid #ccc}
.row{margin:0;height:40px;border-bottom:1px solid #ccc}
.pair{display:flex}.pair .row:first-child{flex:0 0 40%}.pair .row:last-child{flex:1}
#bar{position:fixed;left:0;right:0;top:calc(${READING_LINE * 100}vh - 30px);height:60px;background:rgba(0,0,0,.08)}
@media (max-width:${NARROW_BELOW}px){#menu{display:block}.grid{grid-template-columns:1fr}.pair{display:block}}
body.menu-open{outline:4px solid red}
</style><script>
window.__clicks=[];
document.addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('[data-k]');__clicks.push(t?t.getAttribute('data-k'):'none')},true);
</script></head><body>
<button id="menu" data-k="menu" onclick="document.body.classList.toggle('menu-open')">Menu</button>
<div class="grid">${CARDS}</div>${ROWS}<div id="bar"></div></body></html>`;

/** The mirror's iframe and its document, on the viewer. */
function mirror(page: Page) {
  return page.locator('[data-testid="browser-dom-cobrowse"] iframe').first();
}

/** Run `fn` in the mirror's document. */
async function inMirror<T>(page: Page, fn: () => T): Promise<T> {
  const frame = await (await mirror(page).elementHandle())!.contentFrame();
  return frame!.evaluate(fn);
}

/**
 * The row at a document's reading point, and how far below the row's top the
 * line crosses it. Rows are 40 px on both sides, so the same row and offset is
 * the same place, whatever sits above it.
 */
function readingRow(): { k: string; offset: number } | null {
  const line = innerHeight * 0.25;
  const row = document.elementsFromPoint(innerWidth / 2, line).find((e) => e.classList.contains("row"));
  return row ? { k: row.getAttribute("data-k")!, offset: line - row.getBoundingClientRect().top } : null;
}

/** How far below the top of row `k` the Mac's reading line crosses it. */
function lineIntoRow(k: string): number {
  return innerHeight * 0.25 - document.querySelector(`[data-k="${k}"]`)!.getBoundingClientRect().top;
}

async function openViewer(page: Page, request: Parameters<typeof resetPaneStore>[0], ctx: string): Promise<void> {
  await resetPaneStore(request, [`browser:${ctx}`]);
  await goToApp(page);
  await expect(page.locator('[data-testid="browser-dom-cobrowse"]').first().frameLocator("iframe").getByText("Card 0", { exact: true })).toBeVisible({ timeout: 15_000 });
}

/**
 * A finger's swipe up the mirror, then every place the mirror takes once it is
 * still. A finger that rests `restMs` before lifting does not fling: the mirror
 * stops exactly `step * steps` further down.
 */
async function swipe(page: Page, step: number, steps: number, restMs = 0): Promise<{ atEnd: number; after: number[] }> {
  return page.evaluate(async ({ step, steps, restMs, holdMs }) => {
    const overlay = document.querySelector('[data-testid="browser-dom-input-overlay"]') as HTMLElement;
    const doc = (document.querySelector('[data-testid="browser-dom-cobrowse"] iframe') as HTMLIFrameElement).contentDocument!;
    const read = () => doc.scrollingElement!.scrollTop;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const box = overlay.getBoundingClientRect();
    const x = box.left + box.width / 2;
    let y = box.top + box.height * 0.9;
    // WebKit on the desktop builds no real touches; React reads these fields off any event so named.
    const touch = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const list = [{ identifier: 1, clientX: x, clientY: y }];
      Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : list });
      Object.defineProperty(event, "changedTouches", { value: list });
      overlay.dispatchEvent(event);
    };
    touch("touchstart");
    for (let i = 0; i < steps; i++) {
      y -= step;
      touch("touchmove");
      await frame();
    }
    for (const until = performance.now() + restMs; performance.now() < until; ) await frame();
    touch("touchend");
    let last = read();
    for (let still = 0; still < 10; ) {
      await frame();
      const now = read();
      still = now === last ? still + 1 : 0;
      last = now;
    }
    const atEnd = read();
    const after: number[] = [];
    const until = performance.now() + holdMs * 2 + 400;
    while (performance.now() < until) {
      await frame();
      const now = read();
      if (now !== (after.at(-1) ?? atEnd)) after.push(now);
    }
    return { atEnd, after };
  }, { step, steps, restMs, holdMs: HOLD_MS });
}

/** Tap the mirror on the element `k`, at the middle of its box, the way a finger does. */
async function tap(page: Page, k: string): Promise<void> {
  await page.evaluate((k) => {
    const overlay = document.querySelector('[data-testid="browser-dom-input-overlay"]') as HTMLElement;
    const iframe = document.querySelector('[data-testid="browser-dom-cobrowse"] iframe') as HTMLIFrameElement;
    const r = iframe.contentDocument!.querySelector(`[data-k="${k}"]`)!.getBoundingClientRect();
    const frameBox = iframe.getBoundingClientRect();
    // 1 when the mirror has its own layout, less when it shows the Mac's page scaled down.
    const scale = frameBox.width / iframe.offsetWidth;
    const x = frameBox.left + (r.left + r.width / 2) * scale;
    const y = frameBox.top + (r.top + r.height / 2) * scale;
    const touch = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const list = [{ identifier: 1, clientX: x, clientY: y }];
      Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : list });
      Object.defineProperty(event, "changedTouches", { value: list });
      overlay.dispatchEvent(event);
    };
    touch("touchstart");
    touch("touchend");
  }, k);
}

async function setUp(page: Page, context: import("@playwright/test").BrowserContext, request: Parameters<typeof resetPaneStore>[0], name: string): Promise<NativeHostPage> {
  const ctx = `e2e-own-layout-${name}-${Date.now()}`;
  const host = await hostNativePage(await context.newPage(), ctx, PAGE, { size: MAC, title: "Layout host" });
  await openViewer(page, request, ctx);
  return host;
}

test.describe("Each device keeps its own layout of a page the Mac hosts", () => {
  test("the mirror is laid out at the pane's size, 1:1, and the Mac keeps its own", async ({ page, context, request }) => {
    const host = await setUp(page, context, request, "sizes");
    const overlay = page.locator('[data-testid="browser-dom-input-overlay"]').first();
    const pane = await page.locator('[data-testid="browser-dom-cobrowse"]').first().evaluate((el) => el.clientWidth);
    expect(pane, "the viewer's pane is on the narrow side of the breakpoint").toBeLessThan(NARROW_BELOW);

    await expect.poll(async () => Number(await mirror(page).getAttribute("width"))).toBeLessThan(NARROW_BELOW);
    const width = Number(await mirror(page).getAttribute("width"));
    expect(Math.abs(width - pane)).toBeLessThanOrEqual(2);
    expect(Math.abs((await overlay.boundingBox())!.width - width)).toBeLessThanOrEqual(1);
    // The narrow layout here, the wide one on the Mac.
    expect(await inMirror(page, () => getComputedStyle(document.getElementById("menu")!).display)).toBe("block");
    expect(await host.page.evaluate(() => getComputedStyle(document.getElementById("menu")!).display)).toBe("none");
    // The Mac is at the top of the page, so the mirror is too, whatever each has at its reading line.
    expect(await inMirror(page, () => document.scrollingElement!.scrollTop)).toBe(0);

    // Using the page here does not lay the Mac's out again.
    await tap(page, "card-3");
    await swipe(page, 7, 20);
    await expect.poll(() => host.page.evaluate(() => (window as unknown as { __clicks: string[] }).__clicks.length)).toBe(1);
    expect(host.views.filter((v) => v !== null), "sizes the Mac was told").toEqual([]);
    expect(host.width()).toBe(MAC.width);
    host.close();
  });

  test("a tap reaches the element it landed on, wherever the Mac has it", async ({ page, context, request }) => {
    const host = await setUp(page, context, request, "tap");
    // Where the card is in the mirror, and what the Mac has at that pixel: something else,
    // so coordinates alone would miss it.
    const at = await inMirror(page, () => {
      const r = document.querySelector('[data-k="card-3"]')!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const there = await host.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-k]")?.getAttribute("data-k") ?? "none", at);
    expect(there).not.toBe("card-3");
    await tap(page, "card-3");
    await expect.poll(() => host.page.evaluate(() => (window as unknown as { __clicks: string[] }).__clicks)).toEqual(["card-3"]);
    host.close();
  });

  test("a control only the narrow layout shows still works: its handler runs on the Mac", async ({ page, context, request }) => {
    const host = await setUp(page, context, request, "menu");
    await tap(page, "menu");
    await expect.poll(() => host.page.evaluate(() => document.body.classList.contains("menu-open"))).toBe(true);
    // And what it did comes back to the mirror.
    await expect.poll(() => inMirror(page, () => document.body.classList.contains("menu-open"))).toBe(true);
    host.close();
  });

  test("after a swipe the same row is at the reading line on both sides, and the mirror stays put", async ({ page, context, request }) => {
    const host = await setUp(page, context, request, "swipe");
    // Far enough for the rows to reach the reading line under the narrow layout's taller grid.
    const { atEnd, after } = await swipe(page, 20, 45);
    expect(atEnd).toBeGreaterThan(800);
    expect(after, "the mirror moved after the gesture").toEqual([]);
    const here = (await inMirror(page, readingRow))!;
    // The row read here is at the Mac's reading line too, the same way into it.
    await expect.poll(async () => Math.abs((await host.page.evaluate(lineIntoRow, here.k)) - here.offset)).toBeLessThanOrEqual(2);
    // The layouts differ above the rows: the same place is far apart in pixels.
    expect(Math.abs((await host.scrollOf()) - atEnd)).toBeGreaterThan(300);
    host.close();
  });

  test("the mirror stays put when the Mac has the other row of the pair at its reading point", async ({ page, context, request }) => {
    const host = await setUp(page, context, request, "pair");
    // A slow swipe that stops with row-20 at the reading line here, 5 to 15 px into it.
    const step = 10;
    const steps = await inMirror(page, () => {
      const r = document.querySelector('[data-k="row-20"]')!.getBoundingClientRect();
      return Math.ceil((r.top + 5 - innerHeight * 0.25) / 10);
    });
    const { atEnd, after } = await swipe(page, step, steps, 200);
    expect(atEnd).toBe(step * steps);
    const here = (await inMirror(page, readingRow))!;
    expect(here.k).toBe("row-20");
    await expect.poll(async () => Math.abs((await host.page.evaluate(lineIntoRow, "row-20")) - here.offset)).toBeLessThanOrEqual(2);
    // Side by side on the Mac: its reading point is on row-21, which here is a row further down.
    expect((await host.page.evaluate(readingRow))?.k).toBe("row-21");
    // The Mac said back the place this mirror sent, not its own: no jump of a row once it answered.
    expect(after, "the mirror moved after the gesture").toEqual([]);
    host.close();
  });

  test("the switch in the tab's sheet brings the Mac's page back at this pane's size, and lets it go again", async ({ page, context, request }) => {
    const host = await setUp(page, context, request, "switch");
    const flip = async (from: "own" | "page") => {
      // Right after a load the first press of the dots can go unanswered: press until the sheet is there.
      await expect(async () => {
        if (!(await tabSheet(page).count())) {
          await page.locator('[data-pane-id^="browser:"]').first().hover();
          await page.getByTestId("browser-tab-menu").first().click();
        }
        await expect(tabSheet(page)).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 10_000 });
      const row = await revealInTabSheet(page, "browser-tab-layout");
      await expect(row).toHaveAttribute("data-layout", from);
      await row.click();
      if (await tabSheet(page).count()) await closeTabSheet(page);
    };

    await flip("own");
    // The Mac's page, scaled down here, the way it was before.
    await expect.poll(async () => Number(await mirror(page).getAttribute("width"))).toBe(MAC.width);
    await tap(page, "card-0");
    await expect.poll(() => host.page.evaluate(() => (window as unknown as { __clicks: string[] }).__clicks)).toEqual(["card-0"]);
    // Used from here, the Mac's page takes this pane's size (TOPIC-BROWSER-05).
    await expect.poll(() => host.width()).toBeLessThan(NARROW_BELOW);

    // The choice is this device's, and a reload keeps it.
    await page.reload();
    await expect(page.locator('[data-testid="browser-dom-cobrowse"]').first().frameLocator("iframe").getByText("Card 0", { exact: true })).toBeVisible({ timeout: 15_000 });
    await flip("page");
    // And the Mac has its own back at once, without anyone touching it.
    await expect.poll(() => host.width()).toBe(MAC.width);
    expect(host.views.at(-1), "the last size the Mac was told is its own").toBeNull();
    await expect.poll(async () => Number(await mirror(page).getAttribute("width"))).toBeLessThan(NARROW_BELOW);
    host.close();
  });

  test("a scroll made on the Mac brings the mirror to the same row", async ({ page, context, request }) => {
    const host = await setUp(page, context, request, "mac-scroll");
    await host.page.evaluate(() => {
      // The right one of its pair: on the Mac, the row under the reading point.
      const row = document.querySelector('[data-k="row-121"]') as HTMLElement;
      window.scrollTo({ top: row.offsetTop - innerHeight * 0.25 + 13, behavior: "instant" as ScrollBehavior });
    });
    const there = (await host.page.evaluate(readingRow))!;
    expect(there.k).toBe("row-121");
    await expect.poll(async () => (await inMirror(page, readingRow))?.k, { timeout: 5_000 }).toBe("row-121");
    await expect.poll(async () => Math.abs((await inMirror(page, readingRow))!.offset - there.offset), { timeout: 3_000 }).toBeLessThanOrEqual(2);
    // The same row, from scroll positions the two layouts put far apart.
    expect(Math.abs((await inMirror(page, () => document.scrollingElement!.scrollTop)) - (await host.scrollOf()))).toBeGreaterThan(300);
    // At the end of the page the mirror is at its end too.
    await host.page.evaluate(() => window.scrollTo({ top: document.scrollingElement!.scrollHeight, behavior: "instant" as ScrollBehavior }));
    await expect.poll(() => inMirror(page, () => {
      const el = document.scrollingElement!;
      return el.scrollHeight - el.clientHeight - el.scrollTop;
    }), { timeout: 5_000 }).toBeLessThanOrEqual(1);
    host.close();
  });
});
