/**
 * The tab of a sub-agent's terminal closes one way, whatever closes it, and
 * comes back as itself.
 *
 * Reported on 08/11 on the terminals Jarvis opens as sub-agents: the tab's ×
 * asked before stopping a working sub-agent, ⌘W did not; ⇧⌘T right after a
 * close reopened an EMPTY terminal; and a pointer close showed an empty slot
 * in the strip for a moment.
 *
 *  · TABS-01  ⌘W asks what the × asks, and a confirmed close retires the PTY.
 *  · TABS-02  ⇧⌘T during the close countdown keeps the tab: before, it popped
 *             an older record while this tab still closed.
 *  · TABS-03  ⇧⌘T after the PTY was retired brings the same conversation back
 *             (`claude --resume <id>`), not an empty shell.
 *  · TABS-04  the spacer that holds a closed tab's slot appears only once the
 *             tab is gone: while it counts down, no empty slot beside it.
 *
 * Real pieces only, as in `subagent-strip-survives.spec.ts`: the sub-agent is
 * spawned through the route `spawn_agent` calls, as a claude-code PTY running
 * the e2e stub, its parent a chat of the test.
 *
 * @covers CMD-03 SUBAGENT-20 LAYOUT-42 (scenario DENS-06 of the archived change tab-bar-density)
 */
import { execFileSync } from "node:child_process";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteAllTerminalSessions, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE, daemonAuthHeaders } from "./helpers/test-server";
import { closeTabViaCommand } from "./helpers/layout";
import { fakeTauriShell } from "./helpers/fake-tauri-shell";

hermetic(test);

// A real PTY, a real bridge, then xterm: the terminal family runs on 75 s.
test.describe.configure({ timeout: 120_000 });

const STAMP = Date.now();
const TOPIC_NAME = `E2E agent tabs ${STAMP}`;
const AGENT_NAME = `E2E tab agent ${STAMP}`;

let topicId = "";
let sessionKey = "";
let agentId = "";

type RosterRow = { id: string; claudeSessionId: string | null; parentSessionKey: string | null };

async function roster(request: APIRequestContext): Promise<RosterRow[]> {
  return (await (await request.get(`${E2E_BASE}/api/terminal/sessions`)).json()) as RosterRow[];
}

/** Command lines of the processes launched for this claude session id. */
function cliCommandsFor(claudeSessionId: string | null | undefined): string[] {
  if (!claudeSessionId) return [];
  return execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(claudeSessionId) && line.includes("/.home/.local/bin/claude"));
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

  // `/tmp` is no project Topics knows: the child runs on the CLI, in a PTY.
  const spawned = await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/agents/spawn`, {
    headers: daemonAuthHeaders(),
    data: { prompt: "wait for instructions", name: AGENT_NAME, cwd: "/tmp" },
  });
  expect(spawned.ok(), `spawn refused: ${spawned.status()} ${await spawned.text()}`).toBe(true);
  agentId = ((await spawned.json()) as { agentId: string }).agentId;
  // TRIPWIRE, as in subagent-strip-survives: the PTY must run the e2e stub,
  // never a real `claude` found on PATH.
  const child = (await roster(request)).find((s) => s.id === agentId);
  await expect.poll(() => cliCommandsFor(child?.claudeSessionId).length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(child?.parentSessionKey).toBe(sessionKey);
});

test.afterEach(async ({ request }) => {
  await deleteAllTerminalSessions(request);
  if (topicId) await deleteTopic(request, topicId).catch(() => {});
});

function terminalTab(page: Page, id = agentId) {
  return page.locator(`[role="tab"][data-pane-id="terminal:${id}"]`);
}

function chatTab(page: Page) {
  // A standalone chat's tab carries the topic id, a project one `chat:<id>`.
  return page.locator(`[role="tab"][data-pane-id="${topicId}"], [role="tab"][data-pane-id="chat:${topicId}"]`);
}

async function serverLists(request: APIRequestContext, id: string): Promise<boolean> {
  return (await roster(request)).some((s) => s.id === id);
}

/** The chat from the sidebar, then the sub-agent's pane from its strip row. */
async function openSubAgentTab(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
  await page.getByRole("treeitem", { name: new RegExp(TOPIC_NAME) }).first().click();
  const chat = page.locator(`[data-chat-topic-id="${topicId}"]`).first();
  await expect(chat).toBeVisible({ timeout: 20_000 });
  await chat.getByRole("button", { name: new RegExp(`^${AGENT_NAME}`) }).click();
  await expect(terminalTab(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="single-terminal-pane"]:visible')).toBeVisible({ timeout: 20_000 });
}

function stopDialog(page: Page) {
  return page.getByRole("dialog").filter({ hasText: /Fermare|Stop / });
}

async function confirmStop(page: Page): Promise<void> {
  const dialog = stopDialog(page);
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole("button", { name: /^(Ferma|Stop)$/ }).click();
  await expect(dialog).toHaveCount(0);
}

test("TABS-01: Cmd+W on a working sub-agent's tab asks like its ×, and a confirmed close retires the PTY", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "SUBAGENT-20" });
  // Cmd+W is the desktop shell's shortcut: the page runs as the shell.
  await fakeTauriShell(page, () => () => null);
  await openSubAgentTab(page);

  // Asked, and «Cancel» keeps both the tab and the process.
  await terminalTab(page).click();
  await page.keyboard.press("Meta+w");
  const dialog = stopDialog(page);
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole("button", { name: /^(Annulla|Cancel)$/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(terminalTab(page)).toBeVisible();
  expect(await serverLists(page.request, agentId)).toBe(true);

  // Confirmed: the tab leaves and the PTY is retired, as from the ×.
  await terminalTab(page).click();
  await page.keyboard.press("Meta+w");
  await confirmStop(page);
  await expect(terminalTab(page)).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => serverLists(page.request, agentId), { timeout: 30_000 }).toBe(false);
});

test("TABS-02: Shift+Cmd+T during the close countdown keeps the tab and its process", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "CMD-03" });
  await openSubAgentTab(page);

  await closeTabViaCommand(terminalTab(page));
  await confirmStop(page);
  // The countdown runs with the tab still in the strip.
  await expect(terminalTab(page)).toBeVisible();
  await page.keyboard.press("Meta+Shift+t");

  // Proving that something did NOT happen takes time: well past the 3 s
  // countdown, the tab must still be there at every look.
  const since = Date.now();
  await expect
    .poll(async () => (await terminalTab(page).count()) === 1 && Date.now() - since > 4_500, { timeout: 15_000, intervals: [250] })
    .toBe(true);
  await expect(terminalTab(page)).toHaveCount(1);
  expect(await serverLists(page.request, agentId)).toBe(true);
});

test("TABS-03: Shift+Cmd+T after the PTY was retired resumes the same conversation", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "CMD-03" });
  const claudeSessionId = (await roster(page.request)).find((s) => s.id === agentId)?.claudeSessionId;
  expect(claudeSessionId, "the sub-agent has a conversation id").toBeTruthy();
  await openSubAgentTab(page);

  await closeTabViaCommand(terminalTab(page));
  await confirmStop(page);
  await expect(terminalTab(page)).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => serverLists(page.request, agentId), { timeout: 30_000 }).toBe(false);
  await expect.poll(() => cliCommandsFor(claudeSessionId).length, { timeout: 30_000 }).toBe(0);

  await page.keyboard.press("Meta+Shift+t");
  // A new terminal tab, running claude on the SAME conversation: before, the
  // record had no type and no conversation, and a plain shell came back.
  await expect(page.locator('[role="tab"][data-pane-id^="terminal:"]')).toHaveCount(1, { timeout: 20_000 });
  await expect
    .poll(() => cliCommandsFor(claudeSessionId).some((c) => c.includes(`--resume ${claudeSessionId}`)), { timeout: 30_000 })
    .toBe(true);
});

test("TABS-04: a pointer close leaves no empty slot while the tab counts down", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "LAYOUT-42" });
  await openSubAgentTab(page);
  await expect(chatTab(page)).toBeVisible();
  const spacer = page.locator("[data-density-close-spacer]");

  // Tab and spacer read in ONE look: two separate reads straddled the tab's
  // exit and saw the spacer that, by then, was rightly there.
  const look = () => page.evaluate((id) => ({
    tab: !!document.querySelector(`[role="tab"][data-pane-id="${id}"], [role="tab"][data-pane-id="chat:${id}"]`),
    spacer: !!document.querySelector("[data-density-close-spacer]"),
  }), topicId);

  // The chat's tab, before the terminal's: its slot is the one a spacer holds.
  await closeTabViaCommand(chatTab(page));
  // Countdown: the tab is still there, so nothing may sit in its place too.
  // Every frame while it is there: no spacer beside it.
  let looks = 0;
  for (let now = await look(); now.tab; now = await look()) {
    expect(now.spacer, "a spacer while the closing tab is still in the strip").toBe(false);
    looks++;
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }
  expect(looks, "the countdown was watched, not skipped").toBeGreaterThan(5);
  // Gone: now the spacer holds its slot, so the next tab does not slide under
  // the pointer (the freeze this fix keeps).
  await expect(spacer).toHaveCount(1, { timeout: 5_000 });
});
