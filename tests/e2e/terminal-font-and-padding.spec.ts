/**
 * The terminal draws in JetBrains Mono from the bundle, with a 12 px inner gap
 * and a 1.25 line height. The shade blocks (░▒▓) are part of that face, so they
 * are not allowed to fall back to a system font.
 *
 * Measured in the DOM: the font is read from `document.fonts`, not from the
 * CSS, so a missing file fails here. No screenshot assertion: there is no
 * baseline in the repo for it, and a missing baseline fails on CI.
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

    // Both faces must be `loaded`, not merely declared: `document.fonts.check`
    // answers true for a face that is in `error`, so it proves nothing here.
    const faces = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((f) => f.family === 'JetBrains Mono')
        .map((f) => ({ weight: f.weight, status: f.status }));
    });
    expect(faces.map((f) => f.status)).toEqual(['loaded', 'loaded']);

    // The rows xterm draws use the bundled face, and at 13 px with a 1.25 line
    // height JetBrains Mono's cell is 21 px tall (measured, not assumed).
    const rowMetrics = await page.evaluate(() => {
      const rows = document.querySelector<HTMLElement>('.xterm-rows');
      const row = rows?.firstElementChild as HTMLElement | null;
      return {
        family: rows ? getComputedStyle(rows).fontFamily : '',
        rowPx: row ? row.getBoundingClientRect().height : 0,
      };
    });
    expect(rowMetrics.family).toContain('JetBrains Mono');
    expect(rowMetrics.rowPx).toBe(21);

    // The shade blocks are drawn by the face, so they must reach the rows.
    await terminalPage.waitForReady();
    await terminalPage.focus();
    await terminalPage.typeCommand('echo ░▒▓');
    await terminalPage.waitForOutput('░▒▓');

    // The gap is measured from the box that holds xterm to xterm's screen, at
    // several pane heights: FitAddon rounds the rows down, so the gap below the
    // last row is 12 px plus the remainder, and a fit that counts the padding
    // as rows puts the last row past the bottom edge.
    const measureGaps = () =>
      page.evaluate(() => {
        const box = [...document.querySelectorAll<HTMLElement>('[data-testid="terminal-gap-box"]')].find(
          (el) => el.offsetParent !== null,
        );
        const screen = box?.querySelector<HTMLElement>(".xterm-screen");
        if (!box || !screen) return null;
        const b = box.getBoundingClientRect();
        const s = screen.getBoundingClientRect();
        return { top: s.top - b.top, left: s.left - b.left, bottom: b.bottom - s.bottom, right: b.right - s.right };
      });

    for (const height of [600, 610, 642, 673]) {
      await page.setViewportSize({ width: 1280, height });
      await expect
        .poll(async () => {
          const g = await measureGaps();
          return g !== null && g.bottom >= 12 && g.right >= 11.5;
        }, { timeout: 10_000 })
        .toBe(true);
      const g = await measureGaps();
      expect(g, `gaps at height ${height}`).not.toBeNull();
      expect(Math.abs(g!.top - 12), `top gap at height ${height}`).toBeLessThanOrEqual(1);
      expect(Math.abs(g!.left - 12), `left gap at height ${height}`).toBeLessThanOrEqual(1);
      expect(g!.bottom, `bottom gap at height ${height}`).toBeGreaterThanOrEqual(12);
      expect(g!.right, `right gap at height ${height}`).toBeGreaterThanOrEqual(11.5);
    }
  });
});
