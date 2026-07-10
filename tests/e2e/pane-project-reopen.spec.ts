/**
 * Phase 30 Wave 0 — PANE-04 project-reopen fixture.
 *
 * Reproduces the "empty project tab on reopen" bug class from 30-CONTEXT.md:
 * when a project with a saved pane layout is reopened, current code renders
 * an empty project tab instead of replaying the seeded ProjectLayout.
 *
 * EXPECTED RED. The client-side replay of server ui-state into PanelGrid is
 * not yet driven by the unified reducer. Wave 3 implements PROJECT_LAYOUT_RESTORE.
 *
 * CONTEXT.md "Fixtures first" — this test is both the spec and the exit criterion.
 */
import { test, expect } from "./fixtures/test-fixtures";
import { goToApp } from "./helpers";

test.describe("@phase30-regression PANE-04: project reopen", () => {
  test("PANE-04: reopening a project restores exact layout (types, ratios, focused pane, tab order)", async ({ page, request }) => {
    // EXPECTED RED — Phase 30 Wave 3 (PANE-04 PROJECT_LAYOUT_RESTORE replay).
    // Client-side replay of server ui-state into PanelGrid is not yet driven by
    // the unified reducer; Wave 3 implements PROJECT_LAYOUT_RESTORE so that
    // reopening a project replays the seeded layout exactly.
    // When it lands, remove this annotation and the test should pass.
    // Unimplemented feature (Phase 30 Wave 3). Body seeds server state then drives
    // pre-redesign selectors → times out under test.fail (status "timedOut" ≠
    // "failed" → RED). test.fixme skips the body, the correct marker for a
    // not-yet-built feature. Drop the fixme when Wave 3 ships.
    test.fixme(
      true,
      "WAVE-3 scope — PANE-04 PROJECT_LAYOUT_RESTORE not implemented (see 30-CONTEXT.md)",
    );
    await goToApp(page);

    // Seed server with a known project layout for a specific projectPath
    const projectPath = "/tmp/phase30-test-project";
    const seedKey = `project-layout-${encodeURIComponent(projectPath)}`;
    const seedPayload = {
      groups: [
        { id: "g1", paneIds: ["p1", "p2"], splitRatio: 0.7, splitAxis: "horizontal" }
      ],
      panes: {
        p1: { id: "p1", type: "chat", title: "Seeded A", topicId: "t1" },
        p2: { id: "p2", type: "file", title: "Seeded B", filePath: "/tmp/x.ts" }
      },
      groupOrder: ["g1"],
      focusedPaneId: "p2",
      tabOrder: ["p1", "p2"]
    };
    await request.put(`http://localhost:13334/api/ui-state/${seedKey}`, { data: seedPayload });

    // Open the project (mechanism depends on app: click Projects section → project item)
    await page.getByRole("button", { name: /projects/i }).first().click();
    await page.getByText("phase30-test-project").first().click();

    // Assert EXACT tab order
    const tabs = await page.getByRole("tab").allTextContents();
    expect(tabs.slice(0, 2)).toEqual(["Seeded A", "Seeded B"]);

    // Assert focused pane is p2 (the second tab)
    await expect(page.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");

    // Assert split ratio is 0.7 (not 0.5 default — that's the bug)
    const ratio = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='panel-group']") as HTMLElement | null;
      return el?.style.getPropertyValue("--split-ratio") || null;
    });
    expect(ratio).toBe("0.7");
  });
});
