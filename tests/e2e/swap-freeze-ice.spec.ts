/**
 * swap-freeze-ice.spec.ts - THE FROST OF A FROZEN SESSION, measured.
 *
 * With the Mac in sustained swap Topics SIGSTOPs the heaviest command an agent
 * launched in the background, and the session frosts over. A real freeze needs a
 * thrashing machine, an agent and two minutes of patience: here the frozen trees
 * arrive through the test-only verb `POST /api/test/swap-freeze`, which writes
 * into the SAME store and goes out on the SAME frame (`swap-freeze:state`) as
 * production.
 *
 * The things no unit test can say, measured here on pixels and on the work the
 * browser actually does:
 *
 *  ICE-01  the frost does not cover the words: the card's own text rectangles
 *          come from `Range.getClientRects`, and the canvas UNDER them is read
 *          with `getImageData` - max alpha 2/255, in both themes.
 *  ICE-02  at rest it costs nothing: a counter wraps `putImageData` BEFORE the
 *          page starts, and once the frost has settled the paints over a 3 s
 *          window are zero and no animation of the frost's own elements is still
 *          running. Both readings are ATTRIBUTED to the frost; the page-wide rAF
 *          counter is not, and comparing it against a baseline of the same page
 *          at another moment measured the app's noise, not the frost.
 *  ICE-03  the frost is not an overlay: it must not match `OVERLAY_SELECTOR`
 *          (lib/shell/browserOcclusion.ts), or the native shell would freeze the
 *          browser panes under the card (memory note `native-webview-occlusion`).
 *  ICE-04  the other surfaces: the sidebar row, the tab and the chat pane, with
 *          the banner IN FLOW (it never covers the composer) - both rectangles
 *          read in one layout instant, after the centred composer dock has
 *          stopped sliding, or the slide alone invents an overlap.
 *  ICE-05  under `prefers-reduced-motion` the frost is there already finished,
 *          and it goes at once when the tree thaws.
 *  ICE-06  the WORDS carry the meaning, without hovering (request of 24/09:
 *          "nobody understands the frozen effect"): on the card, the pane and the
 *          sidebar row the visible text says what is paused, why in plain words
 *          (the Mac is short of memory) and that it resumes by itself; the jargon
 *          (swap, pages, SIGSTOP) is allowed only in the tooltip. The row
 *          says what and why on its second line; the tab shows the word
 *          "pausa"; neither title is left with less room than before.
 *
 * It runs in both engines (`chromium` and `webkit`): the app lives inside a
 * WKWebView on this Mac, and canvas 2D and keyframes are engine code.
 *
 * @covers KANBAN-85
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { projectRow } from "./helpers/project-row";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath } from "../../shared/board";
import { projectPanesKey } from "../../shared/project-keys";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

hermetic(test);

const STAMP = Date.now();
const PROJECT_PATH = `${realpathSync("/tmp")}/e2e-swapice-${STAMP}`;
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
const API = `${E2E_BASE}/api`;
/** Screenshots and clips live here: the CI step uploads this directory. */
const SHOTS = join(process.cwd(), "test-results", "swap-ice");
const VIEWPORT = { width: 1400, height: 900 };

let topicId = "";
/** A STANDALONE chat, only so that a top-level sidebar row exists to frost. */
let rowTopicId = "";
const taskIds: string[] = [];

/**
 * Open this project's conversation inside the project's own layout.
 *
 * `openChatTopicIds` is the same key `resetProjectPanes` empties in the
 * `beforeEach`, so the seed has to be written per test, after the reset.
 */
async function seedProjectChat(request: APIRequestContext): Promise<void> {
  const res = await request.put(`${E2E_BASE}/api/ui-state/${projectPanesKey(PROJECT_PATH)}`, {
    data: { nonChatPanes: [], openChatTopicIds: [topicId], activeChatTopicId: topicId },
    ignoreHTTPSErrors: true,
  });
  expect(res.ok()).toBe(true);
}

/** The view the server would push for a frozen tree of this topic. */
const freezeView = (over: Record<string, unknown> = {}) => ({
  id: `tree-${STAMP}`,
  sessionKey: `topic:${topicId}`,
  topicId,
  terminalId: null,
  taskId: taskIds[0] ?? null,
  command: "bun batteria.ts",
  footprintGB: 2.1,
  pagesReadBackPerS: 33.6,
  debtGBPerMin: 8.8,
  frozenAt: Date.now(),
  thawBy: Date.now() + 600_000,
  n: 1,
  ...over,
});

async function setFrozen(page: Page, views: unknown[]): Promise<void> {
  const res = await page.request.post(`${API}/test/swap-freeze`, { data: { views } });
  expect(res.ok(), "the test-only freeze verb is mounted").toBe(true);
}

/** What a person reads without hovering: `innerText`, never `title`. */
const PAUSED = /in pausa/i;
const CAUSE = /memoria/i;
const RESUMES = /riprende da sol[oa]/i;
const JARGON = /swap|pagin[ae]|sigstop/i;

async function expectPlainWords(loc: Locator, where: string): Promise<string> {
  const text = await loc.innerText();
  expect(text, `${where}: says WHAT is paused`).toMatch(PAUSED);
  expect(text, `${where}: says WHY, in plain words`).toMatch(CAUSE);
  expect(text, `${where}: says it comes back by itself`).toMatch(RESUMES);
  expect(text, `${where}: no jargon in the visible text`).not.toMatch(JARGON);
  return text;
}

/** The resume deadline as the page itself prints a clock time. */
const clockOf = (page: Page, at: number) =>
  page.evaluate((t) => new Date(t).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }), at);

function openContext(browser: Browser, opts: { dark?: boolean; reduced?: boolean } = {}) {
  return browser.newContext({
    baseURL: E2E_BASE,
    viewport: VIEWPORT,
    locale: "it-IT",
    colorScheme: opts.dark ? "dark" : "light",
    reducedMotion: opts.reduced ? "reduce" : "no-preference",
    recordVideo: { dir: SHOTS, size: VIEWPORT },
  });
}

/**
 * Counts the two things a "still bitmap" must not do, wrapped BEFORE the page's
 * own code runs so the component cannot be the thing reporting on itself.
 */
const COUNTERS = `
  window.__ice = { paints: 0, frames: 0 };
  const put = CanvasRenderingContext2D.prototype.putImageData;
  CanvasRenderingContext2D.prototype.putImageData = function (...args) {
    if (this.canvas && this.canvas.classList && this.canvas.classList.contains('swap-ice')) window.__ice.paints++;
    return put.apply(this, args);
  };
  const ask = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { window.__ice.frames++; return ask(cb); };
`;

const reads = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __ice: { paints: number; frames: number } }).__ice }));

/**
 * What the page DOES over a window, sampled at both ends inside the page.
 *
 * The window is the instrument here, not a bet on a clock: "a settled frost
 * costs nothing" is a rate, and a rate needs a stretch of time. Sampling inside
 * the page keeps the round trips out of the number.
 */
const overAWindow = (page: Page, ms: number) => page.evaluate(async (windowMs) => {
  const ice = (window as unknown as { __ice: { paints: number; frames: number } }).__ice;
  const from = { paints: ice.paints, frames: ice.frames };
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  return { paints: ice.paints - from.paints, frames: ice.frames - from.frames };
}, ms);

/** The frost has stopped painting: two readings in a row with the same count. */
async function settled(page: Page): Promise<void> {
  let previous = -1;
  await expect.poll(async () => {
    const now = (await reads(page)).paints;
    const stable = now === previous && now > 0;
    previous = now;
    return stable;
  }, { timeout: 15_000, intervals: [300] }).toBe(true);
}

/** The project window of this spec's project, opened from the sidebar. */
async function openProject(page: Page): Promise<void> {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0 && (await projectsSection.getAttribute("aria-expanded")) === "false") {
    await projectsSection.click();
  }
  const row = projectRow(page, `e2e-swapice-${STAMP}`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 20_000 });
}

/**
 * The board, added through the pane "+" menu like every other board spec.
 *
 * A seeded project opens with NO board: the first run of this spec waited for a
 * `Board` tab that the project never had, and every card test died on the
 * kanban locator. The loop over the triggers is the shape `board-blocked-chip`
 * and its siblings use - the last visible "+" is the project's own, and a
 * trigger that does not open the menu is skipped rather than retried blindly.
 */
async function openBoard(page: Page): Promise<void> {
  await openProject(page);
  if (await page.getByTestId("kanban-board").isVisible().catch(() => false)) return;
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = (await triggers.count()) - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3_000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2_000 }).then(() => true, () => false)) { opened = true; break; }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });
}

test.describe("La brina di un comando congelato", () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(SHOTS, { recursive: true });
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-swapice" }, null, 2));
    const topic = await createTopic(request, `E2E-SwapIce-${STAMP}`, { projectPath: PROJECT_PATH });
    topicId = topic.id;
    const rowTopic = await createTopic(request, `E2E-SwapIce-Row-${STAMP}`);
    rowTopicId = rowTopic.id;
    const created = await request.post(`${API}/boards/${PROJECT_ID}/tasks`, { data: { text: "Batteria WebGL" } });
    expect(created.ok()).toBe(true);
    const task = (await created.json()) as { id: string };
    taskIds.push(task.id);
    const bound = await request.post(`${API}/test/tasks/${task.id}/bind-topic`, { data: { topicId, dispatchState: "working" } });
    expect(bound.ok()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    await request.post(`${API}/test/swap-freeze`, { data: { views: [] } }).catch(() => {});
    for (const id of taskIds) await deleteTask(request, PROJECT_ID, id).catch(() => {});
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
    if (rowTopicId) await deleteTopic(request, rowTopicId).catch(() => {});
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
    await resetProjectPanes(request, PROJECT_PATH);
    await seedProjectPane(request, PROJECT_PATH);
    await request.post(`${API}/test/swap-freeze`, { data: { views: [] } });
  });

  for (const dark of [false, true]) {
    const theme = dark ? "dark" : "light";
    test(`ICE-01/02/03 (${theme}): la brina si posa sulla card, non sul testo, e poi sta ferma`, async ({ browser }) => {
      const ctx = await openContext(browser, { dark });
      const page = await ctx.newPage();
      const video = page.video();
      try {
        await page.addInitScript(COUNTERS);
        await page.goto("/");
        await openBoard(page);
        const card = page.locator(`[data-task-card="${taskIds[0]}"]`);
        await expect(card).toBeVisible({ timeout: 20_000 });

        const view = freezeView();
        await setFrozen(page, [view]);
        await expect(card).toHaveAttribute("data-swap-ice", "frozen", { timeout: 10_000 });
        const label = card.getByTestId("swap-freeze-label");
        // The command stays, as the detail; the weight moves to the tooltip.
        await expect(label).toContainText("bun batteria.ts");
        await expect(label).toHaveAttribute("title", /2,1 GB/);
        // ICE-06: the sentence is readable without hovering, and it says when.
        await expectPlainWords(label, `card (${theme})`);
        await expect(label).toContainText(await clockOf(page, view.thawBy as number));
        await expect(card.locator("canvas.swap-ice")).toHaveCount(1);

        // ICE-03: the frost is not an overlay of the native shell.
        const occludes = await card.locator("canvas.swap-ice").evaluate((el) =>
          el.matches('.glass-surface, .native-occlude, [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], [data-radix-popper-content-wrapper]'));
        expect(occludes, "a frost that matched OVERLAY_SELECTOR would freeze the native browser panes under it").toBe(false);

        // ICE-01: the pixels under the card's own text, once the creep is over.
        await settled(page);
        const worst = await card.evaluate((host) => {
          const canvas = host.querySelector("canvas.swap-ice") as HTMLCanvasElement;
          const ctx2 = canvas.getContext("2d")!;
          const base = host.getBoundingClientRect();
          const scaleX = canvas.width / base.width;
          const scaleY = canvas.height / base.height;
          const boxes: DOMRect[] = [];
          const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent || !n.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(n);
            boxes.push(...Array.from(range.getClientRects()));
          }
          let max = 0;
          for (const b of boxes) {
            const x = Math.max(0, Math.round((b.left - base.left) * scaleX));
            const y = Math.max(0, Math.round((b.top - base.top) * scaleY));
            const w = Math.max(1, Math.min(canvas.width - x, Math.round(b.width * scaleX)));
            const h = Math.max(1, Math.min(canvas.height - y, Math.round(b.height * scaleY)));
            if (x >= canvas.width || y >= canvas.height) continue;
            const data = ctx2.getImageData(x, y, w, h).data;
            for (let i = 3; i < data.length; i += 4) if (data[i] > max) max = data[i];
          }
          return { max, boxes: boxes.length };
        });
        expect(worst.boxes, "the card has text to protect").toBeGreaterThan(0);
        expect(worst.max, "no crystal over the printed words").toBeLessThanOrEqual(2);

        await card.screenshot({ path: join(SHOTS, `card-${theme}.png`) });

        // ICE-02: settled, it costs nothing - measured on the frost itself.
        //
        // The rAF counter is the WHOLE PAGE's, so comparing it against a
        // baseline taken while the board was still settling compared the app
        // with itself at two different moments: webkit read 26 against 21, and
        // on the retry 4 against a baseline of 0, which is noise in both
        // directions. What is attributable is `putImageData` on `canvas.swap-ice`
        // - every frame of the creep goes through it (`SwapIce.tsx`), so zero
        // paints over three seconds IS "the loop is not running" - and the
        // animations owned by the frost's own elements.
        const after = await overAWindow(page, 3_000);
        expect(after.paints, "a settled frost is a still bitmap").toBe(0);
        const running = await card.evaluate((el) => Array.from(el.querySelectorAll(".swap-ice, .swap-ice-glint"))
          .flatMap((n) => n.getAnimations())
          .filter((a) => a.playState === "running").length);
        expect(running, "the glints run twice and stop; an endless one would spend the cycles the freeze just bought").toBe(0);

        // The thaw: the overlay goes, and the card is a card again.
        await setFrozen(page, []);
        await expect(card).not.toHaveAttribute("data-swap-ice", "frozen", { timeout: 5_000 });
        await expect(card.getByTestId("swap-freeze-label")).toHaveCount(0);
        await card.screenshot({ path: join(SHOTS, `card-thawed-${theme}.png`) });
      } finally {
        await ctx.close();
        const path = await video?.path().catch(() => null);
        if (path) await video?.saveAs(join(SHOTS, `card-${theme}.webm`)).catch(() => {});
      }
    });
  }

  test("ICE-04: riga, tab e pane della chat, col banner in flusso sopra il composer", async ({ browser, request }) => {
    // The conversation is seeded OPEN in the project's own layout. Clicking it
    // in the sidebar would not do: inside a project the chat is a child row of
    // the project node, so the click depends on an accordion being open, while
    // the pane is what this test is about.
    // The standalone chat's pane, so its row is in the sidebar: a chat is shown
    // there only while it has an open tab, and the `beforeEach` empties the
    // store. The project pane is seeded again after it, because the reset wipes
    // that too.
    await resetPaneStore(request, [rowTopicId]);
    await seedProjectPane(request, PROJECT_PATH);
    await seedProjectChat(request);
    const ctx = await openContext(browser);
    const page = await ctx.newPage();
    try {
      await page.goto("/");
      await openProject(page);
      const pane = page.locator(`[data-chat-topic-id="${topicId}"]`).first();
      await expect(pane).toBeVisible({ timeout: 20_000 });
      // The standalone chat's own row, the second surface: a sidebar row frosts
      // wherever it is, and a top-level row is the one a click can reach here.
      const row = page.getByRole("treeitem", { name: new RegExp(`E2E-SwapIce-Row-${STAMP}`) }).first();
      await expect(row).toBeVisible({ timeout: 20_000 });
      const tab = page.locator(`[data-pane-id="chat:${topicId}"]`).first();
      await expect(tab).toBeVisible({ timeout: 20_000 });
      // The title's room before the freeze, to compare with the room after.
      const tabTitleW = () => tab.getByTestId("pane-tab-label").evaluate((el) => el.getBoundingClientRect().width);
      const rowNameW = () => row.locator('[data-row-name="chat"]').evaluate((el) => el.getBoundingClientRect().width);
      const before = { tab: await tabTitleW(), row: await rowNameW() };

      await setFrozen(page, [freezeView(), freezeView({
        id: `tree-row-${STAMP}`, sessionKey: `topic:${rowTopicId}`, topicId: rowTopicId, taskId: null,
      })]);

      await expect(pane).toHaveAttribute("data-swap-frozen", "true", { timeout: 10_000 });
      await expect(row).toHaveAttribute("data-swap-ice", "frozen", { timeout: 10_000 });
      // The third surface: the tab of the frozen conversation.
      await expect(tab).toHaveAttribute("data-swap-ice", "frozen", { timeout: 10_000 });

      const banner = pane.getByTestId("swap-freeze-label");
      await expect(banner).toBeVisible();

      // The room the titles keep, read BEFORE any assertion on the words so the
      // same number prints on a build that still fails them.
      const after = { tab: await tabTitleW(), row: await rowNameW() };
      console.log(`[ICE-06] title room before/after freeze: tab ${before.tab.toFixed(0)}/${after.tab.toFixed(0)} px, row ${before.row.toFixed(0)}/${after.row.toFixed(0)} px`);

      // ICE-06: the words, on every surface, without hovering.
      await expectPlainWords(banner, "pane");
      await expect(banner).toContainText("bun batteria.ts");
      // The row's own line and not the whole row: the chat's NAME is
      // "E2E-SwapIce-Row-..." and would trip the jargon check by itself.
      const rowLine = row.getByTestId("swap-freeze-line");
      await expect(rowLine).toBeVisible();
      // A row is a COMPACT surface: its second line has 165 px at the default
      // 256 px sidebar, and the whole sentence measured 216 px in WebKit on
      // 24/09. So the row says WHAT and WHY, and "riprende da solo" is carried
      // by the card, the pane and the tooltip.
      const rowText = await rowLine.innerText();
      expect(rowText, "sidebar row: says WHAT is paused").toMatch(PAUSED);
      expect(rowText, "sidebar row: says WHY, in plain words").toMatch(CAUSE);
      expect(rowText, "sidebar row: no jargon").not.toMatch(JARGON);
      await expect(rowLine).toHaveAttribute("title", RESUMES);
      // And what it says has to FIT: an ellipsis that eats the cause would
      // leave the row saying only half of it.
      // The words are the LAST child (the glyph comes first), and that span is
      // the one that carries the ellipsis.
      const clipped = await rowLine.evaluate((el) => {
        const words = el.lastElementChild as HTMLElement;
        return words.scrollWidth - words.clientWidth;
      });
      expect(clipped, "the row's pause line is not truncated at the default sidebar width").toBeLessThanOrEqual(1);
      await expect(tab).toContainText(/pausa/i);
      // The row says it on its second line, so the NAME keeps all its room
      // (it lost 36 px to the close ring the frost pulled back into the flow).
      expect(before.row - after.row, "the row name keeps its room").toBeLessThanOrEqual(1);
      // On a 150 px tab the word costs room. The bar is the code before the
      // words: with the snowflake alone the title went from 126 to 78 px
      // (WebKit, 24/09), because the frost also pulled the close ring into the
      // flow. No worse than that.
      expect(before.tab - after.tab, "the tab title keeps at least the room it kept before").toBeLessThanOrEqual(48);
      // IN FLOW: the banner pushes, it does not cover.
      //
      // BOTH RECTANGLES COME FROM ONE LAYOUT INSTANT, and only once the dock has
      // stopped moving. In an empty chat the whole bottom block is centred with
      // `translateY` under a 420 ms transition (`.composer-dock-slide`), and the
      // banner's arrival changes that offset: two `boundingBox()` round trips
      // then land on two different frames of the same slide and report an
      // overlap that no layout ever had - which is why the number came out
      // different on every attempt (5508, 4853, 1034 px²) instead of being the
      // fixed area a real overlap would give.
      const dock = pane.getByTestId("chat-input-area");
      await expect.poll(async () => dock.evaluate((el) => new Promise<boolean>((resolve) => {
        const first = el.getBoundingClientRect().top;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          resolve(Math.abs(el.getBoundingClientRect().top - first) < 0.5);
        }));
      })), { timeout: 10_000, intervals: [200] }).toBe(true);
      const boxes = await pane.evaluate((root) => {
        const rect = (sel: string): { x: number; y: number; w: number; h: number } | null => {
          const el = root.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        };
        return { b: rect('[data-testid="swap-freeze-label"]'), c: rect('[data-testid="chat-message-input"]') };
      });
      const { b, c } = boxes;
      expect(b && c, "the banner and the composer are both in the pane").toBeTruthy();
      const overlap = Math.max(0, Math.min(b!.y + b!.h, c!.y + c!.h) - Math.max(b!.y, c!.y))
        * Math.max(0, Math.min(b!.x + b!.w, c!.x + c!.w) - Math.max(b!.x, c!.x));
      expect(overlap, "the one control still usable while a command is frozen").toBe(0);
      expect(b!.y + b!.h, "and it sits ABOVE it, not below").toBeLessThanOrEqual(c!.y);

      await page.screenshot({ path: join(SHOTS, "pane-and-row.png") });
      await setFrozen(page, []);
      await expect(pane).not.toHaveAttribute("data-swap-frozen", "true", { timeout: 5_000 });
    } finally {
      await ctx.close();
    }
  });

  test("ICE-05: con reduced-motion la brina c'e' subito e se ne va subito", async ({ browser }) => {
    const ctx = await openContext(browser, { reduced: true });
    const page = await ctx.newPage();
    try {
      await page.addInitScript(COUNTERS);
      await page.goto("/");
      await openBoard(page);
      const card = page.locator(`[data-task-card="${taskIds[0]}"]`);
      await expect(card).toBeVisible({ timeout: 20_000 });
      const before = await reads(page);
      await setFrozen(page, [freezeView()]);
      await expect(card).toHaveAttribute("data-swap-ice", "frozen", { timeout: 10_000 });
      await expect.poll(async () => (await reads(page)).paints - before.paints, { timeout: 5_000 }).toBeGreaterThan(0);
      // WHAT IS BEING TOLD APART: a creep paints once per animation frame, so
      // about 54 times over the 900 ms it lasts; a frost that is already
      // finished repaints only when the host's own boxes move, through the
      // 250 ms debounce of `recheck` (SwapIce.tsx). The ceiling is therefore how
      // often that debounce can fire in the window, and nothing else.
      //
      // The old `<= 2` was a count copied off one run, and it was wrong on the
      // mechanism: the arrival of the frozen label mutates the card and costs a
      // legitimate second repaint, a third when the label and the glints land in
      // two different debounce windows. Webkit paid 3 and the suite called it a
      // creep.
      const CREEP_MS = 900;
      const DEBOUNCE_MS = 250;
      const ceiling = Math.ceil(CREEP_MS / DEBOUNCE_MS) + 1;
      await overAWindow(page, CREEP_MS);
      const paints = (await reads(page)).paints - before.paints;
      expect(paints, `no creep under reduced motion: ${paints} paints in ${CREEP_MS} ms, where a creep paints every frame`).toBeLessThanOrEqual(ceiling);
      await expect(card.locator(".swap-ice-glint")).toHaveCount(0);
      await setFrozen(page, []);
      await expect(card).not.toHaveAttribute("data-swap-ice", "frozen", { timeout: 5_000 });
    } finally {
      await ctx.close();
    }
  });
});
