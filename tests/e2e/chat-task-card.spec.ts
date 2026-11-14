/**
 * chat-task-card.spec.ts - a chat that opens a card sees it, live, in its own transcript.
 *
 * The chat creates a card through the same door the `create_task` tool uses
 * (`/api/sessions/:key/tasks`, which stamps the opener), and its transcript
 * carries the tool call. The card drawn there must follow the board without a
 * reload (todo, in progress, review), and the waiting line under the last
 * message must name the card while it is going and leave when it reaches review.
 *
 * The phase is drawn by the status glyph (`data-testid="status-glyph"` with
 * `data-status`), never by the four-dot spinner.
 *
 * @covers CHAT-TASK-CARD-01
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on", viewport: { width: 1440, height: 900 } });

/** Where the evidence goes: the card's screenshots and the clip of the live transition. */
const EVIDENCE_DIR = process.env.CHAT_TASK_CARD_EVIDENCE_DIR ?? join(homedir(), ".topics", "media", "card-in-chat-214ac2a7");

/** Ad-hoc board id, so the card does not land in anybody else's column. */
const BOARD_ID = "cardchat-e2e001";

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${E2E_BASE}/api/topics`);
  const topics = ((await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> }).topics;
  return Object.values(topics).find((t) => t.id === topicId)!.sessionKey;
}

test("the card in the transcript and the waiting line follow the board without a reload", async ({ page, request }) => {
  test.setTimeout(120_000);
  test.info().annotations.push({ type: "spec", description: "CHAT-TASK-CARD-01" });
  const stamp = Date.now();
  const topic = await createTopic(request, `Card chat ${stamp}`);
  const sessionKey = await sessionKeyOf(request, topic.id);

  const title = `Chat card ${stamp}`;
  // The board API takes the chat as the opener: the same stamp `create_task` leaves.
  const created = await request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, { data: { text: title, status: "todo", originTopicId: topic.id } });
  expect(created.ok(), "the board API refused to open the card").toBe(true);
  const { id } = (await created.json()) as { id: string };

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
  await expect(card.getByTestId("status-glyph")).toHaveAttribute("data-status", "todo");
  await expect(line).toContainText(title);

  const patch = (data: Record<string, unknown>) =>
    request.patch(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks/${id}`, { data });

  expect((await patch({ status: "in_progress" })).ok()).toBe(true);
  await expect(card).toHaveAttribute("data-phase", "working", { timeout: 20_000 });
  await expect(card.getByTestId("status-glyph")).toHaveAttribute("data-status", "in_progress");
  await expect(card.getByTestId("status-glyph")).toHaveCount(1);
  await expect(line).toContainText(title);

  expect((await patch({ status: "review" })).ok()).toBe(true);
  await expect(card).toHaveAttribute("data-phase", "review", { timeout: 20_000 });
  await expect(card.getByTestId("status-glyph")).toHaveAttribute("data-status", "review");
  await expect(line).toHaveCount(0);

  // The clip of this very transition, kept next to the screenshots.
  const video = page.video();
  await page.close();
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  // `saveAs` works for a browser on this machine and for one on the PC.
  await video?.saveAs(join(EVIDENCE_DIR, "card-todo-working-review.webm"));
});

const WIDTHS = [
  { w: 375, h: 812 },
  { w: 768, h: 1024 },
  { w: 1440, h: 900 },
  { w: 3440, h: 1440 },
] as const;

async function shootAt(page: Page, topicId: string, probe: string, name: string): Promise<void> {
  for (const { w, h } of WIDTHS) {
    // The topic opens from the sidebar, which a phone width hides: open it wide, then resize.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
    await page.locator(`[data-pane-id="${topicId}"]`).first().click();
    await expect(page.locator(probe).first()).toBeVisible({ timeout: 20_000 });
    await page.setViewportSize({ width: w, height: h });
    await expect(page.locator(probe).first()).toBeVisible({ timeout: 20_000 });
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(EVIDENCE_DIR, `${name}-${w}.png`) });
  }
}

test("the card and the sub-agent card, side by side at four widths", async ({ page, request }) => {
  test.setTimeout(180_000);
  test.info().annotations.push({ type: "spec", description: "CHAT-TASK-CARD-01" });
  const stamp = Date.now();

  // The reference: a chat with a `spawn_agent` card.
  const refTopic = await createTopic(request, `Reference chat ${stamp}`);
  const refKey = await sessionKeyOf(request, refTopic.id);
  await seedMessage(request, {
    sessionKey: refKey, role: "assistant", content: "",
    toolCalls: [{
      id: `sp-${stamp}`, name: "mcp__topics__spawn_agent", args: { name: "scout", prompt: "Look at the build", agent_type: "scout", description: "Look at the build" },
      status: "success", result: `Started agent scout (agent_id=ref-${stamp})`, startedAt: stamp - 2000, endedAt: stamp - 1000,
    }],
  });

  // The subject: a chat with a card in progress.
  const cardTopic = await createTopic(request, `Card chat wide ${stamp}`);
  const cardKey = await sessionKeyOf(request, cardTopic.id);
  const title = `Add the export button to the report ${stamp}`;
  const created = await request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, { data: { text: title, status: "in_progress", originTopicId: cardTopic.id } });
  expect(created.ok(), "the board API refused to open the card").toBe(true);
  const { id } = (await created.json()) as { id: string };
  await seedMessage(request, {
    sessionKey: cardKey, role: "assistant", content: "",
    toolCalls: [{
      id: `cc-${stamp}`, name: "mcp__topics__create_task", args: { text: title }, status: "success",
      result: `created task ${id} [todo]: ${title}`, startedAt: stamp - 2000, endedAt: stamp - 1000,
    }],
  });

  await resetPaneStore(request, [refTopic.id, cardTopic.id]);
  await shootAt(page, refTopic.id, '[data-testid="spawn-agent-card"]', "sottoagente");
  await resetPaneStore(request, [cardTopic.id]);
  await shootAt(page, cardTopic.id, `[data-testid="task-tool-card"][data-task-id="${id}"]`, "card");
});
