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

  /** Straight legs between waypoints, `moves` pointer moves in all, one per frame. */
  async function pacedPath(page: Page, points: Array<{ x: number; y: number }>, moves: number) {
    const perLeg = Math.max(1, Math.floor(moves / (points.length - 1)));
    for (let leg = 0; leg < points.length - 1; leg++) {
      const a = points[leg]!;
      const z = points[leg + 1]!;
      for (let i = 1; i <= perLeg; i++) {
        await page.mouse.move(a.x + ((z.x - a.x) * i) / perLeg, a.y + ((z.y - a.y) * i) / perLeg);
        await nextFrames(page, 1);
      }
    }
  }

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

    // Drag a Todo card over its neighbour, then onto In progress, paced one
    // move per frame. The dip is what makes a neighbour move: on a straight
    // line to In progress the pointer never leaves the card in hand, and the
    // only transitions were the identity transform flipping on and off.
    await markFrame(page, "drag");
    const todoCards = page.locator(`[data-testid="kanban-column-body-todo"] [data-task-card]`);
    const b = (await todoCards.nth(0).boundingBox())!;
    const next = (await todoCards.nth(1).boundingBox())!;
    const target = (await page.getByTestId("kanban-column-body-in_progress").boundingBox())!;
    const from = { x: b.x + b.width / 2, y: b.y + 12 };
    const to = { x: target.x + target.width / 2, y: target.y + 60 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await pacedPath(page, [from, { x: next.x + next.width / 2, y: next.y + next.height / 2 }, to], 40);
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
    const todoCards = page.locator(`[data-testid="kanban-column-body-todo"] [data-task-card]`);
    const b = (await todoCards.nth(0).boundingBox())!;
    const next = (await todoCards.nth(1).boundingBox())!;
    const target = (await page.getByTestId("kanban-column-body-in_progress").boundingBox())!;
    const from = { x: b.x + b.width / 2, y: b.y + 12 };
    const dip = { x: next.x + next.width / 2, y: next.y + next.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await pacedPath(page, [from, dip], 15);
    // Over the neighbour, the neighbour has moved: without this the test
    // would pass on a drag that displaces nobody.
    expect(await todoCards.nth(1).evaluate((el) => (el as HTMLElement).style.transform), "the neighbour was not displaced: the gesture tests nothing").toMatch(/translate3d\(0px, -\d/);
    await pacedPath(page, [dip, { x: target.x + target.width / 2, y: target.y + 60 }], 15);
    await markFrame(page, "drop");
    await page.mouse.up();
    await nextFrames(page, 10);
    const drag = await readTimeline(page, "drag", "drop");
    const moving = drag.animations.filter((a) => a.props.includes("transform") && a.kind === "CSSTransition" && a.duration > 0);
    expect(moving, "reduced motion: the sortable reflow still transitions").toHaveLength(0);
  });

  test("a card held over In progress at the row's edge lands on In progress, not on a column the snap scrolled in", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PANELOAD-03" });
    // BOARD-18 went red on Chromium with the card dropped on Done while the
    // hand was on In progress: dnd-kit auto-scrolls the row near its edge, a
    // few pixels every 5 ms, and the carousel's mandatory snap turned each
    // nudge into a jump to the next column (measured 0, 56, 768, 936 in three
    // frames once the scroll was instant).
    //
    // The row's scroll is made instant here, under the reduced motion the
    // suite runs in. Its `sm:scroll-smooth` only slows a snap jump into an
    // animation, and a reduced-motion rule that reaches the row makes it
    // instant again: the snap hold has to keep the drop under the pointer on
    // its own. With the smoothing left on, the snap drags a nudged row back
    // and the drop lands on In progress with or without the hold, so the test
    // could not tell them apart.
    //
    // At 1280 the right part of In progress sits inside the auto-scroll band
    // (the row's last 20%, dnd-kit's default threshold, measured from the
    // pointer). The hand rests there for two frames and lets go. Measured on
    // WebKit: without the hold the row is at 760 after those two frames and
    // the card lands on Done (3 out of 3); with it the row has moved 6 to 22 px
    // (holding 2 and 4 frames) and the drop lands on In progress, which
    // redirects to Todo and says so (5 out of 5).
    await page.setViewportSize({ width: 1280, height: 900 });
    await openBoard(page, "reduce");
    const row = page.getByTestId("kanban-columns-row");
    await row.evaluate((el) => { el.style.scrollBehavior = "auto"; el.scrollLeft = 0; });
    await nextFrames(page, 3);
    const card = page.locator(`[data-testid="kanban-column-body-todo"] [data-task-card]`).first();
    const cardId = (await card.getAttribute("data-task-card"))!;
    const c = (await card.boundingBox())!;
    const r = (await row.boundingBox())!;
    const target = (await page.getByTestId("kanban-column-body-in_progress").boundingBox())!;
    const band = { from: Math.max(r.x + r.width * 0.8, target.x), to: Math.min(r.x + r.width, target.x + target.width) };
    // A little past the middle of the stretch of In progress inside the band:
    // deep enough that every auto-scroll tick moves the row, and ~35 px from
    // Review, room for a row that moves by pixels during the hold. If the
    // layout ever takes In progress out of the band, the test says so instead
    // of measuring a gesture that never auto-scrolls.
    expect(band.to - band.from, "In progress is not under the row's auto-scroll band at this viewport").toBeGreaterThan(48);
    const aim = { x: band.from + (band.to - band.from) * 0.55, y: c.y + 12 };
    console.log("[PANELOAD-03] edge aim", JSON.stringify({ aim, row: [r.x, r.x + r.width], inProgress: [target.x, target.x + target.width], band }));

    await page.mouse.move(c.x + c.width / 2, c.y + 12);
    await page.mouse.down();
    await page.mouse.move(c.x + c.width / 2 + 8, c.y + 20, { steps: 4 });
    await page.mouse.move(aim.x, aim.y, { steps: 12 });
    await nextFrames(page, 2);
    const held = await row.evaluate((el) => ({ snap: getComputedStyle(el).scrollSnapType, left: el.scrollLeft }));
    await page.mouse.up();
    console.log("[PANELOAD-03] edge hold", JSON.stringify(held));

    // Landed on In progress: the redirect notice is up and the card is still
    // in Todo. A drop on Done says nothing, so the notice tells the two apart
    // before any PATCH could land.
    await expect(page.getByTestId("board-drop-notice"), "the drop did not land on In progress, the column under the pointer").toBeVisible({ timeout: 5_000 });
    await expect.poll(async () => {
      const res = await page.request.get(`${BASE}/api/boards/${BOARD_ID}/tasks/${cardId}`);
      return ((await res.json()) as { task: { status: string } }).task.status;
    }, { timeout: 10_000 }).toBe("todo");
    // The mechanism, read while the card was in hand.
    expect(held.snap, "the row still snaps while a card is in hand").toMatch(/^none/);
  });

  test("on the phone, the first tap after a drag does not re-snap the row under the finger", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PANELOAD-03" });
    // The snap is held by a drag and comes back at the next scroll gesture.
    // Released at `touchstart`, the first TAP after a drag gave it back too,
    // and the row re-snapped under the finger pressing a card: measured on
    // this viewport, held at 343 and one tap later at 253, a 90 px jump.
    //
    // WebKit on the Mac has no touch input (`new Touch()` is an illegal
    // constructor and a tap sends no `touchstart`), so the tap and the swipe
    // are the events the row listens to, dispatched on it. The drag that
    // holds the snap is a keyboard one, cancelled so no card moves, and the
    // off-snap position is the one a drag's auto-scroll leaves behind.
    await openBoard(page, "reduce");
    await page.setViewportSize({ width: 390, height: 844 });
    const row = page.getByTestId("kanban-columns-row");
    const card = page.locator(`[data-testid="kanban-column-body-todo"] [data-task-card]`).first();
    await row.evaluate((el) => { el.style.scrollBehavior = "auto"; });
    await card.scrollIntoViewIfNeeded();
    await card.focus();
    await page.keyboard.press("Space");
    await expect(page.locator("[data-drag-preview]")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-drag-preview]")).toHaveCount(0);

    const snapOf = () => row.evaluate((el) => getComputedStyle(el).scrollSnapType);
    expect(await snapOf(), "the drag did not hold the snap").toMatch(/^none/);
    // Between two columns, where the auto-scroll of a drag leaves it.
    const left = await row.evaluate((el) => {
      const cols = Array.from(el.querySelectorAll<HTMLElement>('[data-testid^="kanban-column-"]'))
        .filter((c) => c.parentElement === el);
      el.scrollLeft = Math.round((cols[1]!.offsetLeft + cols[2]!.offsetLeft) / 2 - el.clientWidth / 4);
      return el.scrollLeft;
    });
    await nextFrames(page, 5);
    expect(await row.evaluate((el) => el.scrollLeft)).toBe(left);

    const fire = (type: string) => row.evaluate((el, t) => { el.dispatchEvent(new Event(t, { bubbles: true, cancelable: true })); }, type);
    await fire("touchstart");
    await fire("touchend");
    await nextFrames(page, 30);
    expect(await row.evaluate((el) => el.scrollLeft), "a tap re-snapped the row").toBe(left);
    expect(await snapOf(), "a tap gave the snap back").toMatch(/^none/);

    // A finger that moves is a scroll gesture: the carousel snaps again.
    await fire("touchstart");
    await fire("touchmove");
    await expect.poll(snapOf).toMatch(/^x/);
  });

  test("on the phone, a finger carrying a card does not give the row its snap back", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "PANELOAD-03" });
    // The snap comes back when a finger moves on the row. A finger dragging a
    // card moves on the row too: the card's source node stays in it while the
    // card is in hand, so every `touchmove` of the drag bubbles through the
    // row. Released there, the snap came back at the first move with the card
    // still in hand, the condition BOARD-18 forbids.
    //
    // The touches are synthesised (WebKit on the Mac has no touch input): an
    // event named `touchstart`/`touchmove` with a `touches` list is all that
    // dnd-kit's touch sensor and the row's listener read.
    await openBoard(page, "reduce");
    await page.setViewportSize({ width: 390, height: 844 });
    const row = page.getByTestId("kanban-columns-row");
    const card = page.locator(`[data-testid="kanban-column-body-todo"] [data-task-card]`).first();
    const snapOf = () => row.evaluate((el) => getComputedStyle(el).scrollSnapType);
    await card.scrollIntoViewIfNeeded();
    await nextFrames(page, 10);
    expect(await snapOf(), "the row snaps before the drag").toMatch(/^x/);

    type Finger = { __finger: (type: string, dx: number) => void };
    await card.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + 12;
      const hit = document.elementFromPoint(x, y);
      const target = hit && el.contains(hit) ? hit : el;
      (window as unknown as Finger).__finger = (type, dx) => {
        // A MouseEvent so it carries clientX/Y: WebKit on the Mac has no
        // TouchEvent class, and dnd-kit reads the coordinates from the event.
        const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x + dx, clientY: y });
        const t = [{ identifier: 0, target, clientX: x + dx, clientY: y, pageX: x + dx, pageY: y, screenX: x + dx, screenY: y }];
        Object.defineProperty(ev, "touches", { value: type === "touchend" ? [] : t });
        Object.defineProperty(ev, "targetTouches", { value: type === "touchend" ? [] : t });
        Object.defineProperty(ev, "changedTouches", { value: t });
        target.dispatchEvent(ev);
      };
    });
    const finger = (type: string, dx: number) =>
      page.evaluate(({ type, dx }) => (window as unknown as Finger).__finger(type, dx), { type, dx });

    await finger("touchstart", 0);
    // The touch sensor lifts the card after a still press (200 ms).
    await expect(page.locator("[data-drag-preview]")).toHaveCount(1, { timeout: 5_000 });
    await nextFrames(page, 3);
    expect(await snapOf(), "the lift did not hold the snap").toMatch(/^none/);
    await finger("touchmove", 12);
    await nextFrames(page, 5);
    await finger("touchmove", 24);
    await nextFrames(page, 5);
    await expect(page.locator("[data-drag-preview]"), "the card left the hand").toHaveCount(1);
    expect(await snapOf(), "the snap came back while the card was in hand").toMatch(/^none/);

    // The card leaves the hand; the snap stays held until a finger scrolls.
    await finger("touchend", 24);
    await expect(page.locator("[data-drag-preview]")).toHaveCount(0);
    await nextFrames(page, 5);
    expect(await snapOf(), "the drop gave the snap back").toMatch(/^none/);
    await row.evaluate((el) => {
      el.dispatchEvent(new Event("touchstart", { bubbles: true }));
      el.dispatchEvent(new Event("touchmove", { bubbles: true }));
    });
    await expect.poll(snapOf).toMatch(/^x/);
  });
});
