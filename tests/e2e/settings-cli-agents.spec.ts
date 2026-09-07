/**
 * THE CLI IS INSTALLED AND TOPICS SAYS IT IS NOT: THE WAY OUT.
 *
 * Reported on card 38d9f64b: somebody had Codex installed and the Settings pane
 * did not see it. The probe looks in the locations the vendors document, which
 * cannot cover a custom npm prefix or a version manager, and until now the probe
 * was the only voice in the room: the pane stated the CLI was missing and
 * offered nothing to press.
 *
 * WHY AN E2E AND NOT A UNIT TEST. What was missing was a SURFACE. The
 * validation of the path is measured in `server/lib/configure-agent-bin.test.ts`,
 * where it belongs; what cannot be measured there is whether a person opening
 * Settings finds the list, the install command and the field. That question only
 * has an answer in a browser.
 *
 * @covers CLIADD-01 @covers CLIADD-02
 */
import { test, expect } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** The proof shot: the block as a person sees it, list plus the open field. */
const SHOT_PATH = "test-results/settings-cli-agents.png";

test.describe("Settings · agent CLIs", () => {
  test.describe.configure({ timeout: 60_000 });

  async function openProviders(page: import("@playwright/test").Page) {
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await page.keyboard.press("Meta+Comma");
    const panel = page.locator('[data-testid="settings-panel"]');
    await expect(panel).toBeVisible({ timeout: 10000 });
    await panel.locator("nav button", { hasText: /AI|Provider/i }).first().click();
    return panel;
  }

  test("CLIADD-01: the agent CLIs are listed, each one with a way to point at it", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CLIADD-01" });
    const panel = await openProviders(page);

    const block = panel.getByTestId("cli-agents-panel");
    await expect(block, "the pane must list the agent CLIs").toBeVisible({ timeout: 10000 });

    // Every known CLI has a row: the ones that are missing are exactly the rows
    // that matter here, so a list that only shows what was found would be the
    // old silence with a new layout.
    for (const id of ["claude-code", "codex", "opencode", "kimi-code", "gemini"]) {
      await expect(block.getByTestId(`cli-agent-${id}`), `row for ${id}`).toBeVisible();
    }

    // The gesture the card asks for: something to press that lets you say where
    // the binary is.
    const codex = block.getByTestId("cli-agent-codex");
    await expect(codex.getByTestId("cli-agent-path-toggle")).toBeVisible();
    await codex.getByTestId("cli-agent-path-toggle").click();
    await expect(codex.getByTestId("cli-agent-path-input")).toBeVisible();

    // Kept at the block's own width, height capped at 0.70 of it, so it still
    // reads at 268px in the media gallery.
    const box = await block.boundingBox();
    expect(box).toBeTruthy();
    const pad = 8;
    const width = box!.width + 2 * pad;
    const height = Math.min(box!.height + 2 * pad, Math.floor(width * 0.7));
    await page.screenshot({ path: SHOT_PATH, clip: { x: box!.x - pad, y: box!.y - pad, width, height } });
  });

  test("CLIADD-02: a path that points at nothing is refused with a reason", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CLIADD-02" });
    const panel = await openProviders(page);
    const codex = panel.getByTestId("cli-agent-codex");

    await codex.getByTestId("cli-agent-path-toggle").click();
    const field = codex.getByTestId("cli-agent-path-input");
    await expect(field).toBeVisible();
    await field.fill("/definitely/not/here/codex");
    await codex.getByTestId("cli-agent-path-save").click();

    // The refusal is shown where the mistake was made, and it says what is
    // wrong: a silent failure here would let somebody believe the CLI is now
    // configured and discover otherwise at the next empty terminal.
    await expect(codex.getByTestId("cli-agent-path-error")).toContainText(/nothing at that path/i, {
      timeout: 10000,
    });
  });
});
