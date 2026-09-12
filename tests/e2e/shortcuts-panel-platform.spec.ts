/**
 * shortcuts-panel-platform.spec.ts — the panel names keys that EXIST on this
 * keyboard.
 *
 * The registry used to spell the primary modifier as the Mac glyph `⌘`, and the
 * window printed it verbatim on every system. On Windows the list therefore
 * named a key that is not on the keyboard — while the chords themselves worked,
 * because every handler reads `metaKey || ctrlKey`. Reported 2026-08-26 on the
 * installed build. Captions are how shortcuts are LEARNED: one that names the
 * wrong key does not slow you down, it teaches you something false.
 *
 * WHY IT CAN BE PROVEN WITHOUT WINDOWS. `usesCtrl` is decided from
 * `navigator.userAgentData.platform || navigator.platform || userAgent`, read
 * ONCE when the module loads. An init script that answers those three before
 * the bundle boots puts the real panel, rendered by the real component, in the
 * state a Windows machine would produce. What this does NOT prove is anything
 * about the native shell — that still needs the PC.
 *
 * @covers CMD-01
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** Answer the three sources `shortcutLabel` reads, before the bundle boots. */
async function pretendPlatform(page: Page, platform: string): Promise<void> {
  await page.addInitScript((p) => {
    Object.defineProperty(navigator, "platform", { get: () => p, configurable: true });
    Object.defineProperty(navigator, "userAgentData", { get: () => ({ platform: p }), configurable: true });
  }, platform);
}

async function openPanel(page: Page) {
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { timeout: 20000 });
  await page.keyboard.press("Meta+?");
  const panel = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
  await expect(panel).toBeVisible({ timeout: 10000 });
  return panel;
}

test.describe("Pannello scorciatoie · i tasti sono quelli di QUESTA tastiera", () => {
  test.describe.configure({ timeout: 90_000 });

  test("su Windows dice Ctrl e Shift, e il glifo Mac non compare mai", async ({ page }) => {
    await pretendPlatform(page, "Win32");
    const panel = await openPanel(page);

    const caps = await panel.locator("kbd").allTextContents();
    expect(caps.length).toBeGreaterThan(10);
    // The defect in one line: not one glyph that Windows does not have.
    for (const g of ["⌘", "⇧", "⌥", "⌃"]) {
      expect(caps.join(" "), `il pannello non deve mai stampare ${g}`).not.toContain(g);
    }
    expect(caps).toContain("Ctrl");
    expect(caps).toContain("Shift");
    // Nor in the PROSE: an alias written into the description would escape the
    // translation, which is exactly why it lives in a field of its own.
    const prose = await panel.locator("span").allTextContents();
    for (const g of ["⌘", "⇧", "⌥", "⌃"]) {
      expect(prose.join(" ")).not.toContain(g);
    }
  });

  test("su Windows due accordi che collassano sullo stesso nome si dicono UNA volta", async ({ page }) => {
    // `⌃⇧Tab` and its alias `⌘⇧Tab` are two different keyboards on a Mac
    // and the same three keys on Windows: the row must not read
    // "Ctrl+Shift+Tab / Ctrl+Shift+Tab".
    await pretendPlatform(page, "Win32");
    const panel = await openPanel(page);
    const row = panel.getByText("Previous panel", { exact: true }).locator("xpath=..");
    await expect(row).toBeVisible();
    const chips = await row.locator("kbd").allTextContents();
    expect(chips).toEqual(["Ctrl", "Shift", "Tab"]);
  });

  test("su un Mac resta il glifo, e l'alias si vede perché dice un'altra cosa", async ({ page }) => {
    await pretendPlatform(page, "MacIntel");
    const panel = await openPanel(page);
    const caps = await panel.locator("kbd").allTextContents();
    expect(caps).toContain("⌘");
    // Control PROPER stays a different key from the primary modifier.
    expect(caps).toContain("⌃");
  });
});
