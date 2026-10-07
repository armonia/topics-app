/**
 * THE STRIP UNDER A CHAT SHOWS WHAT WORKS NOW (chat-live-work).
 *
 * On 07/10 the Prince of Persia chat had three sub-agents ended hours before
 * in its strip, and nothing of what was working: Muse, a `run_command` that
 * wrote everything to a file (its log said «Waiting for output...» for 58
 * minutes), and a local server for the clips.
 *
 * Real pieces only. The sub-agent is spawned through the route the MCP
 * `spawn_agent` tool calls, as a claude-code PTY running the test server's
 * `claude` stub (scripts/start-test-server.sh): a tripwire stops the test if
 * the PTY resolved any other binary. The commands start through the route
 * `run_command` calls. The ended sub-agents are rows of the test server's own
 * `subagents` table.
 *
 * @covers SUBSTRIP-01 CMDRUN-03
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, seedProjectInnerChats, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE, E2E_DATA_DIR } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
// A real PTY and real processes; scenario 1 waits up to 70 s for an ended row to leave.
test.describe.configure({ timeout: 180_000 });

const STAMP = Date.now();
const TOKEN = { "x-gateway-token": process.env.GATEWAY_TOKEN ?? "test-token" };
const enc = encodeURIComponent;

let project = "";
let topicId = "";
let sessionKey = "";
const processes: string[] = [];
const agents: string[] = [];

test.afterEach(async ({ request }) => {
  for (const id of processes.splice(0)) await request.post(`${E2E_BASE}/api/scripts/${id}/stop`).catch(() => {});
  for (const id of agents.splice(0)) await request.post(`${E2E_BASE}/api/sessions/${enc(sessionKey)}/agents/${id}/stop`, { headers: TOKEN }).catch(() => {});
  if (topicId) await deleteTopic(request, topicId).catch(() => {});
  if (project) removeTmpDir(project);
  topicId = sessionKey = project = "";
});

/** A chat bound to a scratch project: `run_command` runs in the chat's project. */
async function chatWithProject(request: APIRequestContext, label: string): Promise<void> {
  project = canonicalTmpDir(`e2e-live-work-${label}`);
  mkdirSync(project, { recursive: true });
  topicId = (await createTopic(request, `E2E live work ${label} ${STAMP}`, { projectPath: project })).id;
  const { topics } = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as { topics: Record<string, { sessionKey: string }> };
  sessionKey = topics[topicId]?.sessionKey ?? "";
  if (!sessionKey) throw new Error(`topic ${topicId} has no sessionKey`);
}

/** The chat open in its project window, as the person has it. */
async function openChat(page: Page, request: APIRequestContext): Promise<void> {
  await resetPaneStore(request, []);
  await seedProjectPane(request, project);
  await seedProjectInnerChats(request, project, [topicId]);
  await waitForPaneStoreQuiet(request);
  await goToApp(page);
  await expect(page.locator(`[data-testid="project-window"][data-project-path="${project}"]`)).toHaveCount(1, { timeout: 20_000 });
}

/** `run_command` from the chat's session, as the MCP tool calls it. */
async function runCommand(request: APIRequestContext, command: string, description: string, wake = false): Promise<string> {
  const res = await request.post(`${E2E_BASE}/api/sessions/${enc(sessionKey)}/commands/run`, { data: { command, description, wake } });
  expect(res.ok(), `run refused: ${res.status()} ${await res.text()}`).toBe(true);
  const { processId } = (await res.json()) as { processId: string };
  processes.push(processId);
  return processId;
}

/** Spawn a sub-agent of the chat through the route `spawn_agent` calls, and check it runs the stub. */
async function spawnSubAgent(request: APIRequestContext, name: string): Promise<string> {
  const spawned = await request.post(`${E2E_BASE}/api/sessions/${enc(sessionKey)}/agents/spawn`, {
    headers: TOKEN,
    data: { prompt: "wait for instructions", name, cwd: "/tmp" },
  });
  expect(spawned.ok(), `spawn refused: ${spawned.status()} ${await spawned.text()}`).toBe(true);
  const id = ((await spawned.json()) as { agentId: string }).agentId;
  agents.push(id);
  // TRIPWIRE: the PTY must run the stub inside the isolated HOME. A `claude`
  // found on PATH would be the real CLI, and the prompt would reach a paid
  // model: stop it at once and fail loudly instead.
  const roster = (await (await request.get(`${E2E_BASE}/api/terminal/sessions`)).json()) as Array<{ id: string; claudeSessionId: string | null }>;
  const child = roster.find((s) => s.id === id);
  await expect.poll(() => cliCommandsFor(child?.claudeSessionId), { timeout: 15_000 }).not.toEqual([]).catch(() => {});
  const launched = cliCommandsFor(child?.claudeSessionId);
  if (!child || launched.length === 0 || !launched.every((c) => c.includes("/.home/.local/bin/claude"))) {
    await request.post(`${E2E_BASE}/api/sessions/${enc(sessionKey)}/agents/${id}/stop`, { headers: TOKEN });
    throw new Error(`the sub-agent did not run the e2e stub: ${JSON.stringify(launched)}`);
  }
  return id;
}

function cliCommandsFor(claudeSessionId: string | null | undefined): string[] {
  if (!claudeSessionId) return [];
  return execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(`--session-id ${claudeSessionId}`) && !line.includes("ps -axww"));
}

/** Children of this chat that ended hours ago, in the server's own table: two native, one CLI. */
function seedEndedSubAgents(): void {
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const rows = [["topics", 3], ["topics", 5], ["claude-code", 4]] as const;
  const sql = rows.map(([runtime, h], i) =>
    `INSERT INTO subagents (id, parent_session_key, name, cwd, state, turns_reported, reported_at, created_at, ended_at, runtime)
       VALUES ('e2e-ended-${STAMP}-${i}', '${sessionKey}', 'ended ${i}', '/tmp', 'retired', 1, '${ago(h)}', '${ago(h + 1)}', '${ago(h)}', '${runtime}');`).join("\n");
  execFileSync("sqlite3", [join(E2E_DATA_DIR, "topics.db"), sql]);
}

/** A port nobody listens on right now. */
async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => done(port));
    });
  });
}

const strip = (page: Page) => page.getByTestId("subagents-strip");
const tickOf = (text: string | null) => Number(text?.match(/tick (\d+)/)?.[1] ?? 0);

test("only what works now: the working sub-agent and the command, and an ended sub-agent leaves within 70 s", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "SUBSTRIP-01" });
  await chatWithProject(request, "now");
  seedEndedSubAgents();
  const agentId = await spawnSubAgent(request, `E2E worker ${STAMP}`);
  const tick = await runCommand(request, 'for i in $(seq 1 600); do echo "tick $i"; sleep 1; done', "tick every second");
  await openChat(page, request);

  // Two rows, the sub-agent and the command; none of the three ended hours ago.
  const agentRow = strip(page).locator(`[data-testid="subagent-row"][data-subagent-id="${agentId}"]`);
  const commandRow = strip(page).locator(`[data-testid="live-command-row"][data-process-id="${tick}"]`);
  await expect(agentRow).toHaveCount(1, { timeout: 20_000 });
  await expect(commandRow).toHaveCount(1, { timeout: 20_000 });
  await expect(strip(page).locator('[data-testid="subagent-row"], [data-testid="live-command-row"]')).toHaveCount(2);
  await expect(strip(page).locator('[data-state="ended"]')).toHaveCount(0);
  expect(["working", "waiting"]).toContain(await agentRow.getAttribute("data-state"));

  // The command's line moves: a newer «tick N» within 3 s.
  const preview = commandRow.getByTestId("live-work-preview");
  await expect(preview).toHaveText(/tick \d+/, { timeout: 10_000 });
  const seen = tickOf(await preview.textContent());
  await expect.poll(async () => tickOf(await preview.textContent()), { timeout: 3_000, intervals: [200] }).toBeGreaterThan(seen);

  // The sub-agent finishes (its parent stops it): its row stays with the
  // check, then leaves within 70 s of the end.
  await request.post(`${E2E_BASE}/api/sessions/${enc(sessionKey)}/agents/${agentId}/stop`, { headers: TOKEN });
  const endedAt = Date.now();
  await expect(agentRow).toHaveAttribute("data-state", "ended", { timeout: 15_000 });
  await expect(agentRow.locator("svg").first()).toBeVisible();
  await expect(agentRow).toHaveCount(0, { timeout: 70_000 - (Date.now() - endedAt) });
  expect(Date.now() - endedAt).toBeLessThanOrEqual(70_000);
  await expect(commandRow).toHaveCount(1);
});

test("the output a command redirects to a file shows in its log", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "CMDRUN-03" });
  await chatWithProject(request, "redirect");
  const file = `/tmp/topics-e2e-${STAMP}.log`;
  const id = await runCommand(request, `for i in $(seq 1 30); do echo "tick $i"; sleep 1; done > ${file}`, "ticks to a file");
  await openChat(page, request);

  const row = strip(page).locator(`[data-testid="live-command-row"][data-process-id="${id}"]`);
  await expect(row.getByTestId("live-work-preview")).toHaveText(/tick \d+/, { timeout: 15_000 });

  // Everything the log shows from the click on, to prove it never sat empty.
  const log = page.getByTestId("process-log-output");
  await row.getByRole("button").first().click();
  const clickedAt = Date.now();
  await expect(log).toBeVisible({ timeout: 5_000 });
  await log.evaluate((el) => {
    const texts: string[] = [el.textContent ?? ""];
    (window as unknown as { __logTexts: string[] }).__logTexts = texts;
    new MutationObserver(() => texts.push(el.textContent ?? "")).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await expect(log).toContainText("tick 1", { timeout: 3_000 - (Date.now() - clickedAt) });
  const first = tickOf((await log.textContent())?.match(/tick \d+(?![\s\S]*tick \d+)/)?.[0] ?? null);
  // And the lines after it, as they are written.
  await expect.poll(async () => tickOf((await log.textContent())?.match(/tick \d+(?![\s\S]*tick \d+)/)?.[0] ?? null), { timeout: 5_000 }).toBeGreaterThan(first);
  const texts = await page.evaluate(() => (window as unknown as { __logTexts: string[] }).__logTexts);
  expect(texts.filter((t) => /Waiting for output|Nessun output ancora|No output yet/.test(t))).toEqual([]);
});

test("a local server shows its port, and Open goes to its address", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "SUBSTRIP-01" });
  await chatWithProject(request, "server");
  const port = await freePort();
  const id = await runCommand(request, `python3 -m http.server ${port} --bind 127.0.0.1`, "clips server");
  // Every `browser:open-tab` the app dispatches, claimed before a pane takes it.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __openTabs: string[] }).__openTabs = seen;
    window.addEventListener("browser:open-tab", (e) => {
      seen.push((e as CustomEvent<{ url: string }>).detail.url);
      e.preventDefault();
      e.stopImmediatePropagation();
    }, { capture: true });
  });
  await openChat(page, request);

  const row = strip(page).locator(`[data-testid="live-command-row"][data-process-id="${id}"]`);
  await expect(row.getByTestId("live-work-address")).toHaveText(`127.0.0.1:${port}`, { timeout: 20_000 });
  await row.getByTestId("live-work-open").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __openTabs: string[] }).__openTabs), { timeout: 5_000 })
    .toEqual([`http://127.0.0.1:${port}/`]);
});
