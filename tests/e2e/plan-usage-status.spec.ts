import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * THE WINDOW SAID OUT LOUD BEFORE IT RUNS OUT.
 *
 * On a subscription CLI the constraint is not the dollar, it is the five-hour
 * window: the CLI publishes how full it is on every turn (`rate_limit_event`),
 * Topics used to drop that as noise, and the only thing the person ever saw was
 * the wall itself — the hold banner, when everything had already stopped.
 *
 * What is measured here is the row BEFORE the wall, and the fact that it gets
 * out of the way when the wall arrives: two amber lines about the same window
 * would read as two problems.
 *
 * The reading is fed through `POST /api/test/plan-usage`, which calls the same
 * `observePlanUsage` the provider calls, so what travels is the real frame.
 *
 * @covers USAGE-21
 */
test.describe("La finestra del piano sulla fascia di stato", () => {
  test.afterAll(async ({ request }) => {
    await request.post("/api/test/plan-usage", { data: { clear: true } });
  });

  test("la percentuale e l'ora di reset compaiono, e l'hold prende il loro posto", async ({ page, request }) => {
    await goToApp(page);
    // Nothing recorded: no row. Not knowing is not a warning.
    await expect(page.getByTestId("plan-usage-notice")).toHaveCount(0);

    const resetsAtMs = Date.now() + 90 * 60_000;
    await request.post("/api/test/plan-usage", { data: { fiveHour: { utilization: 92, resetsAtMs } } });

    const notice = page.getByTestId("plan-usage-notice");
    await expect(notice).toBeVisible({ timeout: 15_000 });
    // The hour is formatted IN THE PAGE, so it is asked for in the page too:
    // the runner and the browser do not necessarily share a locale, and a test
    // that formats it on its own side measures Node instead of the bar.
    const expected = await page.evaluate(
      (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
      resetsAtMs,
    );
    // The two numbers a person acts on: how full, and until when.
    await expect(notice).toContainText("92");
    await expect(notice).toContainText(expected);

    // At the wall the hold takes over and the reading steps aside.
    await request.post("/api/test/plan-usage", { data: { fiveHour: { utilization: 100, resetsAtMs } } });
    await expect(page.getByTestId("provider-hold-notice")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("plan-usage-notice")).toHaveCount(0);

    // Cleared, both rows go: the bar says nothing rather than yesterday's number.
    await request.post("/api/test/plan-usage", { data: { clear: true } });
    await expect(page.getByTestId("provider-hold-notice")).toHaveCount(0);
    await expect(page.getByTestId("plan-usage-notice")).toHaveCount(0);
  });

  test("sotto la soglia d'avviso la fascia tace", async ({ page, request }) => {
    await request.post("/api/test/plan-usage", { data: { clear: true } });
    await goToApp(page);
    const resetsAtMs = Date.now() + 90 * 60_000;

    // The row is shown FIRST, so its absence afterwards is a disappearance and
    // not a frame that never arrived: an assertion on nothing passes on a
    // broken socket too.
    await request.post("/api/test/plan-usage", { data: { fiveHour: { utilization: 92, resetsAtMs } } });
    await expect(page.getByTestId("plan-usage-notice")).toBeVisible({ timeout: 15_000 });

    await request.post("/api/test/plan-usage", { data: { fiveHour: { utilization: 12, resetsAtMs } } });
    await expect(page.getByTestId("plan-usage-notice")).toHaveCount(0);
  });
});
