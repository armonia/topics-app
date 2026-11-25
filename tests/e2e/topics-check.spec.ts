/**
 * The «Verifica di Topics» row in the Automations view: green first, then red allow-italian: the quoted UI label is the subject
 * with the detail of its three voices (their hours lost and the cause).
 *
 * The round's answer is faked in the page, so the test proves what the view
 * draws from it, at 375, 768, 1440 and 3440 px. The round itself is proved by
 * `server/services/topics-check.test.ts`.
 *
 * Video on: the recording is the proof; the screenshots go to the test's output.
 *
 * @covers CHECK-01
 * @covers CHECK-04
 */
import { expect, test, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore } from "./helpers/api-fixtures";
import { openMainChat, openSceneInSidebar, seedScene, type Scene } from "./helpers/shot-scene";
import { goToApp } from "./helpers";
import { canonicalTmpRoot } from "./helpers/test-server";
import { VIDEO_ON } from "./video-evidence";

hermetic(test);
test.use({ video: VIDEO_ON });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const GREEN = [
  { id: "cards", red: false, hoursLost: 0, detail: "le card avanzano", cause: null },
  { id: "seats", red: false, hoursLost: 0, detail: "i nodi danno i posti promessi", cause: null },
  { id: "proofs", red: false, hoursLost: 0, detail: "nessuna prova dichiarata", cause: null },
];
const RED = [
  { id: "cards", red: true, hoursLost: 52, detail: "3 card ferme, 27 rimbalzi: 52.3 h perse", cause: "in attesa di una persona" },
  { id: "seats", red: true, hoursLost: 9, detail: "9 h su 12 h", cause: "un nodo ha dichiarato posti e ne dà 0 mentre c'è coda" },
  GREEN[2],
];

async function fakeRound(
  page: Page, answer: () => unknown,
  round: () => { state: string; ageMin: number | null } = () => ({ state: "live", ageMin: 1 }),
  cures: () => unknown = () => undefined,
  daily: () => unknown = () => null,
): Promise<void> {
  await page.route("**/api/topics-check", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ at: Date.now(), ...round(), voices: answer(), cures: cures(), daily: daily() }) }));
}

test.describe("topics check row", () => {
  let scene: Scene | null = null;
  test.beforeAll(async ({ request }) => { scene = await seedScene(request, `${canonicalTmpRoot()}/e2e-topics-check-${Date.now().toString(36)}`); });
  test.afterAll(async ({ request }) => { await scene?.cleanup(request); });
  test.beforeEach(async ({ request }) => {
    if (!scene) return;
    await resetPaneStore(request, []);
    await openSceneInSidebar(request, scene);
  });

  test("green, then red, then stopped with the detail of the three voices", async ({ page }, testInfo) => {
    let answer: unknown = GREEN;
    let round = { state: "live", ageMin: 1 as number | null };
    let cures: unknown;
    await page.setViewportSize({ width: 1440, height: 900 });
    await fakeRound(page, () => answer, () => round, () => cures);
    await goToApp(page);
    await openMainChat(page, scene!);
    await page.getByTestId("sidebar-automations").click();
    const check = page.getByTestId("topics-check");
    await expect(check).toBeVisible({ timeout: 20_000 });
    await expect(check).toHaveAttribute("data-state", "green");
    await expect(check.getByTestId("topics-check-state")).toHaveText("Tutto avanza");
    // No cure capped or investigated: no line about them.
    await expect(check.getByTestId("topics-check-cures")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("topics-check-verde-1440.png") });

    // The next read after the round turned red: reload the view's data by reopening it.
    answer = RED;
    // The daily cap of investigation cards was reached: the row says how many were left unopened.
    cures = { investigated: ["c1"], capped: ["c2", "c3"] };
    await page.reload();
    await openMainChat(page, scene!);
    await page.getByTestId("sidebar-automations").click();
    await expect(check).toHaveAttribute("data-state", "red", { timeout: 20_000 });
    await expect(check.getByTestId("topics-check-state")).toHaveText("2 da guardare");
    await expect(check.getByTestId("topics-check-cures")).toHaveText("tetto di indagini del giorno raggiunto, non aperte: 2 · card d'indagine aperte: 1");
    await check.getByTestId("topics-check-toggle").click();
    const voices = check.getByTestId("topics-check-voice");
    await expect(voices).toHaveCount(3);
    await expect(voices.nth(0)).toContainText("in attesa di una persona");
    await expect(voices.nth(1)).toContainText("9 h su 12 h");
    await expect(voices.nth(2)).toHaveAttribute("data-red", "false");

    for (const [w, h] of [[375, 812], [768, 1024], [1440, 900], [3440, 1440]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await expect(check).toBeVisible();
      // A new width can mount the view again, closed: the photo is of the detail.
      const toggle = check.getByTestId("topics-check-toggle");
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      await expect(voices).toHaveCount(3);
      await page.screenshot({ path: testInfo.outputPath(`topics-check-rosso-${w}.png`) });
    }

    // A check that stopped is never green, whatever its last voices said.
    answer = GREEN;
    round = { state: "stale", ageMin: 17 };
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await openMainChat(page, scene!);
    await page.getByTestId("sidebar-automations").click();
    await expect(check).toHaveAttribute("data-state", "stale", { timeout: 20_000 });
    await expect(check.getByTestId("topics-check-state")).toHaveText("verifica ferma da 17 min");
    await page.screenshot({ path: testInfo.outputPath("topics-check-ferma-1440.png") });
  });
  test("the daily reading: red and green read differently, and an older one says it is not today's", async ({ page }, testInfo) => {
    const reading = (over: Record<string, unknown>) => ({ day: "2026-11-22", old: false, color: "green", reason: null, line: "tutto regolare", cardId: null, cardNote: null, ...over });
    let daily: unknown = reading({});
    await page.setViewportSize({ width: 1440, height: 900 });
    await fakeRound(page, () => GREEN, undefined, undefined, () => daily);
    await goToApp(page);
    await openMainChat(page, scene!);
    await page.getByTestId("sidebar-automations").click();
    const line = page.getByTestId("topics-check").getByTestId("topics-check-daily");
    await expect(line).toHaveAttribute("data-state", "green", { timeout: 20_000 });
    await expect(line).toContainText("Lettura del giorno, 2026-11-22: tutto regolare");
    const color = async () => line.evaluate((el) => getComputedStyle(el).color);
    const greenInk = await color();
    await page.screenshot({ path: testInfo.outputPath("topics-check-giorno-verde-1440.png") });

    daily = reading({ color: "red", line: "i lavori falliscono ogni notte", cardNote: "capped" });
    await page.reload();
    await openMainChat(page, scene!);
    await page.getByTestId("sidebar-automations").click();
    await expect(line).toHaveAttribute("data-state", "red", { timeout: 20_000 });
    await expect(line).toContainText("nessuna card: tetto del giorno raggiunto");
    expect(await color()).not.toBe(greenInk);
    for (const [w, h] of [[375, 812], [768, 1024], [1440, 900], [3440, 1440]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await expect(line).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`topics-check-giorno-rosso-${w}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    daily = reading({ day: "2026-11-19", old: true });
    await page.reload();
    await openMainChat(page, scene!);
    await page.getByTestId("sidebar-automations").click();
    await expect(line).toHaveAttribute("data-state", "old", { timeout: 20_000 });
    await expect(line).toContainText("non di oggi");
    await page.screenshot({ path: testInfo.outputPath("topics-check-giorno-vecchio-1440.png") });
  });
});
