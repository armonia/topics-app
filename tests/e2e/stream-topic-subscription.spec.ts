import { copyFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { openTopic } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { openTwoDevices } from "./helpers/multi-client";
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

test("un topic aperto riceve i delta, quello chiuso conserva solo lo stato sidebar", async ({ browser, request }, testInfo) => {
  const topic = await createTopic(request, `D1c-${Date.now()}`, { provider: "claude-code" });
  const topicState = (page: Page) => page.getByRole("treeitem", { name: new RegExp(topic.name) });
  let removeCli: (() => void) | null = null;
  const devices = await openTwoDevices(browser, {
    contextOptions: { recordVideo: { dir: testInfo.outputPath("windows"), size: { width: 1280, height: 800 } } },
    seed: async (req) => { await resetPaneStore(req, []); },
  });
  const observerFrames = captureFrames(devices.pageA);
  const viewerFrames = captureFrames(devices.pageB);
  try {
    removeCli = installSlowTurnCli();
    await openTopic(devices.pageB, new RegExp(topic.name));
    await expect(devices.pageB.locator(`[data-testid="chat-panel"][data-chat-topic-id="${topic.id}"]`)).toBeVisible();
    await expect(devices.pageA.locator(`[data-testid="chat-panel"][data-chat-topic-id="${topic.id}"]`)).toHaveCount(0);

    const topics = await (await request.get(`${E2E_BASE}/api/topics`)).json() as { topics: Record<string, { id: string; sessionKey: string }> };
    const sessionKey = topics.topics[topic.id]?.sessionKey;
    if (!sessionKey) throw new Error("la topic non ha sessionKey");

    const turn = startTurn(sessionKey, "SLOW:12:D1CSTREAM");
    await expect(topicState(devices.pageA).locator('[data-loader-state="working"]')).toBeVisible({ timeout: 15_000 });
    await expect(topicState(devices.pageB).locator('[data-loader-state="working"]')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => viewerFrames.filter((frame) => frame.topicId === topic.id && frame.type === "stream:content_chunk").length, {
      timeout: 15_000,
      message: "la finestra iscritta riceve il testo in streaming",
    }).toBeGreaterThan(0);
    await expect.poll(() => viewerFrames.filter((frame) => frame.topicId === topic.id && frame.type === "stream:usage").length, {
      timeout: 15_000,
      message: "la finestra iscritta riceve usage live",
    }).toBeGreaterThan(0);

    await turn;
    expect(observerFrames.filter((frame) => frame.topicId === topic.id && frame.type === "stream:content_chunk")).toHaveLength(0);
    expect(observerFrames.filter((frame) => frame.topicId === topic.id && frame.type === "stream:usage")).toHaveLength(0);
    await expect(topicState(devices.pageA).locator('[data-loader-state]')).toHaveCount(0, { timeout: 15_000 });
    await expect(topicState(devices.pageB).locator('[data-loader-state]')).toHaveCount(0, { timeout: 15_000 });
    await expect(topicState(devices.pageA)).toHaveAttribute("data-attention", "done", { timeout: 15_000 });
    await expect(topicState(devices.pageB)).toHaveAttribute("data-attention", "done", { timeout: 15_000 });
  } finally {
    removeCli?.();
    const videoA = devices.pageA.video();
    const videoB = devices.pageB.video();
    await devices.dispose();
    for (const [video, name] of [[videoA, "observer.webm"], [videoB, "subscriber.webm"]] as const) {
      const path = await video?.path().catch(() => null);
      if (path) copyFileSync(path, testInfo.outputPath(name));
    }
    await deleteTopic(request, topic.id).catch(() => {});
  }
});
