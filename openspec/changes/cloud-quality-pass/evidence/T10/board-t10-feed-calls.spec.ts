/**
 * T10 measurement, not a gate: how many reads of the global feed a board
 * session pays for 20 real `task:updated` frames (20 PATCHes through the API,
 * so the server broadcasts its own full rows), and how many bytes each read is.
 */
import { test } from "./fixtures/layout.fixture";
import { expect } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const PROJECT_PATH = canonicalTmpDir("e2e-t10-feed-calls");
const PROJECT_ID = boardIdForPath(PROJECT_PATH);
const WINDOW_MS = 400;

test("T10: 20 task:updated in a board session", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(PROJECT_PATH, { recursive: true });
  writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-t10" }));
  const topic = await createTopic(page.request, "E2E-T10", { projectPath: PROJECT_PATH });
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const r = await page.request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: `T10 card ${i}`, status: i % 2 ? "todo" : "backlog", description: `Descrizione ${i}. `.repeat(60) },
    });
    ids.push(((await r.json()) as { id: string }).id);
  }

  let reads = 0;
  let inFlight = 0;
  let last = Date.now();
  const bytes: number[] = [];
  await page.route(/\/api\/all-boards\/tasks(\?|$)/, async (route) => {
    reads++; inFlight++; last = Date.now();
    const res = await route.fetch();
    const body = await res.body();
    bytes.push(body.length);
    await route.fulfill({ response: res, body });
    inFlight--; last = Date.now();
  });
  const settled = () => expect.poll(() => inFlight === 0 && Date.now() - last > 3 * WINDOW_MS, { timeout: 20_000, intervals: [100] }).toBe(true);

  await resetPaneStore(page.request, []);
  await page.goto("/");
  await page.getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu-board").click();
  const board = page.getByTestId("kanban-board");
  await expect(board.getByText("T10 card 29")).toBeVisible({ timeout: 15_000 });
  await settled();
  const bootReads = reads;
  reads = 0;

  // 20 writes, one card each (renames: same column, same parent), 150 ms apart.
  for (let i = 0; i < 20; i++) {
    const r = await page.request.patch(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks/${ids[i]}`, { data: { text: `T10 renamed ${i}` } });
    expect(r.ok()).toBe(true);
    await page.waitForTimeout(150);
  }
  await expect(board.getByText("T10 renamed 19")).toBeVisible({ timeout: 10_000 });
  await settled();
  const result = { bootReads, readsFor20Updates: reads, bytesPerRead: bytes[bytes.length - 1], tasks: ids.length };
  console.log("T10-FEED-CALLS " + JSON.stringify(result));
  test.info().annotations.push({ type: "t10", description: JSON.stringify(result) });

  for (const id of ids) await deleteTask(page.request, PROJECT_ID, id);
  await deleteTopic(page.request, topic.id);
  removeTmpDir(PROJECT_PATH);
});
