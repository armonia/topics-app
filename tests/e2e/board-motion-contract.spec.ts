/**
 * THE BOARD'S MOTION CONTRACT, frame by frame.
 *
 * Three findings of the 2026-09-29 fluidity audit, each one a defect that
 * lasts a handful of frames and ends in the right place, which is why no
 * final-state assertion ever saw it:
 *
 *  - opening a card: the drawer appeared at full opacity on its first frame
 *    and vanished in one frame on Escape, while the whole columns row lurched
 *    sideways (56 px on open, 108 px on close) because the carousel re-snapped
 *    to another column when its width changed. The status chip said
 *    "Loading..." for a frame and then shrank (PANELOAD-01);
 *  - loading the board: a 16 px ring in an empty pane, then 197 cards in one
 *    commit (PANELOAD-02);
 *  - dropping and filtering: the drop notice band pushed every column 28 px
 *    down (and its first floating fix hid the column headers until the next
 *    drag), the Review column animated `flex-basis` (a layout property) while
 *    the cards ran their own FLIP, and dnd-kit's sortable transition ran at
 *    its default `200ms ease`, off the app's motion tokens and on even under
 *    reduced motion (PANELOAD-03).
 *
 * Every number is read with `helpers/frame-probe`, which samples the watched
 * elements on every animation frame from the first frame of the document.
 */
import { test, expect, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import {
  armFrameProbe,
  markFrame,
  maxStep,
  MOTION_TOKENS,
  nextFrames,
  presentSamples,
  readTimeline,
} from "./helpers/frame-probe";

hermetic(test);

const BASE = E2E_BASE;
const BOARD_ID = "panemotion-e2e001";
/** A word only the seeded todo cards carry: filtering on it empties Review. */
const stamp = Date.now().toString(36);
const TODO_WORD = `pmtodo${stamp}`;

const W = {
  colTodo: '[data-testid="kanban-column-todo"]',
  colDone: '[data-testid="kanban-column-done"]',
  colReview: '[data-testid="kanban-column-review"]',
  drawer: '[data-testid="task-detail-drawer"]',
  chip: '[data-testid="task-status-chip"]',
  board: '[data-testid="kanban-board"]',
  skeleton: '[data-testid="board-skeleton"]',
  skelTodo: '[data-testid="board-skeleton-column-todo"]',
  skelBacklog: '[data-testid="board-skeleton-column-backlog"]',
  notice: '[data-testid="board-drop-notice"]',
};

const created: string[] = [];

/** Properties whose animation re-runs layout on every frame. */
const LAYOUT_PROP = /^(width|height|top|left|right|bottom|inset|margin|padding|max-height|max-width|min-height|min-width|flex|flex-basis|flex-grow|gap|row-gap|column-gap|grid-template)/;

test.describe("board motion contract", () => {
  // The audit's rig: at 1440 the five columns overflow the row, which is the
  // condition under which the carousel snap can move them.
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeAll(async ({ request }) => {
    const seed = async (text: string, status: string) => {
      const res = await request.post(`${BASE}/api/boards/${BOARD_ID}/tasks`, { data: { text, status: "todo" } });
      expect(res.ok(), `seed ${text}`).toBe(true);
      const { id } = (await res.json()) as { id: string };
      created.push(id);
      if (status !== "todo") {
        const p = await request.patch(`${BASE}/api/boards/${BOARD_ID}/tasks/${id}`, { data: { status } });
        expect(p.ok(), `move ${text} to ${status}`).toBe(true);
      }
    };
    // The audit's volume (197 cards): the column row, the done column's paging
    // and the drawer's first read all behave as on the audited board.
    const plan: Array<[string, number]> = [["todo", 25], ["backlog", 12], ["review", 6], ["done", 150], ["in_progress", 4]];
    for (const [status, n] of plan) {
      for (let k = 0; k < n; k += 20) {
        await Promise.all(Array.from({ length: Math.min(20, n - k) }, (_, i) =>
          seed(status === "todo" ? `Motion card ${TODO_WORD} ${k + i}` : `Motion ${status} card ${stamp} ${k + i}`, status)));
      }
    }
  });

  test.afterAll(async ({ request }) => {
    for (let i = 0; i < created.length; i += 20) {
      await Promise.all(created.slice(i, i + 20).map((id) => deleteTask(request, BOARD_ID, id).catch(() => {})));
    }
  });

  async function openBoard(page: Page, reducedMotion: "reduce" | "no-preference" = "no-preference") {
    // The suite's context asks for reduced motion (playwright.config); these
    // contracts are about the motion itself, so each test says which it wants.
    await page.emulateMedia({ reducedMotion });
    await resetPaneStore(page.request, ["__board__"]);
    await armFrameProbe(page, W);
    await page.goto("/");
    await expect(page.locator(`[data-testid="kanban-column-body-todo"] [data-task-card]`).first()).toBeVisible({ timeout: 30_000 });
    // Let the board settle: the reveal fade and the first live-usage tick.
    await nextFrames(page, 30);
  }

  test("opening and closing a card never moves the columns, and the drawer enters and leaves", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PANELOAD-01" });
    await openBoard(page);

    await markFrame(page, "open");
    await page.locator(`[data-testid="kanban-column-body-todo"] [data-task-card]`).first().click();
    await expect(page.locator(W.drawer)).toBeVisible();
    await expect(page.locator(W.chip)).not.toContainText(/Loading|Caricamento/);
    await nextFrames(page, 30);
    await markFrame(page, "open-end");

    await markFrame(page, "close");
    await page.keyboard.press("Escape");
    await expect(page.locator(W.drawer)).toHaveCount(0);
    await nextFrames(page, 20);
    await markFrame(page, "close-end");

    const open = await readTimeline(page, "open", "open-end");
    const close = await readTimeline(page, "close", "close-end");

    // 1. The columns stay where they were, on open and on close.
    const todoOpen = presentSamples(open, "colTodo");
    const todoClose = presentSamples(close, "colTodo");
    const colJump = {
      openStep: maxStep(todoOpen, "x"),
      closeStep: maxStep(todoClose, "x"),
      drift: Math.abs(todoClose[todoClose.length - 1].x - todoOpen[0].x),
    };
    console.log("[PANELOAD-01] columns", JSON.stringify(colJump));
    expect(colJump.openStep, "the Todo column moved sideways when the drawer opened").toBeLessThanOrEqual(1);
    expect(colJump.closeStep, "the Todo column moved sideways when the drawer closed").toBeLessThanOrEqual(1);
    expect(colJump.drift, "after open+close the Todo column is not where it started").toBeLessThanOrEqual(1);

    // 2. The drawer ENTERS: its first frame is not already the final one.
    const drawerIn = presentSamples(open, "drawer");
    const first = drawerIn[0];
    const last = drawerIn[drawerIn.length - 1];
    const enter = { firstOp: first.op, firstDx: Math.round(first.x - last.x), lastOp: last.op };
    console.log("[PANELOAD-01] enter", JSON.stringify(enter));
    expect(first.op < 0.99 || Math.abs(first.x - last.x) > 1, "the drawer appeared on its final frame, with no entrance").toBe(true);
    expect(last.op).toBeGreaterThan(0.99);
    // One-shot animations only: a spinner inside the drawer loops on `transform`.
    const drawerAnimations = open.animations.filter((a) => a.key === "drawer" && a.iterations !== -1 && a.props.some((p) => p === "opacity" || p === "transform"));
    expect(drawerAnimations.length, "no entrance animation on the drawer").toBeGreaterThan(0);
    for (const a of drawerAnimations) {
      expect(MOTION_TOKENS, `drawer animation ${a.duration}ms is not a motion token`).toContain(a.duration);
      expect(a.props.every((p) => p === "opacity" || p === "transform"), `drawer animates ${a.props}`).toBe(true);
    }

    // 3. The drawer LEAVES: it stays on screen, fading, for more than a frame.
    const drawerOut = presentSamples(close, "drawer");
    const fading = drawerOut.filter((s) => s.op < 0.99);
    console.log("[PANELOAD-01] exit frames", drawerOut.length, "fading", fading.length);
    expect(fading.length, "the drawer vanished in one frame instead of leaving").toBeGreaterThanOrEqual(2);
    const gone = drawerOut.length ? drawerOut[drawerOut.length - 1].t - close.frames[0].t : 0;
    expect(gone, "the exit lasted longer than a popover's budget allows").toBeLessThan(600);

    // 4. The status chip is the status on its first frame: no width change.
    const chip = presentSamples(open, "chip");
    const widths = chip.map((s) => s.w);
    console.log("[PANELOAD-01] chip widths", Math.min(...widths), Math.max(...widths));
    expect(Math.max(...widths) - Math.min(...widths), "the status chip changed width after mounting").toBeLessThanOrEqual(1);
  });

  test("under reduced motion the drawer arrives and leaves without animating", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PANELOAD-01" });
    await openBoard(page, "reduce");
    await markFrame(page, "open");
    await page.locator(`[data-testid="kanban-column-body-todo"] [data-task-card]`).first().click();
    await expect(page.locator(W.drawer)).toBeVisible();
    await nextFrames(page, 20);
    await markFrame(page, "close");
    await page.keyboard.press("Escape");
    await expect(page.locator(W.drawer)).toHaveCount(0);
    await nextFrames(page, 5);
    const tl = await readTimeline(page, "open");
    const drawer = presentSamples(tl, "drawer");
    expect(drawer[0].op, "reduced motion: the drawer must be opaque on its first frame").toBeGreaterThan(0.99);
    expect(tl.animations.filter((a) => a.key === "drawer" && a.props.includes("opacity")), "reduced motion: the drawer faded").toHaveLength(0);
  });

  test("the board loads behind a skeleton with its own geometry and fades in", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PANELOAD-02" });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await resetPaneStore(page.request, ["__board__"]);
    // The board chunk held back: the wait the audit measured on a warm HTTP
    // server, made long enough that every loading frame is observable.
    await page.route(/\/assets\/KanbanBoardPane-[^/]+\.js/, async (route) => {
      await new Promise((r) => setTimeout(r, 700));
      await route.continue();
    });
    await armFrameProbe(page, W);
    await page.goto("/");
    await expect(page.locator(`[data-testid="kanban-column-body-todo"] [data-task-card]`).first()).toBeVisible({ timeout: 30_000 });
    await nextFrames(page, 30);
    const tl = await readTimeline(page, null);

    const skel = presentSamples(tl, "skeleton");
    const board = presentSamples(tl, "board");
    console.log("[PANELOAD-02] skeleton frames", skel.length, "board first op", board[0]?.op);
    expect(skel.length, "no board skeleton while the board chunk loaded").toBeGreaterThan(0);

    // From the first skeleton frame to the board, the pane is never empty.
    const t0 = skel[0].t;
    const tBoard = board[0].t;
    const holes = tl.frames.filter((f) => f.t >= t0 && f.t < tBoard && !f.els.skeleton && !f.els.board);
    expect(holes.length, "frames with neither the skeleton nor the board").toBe(0);

    // The skeleton's columns sit where the real columns land.
    const final = tl.frames[tl.frames.length - 1].els;
    const skTodo = presentSamples(tl, "skelTodo");
    const skBacklog = presentSamples(tl, "skelBacklog");
    const geo = {
      todo: { skel: skTodo[0] && [skTodo[0].x, skTodo[0].y, skTodo[0].w], real: final.colTodo && [final.colTodo.x, final.colTodo.y, final.colTodo.w] },
      backlog: { skel: skBacklog[0] && [skBacklog[0].x, skBacklog[0].y, skBacklog[0].w] },
    };
    console.log("[PANELOAD-02] geometry", JSON.stringify(geo));
    expect(skTodo.length).toBeGreaterThan(0);
    expect(Math.abs(skTodo[0].x - final.colTodo!.x), "skeleton Todo column x").toBeLessThanOrEqual(2);
    expect(Math.abs(skTodo[0].y - final.colTodo!.y), "skeleton Todo column y").toBeLessThanOrEqual(2);
    expect(Math.abs(skTodo[0].w - final.colTodo!.w), "skeleton Todo column width").toBeLessThanOrEqual(2);

    // And the board does not pop: it fades in over the skeleton.
    expect(board[0].op, "the board landed at full opacity on its first frame").toBeLessThan(0.99);
  });

  test("a redirected drop and a filter move nothing by layout, and the sortable reflow runs on the tokens", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PANELOAD-03" });
    await openBoard(page);

    // Drag a Todo card onto In progress, paced one move per frame.
    await markFrame(page, "drag");
    const card = page.locator(`[data-testid="kanban-column-body-todo"] [data-task-card]`).first();
    const b = (await card.boundingBox())!;
    const target = (await page.getByTestId("kanban-column-body-in_progress").boundingBox())!;
    const from = { x: b.x + b.width / 2, y: b.y + 12 };
    const to = { x: target.x + target.width / 2, y: target.y + 60 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / 40, from.y + ((to.y - from.y) * i) / 40);
      await nextFrames(page, 1);
    }
    await markFrame(page, "drop");
    await page.mouse.up();
    await expect(page.locator(W.notice)).toBeVisible();
    await nextFrames(page, 30);
    await markFrame(page, "drop-end");

    // 1b. Floating is not enough: the first floating band sat over the top of
    // the columns and hid every header (label, status icon, count) until the
    // next drag. The notice covers no column header, not the composer, takes no
    // pointer input, and leaves by itself.
    const cover = await page.evaluate(() => {
      const notice = document.querySelector<HTMLElement>('[data-testid="board-drop-notice"]')!;
      const n = notice.getBoundingClientRect();
      const hit = (r: DOMRect) => r.width > 0 && r.height > 0 && n.left < r.right && r.left < n.right && n.top < r.bottom && r.top < n.bottom;
      const headers = [...document.querySelectorAll<HTMLElement>('[data-testid^="kanban-column-count-"]')].flatMap((count) => {
        const col = count.closest<HTMLElement>('[data-testid^="kanban-column-"]:not([data-testid^="kanban-column-count-"])');
        if (!col) return [];
        const c = col.getBoundingClientRect();
        const b = count.getBoundingClientRect();
        // The header band: from the column's top edge to the bottom of its count badge.
        return [{ id: col.dataset.testid!, r: new DOMRect(c.left, c.top, c.width, b.bottom - c.top) }];
      });
      const composer = document.querySelector<HTMLElement>('[data-testid="board-task-composer"]');
      const underCenter = document.elementFromPoint(n.left + n.width / 2, n.top + n.height / 2);
      return {
        notice: { top: n.top, bottom: n.bottom },
        headers: headers.length,
        covered: headers.filter((h) => hit(h.r)).map((h) => h.id),
        composer: composer ? hit(composer.getBoundingClientRect()) : false,
        catchesPointer: !!underCenter && notice.contains(underCenter),
      };
    });
    console.log("[PANELOAD-03] notice cover", JSON.stringify(cover));
    expect(cover.headers, "no column header found to check").toBeGreaterThan(0);
    expect(cover.covered, "the drop notice covers column headers").toEqual([]);
    expect(cover.composer, "the drop notice covers the task composer").toBe(false);
    expect(cover.catchesPointer, "the drop notice swallows clicks meant for the cards under it").toBe(false);
    await expect(page.locator(W.notice), "the drop notice never leaves by itself").toHaveCount(0, { timeout: 15_000 });

    // Filter on a word only the Todo cards carry: Review empties and narrows.
    await markFrame(page, "filter");
    const input = page.getByTestId("filter-token-input");
    await input.click();
    await input.pressSequentially(TODO_WORD, { delay: 30 });
    await expect(page.getByTestId("kanban-column-count-review")).toHaveText("0");
    await nextFrames(page, 30);
    await input.fill("");
    await page.keyboard.press("Escape");
    await nextFrames(page, 30);
    await markFrame(page, "filter-end");

    const drag = await readTimeline(page, "drag", "drop");
    const filter = await readTimeline(page, "filter", "filter-end");

    // 1. The drop notice does not push the columns: over the whole gesture,
    // from the first move to well after the notice is up.
    const todo = presentSamples(await readTimeline(page, "drag", "drop-end"), "colTodo");
    const pushed = { yStep: maxStep(todo, "y"), hStep: maxStep(todo, "h"), ys: [...new Set(todo.map((s) => s.y))] };
    console.log("[PANELOAD-03] drop push", JSON.stringify(pushed));
    expect(pushed.yStep, "the drop notice pushed the columns down").toBeLessThanOrEqual(1);
    expect(pushed.hStep, "the drop notice shortened the columns").toBeLessThanOrEqual(1);

    // 2. Nothing animates a layout property while filtering.
    const layoutAnimations = filter.animations.filter((a) => a.props.some((p) => LAYOUT_PROP.test(p)));
    console.log("[PANELOAD-03] filter layout anims", JSON.stringify(layoutAnimations.slice(0, 5)));
    expect(layoutAnimations, "a layout property animated during the filter").toHaveLength(0);

    // 3. The sortable reflow of the neighbours runs on the motion tokens.
    const sortable = drag.animations.filter((a) => a.props.includes("transform") && a.kind === "CSSTransition");
    console.log("[PANELOAD-03] sortable transitions", sortable.length, JSON.stringify(sortable.slice(0, 2)));
    expect(sortable.length, "no neighbour reflow observed during the drag").toBeGreaterThan(0);
    for (const a of sortable) {
      expect(MOTION_TOKENS, `sortable transition ${a.duration}ms`).toContain(a.duration);
      expect(a.easing, "sortable easing is not a token curve").toMatch(/^cubic-bezier\(0\.2, 0, 0, 1\)$/);
    }
  });

  test("under reduced motion the sortable reflow does not animate", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PANELOAD-03" });
    await openBoard(page, "reduce");
    await markFrame(page, "drag");
    const card = page.locator(`[data-testid="kanban-column-body-todo"] [data-task-card]`).first();
    const b = (await card.boundingBox())!;
    const target = (await page.getByTestId("kanban-column-body-in_progress").boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + 12);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(b.x + b.width / 2 + ((target.x + target.width / 2 - b.x - b.width / 2) * i) / 30, b.y + 12 + ((target.y + 60 - b.y - 12) * i) / 30);
      await nextFrames(page, 1);
    }
    await markFrame(page, "drop");
    await page.mouse.up();
    await nextFrames(page, 10);
    const drag = await readTimeline(page, "drag", "drop");
    const moving = drag.animations.filter((a) => a.props.includes("transform") && a.kind === "CSSTransition" && a.duration > 0);
    expect(moving, "reduced motion: the sortable reflow still transitions").toHaveLength(0);
  });

  test("a card carried to the row's edge scrolls it without snapping, and lands where the pointer is", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PANELOAD-03" });
    // BOARD-18 went red on Chromium with the card dropped on Done while the
    // hand was on In progress: dnd-kit auto-scrolls the row near its edge, a
    // few pixels every 5 ms, and the carousel's mandatory snap turned each
    // nudge into a jump to the next column (measured 0, 56, 768, 936 in three
    // frames once the scroll was instant). Reduced motion is the instant case.
    await openBoard(page, "reduce");
    const row = page.locator(W.colTodo).locator("xpath=..");
    await row.evaluate((el) => { el.scrollLeft = 0; });
    await nextFrames(page, 3);
    const card = page.locator(`[data-testid="kanban-column-body-todo"] [data-task-card]`).first();
    const cardId = (await card.getAttribute("data-task-card"))!;
    const c = (await card.boundingBox())!;
    const r = (await row.boundingBox())!;
    // 40 px inside the right edge: deep in dnd-kit's auto-scroll band.
    const edge = { x: r.x + r.width - 40, y: c.y + 12 };

    await page.mouse.move(c.x + c.width / 2, c.y + 12);
    await page.mouse.down();
    await page.mouse.move(c.x + c.width / 2 + 8, c.y + 20, { steps: 4 });
    await page.mouse.move(edge.x, edge.y, { steps: 12 });
    // Sample the row once per frame while the pointer rests in the band.
    const held = await row.evaluate((el) => new Promise<{ snap: string; lefts: number[] }>((done) => {
      const lefts: number[] = [];
      const snap = getComputedStyle(el).scrollSnapType;
      const step = () => {
        lefts.push(el.scrollLeft);
        if (lefts.length >= 40) done({ snap, lefts });
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }));
    // Carried on until Done, the column that was off screen when the drag
    // began, has come into the row: the card goes where the pointer is.
    await row.evaluate((el) => new Promise<void>((done) => {
      const target = el.querySelector<HTMLElement>('[data-testid="kanban-column-done"]')!;
      const step = () => {
        const t = target.getBoundingClientRect();
        if (t.left + t.width / 2 < el.getBoundingClientRect().right - 16) done();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }));
    const doneBox = (await page.getByTestId("kanban-column-body-done").boundingBox())!;
    await page.mouse.move(doneBox.x + doneBox.width / 2, edge.y, { steps: 4 });
    await nextFrames(page, 3);
    await page.mouse.up();

    // The snap itself is the contract, not a pixels-per-frame bound: headless
    // frames arrive unevenly (two samples 1 ms apart, then 70 ms of scroll in
    // one), so a rate read from rAF flaps, while a row that does not snap
    // cannot jump to a snap point.
    console.log("[PANELOAD-03] edge auto-scroll", JSON.stringify({ snap: held.snap, lefts: held.lefts }));
    expect(held.snap, "the row still snaps while a card is in hand").toMatch(/^none/);
    expect(held.lefts.at(-1)!, "the row never auto-scrolled towards the edge the card was carried to").toBeGreaterThan(held.lefts[0]);

    await expect.poll(async () => {
      const res = await page.request.get(`${BASE}/api/boards/${BOARD_ID}/tasks/${cardId}`);
      return ((await res.json()) as { task: { status: string } }).task.status;
    }, { timeout: 10_000 }).toBe("done");
  });
});
