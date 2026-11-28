/**
 * Scheduled jobs, made and followed from the Automations view, with NO hub
 * configured (the test server finds nobody on the hub port): create a command
 * job, watch the next three occurrences change with the time field, let the
 * injected clock fire it, read the outcome and the output in its history,
 * pause it, run it now, delete it. Then axe on the section and the shots at
 * 375, 768 and 1440 px (attached to the test, the card's preview).
 *
 * Mutation: with `previewOccurrences` returning a fixed list the «preview
 * changes with the time» step is red; with the history read without the
 * `lastRun` dependency the new round never shows and «reads outcome and
 * output» is red.
 *
 * Video on: the recording is the proof.
 *
 * @covers R25
 */
import { expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { test } from "./fixtures/layout.fixture";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { VIDEO_ON } from "./video-evidence";

hermetic(test);
test.use({ video: VIDEO_ON });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const AXE_PATH = resolve(__dirname, "../../node_modules/axe-core/axe.min.js");
const CLOCK_START = "2030-03-04T08:00:00.000Z";
const CLOCK_LATER = "2030-03-04T08:03:00.000Z";
const SECTION = "scheduled-jobs";

async function advance(page: Page, now: string | null) {
  const response = await page.request.post(`${E2E_BASE}/api/test/scheduled-cards/advance`, { data: { now } });
  expect(response.ok()).toBe(true);
}

async function cleanJobs(page: Page) {
  const { jobs } = await (await page.request.get(`${E2E_BASE}/api/scheduled-jobs`)).json() as { jobs: Array<{ id: string }> };
  for (const job of jobs) await page.request.delete(`${E2E_BASE}/api/scheduled-jobs/${job.id}`);
}

test.describe("scheduled jobs in the Automations view, no hub", () => {
  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await cleanJobs(page);
    await advance(page, CLOCK_START);
  });
  test.afterEach(async ({ page }) => {
    await cleanJobs(page);
    await advance(page, null);
  });

  test("create, preview, fire, read the outcome, pause, run now, delete", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goToApp(page);
    await page.getByTestId("sidebar-automations").click();
    const pane = page.getByTestId("automations-pane");
    await expect(pane).toBeVisible({ timeout: 20_000 });
    const section = pane.getByTestId(SECTION);
    await expect(section.getByTestId("sj-empty")).toBeVisible();
    // No hub: nothing of the hub is drawn, the section stands alone.
    await expect(pane.getByTestId("automations-verdict")).toHaveCount(0);

    await section.getByTestId("sj-new").click();
    const form = section.getByTestId("sj-form");
    await form.getByTestId("sj-name-input").fill("Saluto");
    await form.getByTestId("sj-command").fill("echo ciao-lavori");

    // The preview follows the time field.
    await form.getByTestId("sj-time").fill("09:00");
    const items = form.getByTestId("sj-preview-item");
    await expect(items).toHaveCount(3);
    const before = await items.evaluateAll((els) => els.map((e) => e.getAttribute("data-at")));
    await form.getByTestId("sj-time").fill("18:30");
    await expect.poll(async () => items.evaluateAll((els) => els.map((e) => e.getAttribute("data-at")))).not.toEqual(before);
    await expect(items.first()).toContainText("18:30");
    // A rule the server would refuse says so before saving.
    await form.getByTestId("sj-when-custom").click();
    await form.getByTestId("sj-cron").fill("61 * * * *");
    await expect(form.getByTestId("sj-preview-error")).toBeVisible();
    await expect(form.getByTestId("sj-save")).toBeDisabled();
    await form.getByTestId("sj-when-every").click();
    await form.getByTestId("sj-every").fill("1");
    await expect(items).toHaveCount(3);
    await form.getByTestId("sj-save").click();

    const row = section.getByTestId("sj-row");
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("sj-name")).toHaveText("Saluto");
    await expect(row.getByTestId("sj-last")).toHaveAttribute("data-status", "none");

    // The injected clock reaches the first occurrence: the real tick runs the command.
    await advance(page, CLOCK_LATER);
    await expect(row.getByTestId("sj-last")).toHaveAttribute("data-status", "ok", { timeout: 30_000 });
    await row.getByTestId("sj-toggle").click();
    const runs = row.getByTestId("sj-runs").getByTestId("sj-run-row");
    await expect(runs.first()).toHaveAttribute("data-status", "ok");
    await expect(runs.first().getByTestId("sj-run-output")).toContainText("ciao-lavori");
    await expect(runs.first().getByTestId("sj-run-duration")).toBeVisible();
    const firstCount = await runs.count();

    // Pause: the job stays, no next round.
    await row.getByTestId("sj-pause").click();
    await expect(row).toHaveAttribute("data-enabled", "false");
    await expect(row).toContainText(/in pausa/i);

    // Run now works on a paused job and adds a round to the history.
    await row.getByTestId("sj-run").click();
    await expect(runs).toHaveCount(firstCount + 1, { timeout: 30_000 });

    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(section).toBeVisible();
      await testInfo.attach(`scheduled-jobs-${width}`, { body: await page.screenshot(), contentType: "image/png" });
    }

    // Axe on the section: no violation.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addScriptTag({ path: AXE_PATH });
    const violations = await page.evaluate(async (testId) => {
      const axe = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: Array<{ id: string; help: string }> }> } }).axe;
      const res = await axe.run({ include: [[`[data-testid="${testId}"]`]] }, { resultTypes: ["violations"] });
      return res.violations.map((v) => `${v.id}: ${v.help}`);
    }, SECTION);
    expect(violations).toEqual([]);

    // Delete asks first, then the job and its history are gone.
    await row.getByTestId("sj-delete").click();
    await page.getByRole("button", { name: "Cancella", exact: true }).click();
    await expect(section.getByTestId("sj-empty")).toBeVisible();
  });
});
