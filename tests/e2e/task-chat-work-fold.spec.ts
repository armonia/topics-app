/**
 * THE CHAT OF A TASK IS READ TO DECIDE.
 *
 * Whoever opens the session of a task does not read it as a conversation: they
 * read it to approve. The agent's words, its questions and its deliveries are
 * the decision; the ten actions that produced them are the proof, and they were
 * most of the page.
 *
 * This spec seeds the real shape of a transcript (one message per action, no
 * prose, the way the importer writes it) inside a session BOUND to a task, and
 * demands three things: the run behind one summary row, prose and question
 * always in plain sight, and the very same rows back at the first click.
 *
 * The last case protects all the others: the same seed in a chat that is NOT a
 * task session must not change by one comma.
 *
 * @covers CHAT-TOOL-06
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, deleteTask, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { beat, didascalia } from "./helpers/evidence";
import { projectIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";

hermetic(test);

const SHOTS = "test-results/task-work-fold";
const STAMP = Date.now();
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-workfold-${STAMP}`;
const PROJECT_ID = projectIdForPath(PROJECT_PATH);

type Req = import("@playwright/test").APIRequestContext;

/** The question that stops the turn: the one thing that must NEVER fold. */
const HUMAN_QUESTION = {
  question: "DOMANDA-ALL-UMANO: lando su main?",
  header: "Scelta",
  options: [{ label: "Landa su main" }, { label: "Aspetta" }],
};

const ACTIONS = [
  { name: "Read", args: { file_path: "/repo/src/a.ts" } },
  { name: "Read", args: { file_path: "/repo/src/b.ts" } },
  { name: "Grep", args: { pattern: "partitionTurn" } },
  { name: "Edit", args: { file_path: "/repo/src/a.ts" } },
  { name: "Edit", args: { file_path: "/repo/src/b.ts" } },
  { name: "Bash", args: { command: "bun run typecheck" } },
  { name: "Read", args: { file_path: "/repo/src/c.ts" } },
  { name: "Write", args: { file_path: "/repo/src/d.ts" } },
  { name: "Bash", args: { command: "bun test" } },
  { name: "Read", args: { file_path: "/repo/src/e.ts" } },
];

/** The agent's session, seeded the way a real transcript writes it. */
async function seedSession(request: Req, sessionKey: string, prefix: string) {
  await seedMessage(request, { sessionKey, role: "user", content: "sistema il modulo" });
  for (const [i, a] of ACTIONS.entries()) {
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "",
      toolCalls: [{
        id: `${prefix}-${i}`,
        name: a.name,
        args: a.args,
        status: "success",
        result: "ok",
        startedAt: 1_700_000_000_000 + i * 1000,
        endedAt: 1_700_000_000_000 + i * 1000 + 800,
      }],
    });
  }
  await seedMessage(request, { sessionKey, role: "assistant", content: "PROSA-DELL-AGENTE: il modulo e' sistemato." });
  await seedMessage(request, {
    sessionKey,
    role: "assistant",
    content: "",
    toolCalls: [{
      id: `${prefix}-ask`,
      name: "mcp__topics__ask_user_question",
      args: { questions: [HUMAN_QUESTION] },
      status: "waiting_for_input",
      userInputSchema: { kind: "questions", questions: [{ ...HUMAN_QUESTION, multiSelect: false }] },
    }],
  });
}

/** Binds the task to the agent's topic, the way the dispatcher does. */
async function bindTopic(request: Req, taskId: string, topicId: string) {
  const res = await request.post(`${E2E_BASE}/api/test/tasks/${taskId}/bind-topic`, {
    data: { topicId, dispatchState: "working" },
  });
  expect(res.ok()).toBe(true);
}

async function openChat(page: Page, name: string) {
  await goToApp(page);
  await openTopic(page, new RegExp(name));
}

test.describe("Il lavoro dell'agente in una chat di task", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.describe.configure({ timeout: 120_000 });

  let taskTopicId = "";
  let plainTopicId = "";
  let taskTopicName = "";
  let plainTopicName = "";
  let taskId = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(SHOTS, { recursive: true });
    // The project folder: without it the task's board has nowhere to belong
    // and the card never shows up in the columns.
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-workfold" }));
    taskTopicName = `work-fold-task-${STAMP}`;
    plainTopicName = `work-fold-plain-${STAMP}`;
    const taskTopic = await createTopic(request, taskTopicName);
    const plainTopic = await createTopic(request, plainTopicName);
    taskTopicId = taskTopic.id;
    plainTopicId = plainTopic.id;

    await seedSession(request, `topic:${taskTopicId.slice(0, 8)}`, "wf");
    await seedSession(request, `topic:${plainTopicId.slice(0, 8)}`, "pf");

    const res = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: `Rifinitura conversazione ${STAMP}` },
    });
    expect(res.ok()).toBe(true);
    taskId = ((await res.json()) as { id: string }).id;
    await bindTopic(request, taskId, taskTopicId);
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await deleteTask(request, PROJECT_ID, taskId);
    for (const id of [plainTopicId, taskTopicId]) if (id) await deleteTopic(request, id);
  });

  // One pane at a time: with two chats open together the task strip of one
  // would be on screen while looking at the other, which is exactly what the
  // last case has to be able to deny.

  test("dieci azioni stanno dietro UNA riga chiusa, e la prosa e la domanda restano in chiaro", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-TOOL-06" });
    await resetPaneStore(request, [taskTopicId]);
    await openChat(page, taskTopicName);
    // The strip back to the card is what says this chat is the session of a
    // task: without it the fold must not even switch on.
    await expect(page.getByTestId("chat-task-card-strip")).toBeVisible({ timeout: 20_000 });

    const fold = page.getByTestId("task-work-accordion");
    await expect(fold, "la corsa deve produrre un accordion solo").toHaveCount(1, { timeout: 15_000 });
    await expect(fold).toHaveAttribute("data-open", "false");
    // The summary is what makes the fold worth it: how many actions, what was
    // done, how long it took, how many files were written.
    await expect(fold).toHaveAttribute("data-actions", "10");
    const summary = fold.getByTestId("task-work-summary");
    await expect(summary).toContainText("10");
    await expect(summary).toContainText("Read");
    await expect(fold.getByTestId("task-work-duration")).toBeVisible();
    // Three files WRITTEN (a.ts, b.ts, d.ts): a file only read is not touched.
    await expect(fold.getByTestId("task-work-files")).toContainText("3");
    await didascalia(page, "Dieci azioni dietro una riga sola");
    await beat(page);

    // Closed: none of the ten per-action rows is on screen. The question row
    // (`wf-ask`) is out of the count on purpose: it never folds.
    for (let i = 0; i < ACTIONS.length; i++) {
      await expect(page.getByTestId(`tool-call-row-wf-${i}`)).toHaveCount(0);
    }
    await expect(page.getByTestId("tool-call-row-wf-ask")).toBeVisible();

    // The words stay. In the transcript, not in the sidebar, which makes a
    // preview out of the last message and would match twice.
    const transcript = page.getByTestId("virtuoso-item-list");
    await expect(transcript.getByText("PROSA-DELL-AGENTE", { exact: false })).toBeVisible();
    // The question with its answer panel, open and clickable.
    await expect(page.getByTestId("tool-input-form-wf-ask")).toContainText("DOMANDA-ALL-UMANO");

    await page.screenshot({ path: join(SHOTS, "chiuso.png") });
    await didascalia(page, "La prosa e la domanda restano in chiaro");
    await beat(page);

    // One click and everything is back, per-action rows included.
    await didascalia(page, "Un clic, e il lavoro torna tutto");
    await summary.click();
    await expect(fold).toHaveAttribute("data-open", "true");
    const group = fold.getByTestId("tool-group-summary");
    if (await group.count()) await group.first().click();
    for (let i = 0; i < ACTIONS.length; i++) {
      await expect(page.getByTestId(`tool-call-row-wf-${i}`)).toBeVisible();
    }
    await page.screenshot({ path: join(SHOTS, "aperto.png") });
    await beat(page, 1600);
  });

  test("anche la SCHEDA del task ripiega il lavoro: e' dove si decide", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-TOOL-06" });
    await resetPaneStore(request, [taskTopicId]);
    await goToApp(page);
    // The global board: the card lives on a /tmp project, not on an open
    // project window.
    await page.getByTestId("pane-add-menu-trigger").first().click();
    await page.getByTestId("pane-add-menu-board").click();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });
    // Inside the board: the same text also lives on the chat's task strip,
    // which here sits behind and is not clickable.
    const card = page.getByTestId("kanban-board").getByText(`Rifinitura conversazione ${STAMP}`).first();
    await card.scrollIntoViewIfNeeded();
    await card.click();
    await expect(page.getByTestId("task-detail-drawer")).toBeVisible({ timeout: 15_000 });

    const fold = page.getByTestId("task-detail-drawer").getByTestId("task-work-accordion");
    await expect(fold.first()).toBeVisible({ timeout: 20_000 });
    await expect(fold.first()).toHaveAttribute("data-open", "false");
    await page.screenshot({ path: join(SHOTS, "scheda.png") });
  });

  test("una chat qualunque non cambia: nessun accordion, le azioni si vedono come prima", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-TOOL-06" });
    await resetPaneStore(request, [plainTopicId]);
    await openChat(page, plainTopicName);
    await expect(page.getByTestId("chat-task-card-strip")).toHaveCount(0);
    // The tool group row (CHAT-TOOL-02) is the historical behaviour and it
    // stays: what is absent here is the per-turn fold.
    await expect(page.getByTestId("tool-group-row").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("task-work-accordion")).toHaveCount(0);
    await expect(page.getByTestId("virtuoso-item-list").getByText("PROSA-DELL-AGENTE", { exact: false })).toBeVisible();
  });
});
