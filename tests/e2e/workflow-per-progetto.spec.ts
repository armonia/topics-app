/**
 * workflow-per-progetto.spec.ts: a board's columns come from its workflow
 * (openspec/changes/workflow-per-progetto, decided 28/10).
 *
 * On the `armonia` preset the board shows six columns. A card a person opens
 * is born in Triage and the triage sends it to Todo. A delivery on a card an
 * agent opened goes back to that agent (AI review), which closes it with the
 * proof; only a delivery that carries a question for the person reaches Human
 * review, and that is the only one the attention state lights («Ti aspetta»,
 * the board tab count, the push).
 *
 * Real server paths throughout: the interface's own create route (marked
 * `X-Topics-Action-Origin: interface`), the agent session routes an MCP
 * `update_task` goes through, and the board's columns drawn by the client.
 *
 * @covers KANBAN-01
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { createTopic, deleteTask, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { recordAttentionFrames, sessionKeyOf } from "./helpers/attention";
import { mkdirSync, writeFileSync } from "fs";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath } from "../../shared/board";
import { taskSubject } from "../../shared/attention";

hermetic(test);

const PROJECT_PATH = canonicalTmpDir(`e2e-workflow-${process.pid}`);
const PROJECT_ID = projectIdForPath(PROJECT_PATH);

let openerTopicId: string | null = null;
let openerKey = "";
const createdTasks: string[] = [];

/** Pause for the delivery clip only (E2E_EVIDENCE=1); zero in a normal run. */
const beat = (page: Page, ms = 900) =>
  process.env.E2E_EVIDENCE === "1" ? page.waitForTimeout(ms) : Promise.resolve();

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-workflow/);
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

/** A card opened by the agent session: what an MCP `create_task` does. */
async function agentCreates(request: APIRequestContext, text: string): Promise<string> {
  const res = await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(openerKey)}/tasks`, {
    data: { text, status: "todo", priority: 2, description: "bar: the page renders" },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const id = ((await res.json()) as { id: string }).id;
  createdTasks.push(id);
  return id;
}

/** What an MCP `update_task` does, from the agent session that opened the card. */
async function agentUpdates(request: APIRequestContext, taskId: string, data: Record<string, unknown>) {
  return request.patch(`${E2E_BASE}/api/sessions/${encodeURIComponent(openerKey)}/tasks/${taskId}`, { data });
}

test.describe("Board workflows · triage, AI review, human review", () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ viewport: { width: 1440, height: 760 } });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-workflow" }, null, 2));
    const topic = await createTopic(request, "E2E-Workflow-Opener", { projectPath: PROJECT_PATH, provider: "topics" });
    openerTopicId = topic.id;
    openerKey = await sessionKeyOf(request, topic.id);
    // No dispatch: the cards must stay where the workflow puts them.
    expect((await request.patch(`${E2E_BASE}/api/all-boards/settings`, { data: { autoDispatch: false } })).ok()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    await request.put(`${E2E_BASE}/api/boards/${PROJECT_ID}/workflow`, { data: { preset: null } });
    if (openerTopicId) await deleteTopic(request, openerTopicId);
    removeTmpDir(PROJECT_PATH);
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("six columns; a person's card is triaged into Todo; AI review closes by its opener; only Human review waits on the person", async ({ page, request }) => {
    const frames = recordAttentionFrames(page);
    await page.goto("/");
    await openProjectBoard(page);

    // ── 0. No workflow row: the five columns of before ─────────────────────
    for (const s of ["backlog", "todo", "in_progress", "review", "done"]) {
      await expect(page.getByTestId(`kanban-column-${s}`)).toBeVisible();
    }
    await expect(page.getByTestId("kanban-column-triage")).toHaveCount(0);
    await beat(page, 1200);

    // ── 1. The preset is chosen in the board's settings ────────────────────
    await page.getByTestId("kanban-board").getByTitle("Impostazioni auto-dispatch").click();
    await expect(page.getByTestId("board-workflow-picker")).toBeVisible({ timeout: 10000 });
    await beat(page);
    await page.getByTestId("board-workflow-armonia").click();
    await expect(page.getByTestId("kanban-column-triage")).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Escape");
    const columns = page.locator('[data-testid^="kanban-column-"]:not([data-testid^="kanban-column-body-"]):not([data-testid^="kanban-column-count-"]):not([data-testid="kanban-columns-row"])');
    await expect(columns).toHaveCount(6);
    for (const id of ["triage", "todo", "in_progress", "ai_review", "human_review", "done"]) {
      await expect(page.getByTestId(`kanban-column-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId("kanban-column-ai_review")).toContainText("AI review");
    await expect(page.getByTestId("kanban-column-human_review")).toContainText("Human review");
    await beat(page, 1400);

    // ── 2. A card from a person is born in Triage, the triage sends it to Todo
    const fromPerson = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: "Fix the login copy", status: "backlog" },
      headers: { "X-Topics-Action-Origin": "interface" },
    });
    expect(fromPerson.ok(), await fromPerson.text()).toBe(true);
    const personCard = ((await fromPerson.json()) as { id: string; stage?: string });
    createdTasks.push(personCard.id);
    expect(personCard.stage).toBe("triage");
    await expect(page.getByTestId("kanban-column-triage").locator(`[data-task-card="${personCard.id}"]`)).toBeVisible({ timeout: 10000 });
    await beat(page, 1400);
    // The triage pass (an agent: title, priority, then «to Todo»).
    const triaged = await agentUpdates(request, personCard.id, { stage: "todo", priority: 1, text: "Fix the login page copy" });
    expect(triaged.ok(), await triaged.text()).toBe(true);
    await expect(page.getByTestId("kanban-column-todo").locator(`[data-task-card="${personCard.id}"]`)).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("kanban-column-triage").locator(`[data-task-card="${personCard.id}"]`)).toHaveCount(0);
    await beat(page, 1400);

    // ── 3. An agent's card, delivered with no question: AI review ──────────
    const unmarked = await agentCreates(request, "Rename the settings route");
    const delivered = await agentUpdates(request, unmarked, { status: "review", summary: "Route renamed, tests green." });
    expect(delivered.ok(), await delivered.text()).toBe(true);
    expect(((await delivered.json()) as { stage?: string }).stage).toBe("ai_review");
    const aiCol = page.getByTestId("kanban-column-ai_review");
    await aiCol.scrollIntoViewIfNeeded();
    await expect(aiCol.locator(`[data-task-card="${unmarked}"]`)).toBeVisible({ timeout: 10000 });
    await beat(page, 1400);

    // ── 4. An agent's card delivered WITH a question: Human review ─────────
    const marked = await agentCreates(request, "Pick the onboarding layout");
    const asked = await agentUpdates(request, marked, { status: "review", summary: "Two layouts on the branch.", human_ask: "Which of the two layouts?" });
    expect(asked.ok(), await asked.text()).toBe(true);
    const humanCol = page.getByTestId("kanban-column-human_review");
    await humanCol.scrollIntoViewIfNeeded();
    await expect(humanCol.locator(`[data-task-card="${marked}"]`)).toBeVisible({ timeout: 10000 });
    await beat(page, 1400);

    // ── 5. What waits on the person: only Human review ─────────────────────
    await expect.poll(() => frames.rows().get(taskSubject(marked))?.reason ?? null, { timeout: 15_000 }).toBe("review");
    expect(frames.rows().get(taskSubject(unmarked))?.lit ?? false, "a card in AI review is lit as if it waited on the person").toBe(false);
    await expect(page.getByTestId("kanban-column-count-human_review")).toHaveText("1");
    await expect(page.getByTestId("kanban-column-count-ai_review")).toHaveText("1");

    // ── 6. The opener closes its AI review, with the proof ─────────────────
    const noProof = await agentUpdates(request, unmarked, { status: "done" });
    expect(noProof.status()).toBe(409);
    const closed = await agentUpdates(request, unmarked, { status: "done", summary: "Checked: bun test exit 0, route answers 200." });
    expect(closed.ok(), await closed.text()).toBe(true);
    await page.getByTestId("kanban-column-done").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("kanban-column-done").locator(`[data-task-card="${unmarked}"]`)).toBeVisible({ timeout: 10000 });
    await expect(aiCol.locator(`[data-task-card="${unmarked}"]`)).toHaveCount(0);
    // …but a card in Human review is the person's: the opener cannot close it.
    const notYours = await agentUpdates(request, marked, { status: "done", summary: "proof" });
    expect(notYours.ok()).toBe(false);
    await expect(humanCol.locator(`[data-task-card="${marked}"]`)).toBeVisible();
    await beat(page, 1800);
  });
});
