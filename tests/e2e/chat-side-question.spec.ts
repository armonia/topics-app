import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, seedProjectInnerChats, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { installFakeCli } from "./helpers/fake-claude-cli";

hermetic(test);

let removeCli: (() => void) | null = null;
let tempDir = "";

test.describe("/btw side question", () => {
  test.describe.configure({ timeout: 90_000 });

  test.afterEach(() => {
    removeCli?.();
    removeCli = null;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  });

  test("forks context beside the chat and leaves its transcript unchanged", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-10" });
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "topics-btw-")));
    const project = join(tempDir, "project");
    mkdirSync(project);
    const log = join(tempDir, "fake-cli.jsonl");
    const release = join(tempDir, "release-main");
    appendFileSync(log, "");
    removeCli = installFakeCli(resolve(__dirname, "helpers/fake-claude-btw.ts"), { BTW_LOG: log, BTW_RELEASE: release });
    const topic = await createTopic(request, `Side question ${Date.now()}`, { projectPath: project, provider: "claude-code" });
    try {
      // A project chat lives in its project's window, not among the sidebar's loose chats: open it
      // there, as chat-composer-draft-race does.
      await resetPaneStore(request, []);
      await seedProjectPane(request, project);
      await seedProjectInnerChats(request, project, [topic.id]);
      await waitForPaneStoreQuiet(request);
      await goToApp(page);
      await chatPage.messageInput.waitFor({ state: "visible", timeout: 20_000 });
      await chatPage.sendMessage("main-probe");
      await expect(page.getByText("MAIN-ANSWER-PROBE").first()).toBeVisible({ timeout: 30_000 });

      await chatPage.sendMessage("main-hold");
      await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });

      const transcript = page.locator('[data-testid="chat-message"]');
      const domBefore = await transcript.count();
      const before = (await (await request.get(`${E2E_BASE}/api/topics/${topic.id}/messages?limit=100`)).json()) as { messages: unknown[] };
      const input = chatPage.messageInput;
      await input.fill("/btw side-probe");
      await input.press("Escape");
      await input.press("Control+Enter");

      await expect(page.getByText("SIDE-ANSWER-PROBE").first()).toBeVisible({ timeout: 30_000 });
      await expect(transcript).toHaveCount(domBefore);
      const after = (await (await request.get(`${E2E_BASE}/api/topics/${topic.id}/messages?limit=100`)).json()) as { messages: unknown[] };
      expect(after.messages).toHaveLength(before.messages.length);
      await expect(page.locator('button[aria-label="Stop streaming"], button[aria-label="Ferma la risposta"]')).toBeVisible();

      const events = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { argv?: string[] });
      const fork = events.find((event) => event.argv?.includes("--fork-session"));
      expect(fork?.argv).toContain("--resume");
      expect(fork?.argv).toContain("--resume-session-at");
      const listed = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as { topics: Record<string, { id: string }> };
      expect(Object.values(listed.topics).some((item) => item.id.startsWith("side-question-"))).toBe(false);
      appendFileSync(release, "done");
      await expect.poll(() => page.getByText("MAIN-ANSWER-PROBE").count(), { timeout: 20_000 }).toBeGreaterThan(1);
    } finally {
      appendFileSync(release, "done");
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
