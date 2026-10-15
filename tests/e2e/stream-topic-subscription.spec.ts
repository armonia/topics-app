/**
 * One window, two topics running a turn at the same time. Panes sync across devices, so a
 * topic open in one window is open in all of them: "not subscribed" means not open in any
 * pane. The open topic streams its deltas to the window; the closed one sends none, and its
 * sidebar row still ends the turn as done. A chat with no tab has no sidebar row while it
 * works, on main too: the row arrives with the result.
 *
 * @covers WIRE-12
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { goToApp, openTopic } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
test.describe.configure({ timeout: 120_000 });

type Frame = { type?: string; topicId?: string };

function captureFrames(page: Page) {
  const frames: Frame[] = [];
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      try {
        frames.push(JSON.parse(String(payload)) as Frame);
      } catch { /* Ignore non-JSON socket frames. */ }
    });
  });
  return frames;
}

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const topics = await (await request.get(`${E2E_BASE}/api/topics`)).json() as { topics: Record<string, { sessionKey: string }> };
  const sessionKey = topics.topics[topicId]?.sessionKey;
  if (!sessionKey) throw new Error("la topic non ha sessionKey");
  return sessionKey;
}

function startTurn(sessionKey: string, content: string): Promise<void> {
  const done = (async () => {
    const response = await fetch(`${E2E_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gateway-Token": process.env.GATEWAY_TOKEN ?? "test-token" },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }] }),
    });
    if (!response.ok || !response.body) throw new Error(`POST /api/chat answered ${response.status}`);
    const reader = response.body.getReader();
    while (!(await reader.read()).done) { /* Drain the turn stream. */ }
  })();
  done.catch(() => {});
  return done;
}

test("un topic aperto riceve i delta, quello chiuso conserva solo lo stato sidebar", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "WIRE-12" });
  const stamp = Date.now();
  const opened = await createTopic(request, `D1c-open-${stamp}`, { provider: "claude-code" });
  const closed = await createTopic(request, `D1c-closed-${stamp}`, { provider: "claude-code" });
  const frames = captureFrames(page);
  const count = (topicId: string, type: string) => frames.filter((frame) => frame.topicId === topicId && frame.type === type).length;
  const row = (name: string) => page.getByRole("treeitem", { name: new RegExp(name) });
  const panel = (topicId: string) => page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${topicId}"]`);
  let removeCli: (() => void) | null = null;
  try {
    await resetPaneStore(request, [opened.id]);
    await goToApp(page);
    await openTopic(page, new RegExp(opened.name));
    await expect(panel(opened.id)).toBeVisible();
    await expect(panel(closed.id)).toHaveCount(0);

    removeCli = installSlowTurnCli();
    const turns = [
      startTurn(await sessionKeyOf(request, closed.id), "SLOW:12:D1CCLOSED"),
      startTurn(await sessionKeyOf(request, opened.id), "SLOW:12:D1COPEN"),
    ];
    await expect.poll(() => count(opened.id, "stream:content_chunk"), {
      timeout: 15_000,
      message: "il topic aperto riceve il testo in streaming",
    }).toBeGreaterThan(0);
    await expect.poll(() => count(opened.id, "stream:usage"), {
      timeout: 15_000,
      message: "il topic aperto riceve usage live",
    }).toBeGreaterThan(0);

    await Promise.all(turns);
    expect(count(closed.id, "stream:content_chunk"), "il topic chiuso non manda testo in streaming").toBe(0);
    expect(count(closed.id, "stream:usage"), "il topic chiuso non manda usage live").toBe(0);
    await expect(row(closed.name).locator("[data-loader-state]")).toHaveCount(0, { timeout: 15_000 });
    await expect(row(closed.name)).toHaveAttribute("data-attention", "done", { timeout: 15_000 });
  } finally {
    removeCli?.();
    await deleteTopic(request, opened.id).catch(() => {});
    await deleteTopic(request, closed.id).catch(() => {});
  }
});
