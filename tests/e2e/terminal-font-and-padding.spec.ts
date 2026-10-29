/**
 * The terminal draws in JetBrains Mono from the bundle, with a 12 px inner gap
 * and a 1.25 line height. The shade blocks (░▒▓) are part of that face, so they
 * are not allowed to fall back to a system font.
 *
 * Measured in the DOM and with a screenshot of the pane; the font is read from
 * `document.fonts`, not from the CSS, so a missing file fails here.
 *
 * @covers TERM-FONT-01
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/terminal.fixture";
import {
  resetTerminalWorkspace,
  seedTerminalTopic,
  cleanupTerminalTopic,
  navigateAndOpenTerminal,
} from "./helpers/terminal-workspace";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.describe.configure({ timeout: 90_000 });

test.describe("Terminal font and padding", () => {
  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    const seeded = await seedTerminalTopic(request, "terminal-font");
    topicId = seeded.topicId;
    topicName = seeded.topicName;
  });

  test.afterAll(async ({ request }) => {
    await cleanupTerminalTopic(request, topicId);
  });

  test("TERM-FONT-01: JetBrains Mono loads and the pane keeps 12 px padding", async ({ page, request, terminalPage }) => {
    await resetTerminalWorkspace(request, topicId);
    await navigateAndOpenTerminal(page, terminalPage, topicName);

    const pane = page.locator('[data-testid="single-terminal-pane"]:visible').first();
    await expect(pane).toBeVisible({ timeout: 20_000 });

    const fontLoaded = await page.evaluate(async () => {
      await document.fonts.load("13px 'JetBrains Mono'");
      return document.fonts.check("13px 'JetBrains Mono'");
    });
    expect(fontLoaded).toBe(true);

    const padding = await pane.locator("xpath=.//div[contains(@class,'absolute') and contains(@class,'inset-0')][1]").evaluate(
      (el) => getComputedStyle(el).paddingTop,
    );
    expect(padding).toBe("12px");

    await expect(pane).toHaveScreenshot("terminal-pane.png", { maxDiffPixelRatio: 0.02 });
  });
});
