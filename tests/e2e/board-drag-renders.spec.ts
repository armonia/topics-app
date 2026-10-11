/**
 * board-drag-renders.spec.ts - HOW MUCH ONE POINTER MOVE OF A BOARD DRAG RE-RENDERS.
 *
 * WHY. `board-drag-frames.spec.ts` says how much main thread a drag costs, but
 * not where it goes. The bulk of it is React: dnd-kit hands every `useSortable`
 * and `useDroppable` its internal context, and that value changes whenever the
 * droppable under the pointer changes, so every mounted card runs again. This
 * bench counts those renders, the way `board-update-renders.spec.ts` counts the
 * ones of a `task:updated` frame.
 *
 * THE GESTURE IS THE DRAG BENCH'S. Same seed (150 `done`, 8 `todo`), same
 * viewport, same paced route (todo card -> In Progress -> Backlog, one pointer
 * move per animation frame), so the two numbers speak about the same drag.
 *
 * WHAT IS COUNTED. The React components that really ran (the commit probe of
 * `helpers/react-commit-probe.ts`, no special build), split in two windows:
 * the ACTIVATION (pointer down plus the move that starts the drag: the overlay
 * mounts and the board learns which card is in hand) and the MOVES after it,
 * divided by their number. The second one is the per-move cost a hand feels
 * for the whole length of the gesture.
 *
 * The probe is off outside the windows, so the timed numbers of the drag bench
 * are not taken here: walking the fiber tree on every commit is work of its own.
 *
 * IT DOES NOT JUDGE. It writes `test-results/board-drag-renders.json` and
 * asserts only that the harness worked (cards on screen, renders seen, every
 * drop committed). The before/after comparison lives in the report of the track
 * that introduced it (`cloud-quality-pass`, T8).
 *
 * @covers DRAGFR-01
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hermetic } from "./fixtures/hermetic";
import { deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { beginGesture, endGesture, installProbe, settlePanes } from "./helpers/react-commit-probe";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/** Its own ad-hoc board id: the general board aggregates every board (BOARD-07). */
const BOARD_ID = "dragrender-e2e001";
const DONE_SEEDED = 150;
const TODO_SEEDED = 8;
/** Counted passes, after one discarded warm-up. */
const PASSES = 3;
/** Pointer moves per drag, one per animation frame, as in the drag bench. */
const STEPS = 60;

const OUT_PATH = resolve(__dirname, "../../test-results/board-drag-renders.json");

interface Point {
  x: number;
  y: number;
}

async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
}

/** Straight-line interpolation between waypoints, one move per frame. Returns the moves made. */
async function pacedDrag(page: Page, path: Point[], steps: number): Promise<number> {
  const legs = path.length - 1;
  const perLeg = Math.max(1, Math.floor(steps / legs));
  let moves = 0;
  for (let leg = 0; leg < legs; leg++) {
    const from = path[leg]!;
    const to = path[leg + 1]!;
    for (let i = 1; i <= perLeg; i++) {
      const f = i / perLeg;
      await page.mouse.move(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f);
      await nextFrame(page);
      moves += 1;
    }
  }
  return moves;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

test.describe("@nightly Kanban drag - renders per pointer move", () => {
  test.describe.configure({ timeout: 420_000 });
  test.use({ viewport: { width: 1600, height: 900 } });

  const stamp = Date.now();
  const createdTasks: string[] = [];
  const todoIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const seed = async (text: string, done: boolean): Promise<string> => {
      const res = await request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, { data: { text, status: "todo" } });
      expect(res.ok(), `the board API refused to seed "${text}"`).toBe(true);
      const { id } = (await res.json()) as { id: string };
      createdTasks.push(id);
      if (done) {
        const patch = await request.patch(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks/${id}`, { data: { status: "done" } });
        expect(patch.ok(), `could not close "${text}"`).toBe(true);
      }
      return id;
    };
    const WAVE = 20;
    for (let i = 0; i < DONE_SEEDED; i += WAVE) {
      await Promise.all(
        Array.from({ length: Math.min(WAVE, DONE_SEEDED - i) }, (_, k) => seed(`Drag render closed ${i + k} ${stamp}`, true)),
      );
    }
    for (let i = 0; i < TODO_SEEDED; i++) todoIds.push(await seed(`Drag render open ${i} ${stamp}`, false));
  });

  test.afterAll(async ({ request }) => {
    for (let i = 0; i < createdTasks.length; i += 20) {
      await Promise.all(createdTasks.slice(i, i + 20).map((id) => deleteTask(request, BOARD_ID, id).catch(() => {})));
    }
  });

  test("counts component renders per pointer move while a card is dragged across columns @nightly", async ({ page }, testInfo) => {
    test.info().annotations.push({ type: "spec", description: "DRAGFR-01" });
    await resetPaneStore(page.request, ["__board__"]);
    await installProbe(page);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
    await page.locator('[data-pane-id="__board__"]').first().click();

    const board = page.getByTestId("kanban-board");
    await expect(board).toBeVisible({ timeout: 20_000 });
    const todoBody = page.getByTestId("kanban-column-body-todo");
    const backlogBody = page.getByTestId("kanban-column-body-backlog");
    const inProgressBody = page.getByTestId("kanban-column-body-in_progress");
    await expect(todoBody.locator(`[data-task-card="${todoIds[0]}"]`)).toBeVisible({ timeout: 20_000 });
    const backlogBox = (await backlogBody.boundingBox())!;
    const inProgressBox = (await inProgressBody.boundingBox())!;

    const onePass = async (cardId: string) => {
      const card = page.locator(`[data-task-card="${cardId}"]`);
      await card.scrollIntoViewIfNeeded();
      // The previous drop's re-reads and flights must not land in this window.
      await settlePanes(page);
      const box = (await card.boundingBox())!;
      const grab: Point = { x: box.x + box.width / 2, y: box.y + 12 };
      const cards = await page.locator("[data-task-card]").count();

      await page.mouse.move(grab.x, grab.y);
      const activationMarks = await beginGesture(page);
      await page.mouse.down();
      await page.mouse.move(grab.x + 8, grab.y + 8);
      await nextFrame(page);
      await nextFrame(page);
      const activation = await endGesture(page, activationMarks);

      const moveMarks = await beginGesture(page);
      const moves = await pacedDrag(
        page,
        [
          { x: grab.x + 8, y: grab.y + 8 },
          { x: inProgressBox.x + inProgressBox.width / 2, y: inProgressBox.y + inProgressBox.height / 3 },
          { x: backlogBox.x + backlogBox.width / 2, y: backlogBox.y + backlogBox.height / 2 },
        ],
        STEPS,
      );
      const moving = await endGesture(page, moveMarks);
      await page.mouse.up();

      await expect
        .poll(async () => {
          const r = await page.request.get(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks/${cardId}`);
          return ((await r.json()) as { task?: { status?: string } }).task?.status;
        }, { timeout: 10_000 })
        .toBe("backlog");

      const renders = moving.layoutRenders + moving.paneRenders;
      return {
        cards,
        moves,
        activationRenders: activation.layoutRenders + activation.paneRenders,
        moveRenders: renders,
        moveCommits: moving.commits,
        rendersPerMove: round1(renders / moves),
        commitsPerMove: round1(moving.commits / moves),
        topNames: moving.topNames,
      };
    };

    // Warm-up, discarded: the first drag of the board's life pays the lazy
    // imports and the first measurement of every droppable.
    await onePass(todoIds[0]!);
    const passes: Array<Awaited<ReturnType<typeof onePass>>> = [];
    for (let i = 0; i < PASSES; i++) passes.push(await onePass(todoIds[i + 1]!));

    const payload = {
      $schema: "board-drag-renders-v1",
      measuredAt: new Date().toISOString(),
      protocol: { passes: PASSES, warmup_passes: 1, steps_per_drag: STEPS, done_seeded: DONE_SEEDED, todo_seeded: TODO_SEEDED },
      median: {
        rendersPerMove: round1(median(passes.map((p) => p.rendersPerMove))),
        commitsPerMove: round1(median(passes.map((p) => p.commitsPerMove))),
        activationRenders: median(passes.map((p) => p.activationRenders)),
      },
      passes,
    };
    mkdirSync(resolve(__dirname, "../../test-results"), { recursive: true });
    writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    testInfo.annotations.push({
      type: "renders",
      description: `${payload.median.rendersPerMove} renders/move · ${payload.median.commitsPerMove} commits/move · activation ${payload.median.activationRenders} · ${passes[0]!.cards} cards`,
    });

    // Harness sanity only.
    for (const p of passes) {
      expect(p.cards, "the board shows too few cards for the bench to mean anything").toBeGreaterThanOrEqual(30);
      expect(p.moveCommits, "the probe saw no React commit while dragging: the hook was not installed").toBeGreaterThan(0);
    }
  });
});
