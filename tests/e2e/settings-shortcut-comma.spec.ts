import { expect } from "@playwright/test";
import { test } from "./fixtures/terminal.fixture";
import {
  resetTerminalWorkspace,
  seedTerminalTopic,
  cleanupTerminalTopic,
  gotoTerminalProject,
  openShellViaSidebar,
} from "./helpers/terminal-workspace";
import { goToApp, openTopic } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * Ctrl+, MUST REACH SETTINGS WHILE YOU ARE TYPING, and must not reach it while
 * a terminal owns the keyboard.
 *
 * Mapping the panel on Windows (card cb88f460) left one row unexplained: the
 * Settings shortcut did nothing. The handler in `useKeyboardShortcuts` yielded
 * to ANY focused text input unless `metaKey` was held, and on Windows `metaKey`
 * is always false, so the shortcut was mute exactly where the pointer usually
 * is, the chat composer. The reason for yielding is real but narrower than the
 * guard was: inside an xterm terminal (and a CodeMirror editor) Ctrl+, is a
 * REAL key, and this handler runs in capture on `window`, so its
 * `preventDefault()` would eat it before the surface saw it. A plain textarea
 * does nothing with Ctrl+, so there was nothing to yield to.
 *
 * WHY AN E2E AND NOT A UNIT TEST. The whole behaviour is `document.activeElement`
 * plus event capture: the predicate needs a real DOM (jsdom/happy-dom are
 * deliberately not dependencies here, see `client/src/test/reactHarness.ts`) and
 * the terminal case needs a real xterm with real focus. A browser is the only
 * place where this can be measured instead of imitated.
 *
 * The two cases also cover the Windows path on a Mac runner: Ctrl+, on macOS
 * Chromium is byte-for-byte the event Windows sends (`ctrlKey` true, `metaKey`
 * false), so the regression is reproducible here.
 *
 * @covers CMD-COMMA-01 @covers CMD-COMMA-02
 */
test.describe.configure({ timeout: 75_000 });

test.describe("Settings shortcut, comma", () => {
  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    const seeded = await seedTerminalTopic(request, "settings-comma");
    topicId = seeded.topicId;
    topicName = seeded.topicName;
  });

  test.afterAll(async ({ request }) => {
    await cleanupTerminalTopic(request, topicId);
  });

  test("CMD-COMMA-01: Ctrl+, opens Settings from the chat composer", async ({ page, request }) => {
    await resetTerminalWorkspace(request, topicId);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const composer = page.getByRole("textbox", { name: /Message input/ }).first();
    await composer.waitFor({ state: "visible", timeout: 15_000 });
    await composer.click();
    await expect(composer).toBeFocused();

    await page.keyboard.press("Control+,");
    await expect(page.getByTestId("settings-panel")).toBeVisible({ timeout: 10_000 });
  });

  test("CMD-COMMA-02: in the terminal Ctrl+, is the terminal's key, Meta+, still opens Settings", async ({
    page,
    request,
    terminalPage,
  }) => {
    await resetTerminalWorkspace(request, topicId);
    await gotoTerminalProject(page, topicName);
    await openShellViaSidebar(page, terminalPage);
    await terminalPage.focus();

    const settings = page.getByTestId("settings-panel");
    await page.keyboard.press("Control+,");
    // Negative assertion with a real wait: the modal mounts in a few frames
    // when it mounts at all, so a short settle is enough to tell "did not
    // open" from "has not opened yet".
    await page.waitForTimeout(1_000);
    await expect(settings).toHaveCount(0);

    // The macOS convention is untouched: Cmd+, is absolute, terminal or not.
    await page.keyboard.press("Meta+,");
    await expect(settings).toBeVisible({ timeout: 10_000 });
  });
});
