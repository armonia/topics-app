/**
 * THE CARD'S OWN CHECK (25ad016c): a command that is not in package.json,
 * started from a topic, ticks live in the Processes panel, keeps running when
 * the topic's CLI restarts, and at the end the topic receives one message with
 * the exit code and the last lines.
 *
 * On 24/09 a two-hour retry loop started with `Bash(run_in_background)` was
 * invisible in the panel and died with the CLI session: nobody was woken. This
 * spec drives the route `run_command` calls (`POST /api/sessions/:key/commands/run`)
 * exactly as the MCP bridge does, restarts the CLI with a model change (the
 * server drops the idle child to respawn it), and reads the outcome where the
 * person reads it: the panel row, the log pane, the chat's service line.
 *
 * A behaviour in time, so the video is the proof: `video: "on"`.
 *
 * The second case opens the wake where a board card reads the same session:
 * the drawer drew every user row as the person's bubble, and board agents are
 * the ones the prompt sends to `run_command` for their long waits.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goToApp } from "./helpers";
import { createTopic, deleteTask, deleteTopic, patchTopic, seedProjectInnerChats, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { projectIdForPath } from "../../shared/board";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 120_000 });

const TOKEN = process.env.GATEWAY_TOKEN ?? "test-token";
// The card's loop, with 4 s between ticks instead of 20: the same shape (three
// live ticks, a restart between two of them), a third of the wait. Without the
// card's `zsh -c` around it: run_command already runs it in a shell, and the
// CI's Ubuntu runner has no zsh (`/bin/sh` runs it there).
const COMMAND = "for i in 1 2 3; do echo tick $i; sleep 4; done";

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const body = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as { topics: Record<string, { id: string; sessionKey: string }> };
  return Object.values(body.topics).find((t) => t.id === topicId)!.sessionKey;
}

/** A chat turn from outside the page, drained to its end. */
async function chatTurn(sessionKey: string, content: string): Promise<void> {
  const res = await fetch(`${E2E_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gateway-Token": TOKEN },
    body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }] }),
  });
  if (!res.ok || !res.body) throw new Error(`POST /api/chat answered ${res.status}`);
  const reader = res.body.getReader();
  while (!(await reader.read()).done) { /* the turn is still running */ }
}

/** The pid of the topic's CLI: the fake CLI says it when asked (`CLIPID`). */
async function cliPid(request: APIRequestContext, sessionKey: string): Promise<number> {
  await chatTurn(sessionKey, "CLIPID");
  const body = (await (await request.get(`${E2E_BASE}/api/history/${encodeURIComponent(sessionKey)}`)).json()) as { messages?: Array<{ role: string; content?: string }> };
  const said = [...(body.messages ?? [])].reverse().find((m) => m.role === "assistant" && /cli-pid:\d+/.test(m.content ?? ""));
  return Number(/cli-pid:(\d+)/.exec(said?.content ?? "")?.[1] ?? 0);
}

/** How many rows of the session carry the `process-exit` block of this process. */
async function wakeRows(request: APIRequestContext, sessionKey: string, processId: string): Promise<number> {
  const r = await request.get(`${E2E_BASE}/api/history/${encodeURIComponent(sessionKey)}`);
  const body = (await r.json()) as { messages?: Array<{ blocks?: Array<{ kind: string; processId?: string }> }> };
  return (body.messages ?? []).filter((m) => m.blocks?.some((b) => b.kind === "process-exit" && b.processId === processId)).length;
}

/** A live process, a zombie counting as gone. The test server runs on this machine. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)]).toString().trim();
    return stat !== "" && !stat.startsWith("Z");
  } catch {
    return false;
  }
}

test.describe("run_command: a command of the topic, seen, surviving and reporting back", () => {
  let uninstall: () => void = () => {};
  let project = "";
  let topicId = "";
  let sessionKey = "";
  /** The CLI that is up when the command starts: the one restarted under it. */
  let firstCli = 0;
  /** The card bound to the topic by the drawer case, removed at the end. */
  let card: { board: string; id: string } | null = null;

  test.beforeAll(async ({ request }) => {
    uninstall = installSlowTurnCli();
    project = join(tmpdir(), `e2e-run-command-${Date.now()}`);
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    project = realpathSync(project);
    topicId = (await createTopic(request, "Run command", { projectPath: project, provider: "claude-code" })).id;
    sessionKey = await sessionKeyOf(request, topicId);
    // The topic's CLI is up before the command starts: it is the one restarted below.
    firstCli = await cliPid(request, sessionKey);
    expect(firstCli, "the fake CLI said its pid").toBeGreaterThan(0);
  });

  test.afterAll(async ({ request }) => {
    uninstall();
    if (card) await deleteTask(request, card.board, card.id);
    await deleteTopic(request, topicId).catch(() => {});
    if (project) rmSync(project, { recursive: true, force: true });
  });

  test("the ticks are live in the panel, the CLI restarts under it, and the topic is woken with exit 0", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CMDRUN-02" });

    await seedProjectPane(request, project);
    await seedProjectInnerChats(request, project, [topicId]);
    await waitForPaneStoreQuiet(request);
    await goToApp(page);

    const win = page.locator(`[data-testid="project-window"][data-project-path="${project}"]`);
    await expect(win).toHaveCount(1, { timeout: 15_000 });
    const processes = win.locator('[data-testid="project-sidebar-processes"]');
    await expect(processes).toBeVisible({ timeout: 10_000 });
    if ((await processes.getAttribute("aria-expanded")) !== "true") await processes.click();

    // The call `run_command` makes, for a command no manifest declares.
    const started = await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/commands/run`, {
      data: { command: COMMAND },
      ignoreHTTPSErrors: true,
    });
    expect(started.ok(), await started.text()).toBeTruthy();
    const { processId, wake } = (await started.json()) as { processId: string; wake: boolean };
    expect(wake).toBe(true);

    // The row appears without a reload, and its log shows the ticks as they come.
    const row = win.locator(`[data-testid="command-process-row"][data-process-id="${processId}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toHaveAttribute("data-outcome", "running");
    await row.click();
    const log = page.locator('[data-testid="process-log-output"]').last();
    await expect(log).toContainText("tick 1", { timeout: 10_000 });

    // The topic's CLI restarts mid-run: a model change drops the idle child.
    await patchTopic(request, topicId, { model: "claude-sonnet-4-5" });
    // Observed, not assumed: the CLI that was up is gone, and the command is not.
    await expect.poll(() => isAlive(firstCli), { timeout: 10_000, message: "the topic's CLI was dropped" }).toBe(false);
    await expect(row).toHaveAttribute("data-outcome", "running");

    // The command did not notice: the next ticks keep arriving in the same log.
    await expect(log).toContainText("tick 2", { timeout: 15_000 });
    await expect(log).toContainText("tick 3", { timeout: 15_000 });

    // It ends by itself: the row stays, with its outcome.
    await expect(row).toHaveAttribute("data-outcome", "exit:0", { timeout: 20_000 });
    await expect(row.locator('[data-testid="command-outcome"]')).toHaveText("exit 0");

    // And the topic is told, once, as the machine's line and not as the person's bubble.
    const chat = page.locator(`[data-chat-topic-id="${topicId}"]`).first();
    const wakeRow = chat.locator('[data-testid="process-exit-row"]');
    await expect(wakeRow).toHaveCount(1, { timeout: 20_000 });
    await expect(wakeRow).toHaveAttribute("data-exit-code", "0");
    await wakeRow.locator('[data-testid="process-exit-toggle"]').click();
    await expect(wakeRow).toContainText("tick 3");
    await expect(wakeRow).toContainText("exit 0");

    // The server holds exactly one such row for this process.
    await expect.poll(() => wakeRows(request, sessionKey, processId), { timeout: 10_000 }).toBe(1);

    // The topic answers from a NEW CLI: the restart was real. Polled, because
    // the wake's own turn may still hold the session for a moment.
    let secondCli = 0;
    await expect.poll(async () => (secondCli = await cliPid(request, sessionKey).catch(() => 0)), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(secondCli).not.toBe(firstCli);
  });

  test("a card bound to the topic draws the wake as the machine's line, not as the person's bubble", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CMDRUN-04" });
    const marker = `drawer-wake-${Date.now()}`;
    const started = await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/commands/run`, {
      data: { command: `echo ${marker}; exit 0` },
      ignoreHTTPSErrors: true,
    });
    expect(started.ok(), await started.text()).toBeTruthy();
    const { processId } = (await started.json()) as { processId: string };
    // The wake is in the session before the card is bound: the card only reads it.
    await expect.poll(() => wakeRows(request, sessionKey, processId), { timeout: 20_000 }).toBe(1);

    // A card in review on the project's board, bound to the topic the way the
    // dispatcher binds one. Status first: a PATCH clears the binding.
    const board = projectIdForPath(project);
    const text = `Card of the command ${Date.now()}`;
    const created = await request.post(`${E2E_BASE}/api/boards/${board}/tasks`, { data: { text } });
    expect(created.ok(), await created.text()).toBeTruthy();
    card = { board, id: ((await created.json()) as { id: string }).id };
    expect((await request.patch(`${E2E_BASE}/api/boards/${board}/tasks/${card.id}`, { data: { status: "review" } })).ok()).toBeTruthy();
    expect((await request.post(`${E2E_BASE}/api/test/tasks/${card.id}/bind-topic`, { data: { topicId } })).ok()).toBeTruthy();

    await seedProjectPane(request, project);
    await waitForPaneStoreQuiet(request);
    await goToApp(page);
    const win = page.locator(`[data-testid="project-window"][data-project-path="${project}"]`);
    await expect(win).toHaveCount(1, { timeout: 15_000 });

    // The board, from one of the window's + menus.
    const triggers = win.getByTestId("pane-add-menu-trigger");
    const kanban = page.getByTestId("pane-add-menu-kanban");
    let opened = false;
    for (let i = (await triggers.count()) - 1; i >= 0 && !opened; i--) {
      const trigger = triggers.nth(i);
      if (!(await trigger.isVisible().catch(() => false))) continue;
      if (!(await trigger.click({ timeout: 3000 }).then(() => true, () => false))) continue;
      opened = await kanban.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false);
      if (!opened) await page.keyboard.press("Escape");
    }
    expect(opened, "a + menu with the Board entry").toBe(true);
    await kanban.click();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10_000 });

    await page.getByTestId("kanban-column-review").getByText(text).click({ timeout: 15_000 });
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    // The session's wake is one service line, with its outcome, and no bubble says it.
    const session = drawer.getByTestId("task-session-column");
    const line = session.locator('[data-testid="process-exit-row"]', { hasText: marker });
    await expect(line).toHaveCount(1, { timeout: 15_000 });
    await expect(line).toHaveAttribute("data-exit-code", "0");
    await expect(session.locator(".user-bubble", { hasText: "finished: exit" })).toHaveCount(0);
    await line.getByTestId("process-exit-toggle").click();
    await expect(line).toContainText(marker);
    await expect(line).toContainText("exit 0");
  });
});
