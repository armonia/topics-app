/**
 * A server or ai-bridge that stops answering for a minute must not cost the
 * client a streaming turn or change the panes in its window.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { processRows } from "./helpers/platform";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, waitForTopicVisible } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_PORT, testServerEnv } from "./helpers/test-server";
import { portHolders } from "./helpers/server-death";
import { hermetic } from "./fixtures/hermetic";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 180_000 });

const TOKEN = process.env.GATEWAY_TOKEN ?? "test-token";
const STOP_MS = 60_000;
const CHUNKS = 90;

function startTurn(sessionKey: string, content: string): { said: () => string; done: Promise<void> } {
  let sse = "";
  const done = (async () => {
    const res = await fetch(`${E2E_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gateway-Token": TOKEN },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }] }),
    });
    if (!res.ok || !res.body) throw new Error(`POST /api/chat answered ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      sse += decoder.decode(value);
    }
  })();
  done.catch(() => {});
  return { said: () => sse, done };
}

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const response = await request.get(`${E2E_BASE}/api/topics`);
  const body = (await response.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
  const topic = Object.values(body.topics).find((item) => item.id === topicId);
  if (!topic) throw new Error(`topic ${topicId} was missing from /api/topics`);
  return topic.sessionKey;
}

async function visiblePaneIds(page: Page): Promise<string[]> {
  return page.locator("[data-pane-id]").evaluateAll((tabs) =>
    tabs.map((tab) => (tab as HTMLElement).dataset.paneId ?? "").filter(Boolean),
  );
}

async function pauseProcess(pid: number): Promise<void> {
  const startedAt = Date.now();
  process.kill(pid, "SIGSTOP");
  try {
    await new Promise((resolve) => setTimeout(resolve, STOP_MS));
  } finally {
    process.kill(pid, "SIGCONT");
  }
  if (Date.now() - startedAt < STOP_MS) throw new Error(`process pause lasted less than ${STOP_MS}ms`);
}

async function findBridgePid(timeoutMs = 15_000): Promise<number> {
  const socket = testServerEnv(E2E_PORT).TOPICS_AI_BRIDGE_SOCKET;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = processRows().filter((row) => row.command.includes(socket) && row.command.includes("ai-bridge"));
    if (matches.length === 1) return Number(matches[0]!.pid);
    if (matches.length > 1) throw new Error(`found multiple ai-bridge processes for ${socket}: ${matches.map((row) => row.pid).join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`ai-bridge process for the test socket was not found: ${socket}`);
}

async function assertTurnSurvived(
  page: Page,
  request: APIRequestContext,
  topicId: string,
  tag: string,
  pause: () => Promise<void>,
): Promise<void> {
  const sessionKey = await sessionKeyOf(request, topicId);
  const turn = startTurn(sessionKey, `SLOW:${CHUNKS}:${tag}`);
  await expect.poll(() => turn.said().includes(`${tag}-06`), { timeout: 30_000, message: "the slow turn has started" }).toBe(true);
  await expect.poll(async () => (await visibleChunks(page, topicId, tag)).length, { timeout: 15_000 }).toBeGreaterThan(0);

  const documentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  const panesBefore = await visiblePaneIds(page);
  expect(panesBefore).toHaveLength(2);

  await pause();

  const holes: number[][] = [];
  await expect.poll(async () => {
    const chunks = await visibleChunks(page, topicId, tag);
    if (chunks.some((chunk, index) => chunk !== index + 1)) holes.push(chunks);
    return chunks.length;
  }, {
    timeout: 120_000,
    intervals: [250],
    message: "the complete streamed turn appears after the process wakes",
  }).toBe(CHUNKS);
  await turn.done;

  expect(holes, "every rendered sample is a contiguous prefix with no duplicate chunk").toEqual([]);
  expect(await visibleChunks(page, topicId, tag)).toEqual(Array.from({ length: CHUNKS }, (_, index) => index + 1));
  expect(await page.evaluate(() => performance.timeOrigin), "the page stayed loaded through the pause").toBe(documentTimeOrigin);
  expect(await visiblePaneIds(page), "the same panes remain visible after the pause").toEqual(panesBefore);
}

async function visibleChunks(page: Page, topicId: string, tag: string): Promise<number[]> {
  const text = await page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${topicId}"]`).evaluate((pane) => {
    const bubbles = pane.querySelectorAll<HTMLElement>('[data-testid="chat-message"][data-role="assistant"]');
    return bubbles[bubbles.length - 1]?.textContent ?? "";
  });
  return (text.match(new RegExp(`${tag}-(\\d\\d)`, "g")) ?? []).map((chunk) => Number(chunk.slice(-2)));
}

test.describe("D7c sleep and wake recovery", () => {
  let uninstall: () => void = () => {};
  const topicIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    uninstall = installSlowTurnCli();
    for (const name of ["Sleep wake A", "Sleep wake B"]) {
      topicIds.push((await createTopic(request, name, { provider: "claude-code" })).id);
    }
    const sessionKey = await sessionKeyOf(request, topicIds[0]!);
    await startTurn(sessionKey, "warm up").done;
  });

  test.afterAll(async ({ request }) => {
    uninstall();
    await Promise.all(topicIds.map((id) => deleteTopic(request, id).catch(() => {})));
  });

  test.beforeEach(async ({ page, request }) => {
    await resetPaneStore(request, topicIds);
    await goToApp(page);
    for (const id of topicIds) await waitForTopicVisible(page, id, { timeout: 20_000 });
    await page.locator(`[data-pane-id="${topicIds[0]}"]`).click();
    await expect(page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${topicIds[0]}"]`)).toBeVisible();
  });

  test("server stopped for 60 seconds: the streaming turn and panes survive @nightly", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "RUNTIME-20" });
    // Read from the port, not from globalSetup: a spec that restarts the server changes its pid.
    const holders = portHolders(E2E_PORT);
    if (holders.length !== 1) throw new Error(`expected one test server on port ${E2E_PORT}, found ${holders.length}`);
    await assertTurnSurvived(page, request, topicIds[0]!, "sleepserver", () => pauseProcess(holders[0]!.pid));
  });

  test("ai-bridge stopped for 60 seconds: the streaming turn and panes survive @nightly", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "RUNTIME-20" });
    const pid = await findBridgePid();
    await assertTurnSurvived(page, request, topicIds[0]!, "sleepbridge", () => pauseProcess(pid));
  });
});
