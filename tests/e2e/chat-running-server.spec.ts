/**
 * A SERVER THE CHAT STARTED IS SHOWN AS A SERVER, NOT AS WORK THE CHAT WAITS FOR (BGVIS-08).
 *
 * On 01/10 an agent started `python3 -m http.server 8777` with `run_command`
 * and no wake: the chat said "waiting on 1 job in the background" with the
 * grey ring on its tab for as long as the server ran, and `GET /api/processes`
 * for that chat answered `[]` while the chat named the process.
 *
 * Real server turns from a fake CLI (`helpers/fake-claude-service.ts`) that
 * calls `run_command` through the bridge's own code to start a real HTTP
 * server on a free port. With no wake, once its port is up the chat has no
 * waiting line, no ring and no composer Stop, and shows one row "Server ·
 * 127.0.0.1:<port> · name" with Open (a browser tab of the app, on that
 * address), Logs (the process log in the project window) and Stop; the
 * chat's processes list it; Stop ends it, the row says so and goes. A server
 * started WITH a wake is still work the chat waits for.
 */
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, seedProjectInnerChats, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { E2E_HOME } from "./helpers/test-server";

const VERSIONS_DIR = join(E2E_HOME, ".local", "share", "claude", "versions");
/** Sorted above any real version: the server resolves the CLI at every spawn and takes the highest. */
const CLI_ENTRY = join(VERSIONS_DIR, "999.0.5-e2e-service");
// allow-italian: the exact aria-label shipped in i18n-chat-it.ts.
const STOP = 'button[aria-label="Stop streaming"], button[aria-label="Ferma la risposta"]';
const LINE = '[data-testid="background-work-line"]';
const ROW = '[data-testid="running-service-row"]';

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

/** Puts the fake CLI in front of the test server's, and the tiny server it starts in `dir`. */
function installServiceCli(dir: string, cwd: string, port: number, wakePort: number): void {
  // The server spawns the CLI with a trimmed environment: bun by absolute path.
  const bun = execSync("command -v bun").toString().trim();
  mkdirSync(VERSIONS_DIR, { recursive: true });
  // It stops once the test's folder is gone: a failed run never leaves it listening.
  writeFileSync(join(dir, "srv.ts"), [
    `import { existsSync } from "node:fs";`,
    `Bun.serve({ hostname: "127.0.0.1", port: Number(process.argv[2]), fetch: () => new Response("SRVCARD-OK") });`,
    `console.log("SRVCARD-LISTENING");`,
    `setInterval(() => { if (!existsSync(${JSON.stringify(dir)})) process.exit(0); }, 200);`,
  ].join("\n"));
  const script = resolve(__dirname, "helpers/fake-claude-service.ts");
  writeFileSync(CLI_ENTRY, `#!/usr/bin/env bash\nexport SRVCARD_DIR="${dir}"\nexport SRVCARD_CWD="${cwd}"\nexport SRVCARD_PORT="${port}"\nexport SRVCARD_WAKE_PORT="${wakePort}"\nexec "${bun}" "${script}" "$@"\n`);
  chmodSync(CLI_ENTRY, 0o755);
}

/** Every `browser:open-tab` the app dispatches, held before any pane takes it: what Open asked for. */
async function recordOpenTabs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: Array<{ url: string; topicId?: string }> = [];
    (window as unknown as { __openTabs: typeof seen }).__openTabs = seen;
    window.addEventListener("browser:open-tab", (e) => {
      const d = (e as CustomEvent<{ url: string; topicId?: string }>).detail;
      seen.push({ url: d.url, topicId: d.topicId });
      // Claimed here: no browser engine starts in the test, and nothing leaves for the system browser.
      e.preventDefault();
      e.stopImmediatePropagation();
    }, { capture: true });
  });
}

hermetic(test);

test.describe("a server the chat started", () => {
  test.describe.configure({ timeout: 180_000 });

  let dir = "";
  test.afterEach(() => {
    rmSync(CLI_ENTRY, { force: true });
    // The servers stop once their folder is gone: they never outlive the test.
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function openChat(page: Page, chatPage: { messageInput: { waitFor: (o: { state: "visible"; timeout: number }) => Promise<void> } }, request: Parameters<typeof createTopic>[0], label: string) {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "srvcard-")));
    const project = join(dir, "project");
    mkdirSync(project);
    const port = await freePort();
    const wakePort = await freePort();
    installServiceCli(dir, project, port, wakePort);
    const topic = await createTopic(request, `${label}-${Date.now()}`, { projectPath: project, provider: "claude-code" });
    // Only this test's project window: the one an earlier test seeded points at a folder now gone.
    await resetPaneStore(request, []);
    await seedProjectPane(request, project);
    await seedProjectInnerChats(request, project, [topic.id]);
    await waitForPaneStoreQuiet(request);
    await recordOpenTabs(page);
    await goToApp(page);
    const win = page.locator(`[data-testid="project-window"][data-project-path="${project}"]`);
    await expect(win).toHaveCount(1, { timeout: 15_000 });
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    return { topic, win, port, wakePort };
  }

  test("is one row with its address, Open, Logs and Stop, the chat is not waiting on it, and its processes list it", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "BGVIS-08" });
    const { topic, win, port } = await openChat(page, chatPage, request, "srvcard");
    try {
      await chatPage.sendMessage("srvcard-start");
      await expect(page.getByText("SRV-STARTED").first()).toBeVisible({ timeout: 30_000 });

      // The server answers on its port, and the chat is not waiting on it: no
      // waiting line (a push re-reads the status once its port is seen).
      await expect.poll(async () => (await request.get(`http://127.0.0.1:${port}/`).then((r) => r.text()).catch(() => "")), { timeout: 10_000 }).toBe("SRVCARD-OK");
      await expect(page.locator(LINE)).toHaveCount(0, { timeout: 10_000 });
      // One row: "Server · 127.0.0.1:<port> · name".
      const row = page.locator(ROW);
      await expect(row).toHaveCount(1, { timeout: 5_000 });
      await expect(row).toHaveAttribute("data-state", "running");
      await expect(row.getByTestId("running-service-address")).toHaveText(`127.0.0.1:${port}`);
      await expect(row.getByTestId("running-service-name")).toHaveText("SRVCARD-SERVER");
      // No ring on its tab, no composer Stop.
      const tab = win.locator(`[role="tab"][data-pane-id="chat:${topic.id}"]`);
      await expect(tab.locator('[data-loader-state="background"]')).toHaveCount(0);
      await expect(page.locator(STOP)).toHaveCount(0);

      // The chat's processes list what the chat shows.
      const processId = await row.getAttribute("data-process-id");
      expect(processId).toBeTruthy();
      const listed = await (await request.get(`/api/processes?topicId=${encodeURIComponent(topic.id)}`)).json() as Array<{ processId?: string; status?: string; ports?: number[] }>;
      expect(listed.find((p) => p.processId === processId)).toMatchObject({ status: "running", ports: [port] });

      // Open asks for a browser tab of the app on that address, for this chat.
      await row.getByTestId("running-service-open").click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __openTabs: unknown[] }).__openTabs), { timeout: 5_000 })
        .toEqual([{ url: `http://127.0.0.1:${port}/`, topicId: topic.id }]);

      // Logs opens the process log in the chat's project window.
      await row.getByTestId("running-service-logs").click();
      await expect(win.locator(`[role="tab"][data-pane-id="process-log:${processId}"]`)).toHaveCount(1, { timeout: 10_000 });
      await expect(win.locator('[data-testid="process-log-output"]').last()).toContainText("SRVCARD-LISTENING", { timeout: 10_000 });
      await tab.click();

      // Stop: the row says the server stopped, then goes; no waiting line ever came.
      await page.locator(ROW).getByTestId("running-service-stop").click();
      await expect(page.locator(ROW)).toHaveAttribute("data-state", "ended", { timeout: 10_000 });
      await expect(page.locator(ROW).getByTestId("running-service-ended")).toHaveText(/^(Server stopped|Server fermato)$/);
      await expect(page.locator(ROW)).toHaveCount(0, { timeout: 10_000 });
      await expect(page.locator(LINE)).toHaveCount(0);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("started with a wake, it is still work the chat waits for", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "BGVIS-08" });
    const { topic, wakePort } = await openChat(page, chatPage, request, "srvwake");
    try {
      await chatPage.sendMessage("srvcard-wake");
      await expect(page.getByText("WAKE-STARTED").first()).toBeVisible({ timeout: 30_000 });
      const command = page.locator(LINE).locator('[data-testid="background-work-task"][data-type="command"]');
      await expect(command).toContainText("SRVCARD-WAKE", { timeout: 15_000 });
      // Its port is up, and the chat still waits on it: a line, no server row.
      await expect.poll(async () => (await request.get(`http://127.0.0.1:${wakePort}/`).then((r) => r.text()).catch(() => "")), { timeout: 10_000 }).toBe("SRVCARD-OK");
      await expect(command.getByTestId("background-work-wakes")).toHaveCount(1);
      await expect(page.locator(ROW)).toHaveCount(0);
      // Stopped from its panel, it wakes nobody.
      const processId = await command.getAttribute("data-process-id");
      expect((await request.post(`/api/scripts/${processId}/stop`)).ok()).toBe(true);
      await expect(page.locator(LINE)).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
