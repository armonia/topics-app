/**
 * A CHAT'S SUB-AGENT DOES NOT VANISH FROM THE CHAT.
 *
 * Reported 29/09: "we had a sub-agent in a topic, sent a message, it disappeared
 * from that sub-agent's interface". The strip under the chat read only the live
 * terminal roster, so the moment the sub-agent's process left it (a Ctrl+C
 * typed into its pane, `/exit`, a crash, `stop_agent`) its row was gone, and a
 * one-row strip with it: nothing said whether it finished, died, or was ever
 * there.
 *
 * Real pieces only: the sub-agent is spawned through the same route the MCP
 * `spawn_agent` tool calls, as a claude-code PTY whose parent is the chat. The
 * process behind it is the test server's `claude` stub (scripts/
 * start-test-server.sh), which stays alive and quits on SIGINT: no model is
 * reached. The tripwire below refuses to go on if the PTY resolved any other
 * binary.
 *
 * @covers SUBSTRIP-01
 */
import { execFileSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteAllTerminalSessions, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

// A real PTY, a real bridge, then xterm: the terminal family runs on 75 s (see
// terminal-reconnect.spec.ts); a reload and a chat turn ride on top of it.
test.describe.configure({ timeout: 120_000 });

const STAMP = Date.now();
const TOKEN = { "x-gateway-token": process.env.GATEWAY_TOKEN ?? "test-token" };
const AGENT_NAME = `E2E sub-agent ${STAMP}`;
const TOPIC_NAME = `E2E substrip ${STAMP}`;

let topicId = "";
let agentId = "";

test.beforeEach(async ({ request }) => {
  await deleteAllTerminalSessions(request);
  await resetPaneStore(request, []);
  const topic = await createTopic(request, TOPIC_NAME);
  topicId = topic.id;
  const list = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  const { topics } = (await list.json()) as { topics: Record<string, { sessionKey: string }> };
  const sessionKey = topics[topicId]?.sessionKey;
  if (!sessionKey) throw new Error(`topic ${topicId} has no sessionKey`);

  const spawned = await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/agents/spawn`, {
    headers: TOKEN,
    data: { prompt: "wait for instructions", name: AGENT_NAME, cwd: "/tmp" },
  });
  expect(spawned.ok(), `spawn refused: ${spawned.status()} ${await spawned.text()}`).toBe(true);
  agentId = ((await spawned.json()) as { agentId: string }).agentId;

  // TRIPWIRE: the PTY must run the stub inside the isolated HOME. A `claude`
  // found on PATH would be the real CLI, and the seeded prompt would reach a
  // paid model: stop it at once and fail loudly instead. The roster's
  // `command` is only the label "claude", so the process table is read: the
  // CLI is launched with `--session-id <its claudeSessionId>`.
  const roster = (await (await request.get(`${E2E_BASE}/api/terminal/sessions`)).json()) as Array<{
    id: string; claudeSessionId: string | null; parentSessionKey: string | null;
  }>;
  const child = roster.find((s) => s.id === agentId);
  await expect
    .poll(() => cliCommandsFor(child?.claudeSessionId), { timeout: 15_000 })
    .not.toEqual([])
    .catch(() => {});
  const launched = cliCommandsFor(child?.claudeSessionId);
  if (!child || launched.length === 0 || !launched.every((c) => c.includes("/.home/.local/bin/claude"))) {
    await request.post(
      `${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/agents/${agentId}/stop`,
      { headers: TOKEN },
    );
    throw new Error(`the sub-agent did not run the e2e stub: ${JSON.stringify(launched)}`);
  }
  expect(child.parentSessionKey).toBe(sessionKey);
});

/** Command lines of the processes launched for this claude session id. */
function cliCommandsFor(claudeSessionId: string | null | undefined): string[] {
  if (!claudeSessionId) return [];
  return execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(`--session-id ${claudeSessionId}`) && !line.includes("ps -axww"));
}

test.afterEach(async ({ request }) => {
  await deleteAllTerminalSessions(request);
  if (topicId) await deleteTopic(request, topicId).catch(() => {});
});

/**
 * The sub-agent's button in the strip of ITS chat pane (the sidebar lists the
 * same name, so the pane scopes it). Found by name and role, which the strip
 * had before this fix too: on the old build the test fails where the row
 * vanishes, not on a selector that did not exist yet.
 */
function stripButton(page: Page) {
  return page
    .locator(`[data-testid="chat-panel"][data-chat-topic-id="${topicId}"]`)
    .getByRole("button", { name: new RegExp(`^${AGENT_NAME}`) });
}

/** The row wrapper, which carries the state the fix adds. */
function stripRow(page: Page) {
  return page.locator(`[data-testid="subagent-row"][data-subagent-id="${agentId}"]`);
}

function terminalTab(page: Page) {
  return page.locator(`[role="tab"][data-pane-id="terminal:${agentId}"]`);
}

async function showChat(page: Page): Promise<void> {
  await page.locator(`[role="tab"][data-pane-id="${topicId}"]`).first().click();
}

test("SUBSTRIP-01: the sub-agent stays through a message, and ends marked instead of vanishing", async ({ page, chatPage }) => {
  test.info().annotations.push({ type: "spec", description: "SUBSTRIP-01" });

  // Opened from the sidebar, as a person does. A `/tab/chat/<id>` permalink
  // re-asserts its own tab once the pane store hydrates, and a click landing
  // before that is taken back: a different defect, not this one.
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
  await page.getByRole("treeitem", { name: new RegExp(TOPIC_NAME) }).first().click();
  await expect(page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${topicId}"]`)).toBeVisible({ timeout: 20_000 });

  // 1. The live sub-agent is listed in its chat, and its row opens its pane.
  const button = stripButton(page);
  await expect(button).toBeVisible({ timeout: 20_000 });
  await button.click();
  await expect(terminalTab(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="single-terminal-pane"]:visible')).toBeVisible({ timeout: 20_000 });

  // 2. A message in the parent chat: the row and the pane stay.
  await showChat(page);
  const text = `still there? ${STAMP}`;
  await chatPage.sendMessage(text);
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 20_000 });
  await expect(button).toBeVisible();
  await expect(terminalTab(page)).toBeVisible();

  // 3. Input typed into the sub-agent's own pane ends it (Ctrl+C: the stub
  //    quits on SIGINT, like the CLI does on a double Ctrl+C).
  await terminalTab(page).click();
  await page.locator(".xterm-screen:visible").first().click();
  await page.keyboard.press("Control+c");
  // The roster lets it go (the server's own list is the proof it ended)...
  await expect
    .poll(async () => ((await (await page.request.get(`${E2E_BASE}/api/terminal/sessions`)).json()) as Array<{ id: string }>)
      .some((s) => s.id === agentId), { timeout: 30_000 })
    .toBe(false);
  // ...and its pane stays open.
  await expect(terminalTab(page)).toBeVisible();
  await expect(page.locator('[data-testid="single-terminal-pane"]:visible')).toBeVisible();

  // 4. Back in the chat the row is still there, marked ended. Before the fix
  //    this is where it vanished: the roster no longer lists the sub-agent.
  await showChat(page);
  await expect(button).toBeVisible({ timeout: 15_000 });
  await expect(stripRow(page)).toHaveAttribute("data-state", "ended");

  // 5. A reload is not a dismissal.
  await page.reload();
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
  await showChat(page);
  await expect(button).toBeVisible({ timeout: 20_000 });
  await expect(stripRow(page)).toHaveAttribute("data-state", "ended");

  // 6. The user's dismissal is.
  await stripRow(page).getByTestId("subagent-dismiss").click();
  await expect(button).toHaveCount(0);
});
