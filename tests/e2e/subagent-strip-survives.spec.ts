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
 * @covers SUBSTRIP-01 SUBSTRIP-01b SUBSTRIP-01c SUBSTRIP-01d SUBSTRIP-01e SUBSTRIP-01f SUBSTRIP-01g SUBSTRIP-01h
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import {
  createTopic, deleteAllTerminalSessions, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane,
} from "./helpers/api-fixtures";
import { projectPanesKey } from "../../shared/project-keys";
import { E2E_BASE } from "./helpers/test-server";
import { closeTabViaCommand } from "./helpers/layout";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { fakeTauriShell } from "./helpers/fake-tauri-shell";

hermetic(test);

// A real PTY, a real bridge, then xterm: the terminal family runs on 75 s (see
// terminal-reconnect.spec.ts); a reload and a chat turn ride on top of it.
test.describe.configure({ timeout: 120_000 });

const STAMP = Date.now();
const TOKEN = { "x-gateway-token": process.env.GATEWAY_TOKEN ?? "test-token" };
const AGENT_NAME = `E2E sub-agent ${STAMP}`;
const TOPIC_NAME = `E2E substrip ${STAMP}`;

let topicId = "";
let sessionKey = "";
let agentId = "";

test.beforeEach(async ({ request }) => {
  await deleteAllTerminalSessions(request);
  await resetPaneStore(request, []);
  const topic = await createTopic(request, TOPIC_NAME);
  topicId = topic.id;
  const list = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  const { topics } = (await list.json()) as { topics: Record<string, { sessionKey: string }> };
  sessionKey = topics[topicId]?.sessionKey ?? "";
  if (!sessionKey) throw new Error(`topic ${topicId} has no sessionKey`);
  agentId = await spawnSubAgent(request, AGENT_NAME);
});

/**
 * Spawn a sub-agent of the test's chat through the route the MCP `spawn_agent`
 * tool calls, and check it runs the stub.
 */
async function spawnSubAgent(request: APIRequestContext, name: string, cwd = "/tmp"): Promise<string> {
  const spawned = await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/agents/spawn`, {
    headers: TOKEN,
    data: { prompt: "wait for instructions", name, cwd },
  });
  expect(spawned.ok(), `spawn refused: ${spawned.status()} ${await spawned.text()}`).toBe(true);
  const id = ((await spawned.json()) as { agentId: string }).agentId;

  // TRIPWIRE: the PTY must run the stub inside the isolated HOME. A `claude`
  // found on PATH would be the real CLI, and the seeded prompt would reach a
  // paid model: stop it at once and fail loudly instead. The roster's
  // `command` is only the label "claude", so the process table is read: the
  // CLI is launched with `--session-id <its claudeSessionId>`.
  const roster = (await (await request.get(`${E2E_BASE}/api/terminal/sessions`)).json()) as Array<{
    id: string; claudeSessionId: string | null; parentSessionKey: string | null;
  }>;
  const child = roster.find((s) => s.id === id);
  await expect
    .poll(() => cliCommandsFor(child?.claudeSessionId), { timeout: 15_000 })
    .not.toEqual([])
    .catch(() => {});
  const launched = cliCommandsFor(child?.claudeSessionId);
  if (!child || launched.length === 0 || !launched.every((c) => c.includes("/.home/.local/bin/claude"))) {
    await stopSubAgent(request, id);
    throw new Error(`the sub-agent did not run the e2e stub: ${JSON.stringify(launched)}`);
  }
  expect(child.parentSessionKey).toBe(sessionKey);
  return id;
}

/** The parent's `stop_agent`, then wait until the server's roster lets it go. */
async function stopSubAgent(request: APIRequestContext, id: string): Promise<void> {
  await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/agents/${id}/stop`, { headers: TOKEN });
  await expect.poll(() => serverLists(request, id), { timeout: 30_000 }).toBe(false);
}

async function serverLists(request: APIRequestContext, id: string): Promise<boolean> {
  const roster = (await (await request.get(`${E2E_BASE}/api/terminal/sessions`)).json()) as Array<{ id: string }>;
  return roster.some((s) => s.id === id);
}

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
  return chatScope(page).getByRole("button", { name: new RegExp(`^${AGENT_NAME}`) });
}

/**
 * The chat's own subtree. A top-level chat panel and a chat inside a project
 * window both carry the topic's id; the outermost one is the scope.
 */
function chatScope(page: Page) {
  return page.locator(`[data-chat-topic-id="${topicId}"]`).first();
}

/** The row wrapper, which carries the state the fix adds. */
function stripRow(page: Page, id = agentId) {
  return page.locator(`[data-testid="subagent-row"][data-subagent-id="${id}"]`);
}

function terminalTab(page: Page, id = agentId) {
  return page.locator(`[role="tab"][data-pane-id="terminal:${id}"]`);
}

/**
 * Opened from the sidebar, as a person does. A `/tab/chat/<id>` permalink
 * re-asserts its own tab once the pane store hydrates, and a click landing
 * before that is taken back: a different defect, not this one.
 */
async function openChat(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
  await page.getByRole("treeitem", { name: new RegExp(TOPIC_NAME) }).first().click();
  await expect(chatScope(page)).toBeVisible({ timeout: 20_000 });
}

async function reloadToChat(page: Page): Promise<void> {
  await page.reload();
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
  await showChat(page);
}

/**
 * True once this page has ACCEPTED a roster without `id`: the client writes
 * the roster cache in the same step that records who left it, so from here on
 * a row for `id` in the strip is the client's settled answer, not a frame
 * caught between two rosters.
 */
async function clientDropped(page: Page, id: string): Promise<boolean> {
  return page.evaluate((sid) => {
    const raw = localStorage.getItem("terminal-sessions-cache");
    return !!raw && !(JSON.parse(raw) as Array<{ id: string }>).some((s) => s.id === sid);
  }, id);
}

/** Open the sub-agent's pane from its strip row. */
async function openPaneFromStrip(page: Page): Promise<void> {
  await stripButton(page).click();
  await expect(terminalTab(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="single-terminal-pane"]:visible')).toBeVisible({ timeout: 20_000 });
}

async function showChat(page: Page): Promise<void> {
  // A chat inside a project is the project window's `chat:<id>` tab.
  await page.locator(`[role="tab"][data-pane-id="${topicId}"], [role="tab"][data-pane-id="chat:${topicId}"]`).first().click();
}

test("SUBSTRIP-01: the sub-agent stays through a message, and ends marked instead of vanishing", async ({ page, chatPage }) => {
  test.info().annotations.push({ type: "spec", description: "SUBSTRIP-01" });

  await openChat(page);

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
  await reloadToChat(page);
  await expect(button).toBeVisible({ timeout: 20_000 });
  await expect(stripRow(page)).toHaveAttribute("data-state", "ended");

  // 6. The user's dismissal is.
  await stripRow(page).getByTestId("subagent-dismiss").click();
  await expect(button).toHaveCount(0);
});

test("SUBSTRIP-01b: closing the tab of an ENDED sub-agent takes its row away, for good", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "SUBSTRIP-01b" });
  // A second, live sub-agent: once its row is on screen after the reload, the
  // strip has rendered, and a missing row is an answer.
  const sentinelId = await spawnSubAgent(page.request, `E2E sentinel ${STAMP}`);

  await openChat(page);
  await openPaneFromStrip(page);
  await page.locator(".xterm-screen:visible").first().click();
  await page.keyboard.press("Control+c");
  await expect.poll(() => serverLists(page.request, agentId), { timeout: 30_000 }).toBe(false);
  await showChat(page);
  await expect(stripRow(page)).toHaveAttribute("data-state", "ended", { timeout: 15_000 });

  // The X on the tab bar, the gesture the verifier used. Before the fix only
  // the sidebar's own close reached the dismissal, and an ended sub-agent has
  // no sidebar row: its ended row outlived the tab indefinitely.
  await closeTabViaCommand(terminalTab(page));
  await expect(terminalTab(page)).toHaveCount(0, { timeout: 15_000 });
  await showChat(page);
  await expect(stripRow(page)).toHaveCount(0, { timeout: 15_000 });

  await reloadToChat(page);
  await expect(stripRow(page, sentinelId)).toBeVisible({ timeout: 20_000 });
  await expect(stripRow(page)).toHaveCount(0);
});

test("SUBSTRIP-01c: closing the tab of a LIVE sub-agent does not leave it behind as ended", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "SUBSTRIP-01c" });
  const sentinelId = await spawnSubAgent(page.request, `E2E sentinel ${STAMP}`);

  await openChat(page);
  await openPaneFromStrip(page);
  await closeTabViaCommand(terminalTab(page));
  await expect(terminalTab(page)).toHaveCount(0, { timeout: 15_000 });
  // Closing the tab retires the session on the server...
  await expect.poll(() => serverLists(page.request, agentId), { timeout: 30_000 }).toBe(false);
  // ...and this page has taken the roster without it. Before the fix that
  // roster is exactly what turned the closed tab into an ended row.
  await expect.poll(() => clientDropped(page, agentId), { timeout: 30_000 }).toBe(true);
  await showChat(page);
  await expect(stripRow(page, sentinelId)).toBeVisible({ timeout: 15_000 });
  await expect(stripRow(page)).toHaveCount(0);

  await reloadToChat(page);
  await expect(stripRow(page, sentinelId)).toBeVisible({ timeout: 20_000 });
  await expect(stripRow(page)).toHaveCount(0);
});

test("SUBSTRIP-01d: a row dismissed in one window stays dismissed in the other, and does not come back", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "SUBSTRIP-01d" });
  const betaId = await spawnSubAgent(page.request, `E2E beta ${STAMP}`);
  const gammaId = await spawnSubAgent(page.request, `E2E gamma ${STAMP}`);

  // Two windows of the same browser: one localStorage.
  const other = await page.context().newPage();
  await openChat(page);
  await openChat(other);
  for (const id of [agentId, betaId, gammaId]) await stopSubAgent(page.request, id);
  for (const p of [page, other]) {
    for (const id of [agentId, betaId, gammaId]) {
      await expect(stripRow(p, id)).toHaveAttribute("data-state", "ended", { timeout: 20_000 });
    }
  }

  // Window A dismisses the first: window B lets it go too.
  await stripRow(page).getByTestId("subagent-dismiss").click();
  await expect(stripRow(page)).toHaveCount(0);
  await expect(stripRow(other)).toHaveCount(0, { timeout: 10_000 });

  // Window B dismisses the second. Before the fix B wrote back its own copy
  // of the list, still holding the row A had dismissed.
  await stripRow(other, betaId).getByTestId("subagent-dismiss").click();
  await expect(stripRow(other, betaId)).toHaveCount(0);

  // A reload of A reads what both windows did: gamma (never dismissed) is
  // back, the two dismissed rows are not.
  await reloadToChat(page);
  await expect(stripRow(page, gammaId)).toHaveAttribute("data-state", "ended", { timeout: 20_000 });
  await expect(stripRow(page)).toHaveCount(0);
  await expect(stripRow(page, betaId)).toHaveCount(0);
  await other.close();
});

/** Ctrl+C in the sub-agent's own pane, then wait until its row says ended. */
async function endFromItsPane(page: Page): Promise<void> {
  await page.locator(".xterm-screen:visible").first().click();
  await page.keyboard.press("Control+c");
  await expect.poll(() => serverLists(page.request, agentId), { timeout: 30_000 }).toBe(false);
  await showChat(page);
  await expect(stripRow(page)).toHaveAttribute("data-state", "ended", { timeout: 15_000 });
}

/**
 * The test's chat moved into a PROJECT, with its sub-agent and a live
 * sentinel, and the sub-agent's pane open in the project window: a close or a
 * prune there runs the project's own code, not the one of the top-level tabs.
 * `agentInProject` runs the sub-agent in the project's folder, as one spawned
 * from there does, instead of `/tmp`.
 */
async function chatInProjectWithPaneOpen(
  page: Page, dirName: string, agentInProject = false,
): Promise<{ projectDir: string; sentinelId: string; inProject: Locator }> {
  // The standalone chat of beforeEach goes first: its sub-agent would be a
  // second row with the same name in the sidebar.
  await deleteTopic(page.request, topicId);
  await deleteAllTerminalSessions(page.request);
  const projectDir = canonicalTmpDir(dirName);
  mkdirSync(projectDir, { recursive: true });
  topicId = (await createTopic(page.request, `${TOPIC_NAME} in project`, { projectPath: projectDir })).id;
  const list = await page.request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  const { topics } = (await list.json()) as { topics: Record<string, { sessionKey: string; projectPath?: string }> };
  sessionKey = topics[topicId]?.sessionKey ?? "";
  expect(topics[topicId]?.projectPath, "the chat belongs to a project").toBeTruthy();
  agentId = await spawnSubAgent(page.request, AGENT_NAME, agentInProject ? projectDir : "/tmp");
  const sentinelId = await spawnSubAgent(page.request, `E2E sentinel ${STAMP}`);

  await resetPaneStore(page.request, []);
  await seedProjectPane(page.request, projectDir);
  await page.request.put(`${E2E_BASE}/api/ui-state/${projectPanesKey(projectDir)}`, {
    data: {
      nonChatPanes: [{ id: `terminal:${agentId}`, type: "terminal", title: AGENT_NAME, terminalSessionId: agentId }],
      openChatTopicIds: [topicId],
      activeChatTopicId: topicId,
    },
  });
  await page.goto("/");
  const inProject = page.locator(`[data-testid="project-window"] [role="tab"][data-pane-id="terminal:${agentId}"]`);
  await expect(inProject.first()).toBeVisible({ timeout: 20_000 });
  await inProject.first().click();
  await expect(page.locator('[data-testid="single-terminal-pane"]:visible')).toBeVisible({ timeout: 20_000 });
  return { projectDir, sentinelId, inProject };
}

test("SUBSTRIP-01e: inside a project, closing the tab of a LIVE sub-agent does not leave it behind as ended", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "SUBSTRIP-01e" });
  // The project keeps a closed terminal's session for a minute (the undo
  // window) before retiring it, and the row must not come back then.
  test.setTimeout(180_000);
  const { projectDir, sentinelId, inProject } = await chatInProjectWithPaneOpen(page, "e2e-substrip-project");

  await closeTabViaCommand(inProject.first());
  await expect(terminalTab(page)).toHaveCount(0, { timeout: 15_000 });
  // The session is retired once the project's undo window is over...
  await expect.poll(() => serverLists(page.request, agentId), { timeout: 100_000, intervals: [2_000] }).toBe(false);
  // ...and this page has taken the roster without it: without the dismissal
  // at the close, that roster is what records the closed tab as ended.
  await expect.poll(() => clientDropped(page, agentId), { timeout: 30_000 }).toBe(true);
  await showChat(page);
  await expect(stripRow(page, sentinelId)).toBeVisible({ timeout: 15_000 });
  await expect(stripRow(page)).toHaveCount(0, { timeout: 15_000 });

  await reloadToChat(page);
  await expect(stripRow(page, sentinelId)).toBeVisible({ timeout: 20_000 });
  await expect(stripRow(page)).toHaveCount(0);
  await resetProjectPanes(page.request, projectDir).catch(() => {});
  removeTmpDir(projectDir);
});

test("SUBSTRIP-01f: Cmd+W on the tab of an ENDED sub-agent takes its row away, for good", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "SUBSTRIP-01f" });
  // Cmd+W is the desktop shell's shortcut (a browser keeps it for its own
  // tab), so the page runs as the shell, with its network sent home.
  await fakeTauriShell(page, () => () => null);
  const sentinelId = await spawnSubAgent(page.request, `E2E sentinel ${STAMP}`);

  await openChat(page);
  await openPaneFromStrip(page);
  await endFromItsPane(page);

  await terminalTab(page).click();
  await page.keyboard.press("Meta+w");
  await expect(terminalTab(page)).toHaveCount(0, { timeout: 15_000 });
  await showChat(page);
  await expect(stripRow(page, sentinelId)).toBeVisible({ timeout: 15_000 });
  await expect(stripRow(page)).toHaveCount(0, { timeout: 15_000 });

  await reloadToChat(page);
  await expect(stripRow(page, sentinelId)).toBeVisible({ timeout: 20_000 });
  await expect(stripRow(page)).toHaveCount(0);
});

/**
 * How many answers to the dormant list this page has had. A terminal tab whose
 * session is not in the roster is decided on such an answer: parked, it stays;
 * not listed, it is gone. After a reload the first one comes from the network
 * (the 2 s read cache of `coalescedFetch` lives in the page), so counting them
 * is how the tests below know the boot verdict was taken, instead of sleeping
 * on it. Right after an end the verdict may instead come from a cached read,
 * with nothing to count: that moment is checked, and the reload is the proof.
 */
function countDormantReads(page: Page): () => number {
  let n = 0;
  page.on("response", (r) => {
    if (new URL(r.url()).pathname === "/api/terminal/sessions/dormant") n++;
  });
  return () => n;
}

/** Two frames: a verdict taken in a fetch callback has been rendered. */
async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/**
 * The parent stops its sub-agent (`stop_agent`): the session is DELETED, not
 * parked, so the dormant list does not list it and it reads as gone. Returns
 * once this page has taken the roster without it and shows its row ended.
 */
async function stopAndSeeItEnded(page: Page): Promise<void> {
  await stopSubAgent(page.request, agentId);
  await expect.poll(() => clientDropped(page, agentId), { timeout: 30_000 }).toBe(true);
  await showChat(page);
  await expect(stripRow(page)).toHaveAttribute("data-state", "ended", { timeout: 15_000 });
  await twoFrames(page);
}

/** Reload, and return once the boot verdict on every terminal tab is taken. */
async function reloadAndAwaitVerdict(page: Page, dormantReads: () => number, sentinelId: string): Promise<void> {
  const before = dormantReads();
  await reloadToChat(page);
  await expect(stripRow(page, sentinelId)).toBeVisible({ timeout: 20_000 });
  await expect.poll(dormantReads, { timeout: 15_000 }).toBeGreaterThan(before);
  await twoFrames(page);
}

test("SUBSTRIP-01g: inside a project, the tab of a sub-agent its parent stopped stays open with its ended row", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "SUBSTRIP-01g" });
  const dormantReads = countDormantReads(page);
  const { projectDir, sentinelId, inProject } = await chatInProjectWithPaneOpen(page, "e2e-substrip-ends-in-project", true);

  // The end. Before the fix the tab closed by itself here: the dormant list
  // does not hold a stopped sub-agent, so the project's prune took its tab.
  await stopAndSeeItEnded(page);
  expect(await inProject.count(), "the ended sub-agent's tab, once its row says ended").toBe(1);

  // A reload is not a dismissal: the restored tab is never seen in a roster
  // again, and an authoritative one does not list it.
  await reloadAndAwaitVerdict(page, dormantReads, sentinelId);
  expect(await inProject.count(), "the ended sub-agent's tab, after a reload").toBe(1);
  await expect(stripRow(page)).toHaveAttribute("data-state", "ended");

  // Dismissing the row is the user done with it: the tab kept for that row
  // goes with it, at once, not at the next roster that happens to come in.
  await stripRow(page).getByTestId("subagent-dismiss").click();
  await expect(stripRow(page)).toHaveCount(0);
  await expect(inProject).toHaveCount(0, { timeout: 5_000 });
  await resetProjectPanes(page.request, projectDir).catch(() => {});
  removeTmpDir(projectDir);
});

test("SUBSTRIP-01h: a top-level tab of a sub-agent its parent stopped stays open with its ended row", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "SUBSTRIP-01h" });
  const dormantReads = countDormantReads(page);
  const sentinelId = await spawnSubAgent(page.request, `E2E sentinel ${STAMP}`);

  await openChat(page);
  await openPaneFromStrip(page);
  await stopAndSeeItEnded(page);
  expect(await terminalTab(page).count(), "the ended sub-agent's tab, once its row says ended").toBe(1);

  await reloadAndAwaitVerdict(page, dormantReads, sentinelId);
  expect(await terminalTab(page).count(), "the ended sub-agent's tab, after a reload").toBe(1);
  await expect(stripRow(page)).toHaveAttribute("data-state", "ended");
});
