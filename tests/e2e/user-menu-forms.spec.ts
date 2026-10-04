/**
 * A FORM STAYS A FORM, IN THE USER MENU AND IN ITS OWN PANEL.
 *
 * On 02/10 the Settings window went and its forms became levels of the user
 * menu; on 03/10 the maintainer had them sorted out of it ("sort everything"):
 * the plan and the machines stay in the menu because they are the account, AI
 * providers, tools and calendar live where they are used, drawn by one host
 * (SETHOME-01). What a regression would break first:
 *
 *  · the plan row answers without opening anything («Gratuito»), and no row of
 *    the menu speaks for a form that left it;
 *  · a level opened by HOVER, once used (a press, a key), stays when the
 *    pointer leaves it: for its own confirmation, and with a half-typed key;
 *  · a form in its panel still behaves like a form: every key typed into a
 *    field lands there (letters, space, Home, End, arrows, Enter), Escape in
 *    the field closes only the panel, a selector's list and a confirmation
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
 * @covers USERMENU-06, USERMENU-10, SETHOME-01
 */
import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { openProfileMenu } from "./helpers/open-perf-panel";
import { openHomePanel, openUserMenuLevel } from "./helpers/user-menu";

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

  test("USERMENU-10: a menu aperto Piano dice «Gratuito», e del pannello e dei moduli usciti non resta niente", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-10" });
    await claudeMaxMachine(page);
    await goToApp(page);
    await openProfileMenu(page);
    const menu = page.getByTestId("profile-menu");

    await expect(menu.getByTestId("topics-menu-plan-tail")).toHaveText("Gratuito", { timeout: 15_000 });
    await expect(menu.getByTestId("topics-menu-plan-tail")).not.toHaveAttribute("data-warn", "true");
    // The forms that left for where they are used have no row, and no tail.
    for (const gone of ["providers", "tools", "calendar", "nodes"]) {
      await expect(menu.getByTestId(`topics-menu-${gone}`)).toHaveCount(0);
    }
    // The old door and the old window: gone.
    await expect(page.getByTestId("topics-menu-settings")).toHaveCount(0);
    await expect(page.getByTestId("settings-panel")).toHaveCount(0);
  });

  test("USERMENU-06a: il modulo dei provider nel suo pannello si comporta da modulo", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "SETHOME-01" });
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
    // No chat open, so no model selector on screen: the panel is a sheet of
    // its own in the middle of the window.
    const level = await openHomePanel(page, "providers");

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
    await expect(level).toBeVisible();

    // A selector's list lives in a portal outside the panel: choosing in it
    // is not a press outside.
    await level.getByTestId("ai-providers-advanced-toggle").click();
    const runtime = level.getByRole("combobox", { name: "Runtime degli agenti", exact: true });
    await runtime.click();
    const listbox = page.getByRole("listbox").last();
    await expect(listbox).toBeVisible();
    await listbox.locator('[role="option"][aria-selected="true"]').first().click();
    await expect(listbox).toHaveCount(0);
    await expect(level).toBeVisible();

    // Escape with the list closed closes the panel, and only the panel.
    await field.click();
    await page.keyboard.press("Escape");
    await expect(level).toHaveCount(0);
    await expect(page.getByTestId("profile-menu")).toHaveCount(0);
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
    await expect(tail).toHaveText("Scade tra 12 g · Team · 5 posti", { timeout: 15_000 });
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

  test("USERMENU-06f: in un menu da 288 px l'avviso di scadenza della coda del Piano si vede intero", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-06" });
    // Enough seats to overflow the tail: what the ellipsis cuts must not be the
    // warning. Measured on the glyphs, not read off textContent, which holds
    // the whole string whether it is visible or not.
    const expiresAt = Date.now() + 12 * 86_400_000 + 3_600_000;
    await page.route("**/api/license", async (route) => {
      if (route.request().method() !== "GET") { await route.fallback(); return; }
      await route.fulfill({ json: { plan: "team", seats: 12500, remoteAccess: true, expiresAt, reason: "valid", installationId: "inst-e2e" } });
    });
    await goToApp(page);
    await openProfileMenu(page);
    const menu = page.getByTestId("profile-menu");
    const tail = menu.getByTestId("topics-menu-plan-tail");
    await expect(tail).toHaveAttribute("data-warn", "true", { timeout: 15_000 });
    expect(Math.round((await menu.boundingBox())!.width)).toBe(288);
    const m = await tail.evaluate((el) => {
      const node = el.firstChild as Text;
      const warning = "Scade tra 12 g";
      const at = node.data.indexOf(warning);
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + warning.length);
      const glyphs = range.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return { at, glyphsRight: glyphs.right, boxRight: box.right, truncated: el.scrollWidth > el.clientWidth };
    });
    // The case is real only if the tail does overflow.
    expect(m.truncated).toBe(true);
    expect(m.at).toBeGreaterThanOrEqual(0);
    // The ellipsis takes a few pixels at the right end of the box: the warning
    // must end before it.
    expect(m.glyphsRight).toBeLessThanOrEqual(m.boxRight - 8);
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

    await page.getByTestId("inbox-button").click();
    await expect(page.getByTestId("inbox-panel")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("notification-settings-button").click();
    await expect(page.getByTestId("topics-menu-notifications-menu")).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("un modulo nel menu resta un modulo", () => {
  /** The licence token field of the Plan level, opened with a click. */
  async function openKeyField(page: Page) {
    const level = await openUserMenuLevel(page, "plan");
    const field = level.getByRole("textbox", { name: "Gettone di licenza" });
    await expect(field).toBeVisible({ timeout: 15_000 });
    await field.click();
    return { level, field };
  }

  test("USERMENU-06g: ⌘, con il menu già aperto non lo rimonta: il gettone a metà resta e il fuoco va sulla prima riga", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-06" });
    await goToApp(page);
    const { level, field } = await openKeyField(page);
    await page.keyboard.type("sk-typed-half");
    await expect(field).toHaveValue("sk-typed-half");
    await page.keyboard.press("Meta+Comma");
    await expect(page.getByTestId("account-identity")).toBeFocused();
    await expect(level).toBeVisible();
    await expect(field).toHaveValue("sk-typed-half");
  });

  test("USERMENU-06h: il corpo di un livello con un modulo è un dialogo col nome del livello, non un menu", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-06" });
    await goToApp(page);
    const { level, field } = await openKeyField(page);
    // A field inside role=menu is a field a screen reader announces as a menu
    // item; a dialog admits it.
    await expect(page.getByRole("dialog", { name: "Piano" })).toBeVisible();
    await expect(field.locator('xpath=ancestor::*[@role="menu"]')).toHaveCount(0);
    await expect(page.getByTestId("topics-menu-plan")).toHaveAttribute("aria-haspopup", "dialog");
    // Keyboard unchanged: Tab stays inside the level, Escape closes only it.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(await level.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(level).toHaveCount(0);
    await expect(page.getByTestId("profile-menu")).toBeVisible();
  });

  test("USERMENU-06i: dopo ⌘, il fuoco dato alla prima riga non viene ripreso da un cambio del menu", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-06" });
    await goToApp(page);
    const menu = page.getByTestId("profile-menu");
    await expect(async () => {
      await page.keyboard.press("Meta+Comma");
      await expect(menu).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const first = page.getByTestId("account-identity");
    await expect(first).toBeFocused();
    // A live change of the menu (a row that appears above, as a tail or a
    // banner would): the focus is where the person left it.
    await menu.evaluate((el) => {
      const row = document.createElement("button");
      row.dataset.testid = "late-row";
      row.textContent = "late";
      el.prepend(row);
    });
    await expect(page.getByTestId("late-row")).toHaveCount(1);
    // Two frames for the observer to have run.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(first).toBeFocused();
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

  test("USERMENU-06e: un gettone scritto in un livello aperto al passaggio resta quando il mouse se ne va", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "USERMENU-06" });
    await page.clock.install();
    await goToApp(page);
    const level = await hoverOpen(page, "plan");
    const field = level.getByRole("textbox", { name: "Gettone di licenza" });
    await expect(field).toBeVisible({ timeout: 15_000 });
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
