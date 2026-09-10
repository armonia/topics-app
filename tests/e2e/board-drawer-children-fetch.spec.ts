/**
 * board-drawer-children-fetch.spec.ts — expanding a node of the drawer's
 * subtask tree asks for that node's CHILDREN, not for its whole thread.
 *
 * The board card learned this diet first (board-children-fetch): its per-card
 * GET carries `?fields=children`. The tree inside the task drawer did not: a
 * chevron on a step called `boardApi.get`, the whole body, and threw away
 * every comment the step owns. A step that an agent has worked on carries a
 * thread the size of a real one, so one click on a chevron downloaded tens of
 * kilobytes to draw two rows.
 *
 * This spec is the BENCH for that group of requests: one root with three
 * steps, two grandchildren and a fat thread on EVERY STEP (the nodes the
 * drawer expands, which is where the weight has to sit for the number to mean
 * anything), the per-node GET group summed byte by byte off the wire, and a
 * ceiling the group has to stay under. Measured on 2026-09-07 with the node
 * still on `boardApi.get` the same tree weighed several times the budget, so
 * the number is the proof, not the assertion.
 *
 * The screenshot step is the other half: a lighter body that silently blanked
 * the work chips or the «n/m» counts (both live on the child rows) would pass
 * the byte budget and lose the feature. So they are asserted, and photographed.
 *
 * @covers WIRE-09
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { createTopic, deleteTopic, holdDispatchReconcile, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);
// Twice the pixels for the proof shot only; the wire does not see it.
test.use({ deviceScaleFactor: 2 });

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-drawer-children-fetch-${Date.now()}`;
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

/** The tree under test: one root, 3 steps, 2 grandchildren under each step. */
const STEPS = 3;
const CHILDREN_PER_STEP = 2;
/** The thread on every STEP: five comments of ~5 KB, the size of a real one. */
const COMMENTS_PER_STEP = 5;
const COMMENT_BYTES = 5 * 1024;
/**
 * The ceiling for the WHOLE per-node GET group while the tree is expanded.
 * Measured on 2026-09-07: `?fields=children` carries the two grandchildren of
 * a step in about 2 KB; the whole body carried the step's ~26 KB of comments
 * on top, which put the same three-node group at roughly 80 KB.
 */
const GROUP_BUDGET = 24 * 1024;
/** How long the wire has to stay silent before the group counts as settled. */
const QUIET_MS = 1500;
/** Where the proof shot lands; copied out of test-results by hand. */
const SHOT_PATH = "test-results/drawer-children-fields-tree.png";

let projectTopicId: string | null = null;
/** `${projectId}:${taskId}`, children after their parents. */
const createdTasks: string[] = [];

async function createTask(request: APIRequestContext, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task;
}

async function patchTask(request: APIRequestContext, id: string, data: Record<string, unknown>): Promise<void> {
  const res = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`, { data });
  expect(res.ok()).toBe(true);
}

/** A quiet note: saved and broadcast, handed to no agent. */
async function addComment(request: APIRequestContext, taskId: string, content: string): Promise<void> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}/comments`, {
    data: { content, quiet: true },
  });
  expect(res.ok()).toBe(true);
}

/** The "+" of the project window → Board (same walk as board-children-fetch). */
async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-drawer-children-fetch/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) { opened = true; break; }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

/**
 * The per-task GET: `/api/boards/<board>/tasks/<uuid>`, with or without a
 * query. One path segment after `tasks/`, so the list (`/tasks`), the feed and
 * every sub-resource (`/tasks/<id>/comments`) stay out of the group. Which
 * uuid it is gets checked against the seed: the ROOT is left out on purpose,
 * because opening the drawer is the one place the whole body, comments
 * included, is what the screen draws.
 */
const PER_TASK_GET = new RegExp(`^/api/boards/${PROJECT_ID}/tasks/([0-9a-f-]{36})$`);

const ROOT_TEXT = "Root of the drawer bench";
let rootId: string | null = null;
/** Every node BELOW the root: the steps and their grandchildren. */
const childIds = new Set<string>();
/** The step seeded in progress with no ancestor at work: its row reads unattended. */
let unattendedStep: string | null = null;

test.describe("Task drawer — what a tree node downloads when it opens", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-drawer-children-fetch" }, null, 2));
    const topic = await createTopic(request, "E2E-Drawer-Children-Fetch", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;

    // The brake before anything moves: a step in progress with nobody bound
    // is exactly the shape reconcile sweeps, and sweeping it would flip the
    // unattended chip mid-test.
    await holdDispatchReconcile(request, 110_000);

    const comment = (step: number, k: number) =>
      `Progress note ${k} on step ${step}. ` + "lorem ".repeat(Math.ceil(COMMENT_BYTES / 6));

    const root = await createTask(request, { text: ROOT_TEXT, status: "todo" });
    rootId = root.id;
    for (let s = 0; s < STEPS; s++) {
      const step = await createTask(request, { text: `Step ${s + 1} of the root`, parentTaskId: root.id });
      childIds.add(step.id);
      for (let g = 0; g < CHILDREN_PER_STEP; g++) {
        const kid = await createTask(request, { text: `Item ${g + 1} of step ${s + 1}`, parentTaskId: step.id });
        childIds.add(kid.id);
      }
      // The weight sits on the STEP, the node the chevron expands: a thread on
      // the root alone would never enter the group this bench measures.
      for (let k = 0; k < COMMENTS_PER_STEP; k++) await addComment(request, step.id, comment(s, k));

      // Step 1 in progress with NO ancestor at work, so its row reads
      // «nessuno la lavora». allow-italian: the chip label asserted below
      // The chip is DERIVED off the child row's `subtaskWork`, the field a
      // reduced payload would drop.
      if (s === 0) {
        await patchTask(request, step.id, { status: "in_progress" });
        unattendedStep = step.id;
      }
    }
  });

  test.afterAll(async ({ request }) => {
    // In REVERSE order: the grandchildren before their step, the steps before the root.
    for (const key of [...createdTasks].reverse()) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid!, tid!);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    removeTmpDir(PROJECT_PATH);
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("expanding the tree downloads the children alone, and the rows still draw whole", async ({ page }) => {
    // The meter, installed BEFORE anything loads: every response of the
    // per-node group, its body read off the wire and summed. The root's own
    // GET (the drawer body) and the card's mount GET are not in the group.
    let inFlight = 0;
    let lastActivity = Date.now();
    let bytes = 0;
    let requests = 0;
    const seen = new Set<string>();
    const nodeOf = (url: string): string | null => {
      const m = PER_TASK_GET.exec(new URL(url).pathname);
      return m && childIds.has(m[1]!) ? m[1]! : null;
    };
    page.on("request", (req) => {
      if (req.method() !== "GET" || !nodeOf(req.url())) return;
      inFlight++;
      requests++;
      lastActivity = Date.now();
    });
    page.on("response", async (res) => {
      const node = res.request().method() === "GET" ? nodeOf(res.url()) : null;
      if (!node) return;
      const body = await res.body().catch(() => new Uint8Array(0));
      bytes += body.length;
      seen.add(node);
      inFlight--;
      lastActivity = Date.now();
    });

    await page.goto("/");
    await openProjectBoard(page);
    const card = page.locator(`[data-task-card="${rootId}"]`);
    await expect(card).toBeVisible({ timeout: 15000 });

    // The TITLE, not the centre of the card: at the centre sits a button inside
    // a container that stops propagation, and the click never reaches the card.
    await card.getByText(ROOT_TEXT).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await drawer.getByTestId("task-details-toggle").click();
    const tree = drawer.getByTestId("task-detail-subtasks");
    await expect(tree).toBeVisible({ timeout: 10000 });
    // The three steps arrive with the root: their rows are there before any
    // chevron is clicked.
    await expect(tree.getByText(/↳ \d+\/\d+/)).toHaveCount(STEPS, { timeout: 10000 });

    // Expand every node that has something under it, one chevron at a time,
    // until none is left closed. The grandchildren have no chevron, so this
    // walks exactly the steps.
    const chevrons = tree.locator("button[title='Espandi'], button[title='Expand']");
    for (let guard = 0; guard < STEPS * 2; guard++) {
      if ((await chevrons.count()) === 0) break;
      await chevrons.first().click();
      await expect(tree.getByText(/Item \d of step \d/)).toHaveCount(Math.min(STEPS, guard + 1) * CHILDREN_PER_STEP, { timeout: 10000 });
    }
    await expect(chevrons).toHaveCount(0);
    await expect(tree.getByText(/Item \d of step \d/)).toHaveCount(STEPS * CHILDREN_PER_STEP);

    // «The group is over»: every step asked once, nothing is in flight, and
    // the wire has been silent for longer than any retry the tree would
    // schedule. A condition on what is observed, not a sleep.
    await expect
      .poll(() => seen.size >= STEPS && inFlight === 0 && Date.now() - lastActivity > QUIET_MS, {
        timeout: 30_000,
        intervals: [100],
        message: "the per-node GET group never settled",
      })
      .toBe(true);

    console.log(`[drawer-children-fetch] per-node GET group while expanding: ${requests} requests, ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB) for ${STEPS} steps x ${CHILDREN_PER_STEP} grandchildren x ${COMMENTS_PER_STEP} comments of ${COMMENT_BYTES} B`);

    // The floor keeps the ceiling honest: a tree that asked NOTHING would be
    // under budget for the wrong reason.
    expect(requests).toBeGreaterThanOrEqual(STEPS);
    expect(bytes, `per-node GET group weighs ${bytes} B, over the ${GROUP_BUDGET} B budget`).toBeLessThanOrEqual(GROUP_BUDGET);

    // The other half: the rows arrived WHOLE. Every step still shows its
    // «n/m» count, and the chip derived off the child row is on the tree with
    // the kind the seed put there.
    await expect(tree.getByText(/↳ \d+\/\d+/)).toHaveCount(STEPS);
    const unattended = tree.getByTestId(`subtask-work-${unattendedStep}`);
    await expect(unattended).toHaveAttribute("data-kind", "unattended");
    await expect(unattended).toContainText("nessuno la lavora");

    // The proof shot: the expanded tree, steps and grandchildren in frame, at
    // the section's own width. The drawer sits flush against the right edge
    // of the viewport, so the clip is fenced inside it first: a clip that
    // spills over gets trimmed by the screenshot and the ratio below would be
    // computed on a width the image does not have. Height stays under 0.70 of
    // the width so the gallery card shows it whole.
    const box = await tree.boundingBox();
    expect(box).toBeTruthy();
    const viewport = page.viewportSize()!;
    const pad = 6;
    const x = Math.max(0, box!.x - pad);
    const y = Math.max(0, box!.y - pad);
    const width = Math.min(box!.x + box!.width + pad, viewport.width) - x;
    const height = Math.min(box!.y + box!.height + pad, viewport.height, y + Math.floor(width * 0.7)) - y;
    await page.screenshot({ path: SHOT_PATH, clip: { x, y, width, height } });
  });
});
