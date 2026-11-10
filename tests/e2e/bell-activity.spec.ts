/**
 * THE CLAUDE PROXY'S ACTIVITY IN THE BELL (hub-smistamento, «Activity» merged
 * into the bell; HUBBR-06, HUBBR-07).
 *
 * The hub's Activity page listed the proxy's log: every event of the week,
 * newest first, with its time, a severity dot and a sentence. In Topics:
 *
 *   - the facts that matter light the bell with the panel closed: an account
 *     whose token the proxy could not renew, every account exhausted in the
 *     last hour (the log is read in the background, every minute);
 *   - the account rows of «Now» say how it happened: a switch automatic for a
 *     429, a limit for 10 minutes, the names under a cap, the proxy's error;
 *   - each account row opens History on «Account Claude»: every event of the
 *     week (found, renamed, switched off, removed, priority, settings,
 *     upgrade, a type nobody named yet), under its day, with its hour and
 *     minute and its severity in colour and in words;
 *   - with the panel open, a new event arrives within the minute.
 *
 * The hub is the fake (helpers/fake-hub.ts) answering a quiet hub and the
 * log this spec sets: the real :3360 and :3335 are never touched, the names
 * are placeholders. Video on: the recording is the proof; the shots go to the
 * test's output (`vero-campanella-attivita-*.png`).
 *
 * @covers HUBBR-06
 * @covers HUBBR-07
 */
import { expect, request as playwrightRequest, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { openMainChat, seedScene, type Scene as ShotScene } from "./helpers/shot-scene";
import { goToApp } from "./helpers";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE, canonicalTmpRoot } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WORK = "lavoro@example.com";
const SPARE = "riserva@example.com";

/** A week of the proxy's log, in its own shapes (usage-hub modules/switchboard/dashboard.mjs `logActivity`). */
function weekOfEvents(now: number): Array<Record<string, unknown>> {
  return [
    { type: "auto-switch", ts: now - 5 * MIN, from: WORK, to: SPARE, reason: "429" },
    { type: "rate-limited", ts: now - 6 * MIN, account: SPARE, retryAfter: 600 },
    { type: "all-exhausted", ts: now - 10 * MIN },
    { type: "refresh-failed", ts: now - 30 * MIN, account: WORK, error: "invalid_grant" },
    { type: "account-discovered", ts: now - HOUR, name: "auto-9", label: "nuovo@example.com" },
    { type: "brand-new-thing", ts: now - 90 * MIN },
    { type: "cap-exhausted", ts: now - 2 * HOUR, capped: [WORK, SPARE] },
    { type: "proactive-switch", ts: now - 3 * HOUR, from: SPARE, to: WORK },
    { type: "account-renamed", ts: now - DAY - HOUR, name: SPARE, label: "riserva-2@example.com" },
    { type: "account-enabled", ts: now - 2 * DAY, name: SPARE, enabled: false },
    { type: "account-removed", ts: now - 3 * DAY, name: "vecchio@example.com" },
    { type: "priority-set", ts: now - 4 * DAY, name: WORK, priority: 2 },
    { type: "settings-changed", ts: now - 5 * DAY },
    { type: "upgrade", ts: now - 6 * DAY, to: "2.4.0" },
  ];
}

/** The reader holds the fake hub: the bell knows the hub is there. */
async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: unknown }>;
    return snap.attesa?.data !== undefined;
  }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBe(true);
}

const panel = (page: Page) => page.getByTestId("inbox-panel");

test.describe("the proxy's activity in the bell", () => {
  let hub: FakeHub | null = null;
  let shot: ShotScene | null = null;
  let api: APIRequestContext | null = null;
  test.beforeAll(async ({ request }) => {
    hub = await startFakeHub([], { quiet: true });
    hub.activity = weekOfEvents(Date.now());
    await waitForHub(request);
    api = await playwrightRequest.newContext();
    shot = await seedScene(api, `${canonicalTmpRoot()}/e2e-bell-activity-${Date.now().toString(36)}`);
  });
  test.afterAll(async ({ request }) => {
    await shot?.cleanup(request);
    await api?.dispose();
    await hub?.close();
  });

  test("an expired token lights the bell by itself; the rows say how; History has the whole week, hour by hour, and the next event within the minute", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    // The diary re-reads every 60 s while History is open: the page clock lets
    // the test jump that minute instead of waiting it out (real time still flows).
    await page.clock.install();
    await goToApp(page);
    await openMainChat(page, shot!);

    // Panel closed: the token not renewed and every account exhausted ten minutes ago light the button, grey.
    const count = page.getByTestId("inbox-count");
    await expect(count).toHaveAttribute("data-notification-count", "2", { timeout: 20_000 });
    await expect(page.getByTestId("inbox-button")).toHaveAttribute("data-tone", "quiet");

    await page.getByTestId("inbox-button").click();
    const quota = panel(page).getByTestId("bell-group-quota");
    await expect(quota).toBeVisible({ timeout: 15_000 });
    const row = (type: string) => quota.locator(`[data-source="account"][data-type="${type}"]`);
    // The switch: automatic, for a 429; twice in the day (the early one three hours ago).
    await expect(row("auto-switch")).toContainText(`Account cambiato: ${WORK} → ${SPARE}`);
    await expect(row("auto-switch").getByTestId("bell-account-note")).toHaveText("automatico, errore 429");
    await expect(row("auto-switch")).toContainText("2 volte nelle ultime 24 ore");
    await expect(row("rate-limited").getByTestId("bell-account-note")).toHaveText("per 10 min");
    // A cap on every account is not «every account exhausted»: two rows, the cap with its names.
    await expect(row("cap-exhausted")).toContainText("Tetto raggiunto: tutti gli account");
    await expect(row("cap-exhausted").getByTestId("bell-account-note")).toHaveText(`${WORK}, ${SPARE}`);
    await expect(row("all-exhausted")).toContainText("Limite raggiunto: tutti gli account");
    // The proxy's error, and «Rinnova» beside it.
    await expect(row("refresh-failed").getByTestId("bell-account-note")).toHaveText("invalid_grant");
    await expect(row("refresh-failed").getByTestId("bell-renew")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("vero-campanella-attivita-ora-scuro.png") });

    // From an account row to the whole week of the accounts.
    await row("auto-switch").getByTestId("bell-account-history").click();
    await expect(panel(page).getByTestId("inbox-tab-history")).toHaveAttribute("aria-selected", "true");
    await expect(panel(page).getByTestId("bell-history-accounts")).toHaveAttribute("aria-pressed", "true");
    const events = panel(page).getByTestId("bell-proxy-row");
    await expect(events).toHaveCount(14);
    await expect(panel(page).getByTestId("bell-history-accounts")).toHaveAttribute("data-count", "14");
    // Newest first, each under its day with its hour and minute.
    await expect(events.first()).toHaveAttribute("data-type", "auto-switch");
    await expect(events.last()).toHaveAttribute("data-type", "upgrade");
    for (const time of await events.getByTestId("bell-time").allTextContents()) expect(time).toMatch(/^\d{2}:\d{2}$/);
    expect(await panel(page).getByTestId("bell-history-day").count()).toBeGreaterThanOrEqual(6);
    // The sentences of the hub's page, and its severity in colour and in words (allow-italian: the copy under test).
    const event = (type: string) => panel(page).locator(`[data-testid="bell-proxy-row"][data-type="${type}"]`);
    await expect(event("auto-switch")).toContainText(`Cambio automatico da ${WORK} a ${SPARE}`);
    await expect(event("auto-switch").getByTestId("bell-proxy-detail")).toHaveText("errore 429");
    await expect(event("proactive-switch")).toContainText(`Cambio in anticipo da ${SPARE} a ${WORK}`);
    await expect(event("refresh-failed")).toHaveAttribute("data-tone", "bad");
    await expect(event("refresh-failed").getByTestId("bell-row-status")).toHaveAttribute("title", "problema");
    await expect(event("refresh-failed").getByTestId("bell-proxy-detail")).toHaveText("invalid_grant");
    await expect(event("account-discovered")).toContainText("Trovato nuovo@example.com");
    await expect(event("account-discovered")).toHaveAttribute("data-tone", "ok");
    await expect(event("account-renamed")).toContainText(`${SPARE} rinominato in riserva-2@example.com`);
    await expect(event("account-enabled")).toContainText(`${SPARE} spento: escluso dalla rotazione`);
    await expect(event("account-removed")).toContainText("vecchio@example.com rimosso");
    await expect(event("priority-set")).toContainText(`${WORK}: priorità impostata a 2`);
    await expect(event("settings-changed")).toContainText("Impostazioni del proxy cambiate");
    await expect(event("upgrade")).toContainText("Proxy aggiornato a 2.4.0");
    await expect(event("brand-new-thing")).toContainText("Evento del proxy (brand new thing)");
    await page.screenshot({ path: testInfo.outputPath("vero-campanella-attivita-cronologia-scuro.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({ path: testInfo.outputPath("vero-campanella-attivita-cronologia-chiaro.png") });
    await page.emulateMedia({ colorScheme: "dark" });

    // Problems: the proxy's bad events (the token, the cap, every account out).
    await panel(page).getByTestId("bell-history-problems").click();
    await expect(events).toHaveCount(3);
    // The search reads the sentence.
    await panel(page).getByTestId("bell-history-accounts").click();
    await panel(page).getByTestId("bell-history-search").fill("rinominato");
    await expect(events).toHaveCount(1);
    await panel(page).getByTestId("bell-history-search").fill("");

    // With the panel open, a new event arrives by itself within the minute, as on the hub's page.
    hub!.activity = [{ type: "manual-switch", ts: Date.now(), to: WORK }, ...hub!.activity!];
    await page.clock.fastForward(60_000);
    await expect(events.first()).toContainText(`Cambio manuale a ${WORK}`, { timeout: 15_000 });
    await expect(events).toHaveCount(15);
  });
});
