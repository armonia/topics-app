/**
 * A CHAT WITH NO TURN OPEN SAYS WHAT IT WAITS FOR, AND WRITES ONLY WHEN IT WRITES
 * (BGVIS-10).
 *
 * Before, the tab and the sidebar row of a chat whose turn had ended drew the
 * same ring as a chat that is writing when a `run_command` or a CLI task was
 * still running, and drew NOTHING when the thing still running was a
 * `spawn_agent` child (the chat's task map did not know children at all, and a
 * child that ended minutes later changed nothing on screen).
 *
 * Real pieces, no injected frames:
 *   - the chat's turns come from a fake CLI (`fake-claude-background-job.ts`):
 *     one launches a background Bash and ends, one stays open until released;
 *   - the sub-agent is spawned and stopped through the routes the MCP
 *     `spawn_agent` / `stop_agent` tools call (a PTY child that runs the test
 *     server's `claude` stub, no model is reached).
 *
 * Three moments, recorded on video:
 *   a) the turn is over, a job and a child are alive: the tab says it waits
 *      (`data-waiting-on`), it is not a ring of a chat that writes;
 *   b) the chat is woken by a message and writes: the glyph is the writing
 *      one (no `data-waiting-on`), and the wait returns when the turn closes;
 *   c) job and child are over: nothing hangs on the tab or the row.
 *
 * @covers BGVIS-10
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteAllTerminalSessions, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { runChatTurn, sessionKeyOf } from "./helpers/attention";
import { installFakeCli } from "./helpers/fake-claude-cli";
import { E2E_BASE, daemonAuthHeaders } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });

/** Says on the video which of the three moments is on screen. */
async function caption(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    let el = document.querySelector<HTMLElement>("[data-testid='e2e-caption']");
    if (!el) {
      el = document.createElement("div");
      el.setAttribute("data-testid", "e2e-caption");
      el.style.cssText = "position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:2147483647;padding:8px 14px;border-radius:10px;background:#111;color:#fff;font:600 14px -apple-system,system-ui,sans-serif;pointer-events:none";
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

async function spawnChild(request: APIRequestContext, sessionKey: string): Promise<string> {
  const spawned = await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/agents/spawn`, {
    headers: daemonAuthHeaders(),
    data: { prompt: "wait for instructions", name: `tab-wait-${Date.now()}`, cwd: "/tmp", runtime: "claude-code" },
  });
  expect(spawned.ok(), `spawn refused: ${spawned.status()} ${await spawned.text()}`).toBe(true);
  return ((await spawned.json()) as { agentId: string }).agentId;
}

async function stopChild(request: APIRequestContext, sessionKey: string, id: string): Promise<void> {
  await request.post(`${E2E_BASE}/api/sessions/${encodeURIComponent(sessionKey)}/agents/${id}/stop`, { headers: daemonAuthHeaders() });
}

test.describe("the tab of a chat with no turn open says what it waits for", () => {
  test.describe.configure({ timeout: 150_000 });

  test("a) waits on a job and a sub-agent, b) writes only while a turn is open, c) nothing hangs when all is over", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "BGVIS-10" });
    const dir = mkdtempSync(join(tmpdir(), "tab-wait-"));
    const removeCli = installFakeCli(resolve(__dirname, "helpers/fake-claude-background-job.ts"), { BGKEEP_DIR: dir });
    await deleteAllTerminalSessions(request);
    const chat = await createTopic(request, `Tab Wait ${Date.now()}`, { provider: "claude-code" });
    let childId = "";
    let sessionKey = "";
    try {
      await patchTopic(request, chat.id, { provider: "claude-code" });
      sessionKey = await sessionKeyOf(request, chat.id);
      await resetPaneStore(request, [chat.id]);
      await goToApp(page);
      const row = page.getByRole("treeitem", { name: new RegExp(chat.name) }).first();
      const tab = page.locator('[role="tab"][data-pane-id]', { hasText: chat.name });
      await expect(row).toBeVisible({ timeout: 15_000 });
      const waitingOn = (kind: string) => `[data-waiting-on="${kind}"]`;

      // a) The turn launches a background job and ends: the tab waits for a job, it does not "write".
      await caption(page, "a) turno finito, lavoro in background vivo");
      await runChatTurn(request, chat.id, "bgkeep-start");
      await expect(tab.locator(waitingOn("job")), "the tab does not say it waits for the job").toBeVisible({ timeout: 20_000 });
      await expect(row.locator(waitingOn("job")), "the row does not say it waits for the job").toBeVisible({ timeout: 10_000 });

      // A sub-agent starts: what the chat waits for first is the child.
      childId = await spawnChild(request, sessionKey);
      await caption(page, "a) + un sottoagente vivo: aspetta il sottoagente");
      await expect(tab.locator(waitingOn("subagent")), "the tab does not say it waits for the sub-agent").toBeVisible({ timeout: 20_000 });
      await expect(row.locator(waitingOn("subagent"))).toBeVisible({ timeout: 10_000 });
      await page.screenshot({ path: test.info().outputPath("a-waiting.png") });

      // b) A message wakes the chat: while the turn is open the glyph is the writing one, with no wait on it.
      await caption(page, "b) la chat viene svegliata: scrive davvero");
      const hold = runChatTurn(request, chat.id, "bgkeep-hold");
      await expect(page.getByText("HOLDING").first()).toBeVisible({ timeout: 30_000 });
      await expect(tab.locator('[data-loader-state="working"]'), "the tab does not show the chat writing").toBeVisible({ timeout: 10_000 });
      await expect(tab.locator("[data-waiting-on]"), "a chat that writes is drawn as waiting").toHaveCount(0);
      await expect(row.locator("[data-waiting-on]")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath("b-writing.png") });
      writeFileSync(join(dir, "release"), "");
      await hold;
      await expect(page.getByText("HOLD-DONE").first()).toBeVisible({ timeout: 30_000 });
      // The turn is over again, the child and the job are still there: the wait is back.
      await caption(page, "b) turno chiuso: torna ad aspettare");
      await expect(tab.locator(waitingOn("subagent"))).toBeVisible({ timeout: 20_000 });

      // The job reports and the CLI answers; only the child is left.
      writeFileSync(join(dir, "end-job"), "");
      await expect(page.getByText("BG-JOB-REPORTED").first()).toBeVisible({ timeout: 30_000 });
      await expect(tab.locator(waitingOn("subagent"))).toBeVisible({ timeout: 20_000 });

      // c) The child ends: nothing hangs on the tab or the row.
      await caption(page, "c) tutto finito: nessuno stato appeso");
      await stopChild(request, sessionKey, childId);
      childId = "";
      await expect(tab.locator("[data-waiting-on]"), "the tab still waits after everything ended").toHaveCount(0, { timeout: 30_000 });
      await expect(tab.locator("[data-loader-state]")).toHaveCount(0);
      await expect(row.locator("[data-waiting-on]")).toHaveCount(0);
      await expect(row.locator("[data-loader-state]")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath("c-over.png") });
      await caption(page, "c) tutto finito: nessuno stato appeso (ancora)");
      await expect(tab.locator("[data-loader-state]")).toHaveCount(0);
    } finally {
      if (childId) await stopChild(request, sessionKey, childId).catch(() => {});
      removeCli();
      rmSync(dir, { recursive: true, force: true });
      await deleteTopic(request, chat.id).catch(() => {});
      await deleteAllTerminalSessions(request).catch(() => {});
      const out = process.env.TAB_STATE_VIDEO_DIR;
      const video = page.video();
      await page.close().catch(() => {});
      if (out && video) {
        mkdirSync(out, { recursive: true });
        await video.saveAs(join(out, "tab-stato-attesa.webm")).catch(() => {});
      }
    }
  });
});
