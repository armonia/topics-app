import { expect, test } from "@playwright/test";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { goToApp } from "./helpers";
import { E2E_BASE, testServerEnv } from "./helpers/test-server";
import { seedTranscript } from "./helpers/seed-transcript";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { projectIdForPath } from "../../shared/board";
import { COLUMN_PAGE } from "../../client/src/lib/boardOrder";

/** @covers IDLE-01 */

const MESSAGE_COUNT = 2_000;
const DOM_BUDGET = 5_000;
const PROJECT_PATH = canonicalTmpDir("e2e-dom-node-budget");
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
const topicIds: string[] = [];
const taskIds: string[] = [];
let topic = { id: "", name: "", sessionKey: "" };

async function createTask(request: Parameters<typeof createTopic>[0], status: "backlog" | "todo" | "review" | "done", index: number) {
  const created = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, {
    data: { text: `DOM budget ${status} ${index}`, status: "backlog" },
  });
  if (!created.ok()) throw new Error(`task seed failed: ${created.status()} ${await created.text()}`);
  const task = (await created.json()) as { id: string };
  taskIds.push(task.id);
  if (status !== "backlog") {
    const moved = await request.patch(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks/${task.id}`, { data: { status } });
    if (!moved.ok()) throw new Error(`task status seed failed: ${moved.status()} ${await moved.text()}`);
  }
}

async function waitForRest(page: import("@playwright/test").Page, topicId: string) {
  const list = page.locator(`[data-pane-shell="${topicId}"] [data-testid="chat-message-list"]`);
  await expect(list).toHaveAttribute("data-history", "complete", { timeout: 120_000 });
  await expect.poll(() => list.evaluate((el) => {
    const node = el as HTMLElement;
    return node.scrollHeight - node.clientHeight - node.scrollTop < 8;
  }), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running")), { timeout: 30_000 }).toBe(true);
}

async function recordBudget(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo, label: string) {
  const measurement = await page.evaluate(() => {
    const all = Array.from(document.getElementsByTagName("*"));
    const sizes = new Map<Element, number>();
    const order: Element[] = [];
    const pending: Element[] = [document.documentElement];
    while (pending.length) {
      const element = pending.pop()!;
      order.push(element);
      const children = [...element.children, ...(element.shadowRoot ? Array.from(element.shadowRoot.children) : [])];
      for (const child of children) {
        pending.push(child);
      }
    }
    const shadowElements = order.length - all.length;
    for (let i = order.length - 1; i >= 0; i--) {
      const element = order[i];
      sizes.set(element, 1 + [...element.children, ...(element.shadowRoot ? Array.from(element.shadowRoot.children) : [])].reduce((sum, child) => sum + (sizes.get(child) ?? 0), 0));
    }
    const topTen = order
      .map((element) => ({ element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${element.getAttribute("data-testid") ? `[${element.getAttribute("data-testid")}]` : ""}${typeof element.className === "string" && element.className ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`, nodes: sizes.get(element) ?? 1 }))
      .sort((a, b) => b.nodes - a.nodes)
      .slice(0, 10);
    return { nodes: all.length + shadowElements, topTen };
  });
  await testInfo.attach(`${label}-dom-subtrees`, { body: JSON.stringify(measurement, null, 2), contentType: "application/json" });
  expect(measurement.nodes, `${label}: top ten DOM subtrees attached`).toBeLessThanOrEqual(DOM_BUDGET);
}

test.describe.serial("DOM node budget @nightly", () => {
  test.describe.configure({ timeout: 900_000 });

  test.beforeAll(async ({ request }) => {
    const created = await createTopic(request, `DOM budget ${Date.now()}`);
    topicIds.push(created.id);
    const topicsResponse = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
    if (!topicsResponse.ok()) throw new Error(`topics read failed: ${topicsResponse.status()}`);
    const topics = (await topicsResponse.json()) as { topics: Record<string, { sessionKey?: string }> };
    const sessionKey = topics.topics[created.id]?.sessionKey;
    if (!sessionKey) throw new Error("created topic has no sessionKey");
    topic = { ...created, sessionKey };
    await seedTranscript(request, sessionKey, MESSAGE_COUNT, `DOM${Date.now()}`);

    // The 15/10/2026 live distribution: 1,155 backlog, 21 todo, 1 review, 4,156 done.
    // Backlog and todo render in full; review and done page at COLUMN_PAGE.
    for (let i = 0; i < 1_155; i++) await createTask(request, "backlog", i);
    for (let i = 0; i < 21; i++) await createTask(request, "todo", i);
    await createTask(request, "review", 0);
    for (let i = 0; i < COLUMN_PAGE + 1; i++) await createTask(request, "done", i);
  });

  test.afterAll(async ({ request }) => {
    // In waves of 20, as board-column-volume does: 1,203 DELETEs at once is a
    // nightly red waiting to happen.
    for (let i = 0; i < taskIds.length; i += 20) {
      await Promise.all(taskIds.slice(i, i + 20).map((id) => deleteTask(request, PROJECT_ID, id)));
    }
    for (const id of topicIds) await deleteTopic(request, id);
    removeTmpDir(PROJECT_PATH);
  });

  test("transcript di 2.000 messaggi entro 5.000 nodi", async ({ page, request }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "IDLE-01 (D2e transcript DOM budget)" });
    await resetPaneStore(request, [topic.id]);
    await goToApp(page);
    await expect(page.locator(`[data-pane-shell="${topic.id}"]`)).toBeVisible();
    await waitForRest(page, topic.id);
    await recordBudget(page, testInfo, "transcript");
  });

  test("transcript e board con carico vivo entro 5.000 nodi", async ({ page, request }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "IDLE-01 (D2e transcript plus board DOM budget)" });
    await resetPaneStore(request, ["__board__", topic.id]);
    await goToApp(page);
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`[data-pane-shell="${topic.id}"]`)).toBeVisible();
    await waitForRest(page, topic.id);
    await expect(page.getByTestId("kanban-column-body-backlog").locator("[data-task-card]")).toHaveCount(1_155, { timeout: 120_000 });
    await expect(page.getByTestId("kanban-column-body-todo").locator("[data-task-card]")).toHaveCount(21, { timeout: 30_000 });
    await expect(page.getByTestId("kanban-column-body-review").locator("[data-task-card]")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("kanban-column-body-done").locator("[data-task-card]")).toHaveCount(COLUMN_PAGE, { timeout: 30_000 });
    await recordBudget(page, testInfo, "transcript-board");
  });
});
