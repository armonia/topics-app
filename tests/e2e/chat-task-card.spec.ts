/**
 * chat-task-card.spec.ts - a chat that opens a card sees it, live, in its own transcript.
 *
 * The chat creates a card through the same door the `create_task` tool uses
 * (`/api/sessions/:key/tasks`, which stamps the opener), and its transcript
 * carries the tool call. The card drawn there must follow the board without a
 * reload (todo, in progress, review), and the waiting line under the last
 * message must name the card while it is going and leave when it reaches review.
 *
 * @covers CHAT-TASK-CARD
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on", viewport: { width: 1440, height: 900 } });

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${E2E_BASE}/api/topics`);
  const topics = ((await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> }).topics;
  return Object.values(topics).find((t) => t.id === topicId)!.sessionKey;
}

test("the card in the transcript and the waiting line follow the board without a reload", async ({ page, request }) => {
  test.setTimeout(120_000);
  test.info().annotations.push({ type: "spec", description: "CHAT-TASK-CARD" });
  const stamp = Date.now();
  const topic = await createTopic(request, `Card chat ${stamp}`);
  const sessionKey = await sessionKeyOf(request, topic.id);

  const title = `Chat card ${stamp}`;
  const created = await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/tasks`, { data: { text: title, status: "todo" } });
  expect(created.ok(), "the session door refused to open the card").toBe(true);
  const { id, projectId } = (await created.json()) as { id: string; projectId?: string };
  const board = projectId ?? "";

  await seedMessage(request, {
    sessionKey, role: "assistant", content: "",
    toolCalls: [{
      id: `ct-${stamp}`, name: "mcp__topics__create_task", args: { text: title }, status: "success",
      result: `created task ${id} [todo]: ${title}`, startedAt: stamp - 2000, endedAt: stamp - 1000,
    }],
  });

  await resetPaneStore(request, [topic.id]);
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
  await page.locator(`[data-pane-id="${topic.id}"]`).first().click();

  const card = page.locator(`[data-testid="task-tool-card"][data-task-id="${id}"]`);
  const line = page.locator('[data-testid="background-work-line"]');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByTestId("task-card-title")).toHaveText(title);
  await expect(card).toHaveAttribute("data-phase", "todo", { timeout: 20_000 });
  await expect(card).toHaveAttribute("data-action", "created");
  await expect(line).toContainText(title);

  const patch = (data: Record<string, unknown>) =>
    request.patch(`${E2E_BASE}/api/boards/${board}/tasks/${id}`, { data });

  expect((await patch({ status: "in_progress" })).ok()).toBe(true);
  await expect(card).toHaveAttribute("data-phase", "working", { timeout: 20_000 });
  await expect(line).toContainText(title);

  expect((await patch({ status: "review" })).ok()).toBe(true);
  await expect(card).toHaveAttribute("data-phase", "review", { timeout: 20_000 });
  await expect(line).toHaveCount(0);
});
