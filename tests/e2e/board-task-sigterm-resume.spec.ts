/**
 * A card survives a server SIGTERM by adopting its still-live agent turn.
 *
 * The test server and its SQLite database restart in isolation. The fake
 * Claude CLI runs behind ai-bridge, so its partial answer is still in flight
 * when the server returns and the dispatcher must reattach to that session.
 *
 * @covers KANBAN-10
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectIdForPath } from "../../shared/board";
import { hermetic } from "./fixtures/hermetic";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { createTopic, deleteTask, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { restartTestServer } from "./helpers/restart-test-server";
import { beat, didascalia } from "./helpers/evidence";
import { projectRow } from "./helpers/project-row";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 180_000 });

const PROJECT_PATH = join(realpathSync(canonicalTmpRoot()), `e2e-card-sigterm-${Date.now()}`);
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
const TASK_TEXT = `Concludi il turno senza ripartirlo: SLOW:40:d7aresume-${Date.now()}`;

type TaskSnapshot = {
  task: {
    status: string;
    dispatchState: string | null;
    assignedTopicId: string | null;
    dispatchAttempts: number;
  };
  comments: Array<{ content: string }>;
};

type DispatchSettings = { autoDispatch: boolean; dispatchUseWorktree: boolean };

async function readTask(request: APIRequestContext, taskId: string): Promise<TaskSnapshot> {
  const response = await request.get(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<TaskSnapshot>;
}

async function openProjectBoard(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator('[aria-label="Topics sidebar"]')).toBeVisible({ timeout: 20_000 });
  const projects = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projects.count()) > 0 && (await projects.getAttribute("aria-expanded")) === "false") {
    await projects.click();
  }
  await projectRow(page, /e2e-card-sigterm/).click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 15_000 });
  if (!(await page.getByTestId("kanban-board").isVisible().catch(() => false))) {
    const triggers = page.getByTestId("pane-add-menu-trigger");
    const item = page.getByTestId("pane-add-menu-kanban");
    let opened = false;
    for (let index = (await triggers.count()) - 1; index >= 0; index--) {
      const trigger = triggers.nth(index);
      if (!(await trigger.isVisible().catch(() => false))) continue;
      await trigger.click();
      if (await item.isVisible().catch(() => false)) { opened = true; break; }
      await page.keyboard.press("Escape");
    }
    if (!opened) throw new Error("nessun menu + con la voce Board");
    await item.click();
  }
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
}

test("D7a: una card a metà turno viene riattaccata dopo SIGTERM e arriva in review @nightly", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "KANBAN-10" });
  const stamp = Date.now();
  const projectName = `e2e-card-sigterm-${stamp}`;
  let projectId: string | null = null;
  let topicId: string | null = null;
  let taskId: string | null = null;
  let uninstallCli: (() => void) | null = null;
  let originalSettings: DispatchSettings | null = null;

  try {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(join(PROJECT_PATH, "package.json"), JSON.stringify({ name: projectName }));
    const registered = await request.post(`${E2E_BASE}/api/projects`, { data: { name: projectName, path: PROJECT_PATH } });
    expect(registered.ok(), await registered.text()).toBeTruthy();
    projectId = ((await registered.json()) as { id: string }).id;
    topicId = (await createTopic(request, `D7a card ${stamp}`, { projectPath: PROJECT_PATH, provider: "claude-code" })).id;
    uninstallCli = installSlowTurnCli();

    const settingsResponse = await request.get(`${E2E_BASE}/api/boards/${PROJECT_ID}/settings`);
    expect(settingsResponse.ok(), await settingsResponse.text()).toBeTruthy();
    originalSettings = await settingsResponse.json() as DispatchSettings;
    const enabled = await request.patch(`${E2E_BASE}/api/boards/${PROJECT_ID}/settings`, {
      data: { autoDispatch: true, dispatchUseWorktree: false },
    });
    expect(enabled.ok(), await enabled.text()).toBeTruthy();
    await resetPaneStore(request, []);
    await resetProjectPanes(request, PROJECT_PATH);
    await seedProjectPane(request, PROJECT_PATH);

    const created = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: TASK_TEXT, status: "todo" },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    taskId = ((await created.json()) as { id: string }).id;

    await openProjectBoard(page);
    const card = page.locator(`[data-task-card="${taskId}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await readTask(request, taskId!)).task.dispatchState, {
      timeout: 30_000,
      message: "il dispatcher ha avviato il turno della card",
    }).toBe("working");

    const before = await readTask(request, taskId);
    const boundTopic = before.task.assignedTopicId;
    expect(boundTopic, "la card è legata alla sessione del suo agent").toBeTruthy();
    const messages = async () => {
      const response = await request.get(`${E2E_BASE}/api/topics/${boundTopic}/messages?limit=20`);
      expect(response.ok()).toBeTruthy();
      return ((await response.json()) as { messages: Array<{ content: string }> }).messages;
    };
    await expect.poll(async () => (await messages()).some((message) => message.content.includes("d7aresume-") && message.content.includes("03")), {
      timeout: 30_000,
      message: "il CLI ha già scritto una parte del turno",
    }).toBe(true);
    await didascalia(page, "La card è in lavorazione, il turno ha già prodotto testo");
    await beat(page, 900);

    await restartTestServer();

    const sessionKey = `topic:${boundTopic!.slice(0, 8)}`;
    await expect.poll(async () => (await readTask(request, taskId!)).comments.some((comment) => comment.content.includes("ripreso in diretta")), {
      timeout: 15_000,
      message: "il dispatcher ha riattaccato la sessione viva originale",
    }).toBe(true);
    await expect.poll(async () => (await messages()).some((message) => message.content.includes("d7aresume-") && message.content.includes("30")), {
      timeout: 60_000,
      intervals: [100],
      message: "il turno originale continua a produrre testo dopo il riavvio",
    }).toBe(true);
    const delivered = await request.patch(`${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/tasks/${taskId}`, {
      data: { status: "review", summary: "Il turno originale è proseguito fino alla consegna dopo il riavvio." },
    });
    expect(delivered.ok(), await delivered.text()).toBeTruthy();
    await expect.poll(async () => (await messages()).some((message) => message.content.includes("d7aresume-") && message.content.includes("40")), {
      timeout: 10_000,
      message: "il turno riattaccato conclude la sua risposta originale",
    }).toBe(true);

    await expect.poll(async () => (await readTask(request, taskId!)).task.status, {
      timeout: 60_000,
      message: "il turno riattaccato completa la card in review",
    }).toBe("review");
    const after = await readTask(request, taskId);
    expect(after.task.assignedTopicId, "la sessione originale è rimasta legata alla card").toBe(boundTopic);
    expect(after.task.dispatchAttempts, "il riavvio non consuma un nuovo tentativo").toBe(before.task.dispatchAttempts);
    expect(after.comments.some((comment) => comment.content.includes("ripreso in diretta")), "il dispatcher registra il riattacco del turno vivo").toBe(true);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await didascalia(page, "La stessa card è arrivata in revisione");
    await beat(page, 1200);
  } finally {
    if (originalSettings) {
      await request.patch(`${E2E_BASE}/api/boards/${PROJECT_ID}/settings`, {
        data: { autoDispatch: originalSettings.autoDispatch, dispatchUseWorktree: originalSettings.dispatchUseWorktree },
      }).catch(() => {});
    }
    uninstallCli?.();
    if (taskId) await deleteTask(request, PROJECT_ID, taskId).catch(() => {});
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
    if (projectId) await request.delete(`${E2E_BASE}/api/projects/${projectId}`).catch(() => {});
    removeTmpDir(PROJECT_PATH);
  }
});
