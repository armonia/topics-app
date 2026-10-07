/**
 * THE PHONE CHROME FEEDBACK LOOP (05/10/2026, msg 3862).
 *
 * Trying Topics on the phone: the top row must reveal itself on scroll with
 * the sessions starting right past the safe area, the Topics menu belongs in
 * the user menu, the bottom row keeps its sizes, Search lives in the design
 * system, "Waiting" is never muted and the pencil opens a fresh chat at once.
 *
 * Every entry here is a number read from the DOM at 390x844 with a finger:
 *
 *  MOBILE-CHROME-07  at the top the row is compact (44), on scroll it reveals
 *                    itself whole (56), rows start from `--sat`; the sheet has
 *                    two levels and the Topics menu is reached from the root
 *  MOBILE-CHROME-08  first/last key with the low outer radius above 12px,
 *                    STEP between keys, ROOM above, glyphs centred (±1px)
 *                    and the word below, outside the flow
 *  MOBILE-CHROME-09  the Search toggle keeps the step of the other keys
 *                    (edges and glyph centres, ±1px)
 *  MOBILE-CHROME-10  Search has the app background (never the popover grey),
 *                    painted from y=0, and the content inside the safe area
 *  MOBILE-CHROME-11  "Waiting" is always enabled: with an empty queue it opens
 *                    the Now (the step with the queue stays CHAT-WAIT-04's, tried there)
 *  MOBILE-CHROME-12  tap on the pencil = new focused draft; long press
 *                    = the whole "+" menu, with no chat open
 *
 * The bottom band, the radius and the notch are FORCED (`--sab`,
 * `--screen-corner-radius`, `--sat`): that is why they live in CSS variables
 * instead of bare `env()` calls, `env()` cannot be overwritten.
 *
 * @covers MOBILE-CHROME-07, MOBILE-CHROME-08, MOBILE-CHROME-09, MOBILE-CHROME-10, MOBILE-CHROME-11, MOBILE-CHROME-12
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { waitForLayoutSettled } from "./helpers/layout";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const BAR = '[data-testid="mobile-chrome-bar"]';
const SEARCH = '[data-testid="mobile-chrome-search"]';
const PENCIL = '[data-testid="pane-add-menu-trigger"]';
const WAITING = '[data-testid="mobile-chrome-waiting"]';
const COLUMN = '[aria-label="Topics sidebar"]';
const SCROLLER = `${COLUMN} .sidebar-column`;
/** The home indicator band and the radius of a portrait iPhone. */
const BAND = 34;
const RADIUS = 55;
/** A notch to force: `--sat` at zero cannot tell "past the safe area" from "from y=0". */
const NOTCH = 24;
/** Enough rows to overflow at 844px on their own (see mobile-list-under-chrome). */
const CROWD = 20;

let ids: string[] = [];

test.beforeAll(async ({ request }) => {
  for (let i = 0; i < CROWD; i++) ids.push((await createTopic(request, `Chrome feedback ${i}`)).id);
  await resetPaneStore(request, ids);
});

test.afterAll(async ({ request }) => {
  await resetPaneStore(request, []);
  for (const id of ids) await deleteTopic(request, id);
  ids = [];
});

async function open(page: Page): Promise<void> {
  await page.goto(E2E_BASE);
  await expect(page.locator(BAR)).toBeVisible();
  await page.evaluate(([band, radius]) => {
    const s = document.documentElement.style;
    s.setProperty("--sab", `${band}px`);
    s.setProperty("--screen-corner-radius", `${radius}px`);
    window.dispatchEvent(new Event("resize"));
  }, [BAND, RADIUS] as const);
  // The boxes grow by the band: that is expected, then wait for the row to settle.
  await expect
    .poll(() => page.evaluate((sel) => document.querySelector(`${sel} button`)?.getBoundingClientRect().height ?? 0, BAR))
    .toBeGreaterThanOrEqual(44 + BAND - 1);
  await waitForLayoutSettled(page, BAR);
}

/** Forces the notch and waits for whoever reads it. */
async function notch(page: Page, px: number): Promise<void> {
  await page.evaluate((v) => {
    document.documentElement.style.setProperty("--sat", `${v}px`);
    window.dispatchEvent(new Event("resize"));
  }, px);
  await waitForLayoutSettled(page);
}

/** How many message bubbles are truly visible (kept-alive panes do not count). */
async function visibleMessages(page: Page): Promise<number> {
  return page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="chat-message"]'))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.width > 0 && getComputedStyle(el).visibility !== "hidden";
    }).length);
}

test("MOBILE-CHROME-07: compatta in cima, intera appena si scorre, righe dalla safe area", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-07" });
  await open(page);
  await notch(page, NOTCH);

  const read = () => page.evaluate(() => {
    const column = document.querySelector('[aria-label="Topics sidebar"]')!;
    const header = column.firstElementChild as HTMLElement;
    const sc = column.querySelector<HTMLElement>(".sidebar-column")!;
    const rows = Array.from(sc.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const hr = header.getBoundingClientRect();
    return {
      compact: header.getAttribute("data-compact"),
      headerH: Math.round(hr.height),
      headerBottom: hr.bottom,
      padding: parseFloat(getComputedStyle(sc).paddingTop),
      firstTop: rows.length ? rows[0]!.getBoundingClientRect().top : null,
      behind: rows.some((r) => { const b = r.getBoundingClientRect(); return b.top < hr.bottom && b.bottom > 0; }),
      overflow: sc.scrollHeight - sc.clientHeight,
    };
  });

  // At the top: compact, with rows starting right past the notch.
  const top = await read();
  expect(top.compact).toBe("true");
  expect(top.headerH).toBe(44);
  expect(Math.abs(top.padding - NOTCH)).toBeLessThanOrEqual(1);
  expect(Math.abs(top.firstTop! - NOTCH)).toBeLessThanOrEqual(1);
  expect(top.overflow, "the list must overflow, or there is nothing to reveal on scroll").toBeGreaterThan(0);

  // On scroll: the row reveals itself whole and the rows travel under it.
  await page.evaluate((sel) => { document.querySelector<HTMLElement>(sel)!.scrollTop = 120; }, SCROLLER);
  await expect.poll(async () => (await read()).compact).toBe("false");
  const scrolled = await read();
  expect(scrolled.headerH).toBe(56);
  expect(scrolled.behind, "no row travels behind the revealed header").toBe(true);

  // And scrolling back to the top it turns compact again: the reveal is reversible.
  await page.evaluate((sel) => { document.querySelector<HTMLElement>(sel)!.scrollTop = 0; }, SCROLLER);
  await expect.poll(async () => (await read()).compact).toBe("true");
  expect((await read()).headerH).toBe(44);
});

test("MOBILE-CHROME-07b: il menu Topics si raggiunge dal menu utente", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-07" });
  await open(page);

  // The sheet opens at the root: identity, Topics entry, status.
  await page.locator('[data-testid="sidebar-topics-menu"]').tap();
  const entry = page.locator('[data-testid="user-menu-topics-entry"]');
  await expect(entry).toBeVisible();
  await expect(page.locator('[data-testid="menu-system-status"]')).toBeVisible();
  await expect(page.locator('[data-testid="user-menu-topics-back"]')).toHaveCount(0);

  // The entry goes down to the Topics level: back + the rows.
  await entry.tap();
  await expect(page.locator('[data-testid="user-menu-topics-back"]')).toBeVisible();
  await expect(page.locator('[data-testid="topics-menu-view"]')).toBeVisible();
  await expect(entry).toHaveCount(0);

  // And back climbs to the root.
  await page.locator('[data-testid="user-menu-topics-back"]').tap();
  await expect(entry).toBeVisible();
  await expect(page.locator('[data-testid="menu-system-status"]')).toBeVisible();
});

/** Rectangle, glyph centre, radii and word of every key in the row. */
async function buttons(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid="mobile-chrome-bar"]')!;
    const barH = bar.getBoundingClientRect().height;
    return {
      barH,
      doors: Array.from(bar.querySelectorAll<HTMLElement>("button")).map((b) => {
        const r = b.getBoundingClientRect();
        const g = (b.querySelector("svg") ?? b.querySelector<HTMLElement>(".rounded-full")) as Element;
        const gr = g.getBoundingClientRect();
        // The word, not the first `span`: the waiting door wraps the
        // glyph in a `span.relative` that is not it.
        const word = b.querySelector("span.pointer-events-none") as HTMLElement | null;
        const wr = word?.getBoundingClientRect();
        const s = getComputedStyle(b);
        const px = (v: string) => parseFloat(v) || 0;
        return {
          id: b.getAttribute("data-testid") ?? b.getAttribute("title"),
          x: r.x, w: r.width, h: r.height,
          cx: gr.left + gr.width / 2,
          dcx: gr.left + gr.width / 2 - (r.left + r.width / 2),
          dcy: gr.top + gr.height / 2 - (r.top + r.height / 2),
          glyphCy: gr.top + gr.height / 2,
          glyphBottomAir: r.bottom - (gr.top + gr.height),
          wordTop: wr ? wr.top : null,
          bl: px(s.borderBottomLeftRadius),
          br: px(s.borderBottomRightRadius),
        };
      }),
    };
  });
}

test("MOBILE-CHROME-08: raggi, aria e glifi al centro", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-08" });
  await open(page);
  const { barH, doors } = await buttons(page);
  expect(doors.length).toBe(5);
  const first = doors[0]!;
  const last = doors[doors.length - 1]!;

  // The outer bottom of the first and last is above the standard: it follows the glass.
  expect(first.bl).toBeGreaterThan(12);
  expect(last.br).toBeGreaterThan(12);

  // STEP between keys, ROOM above: the only horizontal air and the one on top.
  for (let i = 1; i < doors.length; i++) {
    const gap = doors[i]!.x - (doors[i - 1]!.x + doors[i - 1]!.w);
    expect(Math.abs(gap - 6), `buco fra ${doors[i - 1]!.id} e ${doors[i]!.id}`).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(barH - first.h - 6)).toBeLessThanOrEqual(1);

  // The glyph centred on both axes, the word below outside the flow
  // with measurable air between the glyph and the bottom of the key.
  for (const d of doors) {
    expect(Math.abs(d.dcx), `${d.id} dcx`).toBeLessThanOrEqual(1);
    expect(Math.abs(d.dcy), `${d.id} dcy`).toBeLessThanOrEqual(1);
    expect(d.wordTop!, `${d.id} ha la parola sotto il glifo`).toBeGreaterThan(d.glyphCy);
    expect(d.glyphBottomAir, `${d.id} aria sotto il glifo`).toBeGreaterThanOrEqual(20);
  }
});

test("MOBILE-CHROME-09: Cerca equidistante", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-09" });
  await open(page);
  const { doors } = await buttons(page);
  expect(doors.length).toBe(5);
  expect(doors[0]!.id).toBe("mobile-chrome-search");

  // A single STEP: the Search gap is the others' gap, and the step between
  // glyph centres is the same across the whole row.
  const gaps = doors.slice(1).map((d, i) => d.x - (doors[i]!.x + doors[i]!.w));
  const steps = doors.slice(1).map((d, i) => d.cx - doors[i]!.cx);
  for (let i = 1; i < gaps.length; i++) {
    expect(Math.abs(gaps[i]! - gaps[0]!), `buco ${i} contro il buco di Cerca`).toBeLessThanOrEqual(1);
    expect(Math.abs(steps[i]! - steps[0]!), `passo ${i} contro il passo di Cerca`).toBeLessThanOrEqual(1);
  }
});

test("MOBILE-CHROME-10: Cerca nel design system e dentro la safe area", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-10" });
  await open(page);
  await notch(page, NOTCH);

  await page.locator(SEARCH).tap();
  const pal = page.locator('[data-testid="command-palette"]');
  await expect(pal).toBeVisible();
  await waitForLayoutSettled(page, '[data-testid="command-palette"]');

  const m = await page.evaluate(() => {
    const root = document.querySelector("[data-testid=\"command-palette\"]") as HTMLElement;
    const panel = root.children[0] as HTMLElement;
    // The app background, read from the same variable that declares it.
    const probe = document.createElement("div");
    probe.style.background = "var(--bg)";
    document.body.appendChild(probe);
    const appBg = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const input = root.querySelector("input")!;
    // Every node crossing the screen must end above the indicator: the
    // page keeps `--sab` of clearance at the bottom, not only `--sat` on top.
    let worst = 0;
    for (const el of Array.from(panel.querySelectorAll("*"))) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.bottom > 0 && r.top < window.innerHeight) worst = Math.max(worst, r.bottom);
    }
    return {
      panelTop: panel.getBoundingClientRect().top,
      panelBg: getComputedStyle(panel).backgroundColor,
      appBg,
      paddingBottom: parseFloat(getComputedStyle(panel).paddingBottom),
      inputTop: input.getBoundingClientRect().top,
      worstBottom: worst,
      vh: window.innerHeight,
    };
  });
  // The background is the app's, painted from y=0: no seam at the notch.
  expect(m.panelBg).toBe(m.appBg);
  expect(m.panelTop).toBeLessThanOrEqual(1);
  // And the content stays inside the safe area, top and bottom.
  expect(m.inputTop).toBeGreaterThanOrEqual(NOTCH);
  expect(m.paddingBottom).toBeGreaterThanOrEqual(BAND - 1);
  expect(m.worstBottom).toBeLessThanOrEqual(m.vh - BAND + 1);

  // It is closed with the back button (the first on the page) and it is gone.
  await pal.locator("button").first().tap();
  await expect(pal).toHaveCount(0);
});

test("MOBILE-CHROME-11: a coda vuota «In attesa» apre il Now", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-11" });
  await open(page);

  // Alive with an empty queue: enabled, not muted.
  const door = page.locator(WAITING);
  await expect(door).toBeEnabled();
  await door.tap();
  await expect(page.locator('[data-testid="inbox-panel-now"]')).toBeVisible();

  // Escape closes it again (on the phone it is a sheet with its scrim: the bell
  // sits behind the veil and cannot be tapped again to close).
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="inbox-panel"]')).toHaveCount(0);
});

test("MOBILE-CHROME-12: tap sulla matita apre la bozza, senza menu", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-12" });
  // Every existing chat has a row: the one opening with no rows is new
  // by force. (Drafts are not read from the server: they are local scratch and
  // the outgoing snapshot strips them, `selectSyncableSnapshot`.)
  const topics = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as {
    topics: Record<string, { sessionKey?: string }>;
  };
  for (const id of ids) {
    const sessionKey = topics.topics[id]?.sessionKey;
    if (!sessionKey) throw new Error(`topic ${id} has no sessionKey: the seed cannot reach it`);
    await seedMessage(request, { sessionKey, role: "user", content: "ciao" });
  }
  await open(page);
  // The row is really there, behind the drawer: were it not visible, the zero
  // after would be vacuous instead of proof.
  await expect.poll(() => visibleMessages(page)).toBeGreaterThanOrEqual(1);

  await page.locator(PENCIL).tap();
  // The drawer closes and a chat with no rows comes forward, the draft, not
  // one of the twenty. No menu.
  await expect(page.locator(COLUMN)).toBeHidden();
  await expect.poll(() => visibleMessages(page)).toBe(0);
  await expect(page.locator('[data-testid="chat-message-input"]')).toBeVisible();
  await expect(page.locator('[data-testid="pane-add-menu"]')).toHaveCount(0);
});

test("MOBILE-CHROME-12b: pressione lunga apre l'intero menu, senza chat", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "MOBILE-CHROME-12" });
  await open(page);

  // The long press, synthesised where the finger puts it: `touchstart`,
  // six hundred milliseconds HELD (the hold IS the gesture, like the speed of
  // a swipe, not a driver wait), `touchend`, and the click the
  // browser would synthesise after, which the trigger must swallow. Bare events
  // with the touches stuck on: `new Touch()` is an illegal constructor outside
  // a real finger (desktop WebKit), and React only needs the event to be named
  // `touchstart` and to carry the touches.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="pane-add-menu-trigger"]') as HTMLElement;
    const r = btn.getBoundingClientRect();
    const touch = { identifier: 1, target: btn, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const touchEvent = (type: string, touches: unknown[], changed: unknown[]) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "touches", { value: touches });
      Object.defineProperty(ev, "targetTouches", { value: touches });
      Object.defineProperty(ev, "changedTouches", { value: changed });
      return ev;
    };
    btn.dispatchEvent(touchEvent("touchstart", [touch], [touch]));
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        btn.dispatchEvent(touchEvent("touchend", [], [touch]));
        btn.click();
        resolve();
      }, 650);
    });
  });

  // The menu is there, populated (the same list as the desktop, not a subset),
  // and no chat has opened: the drawer is still there.
  const menu = page.locator('[data-testid="pane-add-menu"]');
  await expect(menu).toBeVisible();
  expect(await menu.locator("button").count()).toBeGreaterThanOrEqual(3);
  await expect(page.locator(COLUMN)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});
