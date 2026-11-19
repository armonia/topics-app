import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

// A finished chat's row ends with "· 34m ago". The receipt lives outside the
// truncating span of the preview, so a very long last message must not push it
// out of view, on a phone and on a desktop.
for (const width of [375, 1440]) {
  test(`finished-ago stays visible next to a long preview at ${width}px`, async ({ browser, request }) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    const topic = await createTopic(request, `Ago ${width} ${Date.now()}`);
    try {
      const longText = "a very long last message that goes on and on ".repeat(12);
      const res = await request.post(`${E2E_BASE}/api/topics/${topic.id}/system-message`, {
        data: { content: longText },
      });
      expect(res.ok()).toBeTruthy();
      await goToApp(page);
      const ago = page.getByTestId("finished-ago").first();
      await expect(ago).toBeVisible({ timeout: 15000 });
      await expect(ago).toContainText("ago");
      const box = await ago.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.width).toBeGreaterThan(0);
    } finally {
      await deleteTopic(request, topic.id);
      await ctx.close();
    }
  });
}
