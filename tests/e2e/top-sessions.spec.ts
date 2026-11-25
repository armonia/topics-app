/**
 * "WHO IS SPENDING" on the Dashboard's usage section (card 8cb978eb).
 *
 * The ranking itself is covered by `server/usage/top-sessions.test.ts`; this
 * spec seeds `/api/usage/top-sessions` at the network and checks what a person
 * sees at 375 and 1440 px: the rows in order, the model, where each runs, the
 * week share, the badge, and the write action posting to the server.
 *
 * Mutation: with the badge condition dropped from `TopSessionsSection`,
 * «only the dominating session carries the badge» is red.
 *
 * Video on: the recording is the proof.
 *
 * @covers USAGE-29
 */
import { expect, test, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import type { TopSession, TopSessionsResult } from "../../shared/top-sessions";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 150_000 });

const session = (id: string, title: string, over: Partial<TopSession>): TopSession => ({
  id, title, origin: "desktop", cwd: "/work/acme", model: "claude-opus-4", points24h: 1000, weekShare: 0.2, avgContext: 200_000,
  openMs: 5 * 3_600_000, shareOfProject: 0.3, dominatesProject: false, hog: false, ...over,
});

const FIXTURE: TopSessionsResult = {
  generatedAt: new Date().toISOString(),
  sessions: [
    session("11111111-aaaa", "Cloud simulation", { weekShare: 0.76, origin: "desktop", openMs: 52 * 3_600_000, avgContext: 273_000, dominatesProject: true, hog: true }),
    session("22222222-bbbb", "Checkout fix", { origin: "cli", model: "claude-sonnet-4", weekShare: 0.1 }),
  ],
};

async function openDashboard(page: Page): Promise<void> {
  await goToApp(page);
  await expect.poll(() => page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "dashboard" } }));
    return document.querySelector('[data-testid="dashboard-pane"]') !== null;
  }), { timeout: 20_000 }).toBe(true);
}

for (const width of [375, 1440]) {
  test(`the section lists the heaviest sessions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/usage/top-sessions", (route) => route.fulfill({ json: FIXTURE }));
    await openDashboard(page);
    const section = page.getByTestId("top-sessions");
    await expect(section).toBeVisible({ timeout: 30_000 });
    const rows = section.getByTestId("top-session-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Cloud simulation");
    await expect(rows.first()).toContainText("76%");
    await expect(rows.first()).toContainText("opus");
    await expect(rows.first()).toContainText("273k");
    await expect(rows.first()).toContainText("2d");
    await expect(rows.nth(1)).toContainText("sonnet");
    // only the dominating session carries the badge
    await expect(section.getByTestId("top-session-badge")).toHaveCount(1);
    await expect(rows.first().getByTestId("top-session-badge")).toBeVisible();
    await page.screenshot({ path: `test-results/top-sessions-${width}.png` });
  });
}

test("Write posts the message to the listed session", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/usage/top-sessions", (route) => route.fulfill({ json: FIXTURE }));
  let posted: { sessionId?: string; text?: string } | null = null;
  await page.route("**/api/usage/top-sessions/send", async (route) => {
    posted = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true } });
  });
  await openDashboard(page);
  const row = page.getByTestId("top-session-row").first();
  await row.getByTestId("top-session-write").click();
  await row.getByTestId("top-session-input").fill("please stop");
  await row.getByRole("button", { name: /send|invia/i }).click();
  await expect.poll(() => posted).toEqual({ sessionId: "11111111-aaaa", text: "please stop" });
});
