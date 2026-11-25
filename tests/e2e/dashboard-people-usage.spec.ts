/**
 * WHO SPENT THE WEEKLY QUOTA, PER PERSON (USAGE-27).
 *
 * Two channel messages from the same human, one from Discord and one from
 * WhatsApp, reach the chat route with their `sender`; two usage records carry
 * the work. The Dashboard's «Who used it» box shows two people with the share
 * of one account the quota history gives them; a click opens the requests;
 * «Merge into» folds the WhatsApp person into the Discord one and the list
 * becomes one row at once, not at the next poll.
 *
 * The quota history is written into the test server's isolated HOME, the
 * people and the records go through the real API. Names and ids are
 * placeholders.
 *
 * Mutation: without `peopleCache = null` after the merge (server/routes/usage.ts)
 * the second count stays 2; without the record's author the box has no name.
 *
 * Video on: the recording is the proof.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
import { VIDEO_ON } from "./video-evidence";

hermetic(test);
test.use({ video: VIDEO_ON });

const HOUR = 3_600_000;

async function openDashboard(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "dashboard" } }));
    return document.querySelector('[data-testid="dashboard-pane"]') !== null;
  }), { timeout: 20_000 }).toBe(true);
}

test("who used it: two channels of one person, the share of an account, the requests, the merge", async ({ page, request }, testInfo) => {
  test.info().annotations.push({ type: "spec", description: "USAGE-27" });
  const now = Date.now();
  // an hour already started by at least 10 s, so every sample is in the past whatever the clock
  const hour = Math.floor((now - 10_000) / HOUR) * HOUR;
  // 0% and then 12% on one account inside the current hour: 12 points to split.
  // `t` is in seconds, as the hub writes it.
  const dir = join(E2E_HOME, ".topics", "usage-history");
  mkdirSync(dir, { recursive: true });
  const sec = (ms: number) => Math.floor(ms / 1000);
  writeFileSync(join(dir, "history.jsonl"), [
    JSON.stringify({ t: sec(hour + 1_000), s: { "claude|e2e-account|7d": 0 } }),
    JSON.stringify({ t: sec(hour + 2_000), s: { "claude|e2e-account|7d": 12 } }),
  ].join("\n") + "\n");

  const tag = Date.now().toString(36);
  const records = [
    { id: `e2e-${tag}-1`, sender: { channel: "discord", id: "10000000000000000777", name: "Dana E2E" }, inputTokens: 3000, label: "Rifai il bilancio" },
    { id: `e2e-${tag}-2`, sender: { channel: "whatsapp", id: "+390000000777", name: "Dana E2E" }, inputTokens: 1000, label: "Scadenze IMU" },
  ];
  for (const r of records) {
    const res = await request.post(`${E2E_BASE}/api/usage/records`, {
      data: { ...r, ts: hour + 1_500, model: "claude-e2e", purpose: "channel-guest-turn", outputTokens: 0 },
    });
    expect(res.status()).toBe(201);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await goToApp(page);
  await openDashboard(page);
  const box = page.getByTestId("dashboard-people-usage");
  await expect(box).toBeVisible({ timeout: 20_000 });
  const dana = box.getByTestId("people-usage-row").filter({ hasText: "Dana E2E" });
  await expect(dana).toHaveCount(2, { timeout: 20_000 });
  // 3000 and 1000 weighted tokens in the same hour: 9 and 3 of the 12 points.
  await expect(dana.first()).toContainText(/9[.,]0?%|9%/);
  await page.screenshot({ path: testInfo.outputPath("vero-chi-ha-consumato-prima.png") });

  // The requests of one person.
  await dana.first().click();
  await expect(box.getByTestId("people-usage-request")).toContainText(["Rifai il bilancio"]);
  await box.getByTestId("people-usage-back").click();

  // Merge the WhatsApp person (the smaller row) into the Discord one.
  const mergeButtons = box.getByRole("button", { name: /Dana E2E/ }).filter({ has: page.locator("svg") });
  await mergeButtons.last().click();
  await page.getByRole("menuitem", { name: "Dana E2E" }).click();
  await expect(dana).toHaveCount(1, { timeout: 10_000 });
  await expect(dana).toContainText(/12[.,]0?%|12%/);
  await expect(box.getByTestId("people-usage-merge-error")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("vero-chi-ha-consumato-dopo.png") });
});
