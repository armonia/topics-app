/**
 * EACH FORM LIVES WHERE IT IS USED (SETHOME-01, the 03/10/2026 change).
 *
 * The maintainer, on the forms that had moved into the user menu: «ma no il
 * menu di opzioni l'avevamo proprio tolto perchè smistiamo tutto» (allow-italian:
 * the request quoted verbatim). So the menu
 * keeps who you are and how the app looks, and every other form opens beside
 * the thing it configures:
 *
 *  · AI providers, from the foot of the model selector, with how many are ready
 *    in the tail and the Claude plan beside the Claude models;
 *  · MCP tools, from the composer's «+», with how many answer, read without
 *    mounting the fleet;
 *  · the calendar feed, from the menu of the pinned calendar tile;
 *  · the plan, under the account; the machines, inside Devices, with a badge
 *    on the row when another computer waits for an answer;
 *  · and the palette opens each by its own name, with or without its home on
 *    screen.
 *
 * Each home is opened from its place, typed into, saved, and its state read
 * where it is shown. Video on: this is behaviour, the recording is the proof.
 *
 * @covers SETHOME-01
 */
import { test as base, expect, type Locator, type Page, type WebSocketRoute } from "@playwright/test";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { hermetic } from "./fixtures/hermetic";
import { BrowserProcessPage } from "./fixtures/browser.fixture";
import { goToApp, openTopic } from "./helpers";
import { mkdirSync, writeFileSync } from "fs";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { removeTmpDir } from "./helpers/file-project";
import { projectRow } from "./helpers/project-row";
import { openProfileMenu } from "./helpers/open-perf-panel";
import { openUserMenuLevel } from "./helpers/user-menu";
import { CAL_CTX_ID, CAL_PANE_ID, CAL_URL, calendarTile, navigateToSidebar, setPins } from "./helpers/pinned-calendar-tile";
import { E2E_BASE } from "./helpers/test-server";

const test = base.extend<{ bp: BrowserProcessPage }>({
  bp: async ({ page }, use) => {
    await use(new BrowserProcessPage(page));
  },
});
hermetic(test);
test.use({ video: "on" });

type Snapshot = { providers: Array<Record<string, unknown> & { name: string }>; defaultProvider: string | null };

/** The snapshot as a machine signed in to Claude Max 20x sends it: the two
 *  labels the server adds to both Claude rows (`claude/subscription.ts`). */
function withClaudePlan(snapshot: Snapshot): Snapshot {
  const subscription = { type: "max", tier: "default_claude_max_20x" };
  const claudeRow = (name: string, label: string) => ({
    isDefault: false, models: ["claude-sonnet-4-5"], requirements: [], fetchedAt: new Date().toISOString(),
    ...snapshot.providers.find((p) => p.name === name),
    name, label, status: "ready", subscription,
  });
  const others = snapshot.providers.filter((p) => p.name !== "claude-code" && p.name !== "topics");
  return { ...snapshot, providers: [claudeRow("topics", "Topics"), claudeRow("claude-code", "Claude Code"), ...others] };
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

/** Two boxes touch or overlap on one axis and sit next to each other on the
 *  other: the panel hangs from its anchor, not from the middle of the window. */
async function expectBeside(panel: Locator, anchor: Locator) {
  const p = await panel.evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  const a = await anchor.evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  const gapV = Math.max(p.top - a.bottom, a.top - p.bottom);
  const gapH = Math.max(p.left - a.right, a.left - p.right);
  const overlapsH = p.left < a.right && a.left < p.right;
  const overlapsV = p.top < a.bottom && a.top < p.bottom;
  // Beside, not over: the panel never covers what it hangs from.
  const beside = (overlapsH && gapV >= 0 && gapV <= 16) || (overlapsV && gapH >= 0 && gapH <= 16);
  expect(beside, `panel ${JSON.stringify(p)} beside anchor ${JSON.stringify(a)}`).toBe(true);
  return p;
}

/** Each key moves the focus to a control inside `panel`. */
async function expectTabStaysIn(page: Page, panel: Locator, keys: string[]) {
  for (const key of keys) {
    await page.keyboard.press(key);
    const where = await panel.evaluate((el) => {
      const a = document.activeElement as HTMLElement | null;
      return {
        inside: !!a && el.contains(a),
        control: !!a?.matches("button, input, select, textarea, a[href], [role=combobox], [role=switch], [role=checkbox]"),
        what: `${a?.tagName} ${a?.getAttribute("data-testid") ?? ""}`,
      };
    });
    expect(where.inside && where.control, `after ${key}: ${where.what}`).toBe(true);
  }
}

test.describe("ogni modulo vive dove si usa", () => {
  test.afterEach(async ({ request }) => {
    await request.post("/api/test/plan-usage", { data: { clear: true } });
  });

  test("SETHOME-01a: Provider e chiavi si apre dal piede del selettore del modello, accanto al selettore", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "SETHOME-01" });
    await claudeMaxMachine(page);
    await request.post("/api/test/plan-usage", { data: { fiveHour: { utilization: 42, resetsAtMs: Date.now() + 2 * 3_600_000 } } });
    const sent: string[] = [];
    await page.route("**/api/providers/*/configure", async (route) => {
      sent.push((route.request().postDataJSON() as { apiKey: string }).apiKey);
      await route.fulfill({ status: 400, json: { error: "Connection rejected. Check the API key.", code: "api_key_rejected" } });
    });
    const topic = await createTopic(request, `Homes selector ${Date.now()}`);
    try {
      await resetPaneStore(request, [topic.id]);
      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(topic.name));

      const picker = page.getByTestId("provider-model-picker");
      await picker.click();
      const selector = page.getByTestId("provider-model-popover");
      // THE STATE IN THE TAIL, before opening anything.
      const footer = selector.getByTestId("ai-selector-providers");
      await expect(footer).toBeVisible({ timeout: 15_000 });
      await expect(footer).toContainText("Provider e chiavi");
      await expect(selector.getByTestId("ai-selector-providers-tail")).toHaveText(/^\d+ pront[oi]$/, { timeout: 20_000 });
      // A FOOTER: the last row of the selector.
      const last = await selector.locator("button").last().getAttribute("data-testid");
      expect(last).toBe("ai-selector-providers");
      // The Claude plan on the list the selector opens on: a chat with no
      // override never drills in, and the plan is read without opening more.
      await expect(selector.getByTestId("ai-selector-runtimes").getByTestId("ai-selector-claude-plan"))
        .toHaveText("Max 20x · 5 h al 42%");
      // And beside the Claude models.
      await selector.locator('[data-provider="claude-code"]').click();
      await expect(selector.getByTestId("ai-selector-claude-plan")).toHaveText("Max 20x · 5 h al 42%");
      await expect(selector.getByTestId("ai-selector-providers")).toBeVisible();

      await selector.getByTestId("ai-selector-providers").click();
      await expect(selector).toHaveCount(0);
      const panel = page.getByTestId("home-panel-providers");
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute("role", "dialog");
      const box = await expectBeside(panel, picker);
      expect(Math.round(box.width)).toBeGreaterThanOrEqual(400);
      expect(Math.round(box.width)).toBeLessThanOrEqual(440);
      expect(box.bottom).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight) + 1);
      // The plan at the top of the panel, with its five hours.
      await expect(panel.getByTestId("providers-claude-plan")).toContainText("Abbonamento Claude Max 20x", { timeout: 15_000 });
      await expect(panel.getByTestId("providers-claude-usage")).toContainText("42%");
      // THE FIRST TAB, from where the panel put the focus on opening, lands on
      // one of its controls and stays there (WebKit's own Tab skipped the
      // buttons and left for the page on the first press).
      await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      await expectTabStaysIn(page, panel, ["Tab", "Tab", "Shift+Tab", "Shift+Tab"]);

      // A form: typed, saved, answered.
      const setup = panel.getByTestId("api-provider-setup-openai");
      await setup.getByRole("button").first().click();
      const field = panel.getByTestId("api-key-form-openai").locator("input");
      await field.click();
      await page.keyboard.type("sk-home AbC");
      for (const key of ["Home", "End", "ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"]) {
        await page.keyboard.press(key);
        await expect(field, `after ${key}`).toBeFocused();
      }
      await field.evaluate((el) => { const input = el as HTMLInputElement; input.setSelectionRange(input.value.length, input.value.length); });
      await page.keyboard.type("-1");
      await page.keyboard.press("Enter");
      // The key reached the server, and the refusal is read in the panel.
      await expect.poll(() => sent, { timeout: 10_000 }).toEqual(["sk-home AbC-1"]);
      await expect(panel.getByTestId("api-key-form-openai").getByRole("alert")).toBeVisible({ timeout: 10_000 });

      // A list inside the panel closes first; Escape then closes the panel and
      // only the panel, and the focus is back on the selector.
      await panel.getByTestId("ai-providers-advanced-toggle").click();
      await panel.getByRole("combobox", { name: "Runtime degli agenti", exact: true }).click();
      const listbox = page.getByRole("listbox").last();
      await expect(listbox).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(listbox).toHaveCount(0);
      await expect(panel).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(picker).toBeFocused();
    } finally {
      await deleteTopic(request, topic.id);
    }
  });

  test("SETHOME-01b: Strumenti si apre dal «+» del composer, e aprire il composer non monta la flotta", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "SETHOME-01" });
    const fleet = {
      enabled: true, mounted: true, mounting: false,
      servers: [
        { name: "github", transport: "stdio", state: "ready", tools: [], skills: [] },
        { name: "linear", transport: "http", state: "ready", tools: [], skills: [] },
        { name: "broken", transport: "stdio", state: "failed", tools: [], skills: [] },
      ],
    };
    let mounts = 0;
    let peeks = 0;
    await page.route("**/api/mcp/fleet**", async (route) => {
      if (route.request().method() !== "GET") { await route.fallback(); return; }
      if (new URL(route.request().url()).searchParams.get("peek") === "1") peeks++;
      else mounts++;
      await route.fulfill({ json: fleet });
    });
    const tool = `mcp__e2e_homes__probe_${Date.now()}`;
    await request.post(`${E2E_BASE}/api/tool-grants`, { data: { pattern: tool }, ignoreHTTPSErrors: true });
    const topic = await createTopic(request, `Homes tools ${Date.now()}`);
    try {
      await resetPaneStore(request, [topic.id]);
      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(topic.name));
      const plus = page.getByTestId("composer-add-menu");
      await expect(plus).toBeVisible({ timeout: 15_000 });
      await plus.click();
      const row = page.getByTestId("composer-tools");
      await expect(row).toBeVisible();
      await expect(page.getByTestId("composer-tools-tail")).toHaveText("2 attivi");
      // Opening the composer and its «+» read with the peek, never the mount.
      expect(peeks).toBeGreaterThanOrEqual(1);
      expect(mounts).toBe(0);

      await row.click();
      const panel = page.getByTestId("home-panel-tools");
      await expect(panel).toBeVisible();
      await expectBeside(panel, plus);
      await expect(panel.getByTestId("mcp-fleet-panel")).toBeVisible({ timeout: 15_000 });
      // A grant revoked here is revoked on the server.
      const grant = panel.locator(`[data-testid="tool-grant-${tool}"]`);
      await expect(grant).toBeVisible({ timeout: 10_000 });
      await panel.locator(`[data-testid="tool-grant-revoke-${tool}"]`).click();
      await expect(grant).toHaveCount(0, { timeout: 5_000 });
      const grants = await (await request.get(`${E2E_BASE}/api/tool-grants`, { ignoreHTTPSErrors: true })).text();
      expect(grants).not.toContain(tool);

      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(plus).toBeFocused();
    } finally {
      await request.delete(`${E2E_BASE}/api/tool-grants/${encodeURIComponent(tool)}`, { ignoreHTTPSErrors: true }).catch(() => {});
      await deleteTopic(request, topic.id);
    }
  });

  test("SETHOME-01d: il Piano sta sotto l'account, dice com'è e prende un gettone", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SETHOME-01" });
    let installed: string | null = null;
    await page.route("**/api/license", async (route) => {
      if (route.request().method() !== "PUT") { await route.fallback(); return; }
      installed = (route.request().postDataJSON() as { token?: string } | null)?.token ?? "";
      await route.fulfill({ status: 400, json: { error: "invalid_token", reason: "bad_signature" } });
    });
    await goToApp(page);
    await openProfileMenu(page);
    const menu = page.getByTestId("profile-menu");
    // Right under who you are: the account row, then the plan.
    // (the account block above it is the sign-in form or the signed-in row,
    // depending on the machine: what is pinned is that nothing sits between).
    await expect(menu.getByTestId("topics-menu-plan")).toBeVisible({ timeout: 15_000 });
    const ids = await menu.locator("[data-testid]").evaluateAll((els) => els
      .map((el) => el.getAttribute("data-testid") ?? "")
      .filter((id) => /^(topics-menu-|profile-menu-)/.test(id) && !id.endsWith("-tail")));
    expect(ids[0]).toBe("topics-menu-plan");
    expect(ids[1]).toBe("profile-menu-friends");
    await expect(menu.getByTestId("topics-menu-plan-tail")).toHaveText("Gratuito", { timeout: 15_000 });

    const level = await openUserMenuLevel(page, "plan");
    const field = level.getByRole("textbox", { name: "Gettone di licenza" });
    await field.click();
    await page.keyboard.type("tok-e2e-home");
    await expect(field).toHaveValue("tok-e2e-home");
    await level.getByRole("button", { name: "Installa" }).click();
    await expect.poll(() => installed).toBe("tok-e2e-home");
    await expect(level).toBeVisible();
  });

  test("SETHOME-01e: le Macchine stanno in Dispositivi, col badge quando un altro computer aspetta", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SETHOME-01" });
    await page.route("**/api/nodes/delegated-requests", async (route) => {
      if (route.request().method() !== "GET") { await route.fallback(); return; }
      await route.fulfill({ json: { requests: [{
        id: "req-e2e-1", purpose: "catalog", state: "pending", originName: "Studio", requestedBy: "Studio",
        expiresAt: Date.now() + 3_600_000,
      }] } });
    });
    let paired: string | null = null;
    await page.route("**/api/machines/pair", async (route) => {
      paired = (route.request().postDataJSON() as { baseUrl: string }).baseUrl;
      await route.fulfill({ status: 400, json: { error: "bad address", code: "bad_address" } });
    });
    await goToApp(page);
    await openProfileMenu(page);
    const menu = page.getByTestId("profile-menu");
    // The request waits for an answer: the badge is on the row, read with the menu.
    await expect(menu.getByTestId("devices-requests-badge")).toBeVisible({ timeout: 15_000 });
    await expect(menu.getByTestId("devices-requests-badge")).toHaveText("1");
    await menu.getByTestId("profile-menu-devices").click();
    const devices = page.getByTestId("profile-menu-devices-menu");
    await expect(devices).toBeVisible();
    // The line at the top of Devices opens the Machines section beside it.
    await devices.getByTestId("devices-remote-requests").click();
    const machines = page.getByTestId("devices-machines-menu");
    await expect(machines).toBeVisible({ timeout: 10_000 });
    await expect(machines.getByTestId("remote-node-requests")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("devices-machines-requests")).toHaveText("1");

    const address = machines.locator("#node-pair-url");
    await address.click();
    await page.keyboard.type("https://studio.local:3333");
    await page.keyboard.press("Enter");
    await expect.poll(() => paired).toBe("https://studio.local:3333");
    await expect(machines.getByTestId("node-pair-error")).toBeVisible();
    // Escape closes the Machines level only.
    await address.click();
    await page.keyboard.press("Escape");
    await expect(machines).toHaveCount(0);
    await expect(devices).toBeVisible();
  });

  test("SETHOME-01f: la palette apre ogni modulo per nome, senza una voce Impostazioni", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SETHOME-01" });
    await goToApp(page);
    const palette = page.getByTestId("command-palette");
    async function run(query: string, rowId: string) {
      await expect(async () => {
        await page.keyboard.press("Meta+k");
        await expect(palette).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 20_000 });
      await palette.getByRole("textbox").first().fill(query);
      const row = palette.getByTestId(rowId);
      await expect(row).toBeVisible();
      await row.click();
      await expect(palette).toHaveCount(0);
    }
    // No pill that opens «Settings»: the commands are the forms' own names.
    await expect(async () => {
      await page.keyboard.press("Meta+k");
      await expect(palette).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(palette.getByRole("button", { name: /^Impostazioni/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);

    // With no chat open the providers have no selector on screen: a sheet in
    // the middle of the window.
    await run("Provider e chiavi", "palette-home-providers");
    const providers = page.getByTestId("home-panel-providers");
    await expect(providers).toBeVisible();
    await expect(providers).toHaveAttribute("data-popover-owner", "centred");
    const middle = await providers.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { mid: b.left + b.width / 2, vw: window.innerWidth };
    });
    expect(Math.abs(middle.mid - middle.vw / 2)).toBeLessThanOrEqual(2);
    await expect(providers.getByTestId("ai-providers-settings")).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await expect(providers).toHaveCount(0);

    await run("Strumenti MCP", "palette-home-tools");
    await expect(page.getByTestId("home-panel-tools").getByTestId("mcp-fleet-panel")).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.getByTestId("home-panel-tools").evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await expectTabStaysIn(page, page.getByTestId("home-panel-tools"), ["Tab", "Shift+Tab"]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("home-panel-tools")).toHaveCount(0);

    await run("Calendario", "palette-home-calendar");
    await expect(page.getByTestId("home-panel-calendar").getByTestId("calendar-feed-url")).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("home-panel-calendar")).toHaveCount(0);

    // The account's own: the user menu, on its level.
    await run("Piano", "palette-home-plan");
    await expect(page.getByTestId("topics-menu-plan-menu")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("profile-menu")).toHaveCount(0);

    await run("Macchine", "palette-home-machines");
    await expect(page.getByTestId("devices-machines-menu")).toBeVisible({ timeout: 10_000 });
    for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
    await expect(page.getByTestId("profile-menu")).toHaveCount(0);

    await run("Aspetto", "palette-home-appearance");
    await expect(page.getByTestId("topics-menu-appearance-menu")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await run("Notifiche", "palette-home-notifications");
    await expect(page.getByTestId("topics-menu-notifications-menu")).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("il calendario si apre dalla sua tessera", () => {
  let server: Server;
  let origin: string;
  test.beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/calendar; charset=utf-8" });
      res.end("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Homes\r\nEND:VCALENDAR");
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  test.afterAll(async ({ request }) => {
    await request.put(`${E2E_BASE}/api/app-settings`, { data: { calendarFeedUrl: null, calendarEnabled: false } }).catch(() => {});
    await new Promise<void>((closed) => server.close(() => closed()));
  });

  test("SETHOME-01c: il menu della tessera del calendario apre il feed accanto alla tessera, e la coda dice com'è", async ({ page, bp }) => {
    test.info().annotations.push({ type: "spec", description: "SETHOME-01" });
    await bp.mockBrowserContexts([{ id: CAL_CTX_ID, url: CAL_URL, title: "Calendar", lastActivity: Date.now() }]);
    await bp.mockRemoteBrowserPane({ connected: true, url: CAL_URL, title: "Calendar", hasScreenshot: true });
    await setPins(page, [CAL_PANE_ID]);
    await navigateToSidebar(page);
    const tile = calendarTile(page);
    await expect(tile).toBeVisible();

    await tile.click({ button: "right" });
    const row = page.getByTestId("calendar-tile-feed");
    await expect(row).toBeVisible();
    await expect(page.getByTestId("calendar-tile-feed-tail")).toHaveText("Non collegato", { timeout: 10_000 });
    await row.click();
    const panel = page.getByTestId("home-panel-calendar");
    await expect(panel).toBeVisible();
    await expectBeside(panel, tile);

    const field = panel.getByTestId("calendar-feed-url");
    await field.fill(`${origin}/feed.ics`);
    await panel.getByTestId("calendar-save").click();
    await expect(panel.getByTestId("calendar-forget")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(tile).toBeFocused();

    // The tile's menu says it now, without opening the form.
    await tile.click({ button: "right" });
    await expect(page.getByTestId("calendar-tile-feed-tail")).toHaveText("Collegato", { timeout: 10_000 });
  });

  test("SETHOME-01i: con la colonna chiusa la tessera non è a schermo, e la palette apre il calendario al centro", async ({ page, bp }) => {
    test.info().annotations.push({ type: "spec", description: "SETHOME-01" });
    await bp.mockBrowserContexts([{ id: CAL_CTX_ID, url: CAL_URL, title: "Calendar", lastActivity: Date.now() }]);
    await bp.mockRemoteBrowserPane({ connected: true, url: CAL_URL, title: "Calendar", hasScreenshot: true });
    await setPins(page, [CAL_PANE_ID]);
    await navigateToSidebar(page);
    const tile = calendarTile(page);
    await expect(tile).toBeVisible();
    // The collapsed column slides off with a transform: the tile is still laid
    // out, off the left edge.
    await page.keyboard.press("Meta+b");
    await expect.poll(() => tile.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);

    const palette = page.getByTestId("command-palette");
    await expect(async () => {
      await page.keyboard.press("Meta+k");
      await expect(palette).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await palette.getByRole("textbox").first().fill("Calendario");
    await palette.getByTestId("palette-home-calendar").click();
    await expect(palette).toHaveCount(0);
    const panel = page.getByTestId("home-panel-calendar");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-popover-owner", "centred");
    const box = await panel.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, mid: b.left + b.width / 2, vw: window.innerWidth };
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(Math.abs(box.mid - box.vw / 2)).toBeLessThanOrEqual(2);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    // The focus does not go to a tile nobody can see.
    await expect(tile).not.toBeFocused();
  });
});

test.describe("sul telefono il modulo dei provider è un foglio dal basso", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("SETHOME-01g: a 390 il piede del selettore apre Provider e chiavi a tutta larghezza", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "SETHOME-01" });
    const topic = await createTopic(request, `Homes phone ${Date.now()}`);
    try {
      await resetPaneStore(request, [topic.id]);
      await goToApp(page);
      await openTopic(page, new RegExp(topic.name));
      const picker = page.getByTestId("provider-model-picker");
      await expect(picker).toBeVisible({ timeout: 15_000 });
      await picker.tap();
      const footer = page.getByTestId("provider-model-popover").getByTestId("ai-selector-providers");
      await expect(footer).toBeVisible();
      await footer.tap();
      const panel = page.getByTestId("home-panel-providers");
      await expect(panel).toBeVisible();
      await expect.poll(() => panel.evaluate((el) => getComputedStyle(el).transform), { timeout: 5_000 })
        .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
      const box = await panel.evaluate((el) => {
        const b = el.getBoundingClientRect();
        return { left: Math.round(b.left), width: Math.round(b.width), bottom: Math.round(b.bottom), vw: window.innerWidth, vh: window.innerHeight };
      });
      expect(box.left).toBe(0);
      expect(box.width).toBe(box.vw);
      expect(box.bottom).toBeGreaterThanOrEqual(box.vh - 1);
      await expect(panel.getByTestId("ai-providers-settings")).toBeVisible({ timeout: 15_000 });
      const close = panel.getByTestId("home-panel-providers-close");
      expect(await close.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      await close.tap();
      await expect(panel).toHaveCount(0);
    } finally {
      await deleteTopic(request, topic.id);
    }
  });
});

const BOARD_STAMP = Date.now();
const BOARD_NAME = "homesboard";
const BOARD_ROOT = `/tmp/e2e-${BOARD_NAME}-${BOARD_STAMP}`;
const BOARD_DIR = `${BOARD_ROOT}/${BOARD_NAME}`;

test.describe("i predefiniti della board aprono i provider accanto al loro selettore", () => {
  test.afterAll(() => removeTmpDir(BOARD_ROOT));

  test("SETHOME-01h: il piede del selettore nei predefiniti della board apre il pannello accanto al selettore, e le impostazioni della board restano", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "SETHOME-01" });
    test.setTimeout(90_000);
    mkdirSync(BOARD_DIR, { recursive: true });
    writeFileSync(`${BOARD_DIR}/package.json`, JSON.stringify({ name: BOARD_NAME }, null, 2));
    const topic = await createTopic(request, `${BOARD_NAME}-${BOARD_STAMP}`, { projectPath: BOARD_DIR });
    try {
      await resetPaneStore(request, []);
      await resetProjectPanes(request, BOARD_DIR);
      await seedProjectPane(request, BOARD_DIR);
      await page.setViewportSize({ width: 1280, height: 800 });
      await goToApp(page);
      await page.keyboard.press("Escape");
      const projects = page.getByRole("button", { name: /sezione Progetti/ });
      if ((await projects.count()) > 0 && (await projects.getAttribute("aria-expanded")) === "false") await projects.click();
      const row = projectRow(page, BOARD_NAME);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.click();
      await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 15_000 });
      if (!(await page.getByTestId("kanban-board").isVisible().catch(() => false))) {
        // The «+» that has a Board entry: the window's own, whichever it is.
        const triggers = page.getByTestId("pane-add-menu-trigger");
        const item = page.getByTestId("pane-add-menu-kanban");
        for (let i = (await triggers.count()) - 1; i >= 0; i--) {
          const trigger = triggers.nth(i);
          if (!(await trigger.isVisible().catch(() => false))) continue;
          if (!(await trigger.click({ timeout: 3_000 }).then(() => true, () => false))) continue;
          if (await item.waitFor({ state: "visible", timeout: 2_000 }).then(() => true, () => false)) break;
          await page.keyboard.press("Escape");
        }
        await item.click();
      }
      const board = page.getByTestId("kanban-board");
      await expect(board).toBeVisible({ timeout: 15_000 });

      await board.getByRole("button", { name: /Impostazioni auto-dispatch/ }).click();
      const settings = page.getByTestId("board-settings-menu");
      await expect(settings).toBeVisible();
      const selector = page.getByTestId("board-model-selector");
      await selector.click();
      const footer = page.getByTestId("ai-selector-providers");
      await expect(footer).toBeVisible({ timeout: 15_000 });
      await footer.click();

      const panel = page.getByTestId("home-panel-providers");
      await expect(panel).toBeVisible();
      // The board settings hold the selector: they stay, and the panel hangs
      // from the selector, not from a detached element in the corner.
      await expect(settings).toBeVisible();
      await expectBeside(panel, selector);
      await expect(panel.getByTestId("ai-providers-settings")).toBeVisible({ timeout: 15_000 });

      // Escape closes the panel only, and the focus is back on the selector.
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(settings).toBeVisible();
      await expect(selector).toBeFocused();
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
