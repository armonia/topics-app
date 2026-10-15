import { expect, test } from "@playwright/test";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { goToApp } from "./helpers";
import { E2E_BASE, testServerEnv } from "./helpers/test-server";
import { seedTranscript } from "./helpers/seed-transcript";
import { wheelUpUntilVisible } from "./helpers/wheel-scroll";
import { splitViaContextMenu } from "./helpers/layout";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { projectIdForPath } from "../../shared/board";
import { COLUMN_PAGE } from "../../client/src/lib/boardOrder";
import { hermetic } from "./fixtures/hermetic";
import { closeProfileMenu, openColumnViewMenu } from "./helpers/open-perf-panel";
import { mkdirSync } from "fs";

hermetic(test);

/** @covers IDLE-01 IDLE-03 */

const MESSAGE_COUNT = 2_000;
const DOM_BUDGET = 5_000;
const PROJECT_PATH = canonicalTmpDir("e2e-dom-node-budget");
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
const topicIds: string[] = [];
const archiveProjectPaths: string[] = [];
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

async function readWholeThreadThenRest(page: import("@playwright/test").Page, topicId: string) {
  const scroller = `[data-pane-shell="${topicId}"] [data-testid="chat-message-list"]`;
  const list = page.locator(scroller);
  // Since the tail-first open (shared/history-paging.ts) a pane holds the last
  // page and merges the rest as the reader heads up, as bench-streaming says:
  // without the climb the 2,000 messages are forty rows, and a list that drew
  // every row would pass too.
  await wheelUpUntilVisible(page, page.locator(`${scroller}[data-history="complete"]`), 120, scroller);
  await expect(page.locator(`[data-pane-shell="${topicId}"]`).getByTestId("chat-load-older")).toHaveCount(0, { timeout: 120_000 });
  // Back down with the wheel, the way the reader comes back to the end.
  const atBottom = () => list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop < 8);
  for (let i = 0; i < 120 && !(await atBottom()); i++) {
    await page.mouse.wheel(0, 8000);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }
  await expect.poll(atBottom, { timeout: 30_000 }).toBe(true);
  // A spinner that never ends adds no nodes: only finite animations must be over.
  await expect.poll(() => page.evaluate(() => document.documentElement.getAnimations({ subtree: true })
    .every((animation) => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity)), { timeout: 30_000 }).toBe(true);
}

async function recordBudget(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo, label: string, ceiling = DOM_BUDGET) {
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
    // The ten biggest subtrees are the chain of ancestors, each a node smaller
    // than its parent: they say nothing. Where the weight splits, no child
    // holds 90% of it, and that element is who weighs.
    const biggestChild = (element: Element) => Math.max(0, ...[...element.children, ...(element.shadowRoot ? Array.from(element.shadowRoot.children) : [])].map((child) => sizes.get(child) ?? 0));
    const topTen = order
      .filter((element) => biggestChild(element) < 0.9 * (sizes.get(element) ?? 1))
      .map((element) => ({ element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${element.getAttribute("data-testid") ? `[${element.getAttribute("data-testid")}]` : ""}${typeof element.className === "string" && element.className ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`, nodes: sizes.get(element) ?? 1 }))
      .sort((a, b) => b.nodes - a.nodes)
      .slice(0, 10);
    return { nodes: all.length + shadowElements, topTen };
  });
  // In the log too: the run's page is where a nightly's numbers get read.
  console.log(`[dom-budget] ${label}: ${measurement.nodes} nodes, ${measurement.topTen.map((t) => `${t.element} ${t.nodes}`).join("; ")}`);
  await testInfo.attach(`${label}-dom-subtrees`, { body: JSON.stringify(measurement, null, 2), contentType: "application/json" });
  expect(measurement.nodes, `${label}: top ten DOM subtrees attached`).toBeLessThanOrEqual(ceiling);
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
    for (const path of archiveProjectPaths) removeTmpDir(path);
    removeTmpDir(PROJECT_PATH);
  });

  test("transcript di 2.000 messaggi entro 5.000 nodi", async ({ page, request }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "IDLE-01 (D2e transcript DOM budget)" });
    await resetPaneStore(request, [topic.id]);
    await goToApp(page);
    await expect(page.locator(`[data-pane-shell="${topic.id}"]`)).toBeVisible();
    await readWholeThreadThenRest(page, topic.id);
    await recordBudget(page, testInfo, "transcript");
  });

  test("transcript e board con carico vivo entro 5.000 nodi", async ({ page, request }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "IDLE-01 (D2e transcript plus board DOM budget)" });
    await resetPaneStore(request, ["__board__", topic.id]);
    await goToApp(page);
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 30_000 });
    // Side by side, the way a person sets it: the chat's tab split to the right.
    // Two tabs of one group would show one pane at a time.
    await splitViaContextMenu(page, "Dividi a destra", 1);
    await expect(page.locator(`[data-pane-shell="${topic.id}"]`)).toBeVisible();
    await expect(page.getByTestId("kanban-board")).toBeVisible();
    await readWholeThreadThenRest(page, topic.id);
    await expect(page.getByTestId("kanban-column-count-backlog")).toHaveText("1155", { timeout: 120_000 });
    await expect(page.getByTestId("kanban-column-count-todo")).toHaveText("21", { timeout: 30_000 });
    await expect(page.getByTestId("kanban-column-count-review")).toHaveText("1", { timeout: 30_000 });
    await expect(page.getByTestId("kanban-column-count-done")).toHaveText("26", { timeout: 30_000 });
    await recordBudget(page, testInfo, "transcript-board");
  });

  test("sidebar con 2.000 chat archiviate e Mostra archiviate acceso entro 5.000 nodi", async ({ page, request }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "IDLE-03 (D2g archived sidebar pages)" });
    // The 15/10/2026 live database: 1,888 archived chats, 1,244 of them in one
    // project. Here: two projects and the chats without one.
    const paths = ["alpha", "beta"].map((name) => canonicalTmpDir(`e2e-d2g-archive-${name}`));
    archiveProjectPaths.push(...paths);
    for (const path of paths) mkdirSync(path, { recursive: true });
    const seeds = Array.from({ length: 2_000 }, (_, index) => {
      const group = index < 800 ? "Alpha" : index < 1_600 ? "Beta" : "Loose";
      return { name: `D2g-${group}-${index}`, projectPath: group === "Alpha" ? paths[0] : group === "Beta" ? paths[1] : undefined };
    });
    // Raw POSTs, not `createTopic`: that one opens a tab per chat, 2,000 tabs
    // the archive would then purge. DELETE is the archive.
    for (let i = 0; i < seeds.length; i += 20) {
      await Promise.all(seeds.slice(i, i + 20).map(async (seed) => {
        const created = await request.post(`${E2E_BASE}/api/topics`, { data: seed });
        if (!created.ok()) throw new Error(`archived topic seed failed: ${created.status()} ${await created.text()}`);
        const { id } = (await created.json()) as { id: string };
        const archived = await request.delete(`${E2E_BASE}/api/topics/${id}`, { data: { archived: true } });
        if (!archived.ok()) throw new Error(`archive seed failed: ${archived.status()} ${await archived.text()}`);
      }));
    }

    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [] },
    });
    await goToApp(page);
    await openColumnViewMenu(page);
    const archivedToggle = page.getByTestId("topics-menu-archived");
    await expect(archivedToggle).toHaveAttribute("aria-checked", "false");
    await archivedToggle.click();
    await expect(archivedToggle).toHaveAttribute("aria-checked", "true");
    await closeProfileMenu(page);

    const rows = (group: string) => page.getByRole("treeitem", { name: new RegExp(`^D2g-${group}-`) });
    const allRows = page.getByRole("treeitem", { name: /^D2g-/ });
    const expandProjects = async () => {
      for (const label of paths.map((path) => path.split("/").pop()!)) {
        const chevron = page.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${label}$`) });
        await expect(chevron).toBeVisible({ timeout: 30_000 });
        if ((await chevron.getAttribute("aria-label")) === `Expand ${label}`) await chevron.click();
        await expect(page.getByRole("button", { name: `Collapse ${label}` })).toBeVisible();
      }
    };
    await expandProjects();
    // The budget first: without the page, this is where 2,000 rows go red.
    for (const group of ["Alpha", "Beta", "Loose"]) await expect(rows(group).first()).toBeVisible({ timeout: 30_000 });
    await recordBudget(page, testInfo, "archived-sidebar");
    for (const group of ["Alpha", "Beta", "Loose"]) await expect(rows(group)).toHaveCount(25);
    const showMore = page.getByTestId("sidebar-show-more-archived");
    await expect(showMore).toHaveCount(3);

    // A real button inside the tree: the keyboard reaches it and presses it.
    await showMore.first().focus();
    await page.keyboard.press("Enter");
    await expect(allRows).toHaveCount(100);

    // Off and on again: every group starts over at 25.
    await openColumnViewMenu(page);
    await archivedToggle.click();
    await expect(allRows).toHaveCount(0);
    await archivedToggle.click();
    await closeProfileMenu(page);
    await expandProjects();
    for (const group of ["Alpha", "Beta", "Loose"]) await expect(rows(group)).toHaveCount(25);
  });
});
