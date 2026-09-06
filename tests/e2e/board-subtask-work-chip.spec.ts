/**
 * board-subtask-work-chip.spec.ts — a subtask «in corso» with no agent of its    allow-italian: quoted UI string
 * own says WHO is working it, and changes when somebody stops working it.
 *
 * The case: an `in_progress` card with no `assigned_topic_id` and no dispatch
 * chip is ambiguous. Either an ancestor is working it inside its own turn — the
 * intended flow, and the overwhelming norm (243 steps closed that way in a
 * day) — or it was left there and nobody is working it. Orphan recovery sees
 * neither: it filters on the dispatch chip, which in this shape is absent. The
 * signal is DERIVED from the chain of parents, with no new column at all.
 *
 * It is also the delivery clip, and it takes a VIDEO because what has to be
 * shown is TWO STATES on the same row: the parent works → «nel turno del        allow-italian: quoted UI string
 * padre»; the parent drops the turn → «nessuno la lavora», in red, without      allow-italian: quoted UI string
 * reloading anything. A screenshot would prove half the behaviour.
 *
 * @covers KANBAN-08
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, holdDispatchReconcile, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { initGitRepo, canonicalTmpRoot } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-subwork-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const EPICA = "Rifare la scheda prodotto";
const STEP = "Migrare le foto sul nuovo bucket";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: any, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task;
}

const patch = async (request: any, id: string, data: Record<string, unknown>) => {
  const res = await request.patch(`${BASE}/api/boards/${PROJECT_ID}/tasks/${id}`, { data });
  expect(res.ok()).toBe(true);
};

/**
 * Puts the parent inside a turn the way the dispatcher does: bound topic and
 * `dispatch_state`. Those are the two columns only it writes — the test route
 * goes through the real service, not through a hand-written UPDATE.
 */
const bindTopic = async (request: any, id: string, topicId: string | null, dispatchState: string | null) => {
  const res = await request.post(`${BASE}/api/test/tasks/${id}/bind-topic`, {
    data: { topicId, dispatchState },
  });
  expect(res.ok()).toBe(true);
};

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-subwork/);
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

/** A pause that serves ONLY the delivery clip (E2E_EVIDENCE=1). Zero on a normal suite. */
const beat = (page: Page, ms = 1400) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

test.describe("Sottotask senza agente suo · chi lo lavora", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-subwork" }, null, 2));
    initGitRepo(PROJECT_PATH);
    const topic = await createTopic(request, "E2E-SubWork", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    // In REVERSE order: the child before the parent.
    for (const key of [...createdTasks].reverse()) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("il padre lo lavora nel suo turno; quando molla, la riga passa a «nessuno la lavora»", async ({ page, request }) => {
    // The parent at work with its own agent, and one step off its checklist:
    // child, in progress, NEVER dispatched — no topic, no chip. That is the
    // ambiguous shape, the one that so far said nothing.
    // THE BRAKE FIRST, before the fake agent exists. The parent here is a bound
    // topic with a `working` chip and no live turn, which is precisely the shape
    // reconcile recovers after two 10s sweeps — and recovering it is CORRECT
    // server behaviour, so the race cannot be fixed by waiting differently.
    // Measured in a full-suite run on 2026-09-01: under load the window widened
    // past the assertion and the row read `unattended` for 10s (14 reads) before
    // passing on retry. The spec's own comment already named the cause; this is
    // the brake that was built for it.
    await holdDispatchReconcile(request, 60_000);
    const epica = await createTask(request, { text: EPICA });
    // The description makes the row OPENABLE in the tree (`openable`): it serves
    // the third step of the clip, not the signal.
    const step = await createTask(request, { text: STEP, parentTaskId: epica.id, description: "Bucket nuovo, path invariati." });
    await patch(request, epica.id, { status: "in_progress" });
    await bindTopic(request, epica.id, projectTopicId!, "working");
    await patch(request, step.id, { status: "in_progress" });

    await page.goto("/");
    await openProjectBoard(page);

    // The step is NOT a card: the columns show roots only. It shows up by
    // opening the parent — and that is where the signal has to live.
    const card = page.locator(`[data-task-card="${epica.id}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(page.locator("[data-task-card]")).toHaveCount(1);

    // The TITLE, not the centre of the card: at the centre of a card carrying
    // in-line controls sits a button, inside a container that stops propagation,
    // and the click never reaches the card.
    await card.getByText(EPICA).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10000 });

    // (a) The parent holds the turn: the step's row says so, quietly.
    //
    // The assertion comes AT ONCE, before any pause: the parent here is a fake
    // agent — bound topic and a `working` chip with no live session behind it —
    // and the server's recovery does its job by parking it. With `slowMo` (clip
    // mode) that window widens until it overtakes the assertion, and the test
    // went red on CORRECT server behaviour.
    const row = drawer.getByTestId(`subtask-work-${step.id}`);
    await expect(row).toHaveAttribute("data-kind", "parent-turn", { timeout: 10000 });
    await expect(row).toHaveAttribute("title", new RegExp(EPICA));
    await beat(page, 2400);

    // The parent drops the turn — the case measured on the live DB: it goes back
    // to backlog and the dispatch chip goes out. Nobody touches the step, which
    // stays byte for byte what it was: it is the CHAIN that changes, not the row.
    await patch(request, epica.id, { status: "backlog" });
    await bindTopic(request, epica.id, projectTopicId!, null);

    // (b) Same row, same step: now it says nobody is working it. The signal is
    // derived, so it changes on its own — no reload, no write on the step.
    await expect(row).toHaveAttribute("data-kind", "unattended", { timeout: 15000 });
    await expect(row).toContainText("nessuno la lavora");

    // Delivery clip only: the board card shrinks it down to 268px, and at that
    // width a 10px chip disappears. Here we record WHERE to look, so the crop is
    // measured instead of guessed.
    if (process.env.E2E_EVIDENCE === "1") {
      const [d, r] = [await drawer.boundingBox(), await row.boundingBox()];
      // allow-literal-tmp: an evidence dump read by hand, not a path hashed into a board id.
      if (d && r) writeFileSync("/tmp/e2e-subwork-crop.json", JSON.stringify({ drawer: d, row: r }));
    }
    await beat(page, 2600);

    // And on opening the step, the in-line chip in its drawer says the same thing.
    await drawer.getByTestId(`subtask-open-${step.id}`).click();
    const chip = page.getByTestId("task-subtask-work-chip");
    await expect(chip).toHaveAttribute("data-kind", "unattended", { timeout: 10000 });
    await beat(page, 2400);
  });
});
