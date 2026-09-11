/**
 * org-projects-scope.spec.ts - the Organization page's project list follows
 * the SELECTED group, seen.
 *
 * Before this change `OrgProjectsSection` fetched `/api/projects` and drew
 * every non-incognito row, full stop: no `orgId` anywhere in the fetch or the
 * render. On an installation with one group that bug is invisible, because
 * everything visible IS that one group's projects. It stops being correct
 * the moment a SECOND group exists: a project that belongs to group A showed
 * up on group B's page too, because nothing told the panel which page was
 * open.
 *
 * This is exactly the live case the request named: a project owned by one
 * organisation, and a second organisation on the same installation whose
 * page must NOT claim it. Two groups is the minimum needed to observe the
 * bug at all, so this spec stubs a second one and switches between them.
 *
 * @covers ORG-PROJECTS-01
 */
import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const SHOTS = "test-results/org-projects-scope";

test.describe("Organizzazione - la lista progetti segue il gruppo scelto", () => {
  test("ORG-PROJECTS-01: due gruppi, due elenchi diversi", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "ORG-PROJECTS-01" });

    await page.route("**/api/auth/me", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          person: { id: "io", name: "Io", email: null },
          org: { id: "org-armonia", name: "Armonia", logo_url: null, members: 1 },
        }),
      }),
    );
    await page.route("**/api/auth/orgs", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          orgs: [
            { id: "org-armonia", name: "Armonia", logo_url: null, members: 1, role: "owner", installation: true },
            { id: "org-danceroom", name: "Danceroom", logo_url: null, members: 2, role: "owner", installation: false },
          ],
        }),
      }),
    );
    await page.route("**/api/auth/orgs/*/members", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          members: [{ id: "io", name: "Io", email: null, role: "owner", removedAt: null }],
        }),
      }),
    );
    // ONE project, owned by Armonia (PROJECT-13: a project's `orgId` can only
    // be `null` or the installation's own group - here Armonia). Danceroom
    // owns nothing of its own; that is what its page must show.
    await page.route("**/api/projects", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          projects: [
            { id: "proj-dancerooms", name: "dancerooms", path: "/work/dancerooms", incognito: false, orgId: "org-armonia" },
          ],
        }),
      }),
    );

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await page.keyboard.press("Meta+Comma");
    const panel = page.locator('[data-testid="settings-panel"]');
    await expect(panel).toBeVisible({ timeout: 10000 });
    await panel.locator("nav button", { hasText: /^Organizzazione$/ }).click();
    await expect(panel.getByTestId("settings-page-organization")).toBeVisible({ timeout: 10000 });

    // ARMONIA IS SELECTED FIRST (the installation's own group): its one
    // project is there.
    await expect(panel.getByTestId("org-project-row")).toHaveCount(1, { timeout: 10000 });
    await expect(panel.getByTestId("org-project-row")).toContainText("dancerooms");

    await page.screenshot({ path: join(SHOTS, "armonia-un-progetto.png") });

    // SWITCH TO DANCEROOM: the same project must NOT follow. This is the bug
    // this change closes - before the fix, the row above showed on both
    // pages regardless of which group was open.
    const tab = panel.locator("button", { hasText: /^Danceroom$/ });
    await expect(tab).toBeVisible({ timeout: 10000 });
    await tab.click();
    await expect(panel.getByTestId("org-project-row")).toHaveCount(0, { timeout: 10000 });
    await expect(panel).not.toContainText("dancerooms");
    await expect(panel).toContainText("Danceroom");

    await page.screenshot({ path: join(SHOTS, "danceroom-nessun-progetto.png") });
  });
});
