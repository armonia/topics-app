/**
 * ACCOUNTS AND QUOTAS (hub-smistamento, HUBBR-10 and HUBBR-11).
 *
 * The row under the plan in the menu with your name opens «Account e quote»:
 * at the top the decision on the hot account, then the Claude accounts of the
 * proxy with their commands, Codex and Muse read-only with the hub's unlock,
 * the reserve keys, the proxy's rotation and caps, the brake. Every command reaches the fake service it belongs to
 * (the proxy for the accounts, the hub for the unlock and the background stop)
 * and the view shows what it reads back. The card with your name carries the
 * hottest quota (92% of the week in the fixture), and the row and the view's
 * header count the same accounts (the proxy has one the hub's pace has not).
 * The Notifications level
 * carries the proxy's own alerts. With the hub gone the bars stay under the
 * band, and after a reload nothing of the hub is left.
 *
 * The hub is a fake (helpers/fake-hub.ts) on the port the test server reads;
 * it also answers for the Claude proxy. The real :3360 and :3335 are never
 * touched, and the names are placeholders.
 *
 * Mutation: with `commandRequest` (lib/accountQuotas.ts) sending «switch» to
 * the hub instead of the proxy, the card's use command is red (the account
 * stays ready); with the rules drawn from what was written instead of what was
 * read back, «a cap written and read back» is red (the fake ignores 77).
 *
 * Video on: the recording is the proof. The screenshots of the built surface go
 * to the test's output (`vero-account-e-quote-*.png`): the menu with the row
 * and the view, dark and light, and the phone.
 *
 * @covers HUBBR-10
 * @covers HUBBR-11
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { openProfileMenu } from "./helpers/open-perf-panel";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const PANE = "accounts-pane";

async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: unknown[] }>;
    return Array.isArray(snap.pace?.data) ? snap.pace.data.length : -1;
  }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBe(3);
}

async function waitForHubDown(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { error?: string }>;
    return typeof snap.pace?.error;
  }, { timeout: 30_000 }).toBe("string");
}

async function openFromMenu(page: Page): Promise<void> {
  await openProfileMenu(page);
  await page.getByTestId("menu-account-quotas").click();
  await expect(page.getByTestId(PANE)).toBeVisible({ timeout: 20_000 });
}

const card = (page: Page, name: string) => page.getByTestId(PANE).locator(`[data-testid="account-card"][data-account="${name}"]`);
const metered = (page: Page, provider: string) => page.getByTestId(PANE).locator(`[data-testid="metered-card"][data-provider="${provider}"]`);

test.describe("accounts and quotas", () => {
  let hub: FakeHub | null = null;

  test.beforeAll(async ({ request }) => {
    hub = await startFakeHub();
    await waitForHub(request);
  });
  test.afterAll(async () => {
    await hub?.close();
  });

  test("phone, 390 px: one column, nothing wider than the screen", async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({
      baseURL: E2E_BASE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "dark", locale: "it-IT",
      recordVideo: { dir: testInfo.outputPath("phone-video"), size: { width: 390, height: 844 } },
    });
    const page = await ctx.newPage();
    try {
      await page.goto("/");
      await expect(page.getByTestId("mobile-chrome-bar")).toBeVisible({ timeout: 30_000 });
      // The menu with your name, the row and its tail, on the phone.
      await openProfileMenu(page);
      await expect(page.getByTestId("menu-account-quotas-tail")).toHaveText("sett. 92% · 6 account", { timeout: 20_000 });
      await page.screenshot({ path: testInfo.outputPath("vero-account-e-quote-telefono-menu.png") });
      await page.keyboard.press("Escape");
      await expect.poll(() => page.evaluate(() => {
        window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "accounts" } }));
        return document.querySelector('[data-testid="accounts-pane"]') !== null;
      }), { timeout: 20_000 }).toBe(true);
      const pane = page.getByTestId(PANE);
      await expect(pane.getByTestId("account-card")).toHaveCount(4, { timeout: 20_000 });
      await expect(pane.getByTestId("metered-card")).toHaveCount(2);
      await expect(pane.getByTestId("accounts-decide")).toBeVisible();
      const widths = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        pane: document.querySelector<HTMLElement>('[data-testid="accounts-pane"]')!.scrollWidth,
      }));
      expect(widths.doc).toBeLessThanOrEqual(390);
      expect(widths.pane).toBeLessThanOrEqual(390);
      // One column: the second card sits under the first.
      const [a, b] = await Promise.all([pane.getByTestId("account-card").nth(0).boundingBox(), pane.getByTestId("account-card").nth(1).boundingBox()]);
      expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
      // The decision wraps under its text: nothing overflows its box.
      const decide = await pane.getByTestId("accounts-decide").evaluate((el) => el.scrollWidth <= el.clientWidth);
      expect(decide).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("vero-account-e-quote-telefono.png") });
    } finally {
      await ctx.close();
    }
  });

  test("the row with your name opens the view: Claude with the proxy's commands, Codex and Muse read-only", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await goToApp(page);

    // The card with your name carries the hottest quota of a plan in use.
    await expect(page.getByTestId("identity-hot-quota")).toHaveText("sett. 92%", { timeout: 20_000 });
    await openProfileMenu(page);
    const tail = page.getByTestId("menu-account-quotas-tail");
    // Four proxy accounts (one off, absent from the hub's pace) plus Codex and Muse.
    await expect(tail).toHaveText("sett. 92% · 6 account", { timeout: 20_000 });
    await expect(tail).toHaveAttribute("data-warn", "true");
    await page.screenshot({ path: testInfo.outputPath("vero-account-e-quote-menu-scuro.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({ path: testInfo.outputPath("vero-account-e-quote-menu-chiaro.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByTestId("menu-account-quotas").click();
    const pane = page.getByTestId(PANE);
    await expect(pane).toBeVisible({ timeout: 20_000 });

    // The one in use first, then by priority; each with its state.
    await expect(pane.getByTestId("account-card")).toHaveCount(4, { timeout: 20_000 });
    await expect(pane.getByTestId("accounts-count")).toHaveText("6");
    await expect(card(page, "prof-d")).toHaveAttribute("data-state", "off");

    // The decision first: the account in use is past the board's line, with the switch to the next ready one.
    const decide = pane.getByTestId("accounts-decide");
    await expect(decide.getByTestId("accounts-decide-title")).toHaveText("lavoro@example.com è al 92% della settimana");
    await expect(decide).toContainText("Dal 90% la board non avvia card nuove; si azzera");
    await expect(decide.getByTestId("accounts-decide-switch")).toHaveText("Passa a riserva@example.com");
    await expect(decide.getByTestId("accounts-decide-hold")).toHaveText("Ferma il background per 2 h");
    const [decideBox, gridBox] = await Promise.all([decide.boundingBox(), pane.getByTestId("accounts-grid").boundingBox()]);
    expect(decideBox!.y).toBeLessThan(gridBox!.y);
    await expect(pane.getByTestId("account-card").first()).toHaveAttribute("data-account", "prof-a");
    await expect(card(page, "prof-a")).toHaveAttribute("data-state", "in-use");
    await expect(card(page, "prof-a").getByTestId("account-bar-week")).toHaveAttribute("data-pct", "92");
    await expect(card(page, "prof-b")).toHaveAttribute("data-state", "ready");
    await expect(card(page, "prof-c")).toHaveAttribute("data-state", "expired");
    await expect(card(page, "prof-c").getByTestId("account-card-refresh")).toBeVisible();
    await expect(pane).toContainText("si usano dall'alto in giù · Più margine sul ritmo");

    // Codex and Muse: bars, no account command, only the hub's unlock.
    for (const p of ["codex", "muse"]) {
      await expect(metered(page, p).getByTestId("account-bar-week")).toBeVisible();
      await expect(metered(page, p).getByTestId("account-card-more")).toHaveCount(0);
      await expect(metered(page, p).getByTestId("account-card-use")).toHaveCount(0);
      await expect(metered(page, p).getByTestId("metered-unlock")).toHaveText("Sblocca il freno per 2 ore");
    }
    await expect(metered(page, "muse")).toHaveAttribute("data-braked", "true");
    await expect(pane.getByTestId("api-key-row")).toHaveCount(2);
    await expect(pane.getByTestId("accounts-brake-row")).toHaveCount(4);
    await expect(pane.getByTestId("accounts-brake-row").last()).toContainText("Gratis → Muse → Codex → Claude");
    await expect(pane.getByTestId("accounts-pace")).toContainText("Claude: 92% della quota, 55% della settimana passata");
    await page.screenshot({ path: testInfo.outputPath("vero-account-e-quote-scuro.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({ path: testInfo.outputPath("vero-account-e-quote-chiaro.png") });
    await page.emulateMedia({ colorScheme: "dark" });

    // The card's use command goes to the proxy, and the card reads back in use; the proxy pins sticky.
    await card(page, "prof-b").getByTestId("account-card-use").click();
    await expect(card(page, "prof-b")).toHaveAttribute("data-state", "in-use", { timeout: 10_000 });
    expect(hub!.posts).toContainEqual({ path: "switch", name: "prof-b" });
    await expect(pane).toContainText("Resta sull'attuale");

    // Priority from the card's menu.
    await card(page, "prof-c").getByTestId("account-card-more").click();
    await page.getByTestId("account-cmd-up").click();
    await expect.poll(() => hub!.posts).toContainEqual({ path: "priority", name: "prof-c", priority: 1 });

    // The account's own cap: written, and the marker drawn from the read-back.
    await card(page, "prof-a").getByTestId("account-card-more").click();
    await page.getByTestId("account-cmd-cap").click();
    await card(page, "prof-a").getByTestId("account-cap-week").fill("95");
    await card(page, "prof-a").getByTestId("account-cap-save").click();
    await expect(card(page, "prof-a").getByTestId("account-cap-editor")).toHaveCount(0);
    expect(hub!.posts).toContainEqual({ path: "account-cap", name: "prof-a", fiveH: null, sevenD: 95 });

    // Muse's brake unlocked for 2 hours on the hub, and put back.
    await metered(page, "muse").getByTestId("metered-unlock").click();
    await expect(metered(page, "muse").getByTestId("metered-relock")).toBeVisible({ timeout: 10_000 });
    expect(hub!.posts).toContainEqual(expect.objectContaining({ path: "override", provider: "muse", hours: 2, by: "topics" }));
    await expect(metered(page, "muse")).toContainText("sbloccato");
    await metered(page, "muse").getByTestId("metered-relock").click();
    await expect(metered(page, "muse").getByTestId("metered-unlock")).toBeVisible({ timeout: 10_000 });

    // A reserve key switched on.
    const key = pane.locator('[data-testid="api-key-row"][data-key="key-studio"]');
    await key.getByTestId("api-key-switch").click();
    await expect(key).toHaveAttribute("data-disabled", "false", { timeout: 10_000 });
    expect(hub!.posts).toContainEqual({ path: "api-profiles", name: "key-studio", disabled: false });

    // The background stop, for everybody, and back.
    await pane.getByTestId("accounts-hold-stop-1").click();
    await expect(pane.getByTestId("accounts-hold")).toHaveAttribute("data-held", "true", { timeout: 10_000 });
    await pane.getByTestId("accounts-hold-release").click();
    await expect(pane.getByTestId("accounts-hold")).toHaveAttribute("data-held", "false", { timeout: 10_000 });

    // Removing asks first, then the card goes.
    await card(page, "prof-c").getByTestId("account-card-more").click();
    await page.getByTestId("account-cmd-remove").click();
    await page.getByRole("dialog").getByRole("button", { name: "Togli", exact: true }).click();
    await expect(pane.getByTestId("account-card")).toHaveCount(3, { timeout: 10_000 });
    expect(hub!.posts).toContainEqual({ path: "remove", name: "prof-c" });
    await expect(pane.getByTestId("accounts-count")).toHaveText("5");
  });

  test("a cap written and read back; the proxy's alerts in Notifications", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goToApp(page);
    await openFromMenu(page);
    const pane = page.getByTestId(PANE);
    const cap = pane.getByTestId("accounts-rule-usageCap7d");
    await expect(cap).toHaveText(/nessuno/, { timeout: 20_000 });
    await cap.click();
    await page.getByRole("option", { name: "90%" }).click();
    await expect(cap).toHaveText(/90%/, { timeout: 10_000 });
    expect(hub!.posts).toContainEqual({ path: "settings", usageCap7d: 90 });
    // The cap of every account is the marker of the one with none of its own.
    await expect(card(page, "prof-b").getByTestId("account-bar-week").locator("[title]")).toHaveAttribute("title", /Tetto 90%/);

    await pane.getByTestId("accounts-rule-autoSwitch").click();
    await expect(pane.getByTestId("accounts-rule-autoSwitch")).toHaveAttribute("aria-checked", "false", { timeout: 10_000 });
    expect(hub!.posts).toContainEqual({ path: "settings", autoSwitch: false });

    await openProfileMenu(page);
    await page.getByTestId("topics-menu-notifications").click();
    const alerts = page.getByTestId("notif-proxy-alerts");
    await expect(alerts).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
    await alerts.click();
    await expect(alerts).toHaveAttribute("aria-checked", "false", { timeout: 10_000 });
    expect(hub!.posts).toContainEqual({ path: "settings", notifications: false });
  });

  test("hub gone: the bars stay under the band; after a reload no row, no quota on the card", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goToApp(page);
    await openFromMenu(page);
    const pane = page.getByTestId(PANE);
    await expect(metered(page, "codex").getByTestId("account-bar-week")).toHaveAttribute("data-pct", "28", { timeout: 20_000 });
    await hub!.close();
    hub = null;
    await waitForHubDown(request);
    await expect(pane.getByTestId("accounts-hub-down")).toBeVisible({ timeout: 30_000 });
    await expect(pane.getByTestId("accounts-hub-down")).toContainText("Hub muto: barre ferme alla lettura delle");
    await expect(metered(page, "codex").getByTestId("account-bar-week")).toHaveAttribute("data-pct", "28");
    await page.screenshot({ path: testInfo.outputPath("vero-account-e-quote-hub-fermo.png") });

    await page.reload();
    await expect(page.getByTestId("identity-me-profile")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("identity-hot-quota")).toHaveCount(0);
    await openProfileMenu(page);
    await expect(page.getByTestId("menu-account-quotas")).toHaveCount(0);
  });
});
