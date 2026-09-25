/**
 * A turn silent in a tool keeps its Stop in every window that watches it.
 *
 * On 2026-09-25 (topic:3019832f) a live turn dropped out of the server's
 * streaming registry after three minutes without a provider event, which is
 * what a tool that prints nothing looks like. Every window but the sender's
 * reconciles against that registry: two misses and the chat was "finished",
 * the Stop gone, the queue drained, while the turn ran for twenty more
 * minutes. Nothing lit it again.
 *
 * The turn here is a real server turn, from a fake CLI whose Bash prints
 * nothing for 50 s, sent through the API the way a coordinator or a second
 * window sends it: the page is only a viewer. The sweep's silence threshold is
 * cut to 1 s (`/api/test/stale-stream-clock`) so its real 30 s tick acts during
 * the test, and asks the child, which is alive. On a checkout where
 * `isStreaming` still had a clock, the same cut hid the turn 29 s out of 30.
 *
 * @covers CHAT-REL-05
 */
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";

const SILENT_S = 50;
const VERSIONS_DIR = join(E2E_HOME, ".local", "share", "claude", "versions");
/** Sorted above any real version: the server resolves the CLI at every spawn and takes the highest. */
const CLI_ENTRY = join(VERSIONS_DIR, "999.0.1-e2e-silent-tool");

/** Puts the fake CLI in front of the test server's, from the next spawn on. */
function installSilentToolCli(): void {
  // The server spawns the CLI with a trimmed environment: bun by absolute path.
  const bun = execSync("command -v bun").toString().trim();
  mkdirSync(VERSIONS_DIR, { recursive: true });
  writeFileSync(CLI_ENTRY, `#!/usr/bin/env bash\nexec "${bun}" "${resolve(__dirname, "helpers/fake-claude-silent-tool.ts")}" "$@"\n`);
  chmodSync(CLI_ENTRY, 0o755);
}

hermetic(test);

test.describe("a turn silent in a tool for longer than the stale threshold", () => {
  test.describe.configure({ timeout: 180_000 });
  // The app's service worker has a fetch handler: a page it controls sends
  // `/api/chat` through it, where `page.route` never sees the request.
  test.use({ serviceWorkers: "block" });

  test("the viewer keeps the Stop through the silence, and loses it only when the turn ends", async ({ page, request, chatPage }) => {
    installSilentToolCli();
    const topic = await createTopic(request, `silent-tool-${Date.now()}`);

    try {
      expect((await request.post(`${E2E_BASE}/api/test/stale-stream-clock`, { data: { timeoutMs: 1_000 } })).ok()).toBe(true);
      await patchTopic(request, topic.id, { provider: "claude-code" });
      const sessionKey = (await (await request.get(`${E2E_BASE}/api/topics/${topic.id}`)).json()).topic.sessionKey as string;

      await resetPaneStore(request, [topic.id]);
      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(topic.name));
      await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

      // Sent from outside this page: its own SSE would keep it lit whatever the registry said.
      const turn = request.post(`${E2E_BASE}/api/chat`, {
        data: { sessionKey, messages: [{ role: "user", content: `silent ${SILENT_S}` }] },
        timeout: 150_000,
      });

      // allow-italian: the exact aria-label shipped in i18n-chat-it.ts.
      const stop = page.getByRole("button", { name: /Stop streaming|Ferma la risposta/ }).first();
      await expect(page.getByText("Starting a silent tool.").first()).toBeVisible({ timeout: 30_000 });
      await expect(stop).toBeVisible({ timeout: 10_000 });

      // Watched in the page every 250 ms, well past the threshold and two
      // registry polls: the second the Stop went away, or null if it never did.
      const goneAt = await page.evaluate(async (watchMs) => {
        const start = performance.now();
        while (performance.now() - start < watchMs) {
          // allow-italian: the same aria-label as above.
          if (!document.querySelector('button[aria-label="Stop streaming"], button[aria-label="Ferma la risposta"]')) {
            return Math.round((performance.now() - start) / 1000);
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        return null;
      }, (SILENT_S - 8) * 1000);
      expect(goneAt, `the Stop went away ${goneAt} s into a silent tool`).toBeNull();

      // The gate reads the same registry: a second turn waits for this one.
      const second = await request.post(`${E2E_BASE}/api/chat`, {
        data: { sessionKey, messages: [{ role: "user", content: "a second turn" }] },
      });
      expect(second.status()).toBe(409);

      await expect(page.getByText("SILENT-TOOL-DONE").first()).toBeVisible({ timeout: 40_000 });
      await expect(stop).toBeHidden({ timeout: 15_000 });
      expect((await turn).ok()).toBe(true);
    } finally {
      await request.post(`${E2E_BASE}/api/test/stale-stream-clock`, { data: {} }).catch(() => {});
      rmSync(CLI_ENTRY, { force: true });
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("the sender whose reply was cut short without [DONE] keeps the Stop while the server runs the turn", async ({ page, request, chatPage }) => {
    installSilentToolCli();
    const topic = await createTopic(request, `silent-cut-${Date.now()}`);
    let turn: ReturnType<typeof request.post> | null = null;

    try {
      await patchTopic(request, topic.id, { provider: "claude-code" });
      const sessionKey = (await (await request.get(`${E2E_BASE}/api/topics/${topic.id}`)).json()).topic.sessionKey as string;
      await resetPaneStore(request, [topic.id]);
      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(topic.name));
      await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

      // The network, not the app: the page's POST reaches the real server from
      // here, and the page gets a response that ends with no [DONE] once the
      // turn is registered, which is what a proxy or an idle timeout leaves.
      await page.route((url) => url.pathname === "/api/chat", async (route) => {
        turn = request.post(`${E2E_BASE}/api/chat`, { data: route.request().postDataJSON(), timeout: 120_000 });
        await expect.poll(async () => {
          const body = await (await request.get(`${E2E_BASE}/api/topics/streaming`)).json() as { sessions: Array<{ sessionKey: string }> };
          return body.sessions.some((x) => x.sessionKey === sessionKey);
        }, { timeout: 20_000 }).toBe(true);
        await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: ": ping\n\n" });
      });
      await chatPage.sendMessage("silent 25");

      // allow-italian: the exact aria-label shipped in i18n-chat-it.ts.
      const stop = page.getByRole("button", { name: /Stop streaming|Ferma la risposta/ }).first();
      await expect(page.getByText("Starting a silent tool.").first()).toBeVisible({ timeout: 30_000 });
      const goneAt = await page.evaluate(async (watchMs) => {
        const start = performance.now();
        while (performance.now() - start < watchMs) {
          // allow-italian: the same aria-label as above.
          if (!document.querySelector('button[aria-label="Stop streaming"], button[aria-label="Ferma la risposta"]')) {
            return Math.round((performance.now() - start) / 1000);
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        return null;
      }, 12_000);
      expect(goneAt, `the Stop went away ${goneAt} s after the reply was cut`).toBeNull();

      await expect(page.getByText("SILENT-TOOL-DONE").first()).toBeVisible({ timeout: 40_000 });
      await expect(stop).toBeHidden({ timeout: 15_000 });
      expect((await turn!)?.ok()).toBe(true);
    } finally {
      rmSync(CLI_ENTRY, { force: true });
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
