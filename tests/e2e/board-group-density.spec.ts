/**
 * board-group-density.spec.ts — the cross-project board grouped by project,
 * and the compact card.
 *
 * Two projects, two cards each, every card with a description: grouped, the
 * board draws one lane per project and each card sits in its own project's
 * lane; compact, no card draws its description. Both choices survive a
 * reload (a per-viewer preference, like the list/kanban toggle). The Plan
 * view then draws a card the board has loaded with the board's own compact
 * card. Video on: the recording is the proof of the behaviour; screenshots go
 * to the test output and, with BOARD_GROUP_SHOTS set, to that folder too.
 *
 * Mutation: with `groupLanes` (boardLanes.ts) putting every card in the first
 * lane, «each card in its own project's lane» is red.
 *
 * @covers KANBAN-106
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath } from "../../shared/board";

hermetic(test);
test.use({ viewport: { width: 1600, height: 900 }, colorScheme: "dark", locale: "it-IT", video: { mode: "on", size: { width: 1600, height: 900 } } });
test.describe.configure({ mode: "serial", timeout: 120_000 });

const ROOT = canonicalTmpDir(`e2e-board-group-${process.pid}`);
const PROJECTS = [
  { path: join(ROOT, "acme-web"), cards: ["Rifare la pagina dei prezzi", "Correggere il menu su telefono"] },
  { path: join(ROOT, "studio-x"), cards: ["Esportare i report in CSV", "Sistemare il login con il link"] },
];
const SHOTS = process.env.BOARD_GROUP_SHOTS ?? "";
const created: Array<[string, string]> = [];
const topics: string[] = [];

function keep(path: string, name: string): void {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(path, join(SHOTS, name));
}

test.describe("la board di tutti i progetti, raggruppata e compatta", () => {
  test.beforeEach(() => { test.info().annotations.push({ type: "spec", description: "KANBAN-106" }); });

  test.beforeAll(async ({ request }) => {
    for (const p of PROJECTS) {
      mkdirSync(p.path, { recursive: true });
      writeFileSync(join(p.path, "package.json"), JSON.stringify({ name: p.path.split("/").pop() }));
      topics.push((await createTopic(request, `E2E-Group-${p.path.split("/").pop()}`, { projectPath: p.path })).id);
      const board = projectIdForPath(p.path);
      for (const [i, text] of p.cards.entries()) {
        const res = await request.post(`${E2E_BASE}/api/boards/${board}/tasks`, {
          data: { text, status: i === 0 ? "todo" : "backlog", description: `Dettagli per ${text}: cosa cambia e come si prova.` },
        });
        expect(res.ok(), await res.text()).toBe(true);
        created.push([board, ((await res.json()) as { id: string }).id]);
      }
    }
  });

  test.afterAll(async ({ request }) => {
    for (const [board, id] of created) await deleteTask(request, board, id);
    for (const id of topics) await deleteTopic(request, id);
    removeTmpDir(ROOT);
  });

  test("raggruppa per progetto, card compatte, e le due scelte restano dopo il reload", async ({ page, request }, testInfo) => {
    await resetPaneStore(request, []);
    await page.goto("/tab/panel/board");
    const board = page.getByTestId("kanban-board");
    await expect(board).toBeVisible({ timeout: 20_000 });
    const [first] = created;
    await expect(page.locator(`[data-task-card="${first[1]}"]`)).toBeVisible({ timeout: 20_000 });
    // Whole cards by default: the description is there.
    await expect(page.locator(`[data-task-card="${first[1]}"]`).getByTestId("card-description")).toBeVisible();

    const group = page.getByTestId("board-group-toggle");
    const density = page.getByTestId("board-density-toggle");
    await expect(group).toHaveAttribute("aria-pressed", "false");
    await group.click();
    await density.click();
    await expect(group).toHaveAttribute("aria-pressed", "true");
    await expect(density).toHaveAttribute("aria-pressed", "true");

    const check = async () => {
      // One lane per project of ours, each card in its own project's lane.
      for (const p of PROJECTS) {
        const lane = page.locator(`[data-testid="board-lane"][data-project="${projectIdForPath(p.path)}"]`);
        await expect(lane).toHaveCount(1);
        await expect(lane.getByTestId("board-lane-header")).toContainText(p.path.split("/").pop()!);
        for (const [board, id] of created) {
          const inLane = lane.locator(`[data-task-card="${id}"]`);
          await expect(inLane).toHaveCount(board === projectIdForPath(p.path) ? 1 : 0);
        }
      }
      // Compact: every card of ours on its compact face, without its description.
      for (const [, id] of created) {
        const card = page.locator(`[data-task-card="${id}"]`);
        await expect(card).toHaveAttribute("data-density", "compact");
        await expect(card.getByTestId("card-description")).toHaveCount(0);
      }
    };
    await check();
    const shot = testInfo.outputPath("board-raggruppata.png");
    await page.screenshot({ path: shot });
    keep(shot, "board-raggruppata.png");

    await page.reload();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("board-group-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("board-density-toggle")).toHaveAttribute("aria-pressed", "true");
    await check();
    const video = page.video();
    await page.close();
    // saveAs, not path(): the browser may run on another machine (pw-remote).
    if (video && SHOTS) { mkdirSync(SHOTS, { recursive: true }); await video.saveAs(join(SHOTS, "board-raggruppata.webm")); }
  });

  test("il Piano disegna la card della board, compatta", async ({ page, request }, testInfo) => {
    await resetPaneStore(request, []);
    await page.goto("/tab/panel/board");
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(`[data-task-card="${created[0][1]}"]`)).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("board-plan-toggle").click();
    const face = page.locator('[data-testid="plan-card"][data-face="board"]').filter({ has: page.locator(`[data-task-card="${created[0][1]}"]`) });
    await expect(face).toHaveCount(1, { timeout: 20_000 });
    await expect(face.locator(`[data-task-card="${created[0][1]}"]`)).toHaveAttribute("data-density", "compact");
    const shot = testInfo.outputPath("piano-card-board.png");
    await page.screenshot({ path: shot });
    keep(shot, "piano-card-board.png");
    const video = page.video();
    await page.close();
    if (video && SHOTS) { mkdirSync(SHOTS, { recursive: true }); await video.saveAs(join(SHOTS, "piano-card-board.webm")); }
  });
});
