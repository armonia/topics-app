/**
 * A DEV SERVER STARTED WITH A BACKGROUND BASH IS THE CHAT'S SERVER, NOT WORK IN
 * PROGRESS (BGVIS-09).
 *
 * #236 kept a running server apart from work in progress, but only one started
 * with `run_script` or `run_command`. The usual way a Claude Code agent starts
 * a dev server is `Bash` with `run_in_background`, which is a task of the CLI:
 * the chat stayed «in progress» for as long as the server ran.
 *
 * Two chats on a fake CLI that starts its background Bash the way Claude Code
 * does (`helpers/fake-claude-bash-server.ts`: a real shell, child of the CLI,
 * that evals the command): one runs a real HTTP server, the other a job that
 * listens on nothing. The first row carries the server's sign and no ring; the
 * second turns the ring of work in progress. When the server exits, its sign
 * goes. What is faked is the CLI's model and the OS banners.
 */
import { createServer } from "node:net";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
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

test.describe("a dev server started with a background Bash", () => {
  test.describe.configure({ timeout: 120_000 });

  test("the chat that runs it shows the server's sign and is not in progress, the chat whose background Bash listens on nothing is", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "BGVIS-09" });
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bashsrv-")));
    const port = await freePort();
    // Serves `port` (none, given 0) until the test's folder is gone.
    const proc = join(dir, "proc.ts");
    writeFileSync(proc, [
      `import { existsSync } from "node:fs";`,
      `const port = Number(process.argv[2]);`,
      `if (port) Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("BASHSRV-OK") });`,
      `setInterval(() => { if (!existsSync(${JSON.stringify(dir)})) process.exit(0); }, 200);`,
    ].join("\n"));
    const removeCli = installFakeCli(resolve(__dirname, "helpers/fake-claude-bash-server.ts"), {
      BGSRV_LISTEN: `${bunPath()} ${proc} ${port}`,
      BGSRV_BUILD: `${bunPath()} ${proc} 0`,
    });
    const stamp = Date.now();
    const dev = await createTopic(request, `Bash Dev Chat ${stamp}`, { provider: "claude-code" });
    const build = await createTopic(request, `Bash Build Chat ${stamp}`, { provider: "claude-code" });
    try {
      await resetPaneStore(request, [dev.id, build.id]);
      await stubBannersAndWindow(page);
      const frames = recordAttentionFrames(page);
      await goToApp(page);
      const devRow = page.getByRole("treeitem", { name: new RegExp(dev.name) }).first();
      const buildRow = page.getByRole("treeitem", { name: new RegExp(build.name) }).first();
      await expect(devRow).toBeVisible({ timeout: 15_000 });
      await expect(buildRow).toBeVisible({ timeout: 15_000 });

      // Each agent starts its Bash in background and ends its turn.
      await runChatTurn(request, build.id, "bgsrv-build");
      await runChatTurn(request, dev.id, "bgsrv-listen");
      await expect
        .poll(async () => (await request.get(`http://127.0.0.1:${port}/`).then((r) => r.text()).catch(() => "")), { timeout: 20_000, message: "the dev server never answered" })
        .toBe("BASHSRV-OK");

      // The dev server's chat: the server's sign with its address, and no ring.
      const sign = devRow.getByTestId("row-server-sign");
      await expect(sign, "the row has no sign of the server its background Bash runs").toBeVisible({ timeout: 20_000 });
      await expect(sign).toHaveAttribute("title", new RegExp(`127\\.0\\.0\\.1:${port}`));
      await expect(devRow.locator('[data-loader-state="working"]'), "a running server keeps the chat «in progress»").toHaveCount(0, { timeout: 10_000 });
      expect(frames.rows().get(topicSubject(dev.id))?.state, "a running server made the chat «working»").not.toBe("working");

      // The job that listens on nothing: work in progress, and no sign.
      await expectAttention(frames, topicSubject(build.id), { state: "working", lit: false }, "the chat waiting on its job is not «working»");
      await expect(buildRow.locator('[data-loader-state="working"]'), "the job's chat does not say «in progress»").toBeVisible({ timeout: 10_000 });
      await expect(buildRow.getByTestId("row-server-sign")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath("bash-server-sign.png") });

      // The server exits: its sign goes with it.
      rmSync(dir, { recursive: true, force: true });
      await expect(sign, "the sign of a server that exited is still there").toHaveCount(0, { timeout: 15_000 });
      await page.screenshot({ path: test.info().outputPath("bash-server-gone.png") });
    } finally {
      removeCli();
      rmSync(dir, { recursive: true, force: true });
      await deleteTopic(request, dev.id);
      await deleteTopic(request, build.id);
    }
  });
});
