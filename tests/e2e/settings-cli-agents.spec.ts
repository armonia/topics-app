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
import { openHomePanel } from "./helpers/user-menu";

hermetic(test);

/** The proof shot: the block as a person sees it, list plus the open field. */
const SHOT_PATH = "test-results/settings-cli-agents.png";

test.describe("Settings · agent CLIs", () => {
  test.describe.configure({ timeout: 60_000 });

  // Providers and keys with no chat open is a sheet of its own. Since the
  // providers level (model selector revision 2026-10-04, §5.6) a program has no
  // list of its own: a registered one shows its row in its account's detail,
  // one installed but not registered is a card «Da collegare», and the missing
  // ones are under «+ Programma». The row is the same in all three places.
  async function openProviders(page: import("@playwright/test").Page) {
    await page.goto("/");
    // The cards of the programs installed but not registered come with this list.
    const programs = page.waitForResponse((response) => response.url().includes("/api/providers/cli"));
    const panel = await openHomePanel(page, "providers");
    await expect(panel.getByTestId("providers-level")).toBeVisible({ timeout: 15_000 });
    await programs;
    return panel;
  }

  /** Where the row of program `id` lives on this machine, opened. */
  async function openProgramRow(panel: import("@playwright/test").Locator, id: string) {
    const card = panel.getByTestId(`provider-card-${id}`);
    if (await card.count()) {
      await card.getByTestId("provider-card-open").click();
    } else {
      await panel.getByTestId("providers-add-program").click();
    }
    const row = panel.getByTestId(`cli-agent-${id}`);
    await expect(row, `the row of ${id}`).toBeVisible({ timeout: 10_000 });
    return row;
  }

  async function backToList(panel: import("@playwright/test").Locator) {
    await panel.getByTestId("level-back").click();
    await expect(panel.getByTestId("providers-level")).toBeVisible();
  }

  test("CLIADD-01: the agent CLIs are listed, each one with a way to point at it", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CLIADD-01" });
    const panel = await openProviders(page);

    // Every known CLI has a row: the ones that are missing are exactly the rows
    // that matter here, so a list that only shows what was found would be the
    // old silence with a new layout.
    for (const id of ["claude-code", "codex", "opencode", "kimi-code", "gemini"]) {
      const row = await openProgramRow(panel, id);
      await expect(row.getByTestId("cli-agent-path-toggle")).toBeVisible();
      await backToList(panel);
    }

    // The gesture the card asks for: something to press that lets you say where
    // the binary is.
    const codex = await openProgramRow(panel, "codex");
    await expect(codex.getByTestId("cli-agent-path-toggle")).toBeVisible();
    if (!(await codex.getByTestId("cli-agent-path-input").isVisible())) await codex.getByTestId("cli-agent-path-toggle").click();
    await expect(codex.getByTestId("cli-agent-path-input")).toBeVisible();
    const block = codex;

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
    const codex = await openProgramRow(panel, "codex");

    if (!(await codex.getByTestId("cli-agent-path-input").isVisible())) await codex.getByTestId("cli-agent-path-toggle").click();
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
