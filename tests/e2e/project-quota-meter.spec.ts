/**
 * THE PROJECT QUOTA METER (project quota, USAGE-28).
 *
 * Each project row in the sidebar carries «points/limit» for the last 24
 * hours («7/10»), calm under 80% of the limit, amber from 80%, red above it.
 * The Dashboard's usage section carries the same numbers in a table with the
 * 7-day points, the limit, where the points went by surface and the heaviest
 * chats. There is no pause anywhere: the meter only reads.
 *
 * The quota reading is seeded at the network (`/api/usage/projects/quota`
 * answers a fixture keyed by the scene's projects): the count itself is
 * covered by `server/usage/project-quota.test.ts`. This spec is about what a
 * person sees: the numbers, the three tones, and that the Dashboard table and
 * the sidebar agree.
 *
 * Mutation: with `quotaTone` (lib/projectQuotaMeter.ts) turning amber at 90%
 * instead of 80%, «8/10 is amber» is red; with it comparing `>=` to the limit
 * instead of `>`, «10/10 is amber, not red» is red.
 *
 * Video on: the recording is the proof.
 *
 * @covers USAGE-28
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore } from "./helpers/api-fixtures";
import { openSceneInSidebar, seedScene, type Scene } from "./helpers/shot-scene";
import { goToApp } from "./helpers";
import { canonicalTmpRoot } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";
import { QUOTA_SURFACES, type ProjectQuotaResponse, type ProjectQuotaRow, type QuotaSurface } from "../../shared/usage-shapes";
import { VIDEO_ON } from "./video-evidence";

hermetic(test);
test.use({ video: VIDEO_ON });
test.describe.configure({ mode: "serial", timeout: 150_000 });

function surfaces(day: Partial<Record<QuotaSurface, number>>): ProjectQuotaRow["surfaces"] {
  return Object.fromEntries(QUOTA_SURFACES.map((s) => [s, { points24h: day[s] ?? 0, points7d: (day[s] ?? 0) * 3 }])) as ProjectQuotaRow["surfaces"];
}

function row(path: string, points24h: number, day: Partial<Record<QuotaSurface, number>>, limit: number | null = 10): ProjectQuotaRow {
  return {
    projectId: projectIdForPath(path), projectPath: path, points24h, points7d: points24h * 3, weighted24h: 1, weighted7d: 3, limit,
    surfaces: surfaces(day),
    topChats: [{ topicId: "chat-1", title: "Checkout review", surface: "chat", points24h: points24h / 2, points7d: points24h * 1.5 }],
  };
}

const colorOf = (l: Locator) => l.evaluate((el) => getComputedStyle(el).color);

test.describe("project quota meter", () => {
  let scene: Scene | null = null;
  // What the seeded endpoint answers; a test changes it and reloads.
  let points = { acme: 7, studio: 8 };
  // A project nobody configured has no limit; the meter still shows its spend.
  let limit: number | null = 10;

  async function seedQuota(page: Page): Promise<void> {
    await page.route("**/api/usage/projects/quota", async (route) => {
      const body: ProjectQuotaResponse = {
        cachedAt: new Date().toISOString(), quotaHistory: true,
        projects: [
          row(scene!.dirOf("acme-web"), points.acme, { chat: points.acme - 2, cardSubagent: 2 }, limit),
          row(scene!.dirOf("studio-x"), points.studio, { card: points.studio }, limit),
        ],
      };
      await route.fulfill({ json: body });
    });
  }

  test.beforeAll(async ({ request }) => {
    scene = await seedScene(request, `${canonicalTmpRoot()}/e2e-project-quota-meter-${Date.now().toString(36)}`);
  });
  test.afterAll(async ({ request }) => { await scene?.cleanup(request); });
  test.beforeEach(async ({ request }) => {
    if (!scene) return;
    await resetPaneStore(request, []);
    await openSceneInSidebar(request, scene);
  });

  test("the sidebar rows read points/limit and turn amber at 80% and red above the limit", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    points = { acme: 7, studio: 8 };
    await seedQuota(page);
    await goToApp(page);

    const acme = page.getByTestId("project-quota-meter").filter({ hasText: "7/10" });
    const studio = page.getByTestId("project-quota-meter").filter({ hasText: "8/10" });
    await expect(acme).toBeVisible({ timeout: 30_000 });
    await expect(studio).toBeVisible();
    await expect(acme).toHaveAttribute("data-tone", "ok");
    await expect(studio).toHaveAttribute("data-tone", "warn");
    const calm = await colorOf(acme);
    const amber = await colorOf(studio);
    expect(amber).not.toBe(calm);

    // Exactly at the limit is still amber; one past it is red.
    points = { acme: 10, studio: 11 };
    await page.reload();
    const atLimit = page.getByTestId("project-quota-meter").filter({ hasText: "10/10" });
    const over = page.getByTestId("project-quota-meter").filter({ hasText: "11/10" });
    await expect(atLimit).toHaveAttribute("data-tone", "warn", { timeout: 30_000 });
    await expect(over).toHaveAttribute("data-tone", "over");
    const red = await colorOf(over);
    expect(red).not.toBe(amber);
    expect(red).not.toBe(calm);
  });

  test("a project with spend and no limit shows the points alone, neutral, without a slash", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    points = { acme: 35, studio: 21 };
    limit = null;
    await seedQuota(page);
    await goToApp(page);
    const acme = page.getByTestId("project-quota-meter").filter({ hasText: /^35$/ });
    await expect(acme).toBeVisible({ timeout: 30_000 });
    await expect(acme).toHaveAttribute("data-tone", "ok");
    await expect(page.getByTestId("project-quota-meter").filter({ hasText: "/" })).toHaveCount(0);
    limit = 10;
  });

  test("the Dashboard table carries the same points, the limit, the surfaces and the heaviest chats", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    points = { acme: 7, studio: 12 };
    await seedQuota(page);
    await goToApp(page);
    await expect.poll(() => page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "dashboard" } }));
      return document.querySelector('[data-testid="dashboard-pane"]') !== null;
    }), { timeout: 20_000 }).toBe(true);

    const table = page.getByTestId("project-quota-table");
    await expect(table).toBeVisible({ timeout: 30_000 });
    const rows = table.getByTestId("project-quota-row");
    await expect(rows).toHaveCount(2);
    const acme = rows.filter({ hasText: "acme-web" });
    const studio = rows.filter({ hasText: "studio-x" });
    await expect(acme.getByTestId("project-quota-day")).toHaveText("7");
    await expect(acme).toHaveAttribute("data-tone", "ok");
    await expect(studio.getByTestId("project-quota-day")).toHaveText("12");
    await expect(studio).toHaveAttribute("data-tone", "over");
    await expect(acme).toContainText("21");
    await expect(acme).toContainText("10");

    await acme.getByRole("button").click();
    const detail = acme.getByTestId("project-quota-detail");
    await expect(detail).toContainText("Checkout review");
    await expect(detail).toContainText("5");

    // The sidebar row of the same project says the same number.
    await expect(page.getByTestId("project-quota-meter").filter({ hasText: "12/10" })).toHaveAttribute("data-tone", "over");
  });
});
