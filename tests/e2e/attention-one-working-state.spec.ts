/**
 * A JOB THE CHAT WAITS FOR IS WORK IN PROGRESS; A SERVER IS THE ONE STATE APART
 * (notifications-redesign, modified 2026-10-04: ATTN-01, ATTN-02, ATTN-12,
 * BGVIS-01, BGVIS-08).
 *
 * Attention, 04/10: «we should make uniform the state of a topic waiting for a
 * job to finish, because it should read as in progress too. At most we should
 * keep a state if, for instance, a server is running».
 *
 * Before: a chat whose turn left a background job running had a state of its
 * own (`background`), a grey slow ring on its sidebar row and tab, a section of
 * its own in the inbox and in the agents' menu. Now it is `working`, as a turn:
 * the same ring, the same «at work» count, and «finished» only when the job
 * returns. A dev server the agent started with `run_script` is not work: the
 * row carries the server's sign, no ring, and nothing counts it.
 *
 * Real server turns throughout, from fake CLIs that do what Claude Code does:
 * `helpers/fake-claude-background-job.ts` launches a background Bash and ends
 * its turn, `helpers/fake-claude-service.ts` runs the project's `serve` script
 * through the bridge's own `run_script` code. What is faked is the OS banner
 * and the window being behind another app.
 */
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, seedProjectInnerChats, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { expectAttention, recordAttentionFrames, runChatTurn, stubBannersAndWindow } from "./helpers/attention";
import { bunPath, installFakeCli } from "./helpers/fake-claude-cli";
import { topicSubject } from "../../shared/attention";

hermetic(test);

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

test.describe("one state for work in progress, a sign apart for a server", () => {
  test.describe.configure({ timeout: 120_000 });

  test("a chat waiting on its background job is «in progress» on its row, its tab and the inbox, and «finished» when the job returns", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-12" }, { type: "spec", description: "ATTN-01" }, { type: "spec", description: "BGVIS-01" });
    const dir = mkdtempSync(join(tmpdir(), "one-state-"));
    const removeCli = installFakeCli(resolve(__dirname, "helpers/fake-claude-background-job.ts"), { BGKEEP_DIR: dir });
    const chat = await createTopic(request, `Job Chat ${Date.now()}`, { provider: "claude-code" });
    const subject = topicSubject(chat.id);
    try {
      await resetPaneStore(request, [chat.id]);
      await stubBannersAndWindow(page);
      const frames = recordAttentionFrames(page);
      await goToApp(page);
      const row = page.getByRole("treeitem", { name: new RegExp(chat.name) }).first();
      const tab = page.locator('[role="tab"][data-pane-id]', { hasText: chat.name });
      await expect(row).toBeVisible({ timeout: 15_000 });

      // The turn launches a background Bash and ends: the chat is at work.
      await runChatTurn(request, chat.id, "bgkeep-start");
      await expect(page.getByTestId("background-work-line")).toContainText("BGKEEP-JOB", { timeout: 20_000 });
      await expectAttention(frames, subject, { state: "working", lit: false }, "the chat waiting on its job is not «working»");
      // The row and the tab draw the ring of work in progress, the one a turn draws.
      await expect(row.locator('[data-loader-state="working"]'), "the sidebar row does not say «in progress»").toBeVisible({ timeout: 10_000 });
      await expect(tab.locator('[data-loader-state="working"]'), "the tab does not say «in progress»").toBeVisible({ timeout: 10_000 });
      await expect(row).not.toHaveAttribute("data-attention", /.+/);
      // The inbox counts it among the ones at work, and lights nothing.
      await expect(page.getByTestId("inbox-count")).toHaveCount(0);
      await page.getByTestId("inbox-button").click();
      await expect(page.getByTestId("inbox-quiet")).toHaveAttribute("data-working", "1");
      await page.keyboard.press("Escape");
      await page.screenshot({ path: test.info().outputPath("job-in-progress.png") });

      // The job returns: the CLI wakes, answers, and the chat has finished.
      writeFileSync(join(dir, "end-job"), "");
      await expect(page.getByText("BG-JOB-REPORTED").first()).toBeVisible({ timeout: 30_000 });
      await expectAttention(frames, subject, { state: "finished", outcome: "done", lit: true }, "the end of the job did not finish the chat");
      await expect(row).toHaveAttribute("data-attention", "done", { timeout: 10_000 });
      await expect(row.locator("[data-loader-state]")).toHaveCount(0);
      await expect(tab.locator("[data-loader-state]")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath("job-finished.png") });
    } finally {
      removeCli();
      rmSync(dir, { recursive: true, force: true });
      await deleteTopic(request, chat.id);
    }
  });

  test("a chat whose agent started a dev server with run_script shows the server's sign, and is not in progress", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "BGVIS-08" }, { type: "spec", description: "ATTN-01" });
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "devsrv-")));
    const project = join(dir, `devsrv-${Date.now()}`);
    mkdirSync(project);
    const port = await freePort();
    // The server stops by itself once the test's folder is gone.
    writeFileSync(join(dir, "srv.ts"), [
      `import { existsSync } from "node:fs";`,
      `Bun.serve({ hostname: "127.0.0.1", port: Number(process.argv[2]), fetch: () => new Response("DEVSRV-OK") });`,
      `setInterval(() => { if (!existsSync(${JSON.stringify(dir)})) process.exit(0); }, 200);`,
    ].join("\n"));
    // The manifest `run_script` reads: a Bun project with a `serve` script.
    writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: { serve: `'${bunPath()}' '${join(dir, "srv.ts")}' ${port}` } }));
    writeFileSync(join(project, "bun.lock"), "");
    const removeCli = installFakeCli(resolve(__dirname, "helpers/fake-claude-service.ts"), { SRVCARD_DIR: dir, SRVCARD_CWD: project });
    const chat = await createTopic(request, `Dev Server Chat ${Date.now()}`, { projectPath: project, provider: "claude-code" });
    const subject = topicSubject(chat.id);
    try {
      // The chat open in its project window: its folder in the sidebar is open on its row.
      await resetPaneStore(request, []);
      await seedProjectPane(request, project);
      await seedProjectInnerChats(request, project, [chat.id]);
      await waitForPaneStoreQuiet(request);
      await stubBannersAndWindow(page);
      const frames = recordAttentionFrames(page);
      await goToApp(page);
      const row = page.getByRole("treeitem", { name: new RegExp(chat.name) }).first();
      await expect(row).toBeVisible({ timeout: 10_000 });

      await runChatTurn(request, chat.id, "srvcard-script");
      await expect
        .poll(async () => (await request.get(`http://127.0.0.1:${port}/`).then((r) => r.text()).catch(() => "")), { timeout: 20_000, message: "the dev server never answered" })
        .toBe("DEVSRV-OK");
      // The server's sign, with its address, and no ring: nothing is in progress.
      const sign = row.getByTestId("row-server-sign");
      await expect(sign, "the row has no sign of the running server").toBeVisible({ timeout: 20_000 });
      await expect(sign).toHaveAttribute("title", new RegExp(`127\\.0\\.0\\.1:${port}`));
      await expect(row.locator("[data-loader-state]")).toHaveCount(0);
      expect(frames.rows().get(subject)?.state, "a running server made the chat «working»").not.toBe("working");
      await expect(page.getByTestId("inbox-button")).toBeVisible();
      await page.getByTestId("inbox-button").click();
      await expect(page.getByTestId("inbox-quiet")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.screenshot({ path: test.info().outputPath("dev-server-sign.png") });

      // The server goes: its sign goes with it.
      rmSync(dir, { recursive: true, force: true });
      await expect(sign).toHaveCount(0, { timeout: 30_000 });
    } finally {
      removeCli();
      rmSync(dir, { recursive: true, force: true });
      await deleteTopic(request, chat.id);
    }
  });
});
