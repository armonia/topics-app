/**
 * board-update-renders.spec.ts - HOW MUCH ONE `task:updated` FRAME RE-RENDERS.
 *
 * WHY. The board lives on `task:*` frames: an agent at work re-emits its row
 * every few seconds, and each frame reaches an open board with dozens of cards.
 * The cost of a frame never shows in one gesture (drag and click have their own
 * benches): it is background work, render after render, while a person reads.
 * Nothing counted it.
 *
 * WHAT IS COUNTED. The React components that really ran in the commits that
 * follow the frame, with the commit probe the split bench already uses
 * (`helpers/react-commit-probe.ts`): no special build, nothing compiled into the
 * app. `layout` is what renders outside the panes (App, sidebar, tab bars),
 * `pane` is what renders inside them, the board included.
 *
 * THE NOISE. The app has timers of its own (relative clocks, the live-usage
 * tick): the same window WITHOUT frames is measured first and subtracted, so
 * what is left is the cost of the frame and not of the time passing.
 *
 * THE FRAME. A card's title changes through the API: the server sends
 * `task:updated` with the whole row, like any change of a field that does not
 * move the card to another column, and the client absorbs it without reading
 * the feed again (`applyBoardTaskFrame`). It is the most frequent frame and the
 * cheapest one the app can get: if this one is expensive, all of them are.
 *
 * IT DOES NOT JUDGE. It writes `test-results/board-update-renders.json` and
 * asserts only that the harness worked (60+ cards, the frame landed, the probe
 * saw commits). The before/after comparison lives in the report of the track
 * that introduced it (`cloud-quality-pass`, T2).
 *
 * @covers KANBAN-01
 */
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hermetic } from "./fixtures/hermetic";
import { deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { beginGesture, endGesture, installProbe } from "./helpers/react-commit-probe";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/** Ad-hoc board id: the general board aggregates every board (BOARD-07). */
const BOARD_ID = "renderbench-e2e001";
/** Cards per column: 3 columns x 22 = 66, above the 60 the board has to carry. */
const PER_COLUMN = 22;
/** Frames measured. */
const FRAMES = 12;
/** Wait after each frame: long enough for cascading commits, short for timers. */
const SETTLE_MS = 400;

const OUT_PATH = resolve(__dirname, "../../test-results/board-update-renders.json");

test.describe("Board: renders per task:updated frame", () => {
  test.describe.configure({ timeout: 240_000 });
  test.use({ viewport: { width: 1600, height: 900 } });

  const stamp = Date.now();
  const created: string[] = [];

  test.beforeAll(async ({ request }) => {
    const seed = async (text: string, status: "backlog" | "todo" | "done"): Promise<void> => {
      const res = await request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, {
        data: { text, status: status === "done" ? "todo" : status },
      });
      expect(res.ok(), `the board API refused to seed "${text}"`).toBe(true);
      const { id } = (await res.json()) as { id: string };
      created.push(id);
      if (status === "done") {
        const patch = await request.patch(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks/${id}`, { data: { status: "done" } });
        expect(patch.ok(), `could not close "${text}"`).toBe(true);
      }
    };
    for (const status of ["backlog", "todo", "done"] as const) {
      await Promise.all(
        Array.from({ length: PER_COLUMN }, (_, i) => seed(`Render bench ${status} ${i} ${stamp}`, status)),
      );
    }
  });

  test.afterAll(async ({ request }) => {
    for (let i = 0; i < created.length; i += 20) {
      await Promise.all(created.slice(i, i + 20).map((id) => deleteTask(request, BOARD_ID, id).catch(() => {})));
    }
  });

  test("counts component renders per task:updated frame on a 60+ card board", async ({ page, request }, testInfo) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
    await resetPaneStore(page.request, ["__board__"]);
    await installProbe(page);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
    await page.locator('[data-pane-id="__board__"]').first().click();
    const board = page.getByTestId("kanban-board");
    await expect(board).toBeVisible({ timeout: 20_000 });
    await expect(board.getByText(`Render bench todo 0 ${stamp}`)).toBeVisible({ timeout: 20_000 });
    const cards = await board.locator("[data-task-card]").count();
    // The board settles: first reads, previews, entry animations.
    await page.waitForTimeout(1_500);

    // Noise: the same duration, no frame.
    const idleMarks = await beginGesture(page);
    await page.waitForTimeout(FRAMES * SETTLE_MS);
    const idle = await endGesture(page, idleMarks);

    // The frame: a todo card's title changes, the card stays in its column.
    const target = created[PER_COLUMN];
    const busyMarks = await beginGesture(page);
    for (let i = 0; i < FRAMES; i++) {
      const text = `Render bench todo 0 ${stamp} v${i}`;
      const res = await request.patch(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks/${target}`, { data: { text } });
      expect(res.ok()).toBe(true);
      await expect(board.getByText(text, { exact: true })).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(SETTLE_MS);
    }
    const busy = await endGesture(page, busyMarks);

    const per = (b: number, i: number) => Math.round((Math.max(0, b - i) / FRAMES) * 10) / 10;
    const payload = {
      $schema: "board-update-renders-v1",
      measuredAt: new Date().toISOString(),
      cards,
      frames: FRAMES,
      settleMs: SETTLE_MS,
      rendersPerFrame: per(busy.layoutRenders + busy.paneRenders, idle.layoutRenders + idle.paneRenders),
      layoutRendersPerFrame: per(busy.layoutRenders, idle.layoutRenders),
      paneRendersPerFrame: per(busy.paneRenders, idle.paneRenders),
      commitsPerFrame: per(busy.commits, idle.commits),
      idle: { commits: idle.commits, layout: idle.layoutRenders, pane: idle.paneRenders },
      busy: { commits: busy.commits, layout: busy.layoutRenders, pane: busy.paneRenders, topNames: busy.topNames },
    };
    mkdirSync(resolve(__dirname, "../../test-results"), { recursive: true });
    writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    testInfo.annotations.push({
      type: "renders",
      description: `${payload.rendersPerFrame} renders/frame (layout ${payload.layoutRendersPerFrame}, pane ${payload.paneRendersPerFrame}) · ${payload.commitsPerFrame} commits/frame · ${cards} cards`,
    });

    // Harness sanity only: without commits the number says nothing.
    expect(cards, "the board shows fewer than 60 cards").toBeGreaterThanOrEqual(60);
    expect(busy.commits, "the probe saw no React commit: the hook was not installed").toBeGreaterThan(0);
  });
});
