/**
 * THE PREFERENCES LIVE IN THE USER MENU, AND THE SETTINGS PANEL KEEPS THE FORMS.
 *
 * Every assertion here is about a door that moved (change
 * `sidebar-menu-settings`): the control has to be where the person now looks,
 * apply on change without closing the menu, and write where the old page
 * wrote. The routes the app really reads are stubbed only where the server
 * cannot be put in the needed state (the device list and its gestures, the
 * account link, a refused revoke of the public page).
 *
 * @covers USERMENU-01
 * @covers USERMENU-02
 * @covers USERMENU-03
 * @covers USERMENU-04
 * @covers USERMENU-05
 * @covers USERMENU-06
 * @covers USERMENU-07
 * @covers USERMENU-09
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { openProfileMenu } from "./helpers/open-perf-panel";
import { openOrganizationPage, openOwnProfile, openUserMenuLevel } from "./helpers/user-menu";

hermetic(test);

const JSON_OK = { status: 200, contentType: "application/json" };

/** The app's root: the element that carries the font size (App.tsx). */
async function rootFontSize(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = Array.from(document.querySelectorAll<HTMLElement>("#root div")).find((el) => el.style.fontSize !== "");
    return root?.style.fontSize ?? "";
  });
}

interface FakeDevice {
  id: string;
  name: string;
  revokedAt: number | null;
  connected: boolean;
  current: boolean;
  role: "owner" | "guest";
  person: { id: string; name: string } | null;
}

/**
 * `/api/auth/devices` and its three gestures, with state: a rename renames, a
 * revoke revokes, a move moves. Returns the calls, so a test can assert what
 * the level sent and not only what it shows.
 */
async function fakeDevices(page: Page, people: Array<{ id: string; name: string; owner: boolean }>) {
  const devices: FakeDevice[] = [{
    id: "dev-phone", name: "Telefono di prova", revokedAt: null, connected: true, current: false,
    role: "owner", person: people[0] ? { id: people[0].id, name: people[0].name } : null,
  }];
  const calls: Array<{ method: string; body: unknown }> = [];
  await page.route("**/api/auth/devices", (route) => route.fulfill({
    ...JSON_OK,
    body: JSON.stringify({ thisComputer: { name: "Questo computer", current: true }, devices, people }),
  }));
  await page.route("**/api/auth/devices/*", async (route: Route) => {
    const method = route.request().method();
    const body = route.request().postDataJSON() as { name?: string; personId?: string } | null;
    calls.push({ method, body });
    const device = devices[0];
    if (method === "DELETE") device.revokedAt = Date.now();
    if (method === "PATCH" && body?.name) device.name = body.name;
    if (method === "PATCH" && body?.personId) {
      const p = people.find((x) => x.id === body.personId);
      device.person = p ? { id: p.id, name: p.name } : null;
    }
    await route.fulfill({ ...JSON_OK, body: JSON.stringify({ ok: true }) });
  });
  return calls;
}

test.describe("il menu utente: le preferenze come controlli diretti", () => {
  test("USERMENU-01: tema e testo si cambiano dal livello Aspetto, e il menu resta aperto", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-01" });
    await request.put("/api/ui-state/theme", { data: JSON.stringify("system"), headers: { "Content-Type": "application/json" } });
    try {
      await goToApp(page);
      const level = await openUserMenuLevel(page, "appearance");
      const dark = level.getByTestId("appearance-theme-dark");
      await expect(level.getByTestId("appearance-theme-system")).toHaveAttribute("aria-checked", "true");
      await dark.click();

      await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
      await expect(dark).toHaveAttribute("aria-checked", "true");
      await expect(level).toBeVisible();
      await expect(page.getByTestId("profile-menu").or(page.getByTestId("sidebar-topics-menu-panel")).first()).toBeVisible();
      await expect(page.getByTestId("topics-menu-appearance-tail")).toContainText("Scuro");
      await expect.poll(async () => JSON.stringify(await (await request.get("/api/ui-state/theme")).json()), { timeout: 10_000 })
        .toContain("dark");
      // No preview: the menu does not cover the chat, the change is seen live.
      await expect(level.getByText("Hello! How are you?")).toHaveCount(0);
      // The text size from the keyboard: two steps up, then back.
      const size = level.getByTestId("appearance-font-size");
      const start = Number(await size.getAttribute("aria-valuenow"));
      expect(start).toBe(13);
      await size.focus();
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowUp");
      await expect(size).toHaveAttribute("aria-valuenow", "15");
      await expect.poll(() => rootFontSize(page)).toBe("15px");
      // Back where it was: the settings outlive this test on the shared server.
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect(size).toHaveAttribute("aria-valuenow", "13");
      await expect.poll(() => rootFontSize(page)).toBe("13px");
    } finally {
      await request.put("/api/ui-state/theme", { data: JSON.stringify("system"), headers: { "Content-Type": "application/json" } });
    }
  });

  test("USERMENU-02: Vista dice l'ordine attivo, e la riga della board sta qui", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-02" });
    await goToApp(page);
    const level = await openUserMenuLevel(page, "view");
    const timeline = level.getByTestId("topics-menu-view-mode-timeline");
    const byState = level.getByTestId("topics-menu-view-mode-state");
    await expect(timeline).toHaveAttribute("aria-checked", "true");
    await byState.click();
    await expect(byState).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("sidebar-state-section-rest")).toBeVisible({ timeout: 10_000 });
    await timeline.click();
    await expect(timeline).toHaveAttribute("aria-checked", "true");

    const boardRow = level.getByTestId("topics-menu-board-row");
    await expect(boardRow).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("sidebar-board-generale")).toBeVisible();
    await boardRow.click();
    await expect(boardRow).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("sidebar-board-generale")).toHaveCount(0);
    await boardRow.click();
    await expect(page.getByTestId("sidebar-board-generale")).toBeVisible();

    // And Appearance no longer has it.
    await page.keyboard.press("Escape");
    const appearance = await openUserMenuLevel(page, "appearance");
    await expect(appearance.getByTestId("topics-menu-board-row")).toHaveCount(0);
  });

  test("USERMENU-03: l'ingranaggio del campanello apre il livello Notifiche, e un progetto silenziato si riattiva da lì", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-03" });
    await goToApp(page);
    await page.getByTestId("notification-history-button").click();
    await expect(page.getByTestId("notification-history-panel")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("notification-settings-button").click();

    const level = page.getByTestId("topics-menu-notifications-menu");
    await expect(level).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("settings-panel")).toHaveCount(0);
    await expect(level.getByTestId("notif-enabled")).toHaveAttribute("role", "switch");
    // The push block is two levels: this device always, the others when there are some.
    await level.getByTestId("notif-this-device").click();
    await expect(page.getByTestId("notif-this-device-menu").getByTestId("push-status")).toBeVisible({ timeout: 10_000 });

    // A muted project is listed there and comes back with one gesture.
    const before = await (await request.get("/api/ui-state/settings")).json() as unknown;
    const current = (before && typeof before === "object" && "value" in (before as Record<string, unknown>)
      ? (before as { value: unknown }).value
      : before) as Record<string, unknown> | null;
    const muted = "/tmp/e2e-muted/progetto-silenziato";
    await request.put("/api/ui-state/settings", {
      data: { ...(current ?? {}), mutedProjects: [muted] },
      headers: { "Content-Type": "application/json" },
    });
    try {
      await goToApp(page);
      const again = await openUserMenuLevel(page, "notifications");
      const row = again.getByTestId(`muted-project-${muted}`);
      await expect(row).toBeVisible({ timeout: 10_000 });
      await expect(row).toContainText("progetto-silenziato");
      await row.getByTestId("muted-project-unmute").click();
      await expect(row).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => {
        const raw = localStorage.getItem("app-settings");
        return raw ? (JSON.parse(raw) as { mutedProjects?: string[] }).mutedProjects ?? [] : [];
      })).toEqual([]);
    } finally {
      await request.put("/api/ui-state/settings", {
        data: { ...(current ?? {}), mutedProjects: [] },
        headers: { "Content-Type": "application/json" },
      });
    }
  });
});

test.describe("il menu utente: i dispositivi si gestiscono dove si vedono", () => {
  test("USERMENU-04: rinomina, Di chi è con due persone, revoca con conferma in linea, i revocati un livello sotto", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-04" });
    const people = [{ id: "p-1", name: "Proprietario", owner: true }];
    const calls = await fakeDevices(page, people);
    await goToApp(page);
    let level = await openUserMenuLevel(page, "devices");
    const rows = level.getByTestId("device-row");
    await expect(rows).toHaveCount(2, { timeout: 10_000 });

    // The computer has neither pencil nor bin.
    await expect(rows.first().getByTestId("device-rename")).toHaveCount(0);
    await expect(rows.first().getByTestId("device-revoke")).toHaveCount(0);
    // One person: no «whose is it».
    await expect(level.getByTestId("device-whose")).toHaveCount(0);

    const phone = rows.nth(1);
    // Escape cancels the rename and leaves the menu open.
    await phone.getByTestId("device-rename").click();
    const field = level.getByTestId("device-rename-field");
    await expect(field).toBeFocused();
    await field.fill("Nome che non resta");
    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(level).toBeVisible();
    await expect(phone.getByTestId("device-name")).toHaveText("Telefono di prova");

    // Enter saves.
    await phone.getByTestId("device-rename").click();
    await level.getByTestId("device-rename-field").fill("Telefono di Anna");
    await page.keyboard.press("Enter");
    await expect(level.getByTestId("device-name")).toHaveText("Telefono di Anna", { timeout: 10_000 });
    expect(calls).toContainEqual({ method: "PATCH", body: { name: "Telefono di Anna" } });

    // A second person: the row gains «whose is it», which moves the device.
    people.push({ id: "p-2", name: "Collega", owner: false });
    await page.keyboard.press("Escape");
    await expect(level).toBeHidden({ timeout: 10_000 });
    level = await openUserMenuLevel(page, "devices");
    await expect(level.getByTestId("device-owner")).toContainText("Proprietario", { timeout: 10_000 });
    await level.getByTestId("device-whose").click();
    const whose = page.getByTestId("device-whose-menu");
    await expect(whose).toBeVisible();
    await whose.getByTestId("device-whose-p-2").click();
    await expect(level.getByTestId("device-owner")).toContainText("Collega", { timeout: 10_000 });
    expect(calls).toContainEqual({ method: "PATCH", body: { personId: "p-2" } });

    // Revoke asks in line, with the focus on the safe answer.
    await level.getByTestId("device-revoke").click();
    await expect(level.getByTestId("device-revoke-cancel")).toBeFocused();
    await expect(level.getByRole("dialog")).toHaveCount(0);
    await level.getByTestId("device-revoke-confirm").click();
    await expect(level.getByTestId("device-row")).toHaveCount(1, { timeout: 10_000 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    await level.getByTestId("devices-revoked-level").click();
    await expect(page.getByTestId("devices-revoked-level-menu").getByTestId("device-revoked-row")).toContainText("Telefono di Anna");
  });

  test("USERMENU-06: le Impostazioni hanno cinque voci, e Nodi ha l'aggiunta di un nodo ma non l'elenco dei dispositivi", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-06" });
    await goToApp(page);
    const panel = page.getByTestId("settings-panel");
    await expect(async () => {
      await page.keyboard.press("Meta+Comma");
      await expect(panel).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(panel.locator("nav button")).toHaveText(["Providers AI", "Strumenti", "Calendario", "Piano", "Nodi"]);
    await panel.locator("nav button", { hasText: /^Nodi$/ }).click();
    await expect(panel.getByTestId("settings-node-pair")).toBeVisible();
    await expect(panel.getByTestId("device-row")).toHaveCount(0);
    await expect(panel.getByTestId("devices-active")).toHaveCount(0);
  });
});

test.describe("chi sei sta nella tab Profilo", () => {
  test("USERMENU-05: un vecchio collegamento apre la tab Profilo, dove Persone e Fuori da Topics hanno una casa", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-05" });
    await page.route("**/api/app-settings/profile-token", async (route) => {
      if (route.request().method() !== "DELETE") { await route.fallback(); return; }
      await route.fulfill({ ...JSON_OK, status: 500, body: JSON.stringify({ error: "profile token store unavailable" }) });
    });
    await goToApp(page);
    // An old link to the organisation lands on the Profile tab's page.
    await openOrganizationPage(page);
    await expect(page.getByTestId("profile-pane").getByTestId("settings-page-organization")).toBeVisible();
    await expect(page.getByTestId("settings-panel")).toHaveCount(0);

    await openOwnProfile(page, "people");
    await expect(page.getByTestId("list-people").or(page.getByTestId("list-people-empty")).first()).toBeVisible();

    await page.getByTestId("profile-outside-open").click();
    const outside = page.getByTestId("profile-outside-panel");
    await expect(outside).toBeVisible();
    await expect(outside.getByTestId("discord-card")).toBeVisible({ timeout: 15_000 });
    const publish = outside.getByTestId("profile-public-publish");
    await expect(publish).toBeVisible({ timeout: 15_000 });
    await publish.click();
    const revoke = outside.getByTestId("profile-public-revoke");
    await expect(revoke).toBeVisible({ timeout: 10_000 });
    await revoke.click();
    await expect(outside.getByTestId("profile-public-error")).toBeVisible({ timeout: 10_000 });
    await expect(revoke).toBeVisible();
    // The profile tab has no field to sign in: that is the user menu's.
    await expect(page.getByTestId("profile-pane").getByTestId("account-email")).toHaveCount(0);
  });
});

test.describe("il menu da tastiera", () => {
  test("USERMENU-07: dalla card, con le frecce, fino al segmento del tema", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-07" });
    await request.put("/api/ui-state/theme", { data: JSON.stringify("system"), headers: { "Content-Type": "application/json" } });
    try {
      await goToApp(page);
      await openProfileMenu(page);
      const row = page.getByTestId("topics-menu-appearance");
      // Down the first level until the Appearance row holds the focus.
      for (let i = 0; i < 40; i += 1) {
        if (await row.evaluate((el) => el === document.activeElement)) break;
        await page.keyboard.press("ArrowDown");
      }
      await expect(row).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("topics-menu-appearance-menu")).toBeVisible();
      const system = page.getByTestId("appearance-theme-system");
      // The level's body is a chunk of its own: the arrow waits for its rows.
      await expect(system).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await expect(system).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("appearance-theme-light")).toHaveAttribute("aria-checked", "true");
      await expect(page.getByTestId("appearance-theme-light")).toBeFocused();
    } finally {
      await request.put("/api/ui-state/theme", { data: JSON.stringify("system"), headers: { "Content-Type": "application/json" } });
    }
  });
});

test.describe("sul telefono il menu del titolo è il menu utente", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("USERMENU-09: dal menu del titolo si accede, si esce, si rinomina e si revoca, e i livelli sono fogli da 44 px", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-09" });
    let linked = false;
    await page.route("**/api/auth/account", async (route) => {
      if (route.request().method() === "DELETE") {
        linked = false;
        await route.fulfill({ ...JSON_OK, body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({
        ...JSON_OK,
        body: JSON.stringify(linked
          ? { configured: true, linked: true, accountId: "acc-e2e", email: "someone@example.invalid", personId: "p-e2e", personName: "Chi usa l'app", linkedAt: Date.now() }
          : { configured: true, linked: false }),
      });
    });
    await page.route("**/api/auth/account/code", (route) => route.fulfill({ ...JSON_OK, body: JSON.stringify({ ok: true }) }));
    await page.route("**/api/auth/account/verify", async (route) => {
      linked = true;
      await route.fulfill({ ...JSON_OK, body: JSON.stringify({ ok: true }) });
    });
    const calls = await fakeDevices(page, [{ id: "p-1", name: "Proprietario", owner: true }]);

    await goToApp(page);
    // The levels open as a sheet over the sheet, with no target under 44px
    // (USERMENU-07 on the phone).
    const appearance = await openUserMenuLevel(page, "appearance");
    await expect(appearance.getByTestId("appearance-font-size")).toBeVisible();
    const box = await appearance.boundingBox();
    expect(box, "the level is laid out").not.toBeNull();
    expect(Math.round(box!.width)).toBe(390);
    expect(Math.round(box!.y + box!.height)).toBeGreaterThanOrEqual(840);
    const small = await appearance.evaluate((el) => Array.from(
      el.querySelectorAll<HTMLElement>('button, [role="spinbutton"], [role="radio"], [role="switch"], [role="combobox"]'),
    ).filter((b) => b.getBoundingClientRect().height > 0 && b.getBoundingClientRect().height < 44)
      .map((b) => `${b.getAttribute("data-testid") ?? b.getAttribute("aria-label") ?? b.textContent}: ${Math.round(b.getBoundingClientRect().height)}`));
    expect(small).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(appearance).toBeHidden({ timeout: 10_000 });

    const sheet = page.getByTestId("sidebar-topics-menu-panel");
    // Sign in: the account block is at the top of the title menu.
    const email = sheet.getByTestId("account-email");
    await expect(email).toBeVisible({ timeout: 15_000 });
    await email.fill("someone@example.invalid");
    await sheet.getByTestId("account-send-code").click();
    await sheet.getByTestId("account-code").fill("123456");
    await sheet.getByTestId("account-verify").click();
    const signOut = sheet.getByTestId("account-signout");
    await expect(signOut).toBeVisible({ timeout: 10_000 });

    // Rename and revoke from the Devices level, a sheet over the sheet.
    await sheet.getByTestId("profile-menu-devices").click();
    const level = page.getByTestId("profile-menu-devices-menu");
    await expect(level).toBeVisible({ timeout: 10_000 });
    await level.getByTestId("device-rename").click();
    await level.getByTestId("device-rename-field").fill("Telefono rinominato");
    await page.keyboard.press("Enter");
    await expect(level.getByTestId("device-name")).toHaveText("Telefono rinominato", { timeout: 10_000 });
    await level.getByTestId("device-revoke").click();
    await level.getByTestId("device-revoke-confirm").click();
    await expect(level.getByTestId("device-row")).toHaveCount(1, { timeout: 10_000 });
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "DELETE"]);

    // Sign out: the confirmation sits outside the sheet, which closes under it.
    await page.keyboard.press("Escape");
    await expect(level).toBeHidden({ timeout: 10_000 });
    await signOut.click();
    const dialog = page.getByRole("dialog", { name: "Scollega" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole("button", { name: "Conferma" }).click();
    await openProfileMenu(page);
    await expect(page.getByTestId("sidebar-topics-menu-panel").getByTestId("account-email")).toBeVisible({ timeout: 10_000 });
  });
});
