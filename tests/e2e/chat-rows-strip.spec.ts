/**
 * THE LIVE-WORK STRIP DOES NOT TOUCH THE LAST ROW OF THE TRANSCRIPT.
 *
 * Reported: "the Thinking line is stuck to the sub-agents bar". The bar is the
 * strip at the end of the transcript (`SubAgentsStrip`, a bordered band), and
 * the last row above it, a Thinking row, has no margin of its own, so the two
 * sat edge to edge. Here the sub-agent is REAL: spawned through the route the
 * MCP `spawn_agent` tool calls, a claude-code PTY whose parent is the chat,
 * running the test server's `claude` stub (no model is reached; the tripwire
 * refuses to go on if the PTY resolved any other binary).
 *
 * The bar: the distance from the last row to the band is at least the padding
 * a row keeps above and below its own text (2 x `py-1` = 8 px), the rhythm of
 * every other pair of rows. The same measure is taken at 375, 768 and 1440.
 *
 * @covers CHAT-TOOL-14
 */
import { execFileSync } from "node:child_process";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteAllTerminalSessions, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE, daemonAuthHeaders } from "./helpers/test-server";

hermetic(test);
test.describe.configure({ timeout: 120_000 });

const STAMP = Date.now();
const TOPIC_NAME = `E2E rows strip ${STAMP}`;
const AGENT_NAME = `E2E strip agent ${STAMP}`;
/** A row's own padding above and below its text: the vertical rhythm between rows. */
const ROW_RHYTHM_PX = 8;

let topicId = "";
let sessionKey = "";

/** The sub-agent through the spawn route, and proof that it runs the stub. */
async function spawnStubSubAgent(request: APIRequestContext): Promise<void> {
  const spawned = await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/agents/spawn`, {
    headers: daemonAuthHeaders(),
    data: { prompt: "wait for instructions", name: AGENT_NAME, cwd: "/tmp", runtime: "claude-code" },
  });
  expect(spawned.ok(), `spawn refused: ${spawned.status()} ${await spawned.text()}`).toBe(true);
  const id = ((await spawned.json()) as { agentId: string }).agentId;
  const roster = (await (await request.get(`${E2E_BASE}/api/terminal/sessions`)).json()) as Array<{ id: string; claudeSessionId: string | null }>;
  const sid = roster.find((s) => s.id === id)?.claudeSessionId;
  const commands = () => (sid
    ? execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" })
      .split("\n").filter((l) => l.includes(`--session-id ${sid}`) && !l.includes("ps -axww"))
    : []);
  await expect.poll(commands, { timeout: 15_000 }).not.toEqual([]).catch(() => {});
  const launched = commands();
  if (launched.length === 0 || !launched.every((c) => c.includes("/.home/.local/bin/claude"))) {
    await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/agents/${id}/stop`, { headers: daemonAuthHeaders() });
    throw new Error(`the sub-agent did not run the e2e stub: ${JSON.stringify(launched)}`);
  }
}

test.beforeEach(async ({ request }) => {
  await deleteAllTerminalSessions(request);
  await resetPaneStore(request, []);
  const topic = await createTopic(request, TOPIC_NAME);
  topicId = topic.id;
  const list = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  const { topics } = (await list.json()) as { topics: Record<string, { sessionKey: string }> };
  sessionKey = topics[topicId]?.sessionKey ?? "";
  if (!sessionKey) throw new Error(`topic ${topicId} has no sessionKey`);
  const now = Date.now();
  const user = await seedMessage(request, { sessionKey, role: "user", content: "controlla", timestamp: new Date(now - 9000).toISOString() });
  await seedMessage(request, {
    sessionKey, role: "assistant", parentId: user.id, content: "", timestamp: new Date(now - 8000).toISOString(),
    blocks: [
      { kind: "tool", toolCall: { id: "strip-read", name: "Read", args: { file_path: "/tmp/modulo.ts" }, status: "success", result: "export {}", startedAt: now - 7000, endedAt: now - 6900 } },
      { kind: "thinking", text: "Lancio un sottoagente per i controlli, poi leggo l'esito.\n".repeat(2) },
    ],
  });
  await spawnStubSubAgent(request);
});

test.afterEach(async ({ request }) => {
  await deleteAllTerminalSessions(request);
  if (topicId) await deleteTopic(request, topicId).catch(() => {});
});

async function open(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "attached", timeout: 20_000 });
  if (!(await page.locator('[aria-label="Topics sidebar"]').isVisible())) await page.keyboard.press("ControlOrMeta+b");
  await page.getByRole("treeitem", { name: new RegExp(TOPIC_NAME) }).first().click();
  await expect(page.locator(`[data-chat-topic-id="${topicId}"]`).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="subagent-row"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="reasoning-row"]').last()).toBeVisible({ timeout: 20_000 });
}

for (const width of [375, 768, 1440]) {
  test(`${width} px: the Thinking row keeps a row's distance from the sub-agents bar`, async ({ page }) => {
    await open(page, width);
    const measure = () => page.evaluate(() => {
      const thinking = [...document.querySelectorAll('[data-testid="reasoning-row"]')].at(-1);
      const strip = document.querySelector('[data-testid="subagents-strip"]');
      return thinking && strip ? strip.getBoundingClientRect().top - thinking.getBoundingClientRect().bottom : null;
    });
    // The photo first: a failing build still leaves its picture.
    const dir = process.env.ROWS_SHOT_DIR;
    if (dir) await page.screenshot({ path: `${dir}/${process.env.ROWS_SHOT_TAG ?? "shot"}-strip-${width}.png` });
    // Polled: the strip and the row are two parts of a virtualized list that settle on their own.
    await expect.poll(async () => (await measure()) ?? -1, {
      message: "px between the last Thinking row and the strip", timeout: 10_000,
    }).toBeGreaterThanOrEqual(ROW_RHYTHM_PX);
  });
}
