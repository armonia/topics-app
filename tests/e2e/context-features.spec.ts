/**
 * THE AGENTS' CONTEXT AND THE FEATURE MAP (hub-smistamento, HUBBR-17, HUBBR-18).
 *
 * System carries, after the agents-and-jobs row, the agents' context row with
 * the weight of Claude Code at start, the processes row, and the feature-map
 * row with how many features Jarvis is behind on. The context level lists four
 * harnesses with the home sessions' memory under Claude Code, the files read
 * at start (one opened shows its text), the duplicated lines and the old
 * rules; the contradictions button asks first, sends nothing on cancel, sends
 * exactly one check on confirm, says an agent is reading, and shows what the
 * agent found when the hub says it is over. The feature map opens as a view
 * from System and from the palette, the same single tab, never offered by a
 * row of its own in the sidebar: the verdict, the ranking, the features where
 * Jarvis is behind until the all filter, one opened with who has it. Above the
 * comparison the pyramid of what Jarvis needs (seven levels widening down,
 * one opened at a time with its functions, where they live and their use)
 * and the decisions on what is missing with the two still to build; the
 * filters for news, to build and chosen not now; an area with who leads it,
 * its groups with their own share; a feature with the note, the decision,
 * every other system, eight news and the evidence link. Without the hub,
 * after a reload, System and the palette offer neither.
 *
 * The hub is a fake (helpers/fake-hub.ts with `context`, shapes in
 * fake-hub-context.ts) on the port the test server reads. The real :3360 is
 * never touched, and the files and projects are placeholders.
 *
 * Mutation: with the check sent on the first button instead of on the
 * confirm, the count of checks after cancel is 1 and the test
 * is red; with the home sessions' loader read as a harness, the level lists
 * five and the test is red; with the news cap back at five the opened feature
 * shows five and no hint of the other two, and the test is red.
 *
 * The shots are taken in the mockups' workspace (helpers/shot-scene.ts):
 * acme-web and studio-x with their chats in the sidebar, a chat with messages.
 *
 * Video on: the recording is the proof. The screenshots of the built surface
 * go to the test's output (`vero-contesto-funzionalita-*.png`).
 *
 * @covers HUBBR-17
 * @covers HUBBR-18
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore } from "./helpers/api-fixtures";
import { openMainChat, openSceneInSidebar, seedScene, type Scene } from "./helpers/shot-scene";
import { goToApp } from "./helpers";
import { openProfileMenu } from "./helpers/open-perf-panel";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE, canonicalTmpRoot } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

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

async function openSystem(page: Page) {
  await openProfileMenu(page);
  await page.getByTestId("sidebar-system-menu").getByTestId("menu-system-status").click();
  const status = page.getByTestId("menu-system-status-menu");
  await expect(status).toBeVisible({ timeout: 10_000 });
  return status;
}

/** Waits for the level's colours to have turned light, not for a clock. */
async function turnedLight(page: Page, testId: string): Promise<void> {
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await expect.poll(() => page.getByTestId(testId).evaluate((el) => {
    const [r = 255, g = 255, b = 255] = (getComputedStyle(el).color.match(/\d+(\.\d+)?/g) ?? []).map(Number);
    return (r + g + b) / 3 < 128;
  })).toBe(true);
}

const checks = (hub: FakeHub) => hub.posts.filter((p) => p.path === "contesto/check").length;

test.describe("agents' context and feature map", () => {
  let hub: FakeHub | null = null;
  let scene: Scene | null = null;

  test.beforeAll(async ({ request }) => {
    scene = await seedScene(request, `${canonicalTmpRoot()}/e2e-context-features-${Date.now().toString(36)}`);
    hub = await startFakeHub(undefined, { context: true });
    await waitForHub(request);
  });
  test.afterAll(async ({ request }) => {
    await hub?.close();
    await scene?.cleanup(request);
  });

  // Each test starts on the scene alone: a view opened by the test before
  // stays a tab, and clicking its row again would only focus that tab.
  test.beforeEach(async ({ request }) => {
    if (!scene) return;
    await resetPaneStore(request, []);
    await openSceneInSidebar(request, scene);
  });

  test("System: the context with the check on confirmation", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await goToApp(page);
    await openMainChat(page, scene!);
    const status = await openSystem(page);

    // The rows in the mockup's order, each with its number.
    const rows = status.locator('[data-testid^="menu-system-"]:not([data-testid$="-tail"])');
    await expect(status.getByTestId("menu-system-context")).toBeVisible({ timeout: 15_000 });
    const order = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(order.filter((id) => ["menu-system-agents", "menu-system-context", "menu-system-processes", "menu-system-features"].includes(id ?? "")))
      .toEqual(["menu-system-agents", "menu-system-context", "menu-system-processes", "menu-system-features"]);
    await expect(status.getByTestId("menu-system-context-tail")).toHaveText("15 k tok di base", { timeout: 20_000 });
    await expect(status.getByTestId("menu-system-features-tail")).toHaveText("Jarvis indietro su 47", { timeout: 20_000 });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath("vero-contesto-funzionalita-menu-scuro.png") });

    await status.getByTestId("menu-system-context").click();
    const level = page.getByTestId("context-level");
    await expect(level).toBeVisible({ timeout: 15_000 });
    await page.mouse.move(0, 0);

    // Four harnesses, the home sessions' memory under Claude Code, not a fifth.
    const harness = level.getByTestId("context-harness");
    await expect(harness).toHaveCount(4, { timeout: 20_000 });
    await expect(harness.filter({ hasText: "Claude Code" })).toContainText("+4,9 k tok nelle sessioni aperte nella home");
    await expect(harness.filter({ hasText: "OpenClaw" })).toContainText("11 k tok");
    await expect(level).not.toContainText("claude-cli");
    await expect(level).not.toContainText("~/");
    await expect(level.getByTestId("context-check-ask")).toHaveText("Cerca contraddizioni");
    await expect(level.getByTestId("context-contradictions")).toContainText("mai state confrontate");
    await expect(level.getByTestId("context-duplicate")).toContainText("CLAUDE.md globale · CLAUDE.md · acme-web");
    await expect(level.getByTestId("context-old-rule").first()).toContainText("372 giorni fa");
    // The hub quotes raw markdown lines: bold marks, list dashes and link targets stay off screen.
    await expect(level.getByTestId("context-old-rule").first()).toContainText("Ultimo aggiornamento: 29 ottobre 2025");
    await expect(level.getByTestId("context-old-rules")).not.toContainText("**");
    await expect(level.getByTestId("context-old-rules")).not.toContainText("reference_");
    await expect(level.getByTestId("context-doctor")).toContainText("27 controlli dei collegamenti: tutti verdi");

    // A file read at start opens its text.
    const file = level.getByTestId("context-file").filter({ hasText: "CLAUDE.md globale" });
    await file.getByRole("button").click();
    await expect(file.getByTestId("context-file-text")).toContainText("Una domanda è una domanda.", { timeout: 10_000 });

    // The check asks first: nothing reaches the hub on cancel.
    await level.getByTestId("context-check-ask").click();
    await expect(level.getByTestId("context-check-confirm")).toContainText("Un agente legge tutte le regole");
    await level.getByTestId("context-check-cancel").click();
    await expect(level.getByTestId("context-check-confirm")).toHaveCount(0);
    expect(checks(hub!)).toBe(0);
    await level.getByTestId("context-check-ask").click();
    await page.screenshot({ path: testInfo.outputPath("vero-contesto-funzionalita-conferma-scuro.png") });
    await level.getByTestId("context-check-start").click();
    await expect(level.getByTestId("context-check-running")).toContainText("Un agente sta leggendo le regole", { timeout: 10_000 });
    expect(checks(hub!)).toBe(1);
    // The agent answers: the contradiction shows, with its two rules by file label.
    const found = level.getByTestId("context-contradiction");
    await expect(found).toHaveCount(1, { timeout: 20_000 });
    await expect(found).toContainText("Una chiede i commenti in italiano, l'altra in inglese.");
    await expect(found).toContainText("CLAUDE.md globale");
    // A file the hub does not list is named by whose it is, not by a bare file name.
    await expect(found).toContainText("Regole di OpenClaw studio-x");
    await expect(found).not.toContainText("AGENTS.md");
    // A long rule is one line until tapped, then reads whole: no tooltip needed.
    const rule = found.getByTestId("context-rule-text").first();
    await expect(rule).toHaveAttribute("aria-expanded", "false");
    const closed = (await rule.boundingBox())!.height;
    await rule.click();
    await expect(rule).toHaveAttribute("aria-expanded", "true");
    expect((await rule.boundingBox())!.height).toBeGreaterThan(closed * 1.5);
    await expect(rule).toContainText("salvo i termini di dominio.");
    await expect(level.getByTestId("context-check-running")).toHaveCount(0);
    await expect(level.getByTestId("context-check-ask")).toHaveText("Controlla di nuovo");
    expect(checks(hub!)).toBe(1);
    await file.getByRole("button").click();
    await expect(file.getByTestId("context-file-text")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("vero-contesto-funzionalita-scuro.png") });

    await turnedLight(page, "context-level");
    await page.screenshot({ path: testInfo.outputPath("vero-contesto-funzionalita-chiaro.png") });
    await page.emulateMedia({ colorScheme: "dark" });
  });

  test("Funzionalità from System and from the palette, the same view, no sidebar row of its own", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await goToApp(page);
    await openMainChat(page, scene!);
    const sidebar = page.locator('[aria-label="Topics sidebar"]').first();
    await expect(sidebar).not.toContainText("Funzionalità");
    const status = await openSystem(page);
    await status.getByTestId("menu-system-features").click();
    const pane = page.getByTestId("features-pane");
    await expect(pane).toBeVisible({ timeout: 20_000 });
    await expect(pane.getByTestId("features-verdict-title")).toHaveText("47 dove Jarvis è indietro, su 172 voci", { timeout: 20_000 });
    await expect(pane.getByTestId("features-verdict")).toContainText("16 sistemi a confronto · Jarvis copre il 70%, 1° posto");
    await expect(pane.getByTestId("features-system")).toHaveCount(16);
    await expect(pane.locator('[data-testid="features-system"][data-ours="true"]')).toContainText("Jarvis");
    await expect(pane).not.toContainText("jarvis-channels");
    // Behind by default: every row listed is behind, 47 of them.
    await expect(pane.getByTestId("features-leaf")).toHaveCount(47);
    await expect(pane.locator('[data-testid="features-leaf"][data-behind="false"]')).toHaveCount(0);
    const first = pane.getByTestId("features-leaf").first();
    await first.getByRole("button").click();
    await expect(first.getByTestId("features-leaf-detail")).toContainText("Ce l'hanno:");
    // The hub writes the map in English: the view reads it in Italian.
    await expect(first).toContainText("Ponte WhatsApp nativo, chat private e gruppi");
    await expect(pane.locator('[data-area="channels"] h2')).toContainText("Canali e messaggi");
    await expect(pane.locator('[data-area="channels"]')).toContainText("Piattaforme di chat");
    await expect(pane).not.toContainText("Channels and messaging");
    await expect(pane).not.toContainText("Native WhatsApp bridge");
    // News are the upstream changelogs quoted as written, with who wrote them.
    await expect(first.getByTestId("features-news-hint")).toHaveText("dai changelog, nella lingua originale");
    await expect(first.getByTestId("features-news-source").first()).toHaveText("OpenClaw");
    // Open, and still not in the sidebar: the tab bar holds it.
    await expect(page.getByTestId("pane-tab-__features__")).toHaveCount(1);
    await expect(sidebar).not.toContainText("Funzionalità");
    // The ranking reads down the columns: the second system sits under the first.
    const [one, two] = await pane.getByTestId("features-system").evaluateAll((els) => els.slice(0, 2).map((e) => e.getBoundingClientRect()));
    expect(Math.abs(one!.left - two!.left)).toBeLessThan(2);
    expect(two!.top).toBeGreaterThan(one!.top);
    await page.screenshot({ path: testInfo.outputPath("vero-contesto-funzionalita-vista-scuro.png") });
    await turnedLight(page, "features-pane");
    await page.screenshot({ path: testInfo.outputPath("vero-contesto-funzionalita-vista-chiaro.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await pane.getByTestId("features-filter-all").click();
    await expect(pane.getByTestId("features-leaf")).toHaveCount(172);
    await pane.getByTestId("features-search").fill("whatsapp");
    await expect(pane.getByTestId("features-leaf")).toHaveCount(1);
    // The English words still find it.
    await pane.getByTestId("features-search").fill("bridge");
    await expect(pane.getByTestId("features-leaf")).toHaveCount(1);

    // The palette brings back the same single view.
    const search = page.getByPlaceholder(/Cerca topic/);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(search).toBeVisible({ timeout: 5_000 });
    await search.fill("Funzionalità");
    await page.getByTestId("palette-features").click();
    await expect(page.getByTestId("features-pane")).toHaveCount(1);
    await expect(page.getByTestId("pane-tab-__features__")).toHaveCount(1);
  });

  test("Funzionalità: the pyramid, the decisions, the filters and a feature whole", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await goToApp(page);
    await openMainChat(page, scene!);
    const status = await openSystem(page);
    await status.getByTestId("menu-system-features").click();
    const pane = page.getByTestId("features-pane");
    await expect(pane.getByTestId("features-verdict-title")).toHaveText("47 dove Jarvis è indietro, su 172 voci", { timeout: 20_000 });

    // The pyramid: seven levels from the top down, each wider than the one above.
    const pyramid = pane.getByTestId("features-pyramid");
    const levels = pyramid.getByTestId("features-pyramid-level");
    await expect(levels).toHaveCount(7);
    expect(await levels.evaluateAll((els) => els.map((e) => e.getAttribute("data-level")))).toEqual(["7", "6", "5", "4", "3", "2", "1"]);
    const widths = await levels.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    for (let k = 1; k < widths.length; k++) expect(widths[k]!).toBeGreaterThan(widths[k - 1]!);
    await expect(pyramid.getByTestId("features-pyramid-summary")).toHaveText(
      "15 di 17 funzioni che servono sono coperte; 1 fatte oggi; 1 passano al motore unico; 1 mancano; 2 si lasciano o si ritirano. Tocca un livello per le voci.",
    );
    await expect(pyramid.getByTestId("features-pyramid-legend")).toHaveText(/coperta.*motore unico.*manca.*non serve/);
    await expect(pyramid.getByTestId("features-pyramid-updated")).toContainText("aggiornata il");
    const base = pyramid.locator('[data-testid="features-pyramid-level"][data-level="1"]');
    await expect(base.getByTestId("features-pyramid-count")).toHaveText("2/3");
    // Four colours in the bar of the base: covered, single engine, not needed.
    expect(await base.locator("[data-band]").evaluateAll((els) => els.map((e) => e.getAttribute("data-band")))).toEqual(["ok", "warn", "off"]);
    await base.click();
    const detail = pyramid.getByTestId("features-pyramid-detail");
    await expect(detail).toHaveCount(1);
    await expect(detail).toContainText("Da dove arrivano i messaggi e come si risponde");
    const items = detail.getByTestId("features-pyramid-item");
    await expect(items).toHaveCount(4);
    // What moved today first, the covered last.
    await expect(items.first()).toHaveAttribute("data-status", "fatto");
    await expect(items.first()).toContainText("fatta oggi");
    await expect(items.first()).toContainText("fatta, anche sul secondo canale");
    await expect(items.first()).toContainText("src/channels/team.rs · 12 in 14 giorni");
    await expect(items.last()).toContainText("36 turni in 14 giorni");
    // One level at a time.
    await pyramid.locator('[data-testid="features-pyramid-level"][data-level="3"]').click();
    await expect(detail).toHaveCount(1);
    await expect(detail).toContainText("Cosa può fare l'agente");
    await expect(detail.getByTestId("features-pyramid-item").first()).toContainText("manca");

    // What is missing, decided: one tile per decision, the two to build by priority.
    const decided = pane.getByTestId("features-decided");
    const tiles = decided.getByTestId("features-decided-tile");
    expect(await tiles.evaluateAll((els) => els.map((e) => `${e.getAttribute("data-plan")}=${e.textContent}`))).toEqual([
      "sviluppo=2da fare", "topics=17si usano da Topics", "altro=30coperte in altro modo", "scelta=23scelte di non farle ora", "fatto=11già fatte",
    ]);
    await expect(decided.getByTestId("features-todo-row")).toHaveText(["P1Discord · Serve al secondo canale", "P2Telegram · Dopo il primo"]);

    // How the shares count, and when the watcher last looked.
    await expect(pane.getByTestId("features-ranking-foot")).toContainText("Sì vale 1, in parte 0,5, no 0; le voci non note non contano");
    await expect(pane.getByTestId("features-checked")).toHaveText(/^novità controllate il \d{1,2} \S+ alle \d{2}:\d{2}$/);
    await page.screenshot({ path: testInfo.outputPath("vero-funzionalita-piramide-scuro.png"), fullPage: true });

    // The filters beyond behind, each with its count, each keeping what it says.
    const leaves = pane.getByTestId("features-leaf");
    for (const [f, n] of [["news", 43], ["todo", 2], ["choice", 23]] as const) {
      const tab = pane.getByTestId(`features-filter-${f}`);
      await expect(tab).toContainText(String(n));
      await tab.click();
      await expect(leaves).toHaveCount(n);
    }
    await expect(pane.locator('[data-testid="features-leaf"] [data-testid="features-plan"][data-plan="scelta"]')).toHaveCount(23);
    await expect(pane.getByTestId("features-filter-news")).toHaveText(/Novità da rivedere/);

    // All: the area says who leads it and how many behind, its groups their own share.
    await pane.getByTestId("features-filter-all").click();
    await expect(leaves).toHaveCount(172);
    const channels = pane.locator('[data-area="channels"]');
    await expect(channels.getByTestId("features-area-behind")).toHaveText("7 indietro");
    await expect(channels.getByTestId("features-area-hint")).toHaveText("Jarvis 62%, 5° di 16 · davanti OpenClaw 74%");
    await expect(channels.getByTestId("features-group")).toHaveCount(3);
    await expect(channels.locator('[data-group="ch.chat"]')).toContainText("Piattaforme di chat");
    await expect(channels.locator('[data-group="ch.chat"] [data-testid="features-group-ours"]')).toHaveText("Jarvis 17%");

    // A feature whole: behind and its decision on the row, then the note, the
    // decision, all fifteen others, eight news of ten and the evidence page.
    const wa = channels.locator('[data-leaf="ch.wa"]');
    await expect(wa.getByTestId("features-behind-chip")).toHaveText("indietro");
    await expect(wa.getByTestId("features-plan")).toHaveText("scelta: non ora");
    await wa.getByRole("button").first().click();
    const leaf = wa.getByTestId("features-leaf-detail");
    await expect(leaf.getByTestId("features-note")).toHaveText("Noi: solo i messaggi diretti e i gruppi del primo account");
    await expect(leaf.getByTestId("features-decided-why")).toHaveText("Deciso: Nessun cliente lo usa: si fa quando serve");
    await expect(leaf.getByTestId("features-cell")).toHaveCount(15);
    await expect(leaf.getByTestId("features-cell").first()).toHaveAttribute("data-status", "yes");
    await expect(leaf.locator('[data-testid="features-cell"][data-status="no"]').first()).toBeVisible();
    await expect(leaf.getByTestId("features-news")).toHaveCount(8);
    await expect(leaf.getByTestId("features-news-more")).toHaveText("altre 2");
    const source = leaf.getByTestId("features-source");
    await expect(source).toHaveAttribute("href", "https://docs.example.com/channels/whatsapp");
    await expect(source).toHaveText(/fonte\s*docs\.example\.com\/channels\/whatsapp/);
    await wa.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("vero-funzionalita-voce-scuro.png") });
    await turnedLight(page, "features-pane");
    await pyramid.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("vero-funzionalita-piramide-chiaro.png") });
    await page.emulateMedia({ colorScheme: "dark" });
  });

  test("phone, 390 px: the context level is one sheet, nothing wider than the screen", async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({
      baseURL: E2E_BASE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "dark", locale: "it-IT",
      recordVideo: { dir: testInfo.outputPath("phone-video"), size: { width: 390, height: 844 } },
    });
    const page = await ctx.newPage();
    try {
      await page.goto("/");
      await expect(page.getByTestId("mobile-chrome-bar")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("sidebar-topics-menu").tap();
      const menu = page.getByTestId("sidebar-system-menu");
      await expect(menu).toBeVisible({ timeout: 15_000 });
      await menu.getByTestId("menu-system-status").tap();
      const status = page.getByTestId("menu-system-status-menu");
      await expect(status.getByTestId("menu-system-context")).toBeVisible({ timeout: 15_000 });
      await status.getByTestId("menu-system-context").tap();
      const level = page.getByTestId("context-level");
      await expect(level.getByTestId("context-harness")).toHaveCount(4, { timeout: 20_000 });
      await expect(level.getByTestId("context-back")).toHaveText("Sistema");
      await expect(level.getByTestId("context-close")).toBeVisible();
      const widths = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        level: document.querySelector<HTMLElement>('[data-testid="context-level"]')!.getBoundingClientRect().right,
      }));
      expect(widths.doc).toBeLessThanOrEqual(390);
      expect(widths.level).toBeLessThanOrEqual(390);
      // The two rules of a contradiction read whole on a tap, inside the screen.
      const rules = level.getByTestId("context-contradiction").first().getByTestId("context-rule-text");
      await rules.nth(0).tap();
      await rules.nth(1).tap();
      await expect(rules.nth(0)).toHaveAttribute("aria-expanded", "true");
      await expect(rules.nth(0)).toContainText("salvo i termini di dominio.");
      await expect(rules.nth(1)).toContainText("fails on any Italian comment in a new file.");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await rules.nth(0).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("vero-contesto-funzionalita-telefono.png") });
      await level.getByTestId("context-back").tap();
      await expect(level).toHaveCount(0);
      await expect(page.getByTestId("menu-system-status-menu")).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test("hub gone, after a reload: System and the palette offer neither", async ({ page, request }) => {
    await hub?.close();
    hub = null;
    await waitForHubDown(request);
    const errors: string[] = [];
    page.on("pageerror", (e) => { if (!e.message.startsWith("ResizeObserver loop")) errors.push(e.message); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await goToApp(page);
    const status = await openSystem(page);
    await expect(status.getByTestId("menu-system-agents")).toBeVisible();
    await expect(status.getByTestId("menu-system-context")).toHaveCount(0);
    await expect(status.getByTestId("menu-system-features")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder(/Cerca topic/);
    await expect(search).toBeVisible({ timeout: 5_000 });
    await search.fill("Funzionalità");
    await expect(page.getByTestId("palette-features")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
