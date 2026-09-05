/**
 * A GESTURE THE SERVER REFUSED, AND THE SCREEN THAT SAID NOTHING.
 *
 * The same shape in five places: the request goes out, the outcome is never
 * looked at, and the surface closes as if it had been accepted. Whoever pressed
 * cannot tell «it went» from «the server said no», and the next move for those
 * two is the opposite one. Two of the five were the dangerous kind: revoking a
 * public profile page that stays alive, and revoking a device on the surface
 * that exists so that «authorization can be revoked at any time» is true for
 * people who do not use curl.
 *
 * Each test here mocks ONE route with a refusal and then asks the only question
 * that matters afterwards: is there something to read. Two of them ask a second
 * one, and it is the one a screenshot would miss: the typed text is still in
 * the field, and the state that was not changed is still shown as unchanged.
 *
 * The cron half of the family lives in `infra-panels.spec.ts`, next to the
 * fixture that already knows how to open that panel.
 */
import { test, expect, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** Where the screenshots of the refusals go: they are the card's evidence. */
const SHOTS = "test-results/refusals";

const JSON_HEADERS = { status: 200, contentType: "application/json" };

/**
 * Cmd+comma opens Preferences, and the keystroke is repeated until it lands.
 *
 * Same helper as `settings-profile-devices.spec.ts`, and for the same reason
 * written down there: the shortcut is listened for by an effect of the mounted
 * app, so a keypress sent to a freshly loaded document falls into the void.
 */
async function openSettings(page: Page, section: string) {
  await expect(page.locator('[aria-label="Topics sidebar"]')).toBeVisible({ timeout: 20000 });
  const panel = page.getByTestId("settings-panel");
  await expect(async () => {
    await page.keyboard.press("Meta+Comma");
    await expect(panel).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
  await panel.getByRole("button", { name: section, exact: true }).click();
  return panel;
}

test.describe("un rifiuto che nessuno stampa", () => {
  test("ACCOUNT-04: uno scollegamento rifiutato dice perche'", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "ACCOUNT-04" });

    // An account IS linked here: that is the state the bug hid in, because the
    // error row used to live inside the «no account linked» block.
    await page.route("**/api/auth/account", async (route) => {
      if (route.request().method() === "DELETE") {
        await route.fulfill({
          ...JSON_HEADERS,
          status: 503,
          body: JSON.stringify({ ok: false, code: "service_unreachable" }),
        });
        return;
      }
      await route.fulfill({
        ...JSON_HEADERS,
        body: JSON.stringify({
          configured: true,
          linked: true,
          accountId: "acc-e2e",
          email: "someone@example.invalid",
          personId: "p-e2e",
          personName: "Chi usa l'app",
          linkedAt: Date.now(),
        }),
      });
    });

    await page.goto("/");
    await page.getByTestId("identity-me-profile").click();
    const signOut = page.getByTestId("account-signout");
    await expect(signOut).toBeVisible({ timeout: 20000 });
    await signOut.click();

    // The confirmation is the React `ConfirmDialog`, not `window.confirm`.
    const dialog = page.getByRole("dialog", { name: "Scollega" });
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await dialog.getByRole("button", { name: "Conferma" }).click();

    // The pointer that presses the confirmation falls outside the popover and
    // `useDismissable` closes it in the capture phase, so the row alone was not
    // enough: the reason travels as a toast too. Either surface answers the
    // question, and the test asks for the pair.
    const row = page.getByTestId("account-error");
    const toast = page.getByTestId("toast");
    await expect(row.or(toast).first()).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: `${SHOTS}/account-04-signout-refused.png` });
  });

  test("ORG-INST-03: un gruppo rifiutato non porta via il nome digitato", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "ORG-INST-03" });

    await page.route("**/api/auth/orgs", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      // One of the three refusals the server really answers with here.
      await route.fulfill({
        ...JSON_HEADERS,
        status: 400,
        body: JSON.stringify({ error: "name_required" }),
      });
    });

    await page.goto("/");
    const panel = await openSettings(page, "Organizzazione");

    await panel.getByRole("button", { name: "Nuovo gruppo" }).click();
    const field = panel.getByLabel("Nome del nuovo gruppo");
    await field.fill("Gruppo di prova");
    await panel.getByRole("button", { name: "Crea", exact: true }).click();

    await expect(panel.getByTestId("identity-group-error")).toBeVisible({ timeout: 10000 });
    // The second half, and the one a picture would not show: the form is still
    // open with what was typed in it. It used to close on every refusal.
    await expect(field).toHaveValue("Gruppo di prova");
    await page.screenshot({ path: `${SHOTS}/org-inst-03-create-refused.png` });
  });

  test("APPSET-07: una revoca rifiutata non spegne il link", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "APPSET-07" });

    // Only the DELETE is faked: publishing goes to the real server, so the
    // state the test then tries to revoke is a state the app really reached.
    await page.route("**/api/app-settings/profile-token", async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        ...JSON_HEADERS,
        status: 500,
        body: JSON.stringify({ error: "profile token store unavailable" }),
      });
    });

    await page.goto("/");
    const panel = await openSettings(page, "Profilo");

    const publish = panel.getByTestId("profile-public-publish");
    await expect(publish).toBeVisible({ timeout: 20000 });
    await publish.click();

    const revoke = panel.getByTestId("profile-public-revoke");
    await expect(revoke).toBeVisible({ timeout: 10000 });
    await revoke.click();

    await expect(panel.getByTestId("profile-public-error")).toBeVisible({ timeout: 10000 });
    // The link is still published, and the panel still says so: showing it as
    // closed on a request that failed is the one lie this surface must not
    // tell, because nothing else would ever correct it.
    await expect(revoke).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/appset-07-revoke-refused.png` });
  });

  test("DEVICEUI-01: una revoca rifiutata lascia il blocco d'errore, e resta", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "DEVICEUI-01" });

    const device = {
      id: "dev-e2e",
      name: "Telefono di prova",
      createdAt: Date.now() - 86_400_000,
      lastSeenAt: Date.now() - 60_000,
      firstIp: "192.168.1.20",
      revokedAt: null,
      connected: false,
      current: false,
      role: "guest" as const,
      person: null,
    };
    let reloads = 0;
    await page.route("**/api/auth/devices", async (route) => {
      reloads += 1;
      await route.fulfill({
        ...JSON_HEADERS,
        body: JSON.stringify({
          devices: [device],
          thisComputer: { name: "Questo computer", current: true },
          people: [],
        }),
      });
    });
    await page.route("**/api/auth/devices/*", async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        ...JSON_HEADERS,
        status: 400,
        body: JSON.stringify({ error: "unknown_device" }),
      });
    });

    await page.goto("/");
    const panel = await openSettings(page, "Dispositivi");
    await expect(panel.getByText("Telefono di prova")).toBeVisible({ timeout: 20000 });

    const before = reloads;
    await panel.getByRole("button", { name: "Revoca Telefono di prova" }).click();
    await panel.getByRole("button", { name: "Conferma revoca" }).click();

    const band = panel.getByTestId("devices-error");
    await expect(band).toBeVisible({ timeout: 10000 });
    // AND IT SURVIVES THE RELOAD THE GESTURE ITSELF TRIGGERS. That reload is
    // what used to erase the message: it clears the load error on success, and
    // the refusal was stored in the same place. Waiting for the list to have
    // been read again is what makes this assertion mean something.
    await expect.poll(() => reloads, { timeout: 10000 }).toBeGreaterThan(before);
    await expect(band).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/deviceui-01-revoke-refused.png` });
  });
});
