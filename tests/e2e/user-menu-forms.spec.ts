/**
 * EVERY SETTING IS IN THE USER MENU, THE FORMS TOO (the 02/10/2026 change).
 *
 * The maintainer, on 02/10, asked for the providers, the calendar and the
 * rest to be in the user menu itself, and for the Settings button to go. So
 * the Settings window and its row are gone, and AI providers, tools, calendar,
 * plan and nodes are levels of the menu. What a regression would break first:
 *
 *  · the rows answer without opening anything: Plan says «Gratuito», AI
 *    providers says the provider and the Claude plan it runs on, with the
 *    default runtime too;
 *  · a level opened by HOVER, once used (a press, a key), stays when the
 *    pointer leaves it: for its own confirmation, and with a half-typed key;
 *  · a form inside a menu still behaves like a form: every key typed into a
 *    field lands there (letters, space, Home, End, arrows, Enter), Escape in
 *    the field closes only the level, a selector's list and a confirmation
 *    opened from a level do not take the menu down with them;
 *  · ⌘, opens the menu with its first row focused, and no element of the old
 *    panel exists; the bell's gear still lands on Notifications;
 *  · on a phone, a form level is a full-width sheet.
 *
 * The Claude plan is a fact of the machine's credentials, which the isolated
 * server does not have: the providers snapshot is passed through with the two
 * labels the server would add (`server/providers/claude/subscription.ts`), on
 * HTTP and on the socket. Every other read is the real server's.
 *
 * Video on: this is behaviour, and the recording is the proof.
 *
 * @covers USERMENU-06, USERMENU-10
 */
import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { openProfileMenu } from "./helpers/open-perf-panel";
import { openUserMenuLevel } from "./helpers/user-menu";

hermetic(test);
test.use({ video: "on" });

type Snapshot = { providers: Array<Record<string, unknown> & { name: string }>; defaultProvider: string | null };

/**
 * The snapshot as the server would send it on a machine signed in to Claude
 * Max 20x, with the default runtime: `topics` (`DEFAULT_AGENT_RUNTIME`), which
 * signs in with the same credentials as the claude CLI, so both rows carry the
 * plan. The default stays `topics` on purpose: a fixture that made Claude Code
 * the default hid a tail that never named the plan for most people.
 */
function withClaudePlan(snapshot: Snapshot): Snapshot {
  const subscription = { type: "max", tier: "default_claude_max_20x" };
  const claudeRow = (name: string, label: string, isDefault: boolean) => ({
    status: "ready", models: [], requirements: [], fetchedAt: new Date().toISOString(),
    ...snapshot.providers.find((p) => p.name === name),
    name, label, isDefault, subscription,
  });
  const others = snapshot.providers
    .filter((p) => p.name !== "claude-code" && p.name !== "topics")
    .map((p) => ({ ...p, isDefault: false }));
  return {
    ...snapshot,
    defaultProvider: "topics",
    providers: [claudeRow("topics", "Topics", true), claudeRow("claude-code", "Claude Code", false), ...others],
  };
}

async function claudeMaxMachine(page: Page) {
  await page.route("**/api/providers/snapshot", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: withClaudePlan(await response.json() as Snapshot) });
  });
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket: WebSocketRoute) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (typeof message === "string" && message.includes('"providers:snapshot"')) {
        const frame = JSON.parse(message) as { snapshot?: Snapshot };
        if (frame.snapshot) frame.snapshot = withClaudePlan(frame.snapshot);
        socket.send(JSON.stringify(frame));
      } else socket.send(message);
    });
    socket.onMessage((message) => server.send(message));
  });
}

test.describe("il menu utente è la casa di ogni impostazione", () => {
  test.afterEach(async ({ request }) => {
    await request.post("/api/test/plan-usage", { data: { clear: true } });
  });

  test("USERMENU-10: a menu aperto Piano dice «Gratuito» e Provider AI il provider col piano Claude, e del pannello non resta niente", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-10" });
    await claudeMaxMachine(page);
    await goToApp(page);
    await openProfileMenu(page);
    const menu = page.getByTestId("profile-menu");

    await expect(menu.getByTestId("topics-menu-plan-tail")).toHaveText("Gratuito", { timeout: 15_000 });
    await expect(menu.getByTestId("topics-menu-plan-tail")).not.toHaveAttribute("data-warn", "true");
    await expect(menu.getByTestId("topics-menu-providers-tail")).toHaveText("Topics · Max 20x", { timeout: 15_000 });
    await expect(menu.getByTestId("topics-menu-calendar-tail")).toHaveText(/Collegato|In pausa|Non collegato/, { timeout: 15_000 });
    await expect(menu.getByTestId("topics-menu-nodes-tail")).toBeVisible({ timeout: 15_000 });
    // The old door and the old window: gone.
    await expect(page.getByTestId("topics-menu-settings")).toHaveCount(0);
    await expect(page.getByTestId("settings-panel")).toHaveCount(0);
  });

  test("USERMENU-06a: un modulo dentro il menu si comporta da modulo", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-06" });
    await claudeMaxMachine(page);
    // A five-hour window at 42%, as the CLI would report it: the level puts it
    // next to the plan it belongs to.
    await request.post("/api/test/plan-usage", { data: { fiveHour: { utilization: 42, resetsAtMs: Date.now() + 2 * 3_600_000 } } });
    // A key is never sent anywhere real: the server answers as a provider
    // refusing it would, which also proves Enter reached the form.
    const sent: string[] = [];
    await page.route("**/api/providers/*/configure", async (route) => {
      sent.push((route.request().postDataJSON() as { apiKey: string }).apiKey);
      await route.fulfill({ status: 400, json: { error: "Connection rejected. Check the API key.", code: "api_key_rejected" } });
    });
    await goToApp(page);
    const level = await openUserMenuLevel(page, "providers");
    const menu = page.getByTestId("profile-menu");

    // The plan and how much of it is spent, read together at the top.
    const plan = level.getByTestId("providers-claude-plan");
    await expect(plan).toContainText("Abbonamento Claude Max 20x", { timeout: 15_000 });
    await expect(level.getByTestId("providers-claude-usage")).toContainText("42%");

    // A field: every key lands in it, none moves the menu.
    const setup = level.getByTestId("api-provider-setup-openai");
    await setup.getByRole("button").first().click();
    const field = level.getByTestId("api-key-form-openai").locator("input");
    await field.click();
    await page.keyboard.type("sk-proj AbC");
    // The keys a menu owns (its arrows, Home and End, the level's ArrowLeft)
    // stay with the field: the focus does not leave it, the level stays, and
    // nothing typed is lost. Where the caret goes is the engine's business
    // (Home on a Mac WebKit field is not Home on Windows), so the caret is put
    // at the end explicitly before typing on.
    for (const key of ["Home", "End", "ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"]) {
      await page.keyboard.press(key);
      await expect(field, `after ${key}`).toBeFocused();
    }
    await expect(level).toBeVisible();
    await expect(field).toHaveValue("sk-proj AbC");
    await field.evaluate((el) => { const input = el as HTMLInputElement; input.setSelectionRange(input.value.length, input.value.length); });
    await page.keyboard.type("-9 Z");
    await expect(field).toHaveValue("sk-proj AbC-9 Z");
    await page.keyboard.press("Enter");
    await expect(level.getByTestId("api-key-form-openai").getByRole("alert")).toContainText("Chiave API rifiutata", { timeout: 10_000 });
    expect(sent).toEqual(["sk-proj AbC-9 Z"]);
    await expect(menu).toBeVisible();

    // A selector's list lives in a portal outside the level: choosing in it
    // is not a press outside the menu.
    await level.getByTestId("ai-providers-advanced-toggle").click();
    const runtime = level.getByRole("combobox", { name: "Runtime degli agenti", exact: true });
    await runtime.click();
    const listbox = page.getByRole("listbox").last();
    await expect(listbox).toBeVisible();
    await listbox.locator('[role="option"][aria-selected="true"]').first().click();
    await expect(listbox).toHaveCount(0);
    await expect(level).toBeVisible();
    await expect(menu).toBeVisible();

    // Escape in a field closes the level and only the level.
    await field.click();
    await page.keyboard.press("Escape");
    await expect(level).toHaveCount(0);
    await expect(menu).toBeVisible();
    // The focus comes back into the menu, not onto the page behind it.
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="profile-menu"]'))).toBe(true);
  });

  test("USERMENU-06b: una conferma chiesta da un livello non chiude il menu, e la coda avvisa la scadenza", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-06" });
    // A team licence twelve days from its end: the only plan with «remove»,
    // and inside the thirty days in which the tail names the expiry.
    const expiresAt = Date.now() + 12 * 86_400_000 + 3_600_000;
    await page.route("**/api/license", async (route) => {
      if (route.request().method() !== "GET") { await route.fallback(); return; }
      await route.fulfill({ json: { plan: "team", seats: 5, remoteAccess: true, expiresAt, reason: "valid", installationId: "inst-e2e" } });
    });
    await goToApp(page);
    await openProfileMenu(page);
    const tail = page.getByTestId("topics-menu-plan-tail");
    await expect(tail).toHaveText("Team · 5 posti · scade tra 12 g", { timeout: 15_000 });
    await expect(tail).toHaveAttribute("data-warn", "true");

    const level = await openUserMenuLevel(page, "plan");
    await level.getByRole("button", { name: "Togli la licenza" }).click();
    const dialog = page.getByRole("dialog", { name: "Togli la licenza" });
    await expect(dialog).toBeVisible();
    // Answering is not leaving: the level and the menu are still there.
    await dialog.getByRole("button", { name: "Annulla" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(level).toBeVisible();
    await expect(page.getByTestId("profile-menu")).toBeVisible();
  });

  test("USERMENU-06c: ⌘, apre il menu utente con il fuoco sulla prima riga, e l'ingranaggio del campanello porta a Notifiche", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-06" });
    await goToApp(page);
    const menu = page.getByTestId("profile-menu");
    await expect(async () => {
      await page.keyboard.press("Meta+Comma");
      await expect(menu).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.getByTestId("account-identity")).toBeFocused();
    await expect(page.locator('[data-testid="settings-panel"], [data-testid="topics-menu-settings"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    await page.getByTestId("notification-history-button").click();
    await expect(page.getByTestId("notification-history-panel")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("notification-settings-button").click();
    await expect(page.getByTestId("topics-menu-notifications-menu")).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("un livello aperto col passaggio del mouse, una volta usato, resta", () => {
  /** Open a level the way a mouse does, by resting on its row: no click, so
   *  nothing pinned it yet. */
  async function hoverOpen(page: Page, row: string) {
    await openProfileMenu(page);
    await page.getByTestId(`topics-menu-${row}`).hover();
    const level = page.getByTestId(`topics-menu-${row}-menu`);
    await expect(level).toBeVisible({ timeout: 10_000 });
    return level;
  }

  /** Move the mouse to the middle of `target` in steps, then press there. */
  async function pressAt(page: Page, target: ReturnType<Page["getByTestId"]>) {
    const box = await target.boundingBox();
    if (!box) throw new Error("target has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    await page.mouse.down();
    await page.mouse.up();
  }

  test("USERMENU-06d: la conferma chiesta da un livello aperto al passaggio non lo chiude", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-06" });
    const expiresAt = Date.now() + 12 * 86_400_000 + 3_600_000;
    await page.route("**/api/license", async (route) => {
      if (route.request().method() !== "GET") { await route.fallback(); return; }
      await route.fulfill({ json: { plan: "team", seats: 5, remoteAccess: true, expiresAt, reason: "valid", installationId: "inst-e2e" } });
    });
    await page.clock.install();
    await goToApp(page);
    const level = await hoverOpen(page, "plan");
    await pressAt(page, level.getByRole("button", { name: "Togli la licenza" }));
    const dialog = page.getByRole("dialog", { name: "Togli la licenza" });
    await expect(dialog).toBeVisible();
    // The dialog lives outside the level: reaching its button leaves the level.
    const cancel = dialog.getByRole("button", { name: "Annulla" });
    const box = await cancel.boundingBox();
    if (!box) throw new Error("Annulla has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    // Past the hover grace (150 ms) that used to take the level away: the
    // page's own clock runs its timers, nothing here sleeps.
    await page.clock.runFor(400);
    await expect(level).toBeVisible();
    await page.mouse.down();
    await page.mouse.up();
    await expect(dialog).toHaveCount(0);
    await expect(level).toBeVisible();
  });

  test("USERMENU-06e: una chiave scritta in un livello aperto al passaggio resta quando il mouse se ne va", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-06" });
    await page.clock.install();
    await goToApp(page);
    const level = await hoverOpen(page, "providers");
    const setup = level.getByTestId("api-provider-setup-openai");
    await expect(setup).toBeVisible({ timeout: 15_000 });
    await pressAt(page, setup.getByRole("button").first());
    const field = level.getByTestId("api-key-form-openai").locator("input");
    await pressAt(page, field);
    await page.keyboard.type("sk-typed-half");
    await expect(field).toHaveValue("sk-typed-half");
    // The pointer drifts off the level; the focus stays in the field.
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("no viewport");
    await page.mouse.move(viewport.width - 20, viewport.height / 2, { steps: 8 });
    // Past the hover grace (150 ms) that used to take the level away: the
    // page's own clock runs its timers, nothing here sleeps.
    await page.clock.runFor(400);
    await expect(level).toBeVisible();
    await expect(field).toHaveValue("sk-typed-half");
  });
});

test.describe("sul telefono un modulo è un foglio", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("USERMENU-10b: a 390 Piano apre un foglio largo quanto lo schermo, con la coda già scritta", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-10" });
    await goToApp(page);
    await openProfileMenu(page);
    await expect(page.getByTestId("sidebar-topics-menu-panel").getByTestId("topics-menu-plan-tail")).toHaveText("Gratuito", { timeout: 15_000 });
    const sheet = await openUserMenuLevel(page, "plan");
    await expect(sheet.getByTestId("topics-menu-plan-form")).toBeVisible();
    const box = await sheet.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { left: Math.round(b.left), width: Math.round(b.width), bottom: Math.round(b.bottom), vw: window.innerWidth, vh: window.innerHeight };
    });
    expect(box.left).toBe(0);
    expect(box.width).toBe(box.vw);
    expect(box.bottom).toBeGreaterThanOrEqual(box.vh - 1);
    // The header's close is a finger's target.
    const close = sheet.getByTestId("topics-menu-plan-close");
    expect(await close.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await close.click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId("sidebar-topics-menu-panel")).toBeVisible();
  });
});
