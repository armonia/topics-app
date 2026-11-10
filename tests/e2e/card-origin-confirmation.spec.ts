import { expect, test } from "@playwright/test";
import { mkdirSync } from "fs";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, deleteTask } from "./helpers/api-fixtures";
import { E2E_BASE, sessionTokenHeaders } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath } from "../../shared/board";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);

/**
 * A request that becomes a card is confirmed in the chat that asked for it:
 * the agent opens a card through the session door and the chat gets the "became a card" line
 * with the title and a link, with no turn started.
 * Two states, so a clip: the chat before, and the chat with the line.
 */
const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-card-origin-${Date.now()}`;
const TITLE = "Conferma di origine: la card nasce dalla chat";

test("the chat that asked is told the request became a card", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "KANBAN-103" });
  mkdirSync(PROJECT_PATH, { recursive: true });
  const topic = await createTopic(request, `card-origin-${Date.now()}`, { projectPath: PROJECT_PATH });
  let taskId: string | null = null;
  try {
    await goToApp(page);

    const sessionKey = `topic:${topic.id.slice(0, 8)}`;
    const res = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/tasks`, {
      data: { text: TITLE },
      headers: sessionTokenHeaders(sessionKey),
    });
    expect(res.status()).toBe(201);
    taskId = ((await res.json()) as { id: string }).id;

    // Project topics live inside a project window, so the chat is read through its API.
    await expect
      .poll(async () => {
        const r = await request.get(`${BASE}/api/topics/${topic.id}/messages`);
        return r.ok() ? JSON.stringify(await r.json()) : "";
      }, { timeout: 15000 })
      .toContain(`/task/${taskId}`);
    const body = await (await request.get(`${BASE}/api/topics/${topic.id}/messages`)).text();
    expect(body).toContain("diventata una card");
    expect(body).toContain(TITLE);
  } finally {
    if (taskId) await deleteTask(request, projectIdForPath(PROJECT_PATH), taskId).catch(() => {});
    await deleteTopic(request, topic.id).catch(() => {});
    removeTmpDir(PROJECT_PATH);
  }
});
