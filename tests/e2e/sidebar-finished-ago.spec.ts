import { expect, test } from "@playwright/test";
import { E2E_BASE } from "./helpers/test-server";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { runChatTurn, sessionKeyOf } from "./helpers/attention";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const SIDEBAR = '[aria-label="Topics sidebar"]';

// A finished chat's row ends with "· 34m ago". The receipt lives outside the
// truncating span of the preview, so a very long last message must not push it
// out of view, on a phone and on a desktop.
for (const width of [375, 1440]) {
  test(`finished-ago stays visible next to a long preview at ${width}px`, async ({ browser, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-06" });
    const removeCli = installSlowTurnCli();
    const ctx = await browser.newContext({ baseURL: E2E_BASE, viewport: { width, height: 900 }, locale: "en-US" });
    const page = await ctx.newPage();
    const topic = await createTopic(request, `Ago ${width} ${Date.now()}`, { provider: "claude-code" });
    try {
      await resetPaneStore(request, [topic.id]);
      await runChatTurn(request, topic.id, "finish");
      const sessionKey = await sessionKeyOf(request, topic.id);
      await seedMessage(request, {
        sessionKey,
        role: "assistant",
        content: "a very long last message that goes on and on ".repeat(12),
      });
      await page.goto("/");
      await page.locator(SIDEBAR).waitFor({ state: "attached", timeout: 20_000 });
      const box0 = await page.locator(SIDEBAR).boundingBox();
      if (!box0 || box0.width <= 0 || box0.x + box0.width <= 0) await page.keyboard.press("ControlOrMeta+b");
      const ago = page.getByTestId("finished-ago").first();
      await expect(ago).toBeVisible({ timeout: 20_000 });
      await expect(ago).toHaveText(/^ · \d+\w+ (ago|fa)$/);
      const box = await ago.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    } finally {
      await deleteTopic(request, topic.id);
      await ctx.close();
      removeCli();
    }
  });
}
