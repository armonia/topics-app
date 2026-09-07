/**
 * board-children-fetch.spec.ts — a card asks for its CHILDREN, not for the
 * whole thread, and the chips it draws off those children survive the diet.
 *
 * Measured on the live board on 2026-09-07: mounting the board cost 25 per-card
 * GETs for 1.122.652 B, of which 664.282 were comments the card never draws
 * (the window it renders already travels on the list row). The card only needs
 * the children, to draw the checklist and the work chips, and it asks again on
 * every `updatedAt` bump, which is every comment an agent writes.
 *
 * This spec is the BENCH for that group of requests: a board of 25 roots with
 * three steps each and a fat thread on every root, the per-card GET group
 * summed byte by byte off the wire, and a ceiling the whole group has to stay
 * under. Run against the route WITHOUT `?fields=children` the same board weighs
 * several times the budget, so the number is the proof, not the assertion.
 *
 * The screenshot step is the other half: a lighter body that silently blanked
 * the work chips (`subtaskWork` lives on the child rows) would pass the byte
 * budget and lose the feature. So the chips are asserted, and photographed.
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
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-children-fetch-${Date.now()}`;
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

/** The board under test: 25 roots, 3 steps each, spread over three columns. */
const ROOTS = 25;
const STEPS = 3;
const COLUMNS = ["backlog", "todo", "in_progress"] as const;
/** The thread on every root: five comments of ~5 KB, the size of a real one. */
const COMMENTS_PER_ROOT = 5;
const COMMENT_BYTES = 5 * 1024;
/**
 * The ceiling for the WHOLE per-card GET group at mount. The children alone
 * weigh ~2 KB per root here; the whole body carried ~26 KB of comments each,
 * which put the same group at ~700 KB before the route learned `?fields`.
 */
const GROUP_BUDGET = 300 * 1024;
/** How long the wire has to stay silent before the group counts as settled. */
const QUIET_MS = 1500;
/** Where the proof shot lands; copied out of test-results by hand. */
const SHOT_PATH = "test-results/children-fields-chips.png";

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

/** Puts a root inside a turn the way the dispatcher does (see board-subtask-work-chip). */
async function bindTopic(request: APIRequestContext, id: string, topicId: string, dispatchState: string): Promise<void> {
  const res = await request.post(`${BASE}/api/test/tasks/${id}/bind-topic`, { data: { topicId, dispatchState } });
  expect(res.ok()).toBe(true);
}

/** The "+" of the project window → Board (same walk as board-feed-reads). */
async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-children-fetch/);
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
 * The per-card GET: `/api/boards/<board>/tasks/<uuid>`, with or without a
 * query. One path segment after `tasks/`, so the list (`/tasks`), the feed and
 * every sub-resource (`/tasks/<id>/comments`) stay out of the group.
 */
const PER_CARD_GET = new RegExp(`/api/boards/${PROJECT_ID}/tasks/[0-9a-f-]{36}(\\?[^/]*)?$`);

/** The two roots the proof shot is taken on. */
let parentTurnRoot: { id: string; step: string } | null = null;
let unattendedRoot: { id: string; step: string } | null = null;

test.describe("Kanban board — what a card downloads for its steps", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-children-fetch" }, null, 2));
    const topic = await createTopic(request, "E2E-Children-Fetch", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;

    // The brake before the fake agent exists: a bound root with a `working`
    // chip and no live turn is exactly what reconcile recovers, and recovering
    // it would flip the parent-turn chip to unattended mid-test.
    await holdDispatchReconcile(request, 110_000);

    const comment = (root: number, k: number) =>
      `Progress note ${k} on root ${root}. ` + "lorem ".repeat(Math.ceil(COMMENT_BYTES / 6));

    for (let i = 0; i < ROOTS; i++) {
      const column = COLUMNS[i % COLUMNS.length];
      // `in_progress` goes through PATCH like the dispatcher would; the two
      // resting columns are set at creation.
      const root = await createTask(request, {
        text: `Root ${String(i + 1).padStart(2, "0")} of the bench`,
        status: column === "in_progress" ? "todo" : column,
      });
      if (column === "in_progress") await patchTask(request, root.id, { status: "in_progress" });
      const steps: string[] = [];
      for (let s = 0; s < STEPS; s++) {
        const step = await createTask(request, { text: `Step ${s + 1} of root ${i + 1}`, parentTaskId: root.id });
        steps.push(step.id);
      }
      for (let k = 0; k < COMMENTS_PER_ROOT; k++) await addComment(request, root.id, comment(i, k));

      // Root 1 (todo) has a step in progress with NO ancestor at work, so its
      // row reads «nessuno la lavora». allow-italian: the chip label asserted below
      // Root 3 (in progress) holds the turn instead. Both chips are DERIVED off
      // the child rows' `subtaskWork`, the field a reduced payload would drop.
      if (i === 1) {
        await patchTask(request, steps[0]!, { status: "in_progress" });
        unattendedRoot = { id: root.id, step: steps[0]! };
      }
      if (i === 2) {
        await bindTopic(request, root.id, projectTopicId, "working");
        await patchTask(request, steps[0]!, { status: "in_progress" });
        parentTurnRoot = { id: root.id, step: steps[0]! };
      }
    }
  });

  test.afterAll(async ({ request }) => {
    // In REVERSE order: the steps before their root.
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

  test("mounting the board downloads the children alone, and the work chips still render", async ({ page }) => {
    // The meter, installed BEFORE anything loads: every response of the
    // per-card group, its body read off the wire and summed.
    let inFlight = 0;
    let lastActivity = Date.now();
    let bytes = 0;
    let requests = 0;
    const seen = new Set<string>();
    page.on("request", (req) => {
      if (req.method() !== "GET" || !PER_CARD_GET.test(new URL(req.url()).pathname + new URL(req.url()).search)) return;
      inFlight++;
      requests++;
      lastActivity = Date.now();
    });
    page.on("response", async (res) => {
      const url = new URL(res.url());
      if (res.request().method() !== "GET" || !PER_CARD_GET.test(url.pathname + url.search)) return;
      const body = await res.body().catch(() => new Uint8Array(0));
      bytes += body.length;
      seen.add(url.pathname);
      inFlight--;
      lastActivity = Date.now();
    });

    await page.goto("/");
    await openProjectBoard(page);
    const cards = page.locator("[data-task-card]");
    await expect(cards).toHaveCount(ROOTS, { timeout: 15000 });

    // «The group is over»: every card that has steps asked once, nothing is
    // in flight, and the wire has been silent for longer than any retry the
    // card would schedule. A condition on what is observed, not a sleep.
    await expect
      .poll(() => seen.size >= ROOTS && inFlight === 0 && Date.now() - lastActivity > QUIET_MS, {
        timeout: 30_000,
        intervals: [100],
        message: "the per-card GET group never settled",
      })
      .toBe(true);

    console.log(`[children-fetch] per-card GET group at mount: ${requests} requests, ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB) for ${ROOTS} roots x ${STEPS} steps x ${COMMENTS_PER_ROOT} comments of ${COMMENT_BYTES} B`);

    // The floor keeps the ceiling honest: a board that asked NOTHING would be
    // under budget for the wrong reason.
    expect(requests).toBeGreaterThanOrEqual(ROOTS);
    expect(bytes, `per-card GET group weighs ${bytes} B, over the ${GROUP_BUDGET} B budget`).toBeLessThanOrEqual(GROUP_BUDGET);

    // The other half: the steps arrived WHOLE. Each card draws its checklist
    // (the compact «n/m» fallback is gone), and the two chips derived off the
    // child rows are on the board, with the kind the seed put there.
    const fallback = page.locator("[data-task-card]").getByText(/↳ \d+\/\d+/);
    await expect(fallback).toHaveCount(0);
    const unattended = page.getByTestId(`card-subtask-work-${unattendedRoot!.step}`);
    const parentTurn = page.getByTestId(`card-subtask-work-${parentTurnRoot!.step}`);
    await expect(unattended).toHaveAttribute("data-kind", "unattended");
    await expect(unattended).toContainText("nessuno la lavora");
    await expect(parentTurn).toHaveAttribute("data-kind", "parent-turn");

    // The proof shot: the card whose chip carries a LABEL, checklist rows and
    // chip in frame, at the card's own width so it reads at 268 px in the
    // media gallery. Height stays under 0.70 of the width so the gallery card
    // shows it whole.
    const box = await page.locator(`[data-task-card="${unattendedRoot!.id}"]`).boundingBox();
    expect(box).toBeTruthy();
    const pad = 6;
    const width = box!.width + 2 * pad;
    const height = Math.min(box!.height + 2 * pad, Math.floor(width * 0.7));
    await page.screenshot({ path: SHOT_PATH, clip: { x: box!.x - pad, y: box!.y - pad, width, height } });
  });
});
