/**
 * A QUEUED MESSAGE LEAVES AFTER THE REAL END OF THE TURN, AND ONCE.
 *
 * Attilio, 29/09: queued messages sometimes left before the turn was over. The
 * queue drained on this window's own idea of "the turn is over" (its streaming
 * flag, a `stream:end`, a history read after a reconnect), and the server let a
 * message through while the CLI was in a turn it had opened by itself. Now the
 * server's ledger decides (CHAT-QUEUE-07), and the CLI is the witness: the fake
 * CLI writes down every message it is handed and whether a turn was running at
 * that moment (`helpers/fake-claude-queue-turns.ts`).
 *
 *   1. A turn of several assistant messages and tool calls, started from
 *      outside the window; a message queued in the window; the window's socket
 *      dropped and reconnected in the middle. The CLI reads the message only
 *      after the turn's result, once.
 *   2. The CLI opens a turn by itself (a background task's report) and stays
 *      silent for a while before its first line, as the real one does; the
 *      person writes in that silence. Same verdict.
 *   3. Another device presses Stop while the child is still starting (its
 *      `system/init` not come yet): the message queued here stays queued.
 *   4. A turn started elsewhere ends on a plan approval: the message queued
 *      here waits for the person's answer, and leaves with it.
 *
 * Behaviour, not layout: video on, the .webm is the proof.
 *
 * @covers CHAT-QUEUE-07
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { installQueueTurnsCli } from "./helpers/fake-claude-cli";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 150_000 });

const TOKEN = process.env.GATEWAY_TOKEN ?? "test-token";
const LOG = join(E2E_HOME, "fake-cli-queue-turns.jsonl");

interface LogLine { at: number; event: string; text?: string; busy?: boolean; tag?: string }
const readLog = (): LogLine[] => existsSync(LOG)
  ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogLine)
  : [];
const receivedWith = (tag: string) => readLog().filter((l) => l.event === "received" && !!l.text?.includes(tag));
const turnEvent = (event: "turn-start" | "turn-end", tag: string) => readLog().find((l) => l.event === event && l.tag === tag);

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const body = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as { topics: Record<string, { id: string; sessionKey: string }> };
  return Object.values(body.topics).find((t) => t.id === topicId)!.sessionKey;
}

/** POST /api/chat from outside the page, the way another device or the board would. */
function startTurn(sessionKey: string, content: string): Promise<void> {
  const done = (async () => {
    const res = await fetch(`${E2E_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gateway-Token": TOKEN },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }] }),
    });
    if (!res.ok || !res.body) throw new Error(`POST /api/chat answered ${res.status}`);
    const reader = res.body.getReader();
    for (;;) { const { done: end } = await reader.read(); if (end) break; }
  })();
  done.catch(() => {});
  return done;
}

const queuedBubbles = (page: Page) => page.getByTestId("queued-bubble");

/** Whether this window holds the queue of a session (`msgQueue:hold:`, `state/chatQueue.ts`). */
const queueHeld = (page: Page, sessionKey: string) =>
  page.evaluate((key) => localStorage.getItem(key) !== null, `msgQueue:hold:${sessionKey}`);

/** The chat socket goes through here, so the test can drop it; every reconnect is proxied again. */
async function socketThatDrops(page: Page): Promise<{ drop: () => Promise<void>; opened: () => number }> {
  const sockets: Array<{ close: () => Promise<void> }> = [];
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    sockets.push(ws);
  });
  return {
    drop: async () => { await sockets.at(-1)?.close(); },
    opened: () => sockets.length,
  };
}

test.describe("the turn queue waits for the real end of the turn", () => {
  let uninstall: () => void = () => {};
  const topic = { id: "", name: `queue-turn-end-${Date.now()}`, sk: "" };
  // Autonomy `ask`: a turn that ends on `ExitPlanMode` becomes a plan approval.
  const planTopic = { id: "", name: `queue-plan-${Date.now()}`, sk: "" };

  test.beforeAll(async ({ request }) => {
    rmSync(LOG, { force: true });
    uninstall = installQueueTurnsCli(LOG);
    topic.id = (await createTopic(request, topic.name, { provider: "claude-code" })).id;
    topic.sk = await sessionKeyOf(request, topic.id);
    planTopic.id = (await createTopic(request, planTopic.name, { provider: "claude-code" })).id;
    planTopic.sk = await sessionKeyOf(request, planTopic.id);
    expect((await request.patch(`${E2E_BASE}/api/topics/${planTopic.id}`, { data: { autonomyLevel: "ask" } })).ok()).toBe(true);
    // The first spawn of the CLI is the slow one: paid here.
    await startTurn(topic.sk, "warm up");
    await startTurn(planTopic.sk, "warm up");
  });

  test.afterAll(async ({ request }) => {
    uninstall();
    await deleteTopic(request, topic.id).catch(() => {});
    await deleteTopic(request, planTopic.id).catch(() => {});
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topic.id, planTopic.id]);
  });

  async function openChat(page: Page, chatPage: { messageInput: import("@playwright/test").Locator }, name = topic.name) {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(name));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
  }

  test("a turn of several messages and tools, the socket dropped mid-turn: the message leaves after the result, once", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-QUEUE-07" });
    const socket = await socketThatDrops(page);
    await openChat(page, chatPage);

    const turn = startTurn(topic.sk, "LONGTURN:4:1500:long");
    const chat = page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${topic.id}"]`);
    await expect(chat.getByText("long round 1.", { exact: false }).first()).toBeVisible({ timeout: 30_000 });

    const TAG = "QUEUED-AFTER-LONG";
    await chatPage.messageInput.fill(TAG);
    await chatPage.messageInput.press("Enter");
    await expect(queuedBubbles(page)).toHaveCount(1, { timeout: 10_000 });

    // The socket drops and comes back in the middle of the turn: the window
    // reloads the history, its streaming flag is reset, it gets a catch-up.
    const before = socket.opened();
    await socket.drop();
    await expect.poll(() => socket.opened(), { timeout: 20_000, message: "the window reconnects" }).toBeGreaterThan(before);
    await expect(chat.getByText("long round 3.", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    // Still waiting, and the CLI has not been handed it.
    await expect(queuedBubbles(page)).toHaveCount(1);
    expect(receivedWith(TAG)).toEqual([]);

    await turn;
    await expect.poll(() => receivedWith(TAG).length, { timeout: 30_000, message: "the message reaches the CLI" }).toBe(1);
    const end = turnEvent("turn-end", "long")!;
    const [got] = receivedWith(TAG);
    expect(got!.busy, "the CLI was not in a turn when it was handed the message").toBe(false);
    expect(got!.at).toBeGreaterThanOrEqual(end.at);
    await expect(queuedBubbles(page)).toHaveCount(0, { timeout: 10_000 });
    await expect(chat.getByText(`got:`, { exact: false }).last()).toContainText(TAG, { timeout: 20_000 });
    // Once: the answer is on screen and the CLI was handed it a single time.
    expect(receivedWith(TAG)).toHaveLength(1);
  });

  test("the CLI opens a turn by itself and is silent before its first line: a message written then waits for its result", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-QUEUE-07" });
    await openChat(page, chatPage);

    // Armed from outside; 800 ms later the CLI opens its own turn and says
    // nothing for 3 s, then three rounds of text and a tool.
    await startTurn(topic.sk, "WAKE:800:3:3000:bgreport");
    await expect.poll(() => !!turnEvent("turn-start", "bgreport"), { timeout: 20_000, message: "the CLI opened its own turn" }).toBe(true);

    const TAG = "WRITTEN-DURING-BG";
    await chatPage.messageInput.fill(TAG);
    await chatPage.messageInput.press("Enter");
    // Nothing on screen says a turn runs yet (no line from the model): the
    // server's word queues it, or its 409 sends it back to the queue.
    await expect(queuedBubbles(page)).toHaveCount(1, { timeout: 10_000 });

    await expect.poll(() => receivedWith(TAG).length, { timeout: 60_000, message: "the message reaches the CLI" }).toBe(1);
    const end = turnEvent("turn-end", "bgreport")!;
    expect(end, "the CLI's own turn ended").toBeTruthy();
    const [got] = receivedWith(TAG);
    expect(got!.busy, "the CLI was not in a turn when it was handed the message").toBe(false);
    expect(got!.at).toBeGreaterThanOrEqual(end.at);
    await expect(queuedBubbles(page)).toHaveCount(0, { timeout: 10_000 });
    // The CLI's own turn kept its own row: its rounds are not in the answer to the message.
    const chat = page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${topic.id}"]`);
    await expect(chat.getByText("bgreport round 1.", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    await expect(chat.getByText(`got:`, { exact: false }).last()).toContainText(TAG, { timeout: 20_000 });
  });

  test("Stop pressed on another device while the child is still starting: the message queued here stays queued", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-QUEUE-07" });
    await openChat(page, chatPage);

    // Its `system/init` comes 9 s late: nothing but the route holds the turn
    // open, as after every Stop, idle close or restart of the child.
    const turn = startTurn(topic.sk, "SLOWINIT:9000:coldstop");
    await expect.poll(() => !!turnEvent("turn-start", "coldstop"), { timeout: 20_000, message: "the CLI took the turn" }).toBe(true);

    const TAG = "QUEUED-BEFORE-REMOTE-STOP";
    await chatPage.messageInput.fill(TAG);
    await chatPage.messageInput.press("Enter");
    await expect(queuedBubbles(page)).toHaveCount(1, { timeout: 10_000 });

    // The other device: POST /api/chat/abort from outside the page, the person's Stop.
    const stop = await fetch(`${E2E_BASE}/api/chat/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gateway-Token": TOKEN },
      body: JSON.stringify({ sessionKey: topic.sk }),
    });
    expect(stop.status).toBe(200);
    await turn;

    // The window has taken the Stop (its hold is on) and the turn is over for
    // it (the queue's button no longer promises to stop a turn): whatever the
    // close of the turn was going to do with the queue, it has done.
    await expect.poll(() => queueHeld(page, topic.sk), { timeout: 10_000, message: "the queue is held" }).toBe(true);
    await expect(page.getByTestId("queue-send-now")).toHaveAttribute("data-queue-busy", "false", { timeout: 10_000 });
    await expect(queuedBubbles(page)).toHaveCount(1);
    expect(receivedWith(TAG)).toEqual([]);

    // A whole turn later (started elsewhere, closed plainly), still held.
    await startTurn(topic.sk, "AFTER-THE-STOP");
    await expect.poll(() => receivedWith("AFTER-THE-STOP").length, { timeout: 30_000 }).toBe(1);
    const chat = page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${topic.id}"]`);
    await expect(chat.getByText("got:", { exact: false }).last()).toContainText("AFTER-THE-STOP", { timeout: 20_000 });
    await expect(queuedBubbles(page)).toHaveCount(1);
    expect(receivedWith(TAG)).toEqual([]);
  });

  test("a turn started elsewhere ends on a plan approval: the message queued here waits for the answer and leaves with it", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-QUEUE-07" });
    await openChat(page, chatPage, planTopic.name);

    const turn = startTurn(planTopic.sk, "PLANTURN:4000:planq");
    const chat = page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${planTopic.id}"]`);
    await expect(chat.getByText("planq planning.", { exact: false }).first()).toBeVisible({ timeout: 20_000 });

    const TAG = "QUEUED-DURING-PLAN";
    await chatPage.messageInput.fill(TAG);
    await chatPage.messageInput.press("Enter");
    await expect(queuedBubbles(page)).toHaveCount(1, { timeout: 10_000 });
    await turn;

    // The question is on screen and the turn is over for this window: the
    // message has not left.
    await expect(page.getByTestId("plan-approval-bar")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("queue-send-now")).toHaveAttribute("data-queue-busy", "false", { timeout: 10_000 });
    await expect(queuedBubbles(page)).toHaveCount(1);
    expect(receivedWith(TAG)).toEqual([]);

    // The person answers: the queued message goes out with the answer, once.
    await page.getByTestId("plan-reject").click();
    await expect.poll(() => receivedWith(TAG).length, { timeout: 30_000, message: "the message reaches the CLI" }).toBe(1);
    await expect(queuedBubbles(page)).toHaveCount(0, { timeout: 10_000 });
  });
});
