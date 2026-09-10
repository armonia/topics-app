/**
 * board-orchestrator-drawer.spec.ts — the coordinator opens INSIDE the Kanban.
 *
 * The toolbar entry used to promote the conversation to a permanent pane: you
 * left the board to talk about the board. It now takes the slot the task
 * preview opens in, and this spec is the acceptance criterion: the drawer sits
 * inside the board's own box, the tab strip gains nothing, the two drawers are
 * never open together, and the escape hatch (open in a tab) still exists.
 *
 * @covers GLOBAL-ORCHESTRATOR-CLIENT-01
 */
import { test } from "./fixtures/layout.fixture";
import { expect } from "@playwright/test";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { beat, didascalia } from "./helpers/evidence";
import { mkdirSync, writeFileSync } from "fs";

hermetic(test);

// A REAL card in the global feed: without one the mutual-exclusion test would
// skip, and a skipped test is not evidence.
const PROJECT_PATH = canonicalTmpDir("e2e-orch-drawer");
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
let projectTopicId: string | null = null;
let seededTaskId: string | null = null;

test.describe("il coordinatore della Kanban è una finestra della Kanban", () => {
  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-orch-drawer" }, null, 2));
    const topic = await createTopic(request, "E2E-Orch-Drawer", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    const res = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: "Card di prova per il cassetto del coordinatore", status: "todo" },
    });
    expect(res.ok()).toBe(true);
    seededTaskId = ((await res.json()) as { id: string }).id;
  });

  test.afterAll(async ({ request }) => {
    if (seededTaskId) await deleteTask(request, PROJECT_ID, seededTaskId);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    removeTmpDir(PROJECT_PATH);
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await page.goto("/");
    await page.getByTestId("pane-add-menu-trigger").first().click();
    await page.getByTestId("pane-add-menu-board").click();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
  });

  test("ORCH-DRAWER-01: l'ingresso apre un cassetto dentro la board, senza aprire una tab", async ({ page }) => {
    const board = page.getByTestId("kanban-board");
    const entry = page.getByTestId("board-open-orchestrator");
    await expect(entry).toBeVisible();
    await expect(entry).toHaveAttribute("aria-pressed", "false");

    // The glyph IS the contract: the default speech bubble said "a chat like
    // any other". `Music4` is a beamed pair of notes, and those two note heads
    // (two <circle> elements) are what tells this button apart.
    await expect(entry.locator("svg circle")).toHaveCount(2);

    // How many surfaces are open BEFORE: if the coordinator still opened a
    // pane this number would rise. It is the measurement behind "not a tab".
    const tabsBefore = await page.getByRole("tab").count();
    await didascalia(page, "In barra: due note, non una nuvoletta");
    await beat(page, 1800);

    await entry.click();

    const drawer = page.getByTestId("board-orchestrator-drawer");
    await expect(drawer).toBeVisible({ timeout: 15000 });
    await expect(entry).toHaveAttribute("aria-pressed", "true");
    // The real chat, not an empty shell.
    await expect(drawer.getByTestId("chat-panel")).toBeVisible({ timeout: 15000 });

    // INSIDE the board, not over the window: the drawer's rectangle is
    // contained in the board's (1px of tolerance for rounded edges).
    const boardBox = (await board.boundingBox())!;
    const drawerBox = (await drawer.boundingBox())!;
    expect(drawerBox.x).toBeGreaterThanOrEqual(boardBox.x - 1);
    expect(drawerBox.y).toBeGreaterThanOrEqual(boardBox.y - 1);
    expect(drawerBox.x + drawerBox.width).toBeLessThanOrEqual(boardBox.x + boardBox.width + 1);
    expect(drawerBox.y + drawerBox.height).toBeLessThanOrEqual(boardBox.y + boardBox.height + 1);
    // And the columns stay: the drawer SHRINKS them, it does not cover them.
    await expect(page.getByTestId("kanban-column-todo")).toBeVisible();
    await didascalia(page, "Si apre DENTRO la board: le colonne si stringono, non spariscono");
    await beat(page, 2400);

    expect(await page.getByRole("tab").count()).toBe(tabsBefore);
    await didascalia(page, `Nessuna tab in piu\u2019: ${tabsBefore} prima, ${tabsBefore} adesso`);
    await beat(page, 2000);

    // The entry is a toggle: pressed again, it closes.
    await entry.click();
    await expect(drawer).toBeHidden();
    await expect(entry).toHaveAttribute("aria-pressed", "false");
    await didascalia(page, "Lo stesso bottone lo richiude");
    await beat(page, 1800);
  });

  test("ORCH-DRAWER-02: un solo cassetto per volta — aprire una card chiude il coordinatore", async ({ page }) => {
    const entry = page.getByTestId("board-open-orchestrator");
    await entry.click();
    const drawer = page.getByTestId("board-orchestrator-drawer");
    await expect(drawer).toBeVisible({ timeout: 15000 });

    // The card THIS file seeded, not "any card": the global board aggregates
    // every project, and in a full run other specs' seeds land here too.
    const card = page.locator(`[data-task-card="${seededTaskId}"]`);
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.click();
    await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 15000 });
    await expect(drawer, "i due cassetti condividono lo slot: non stanno aperti insieme").toBeHidden();
    await expect(entry).toHaveAttribute("aria-pressed", "false");
  });

  test("ORCH-DRAWER-03: la X chiude, e l'uscita di sicurezza promuove la stessa conversazione a tab", async ({ page }) => {
    const entry = page.getByTestId("board-open-orchestrator");
    await entry.click();
    const drawer = page.getByTestId("board-orchestrator-drawer");
    await expect(drawer).toBeVisible({ timeout: 15000 });

    await page.getByTestId("board-orchestrator-close").click();
    await expect(drawer).toBeHidden();

    await entry.click();
    await expect(drawer).toBeVisible({ timeout: 15000 });
    const tabsBefore = await page.getByRole("tab").count();
    await page.getByTestId("board-orchestrator-popout").click();
    // The drawer closes (the same chat is never mounted twice) and the
    // conversation reaches the strip as a permanent pane.
    await expect(drawer).toBeHidden();
    await expect.poll(() => page.getByRole("tab").count(), { timeout: 15000 }).toBe(tabsBefore + 1);
  });
});
