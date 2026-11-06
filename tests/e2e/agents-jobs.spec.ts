/**
 * AGENTS AND JOBS (hub-smistamento, HUBBR-13).
 *
 * System > agents and jobs lists who works with three filters. With the hub:
 * the running filter has the Topics session at work, the proxy's session
 * outside Topics (named without its raw prompt), the queue's running job and
 * the running workflow with its phase and its bar; the waiting filter has,
 * oldest first, the workflow stopped at its gate and the Topics chat waiting
 * on you, each with what it asks and the way to answer, then the line
 * numbered with the twin folded as x2, and the job a quota holds; the
 * finished filter has the failed workflow and the failed job on top, the job
 * born from a card is nowhere, and a job taken out of the line goes to the
 * hub as `DELETE queue?id=` and leaves the list. With the hub silent a band
 * says since when and the retry reads again. Without the hub, after a
 * reload, the level lists Topics alone.
 *
 * The hub is a fake (helpers/fake-hub.ts, `jobs`) on the port the test server
 * reads; it also answers for the Claude proxy. The real :3360 and :3335 are
 * never touched, and the names are placeholders.
 *
 * The same list carries what the hub sees outside Topics (a session of every
 * provider with its project's icon and share of the week, the sub-agent, the
 * live workflow with its agents and tokens, the session already in a Topics
 * tab left out), why a held job is paused, the proxy's account, tool at work,
 * idle session, cost, timeline without prompts and the band of two sessions on
 * one file. `/lavori/<filter>` opens the level on its filter; the gate's card
 * and the footer open Topics' Automazioni, the latter on the Calendar, where a
 * late reminder stays, a row opens on what it will do and who runs it, and the
 * agent's instructions show only behind their own fold.
 *
 * Mutation: with `isBoardCard` (lib/agentsJobs.ts) returning false, «Rilascio
 * di acme-web» shows in the waiting filter and the test is red; with the proxy's title
 * taken from the timeline, «PROMPT GREZZO» shows and the test is red; with the
 * recent segments of a session at work kept, «Jarvis su WhatsApp» shows among
 * the finished and the test is red.
 *
 * Video on: the recording is the proof. The screenshots of the built surface
 * go to the test's output (`vero-agenti-e-lavori-*.png`).
 *
 * @covers HUBBR-13
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { attentionUpdated } from "./helpers/attention";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { openProfileMenu } from "./helpers/open-perf-panel";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";

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

/** Topics as the mockup's scene: one chat at work, one waiting on you. */
async function stageTopics(page: Page, ids: { working: string; waiting: string }, open: (page: Page) => Promise<unknown> = goToApp): Promise<void> {
  await page.route("**/api/topics/streaming", (r) => r.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ sessions: [{ topicId: ids.working, sessionKey: `k-${ids.working}`, state: "streaming" }] }),
  }));
  const ws = await interceptWebSocket(page, /\/ws(?:\?|$)/);
  await open(page);
  await expect.poll(() => ws.getByType("attention:init").length, { timeout: 15_000 }).toBeGreaterThan(0);
  ws.send(attentionUpdated(`topic:${ids.waiting}`, { state: "needs-you", reason: "question", detail: "Porto la fix del rate limit sul main o la lascio su release/1.1?", since: new Date(Date.now() - 6 * 60_000).toISOString() }));
}

/**
 * WebKit on the Windows runner never completes the socket handshake with the
 * test server (bell-groups.spec.ts, 05/11): there the Topics side, which comes
 * over the socket, is not staged and the hub's side is asserted alone.
 */
const socketOn = (project: string) => !(project === "webkit" && process.platform === "win32");

async function openLevel(page: Page) {
  const menu = page.getByTestId("sidebar-system-menu");
  await openProfileMenu(page);
  await menu.getByTestId("menu-system-status").click();
  const status = page.getByTestId("menu-system-status-menu");
  await expect(status).toBeVisible({ timeout: 10_000 });
  await status.getByTestId("menu-system-agents").click();
  const level = page.getByTestId("agents-jobs-level");
  await expect(level).toBeVisible({ timeout: 15_000 });
  await page.mouse.move(0, 0);
  return { level, status };
}

test.describe("agents and jobs", () => {
  let hub: FakeHub | null = null;
  const topicIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    hub = await startFakeHub(undefined, { jobs: true });
    await waitForHub(request);
  });
  test.afterAll(async ({ request }) => {
    await hub?.close();
    for (const id of topicIds) await deleteTopic(request, id).catch(() => {});
  });

  test("the queue and the workflows in the filters, no card of the Board, never the raw prompt", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    const working = await createTopic(request, "Firma della release v1.1");
    const waiting = await createTopic(request, "Fix del rate limit");
    topicIds.push(working.id, waiting.id);
    const withTopics = socketOn(testInfo.project.name);
    if (withTopics) await stageTopics(page, { working: working.id, waiting: waiting.id });
    else await goToApp(page);

    const { level, status } = await openLevel(page);
    if (withTopics) {
      // The row in System says who waits on you: the chat and the workflow at its gate, read when System opens.
      await expect(status.getByTestId("menu-system-agents-tail")).toHaveText("2 aspettano te", { timeout: 20_000 });
      // Somebody waits on you: the level opens on the waiting filter.
      await expect(level).toHaveAttribute("data-filter", "waiting");
    } else {
      await level.getByTestId("agents-jobs-filter-waiting").click();
    }
    await expect(level.getByTestId("agents-jobs-freshness")).toHaveText("aggiornato ora", { timeout: 20_000 });

    // WAITING: yours oldest first, each with what it asks; then the line in the hub's order, then the held one.
    const decide = level.getByTestId("agents-jobs-section-decide");
    const cards = decide.getByTestId("agents-jobs-decide-card");
    await expect(cards.first()).toContainText("Pubblica la landing di acme-web", { timeout: 20_000 });
    await expect(cards.first().getByTestId("agents-jobs-question")).toHaveText("“aspetta il tuo ok al passo «deploy» da 14 min”");
    await expect(cards.first().getByTestId("agents-jobs-open-hub")).toHaveText("Apri in Automazioni");
    if (withTopics) {
      await expect(cards).toHaveCount(2);
      const chat = cards.nth(1);
      await expect(chat.getByTestId("awaiting-agent-row")).toContainText("Fix del rate limit");
      await expect(chat).toContainText("ferma da 6 min");
      await expect(chat.getByTestId("agents-jobs-question")).toHaveText("“Porto la fix del rate limit sul main o la lascio su release/1.1?”");
      await expect(chat.getByTestId("agents-jobs-open")).toHaveText("Apri la chat");
    }
    const line = level.getByTestId("agents-jobs-section-line").getByTestId("agents-jobs-row");
    await expect(line).toHaveCount(2, { timeout: 20_000 });
    await expect(line.nth(0)).toContainText("Docs index non risponde");
    await expect(line.nth(0)).toContainText("×2");
    await expect(line.nth(0)).toContainText("1°");
    // Each says what it waits on: the next round, a free Mac.
    await expect(line.nth(0)).toContainText("parte al prossimo giro");
    await expect(line.nth(1)).toContainText("Test unit di studio-x");
    await expect(line.nth(1)).toContainText("parte a Mac libero");
    const quota = level.getByTestId("agents-jobs-section-quota");
    await expect(quota).toContainText("Refactor del router di studio-x, seconda passata");
    // Why the hub holds it, in its words, and since when it waits in line.
    await expect(quota).toContainText("in pausa: Claude frenato");
    await expect(quota).toContainText("in coda da 1 h 00");
    await expect(level.getByTestId("agents-jobs-count-waiting")).toHaveText(withTopics ? "5" : "4");
    await expect(level).not.toContainText("Rilascio di acme-web");
    // The way to the Board and to Automazioni (its calendar), inside Topics.
    await expect(level.getByTestId("agents-jobs-automations")).toHaveText("Automazioni");
    await page.screenshot({ path: testInfo.outputPath("vero-agenti-e-lavori-scuro.png") });

    // RUNNING: Topics, the proxy outside Topics, the queue, the workflow.
    await level.getByTestId("agents-jobs-filter-running").click();
    await expect(level).toHaveAttribute("data-filter", "running");
    if (withTopics) {
      // The chat and the workflow at its gate: the band and the row of System count the same.
      await expect(level.getByTestId("agents-jobs-band")).toContainText("2 aspettano te");
      await expect(page.getByTestId("menu-system-status-menu").getByTestId("menu-system-agents-tail")).toHaveText("2 aspettano te");
      await expect(level.getByTestId("agents-jobs-section-topics").getByTestId("active-agent-row")).toContainText("Firma della release v1.1");
    }
    const proxy = level.getByTestId("agents-jobs-section-proxy");
    // Told apart without their prompts: the Jarvis turn by its channel and its project, the other by its model.
    const proxyRows = proxy.getByTestId("agents-jobs-row");
    await expect(proxyRows).toHaveCount(2);
    await expect(proxyRows.filter({ hasText: "Jarvis su WhatsApp" })).toContainText("Sonnet 5.5 · studio-x");
    await expect(proxyRows.filter({ hasText: "Sessione Claude fuori da Topics" })).toContainText("Haiku 5.5");
    // The account it spends; silent for minutes it waits for input, else it says the tool at work.
    await expect(proxyRows.filter({ hasText: "Jarvis su WhatsApp" })).toContainText("lavoro@example.com");
    await expect(proxyRows.filter({ hasText: "Jarvis su WhatsApp" })).toContainText("in attesa di input da 7 min");
    await expect(proxyRows.filter({ hasText: "Sessione Claude fuori da Topics" })).toContainText("Legge README.md");
    // Two sessions on one file: the band, with the file's name; a word out of a command is not a file.
    await expect(level.getByTestId("agents-jobs-conflict")).toHaveCount(1);
    await expect(level.getByTestId("agents-jobs-conflict")).toHaveText("2 sessioni modificano router.ts");
    // What the hub sees outside Topics: every provider, the Topics tab left out, with the project's real icon.
    const outside = level.getByTestId("agents-jobs-section-outside").getByTestId("agents-jobs-row");
    await expect(outside).toHaveCount(3);
    await expect(outside.filter({ hasText: "Test A/B con assegnazione all'edge" })).toContainText("Claude · Opus · acme-web");
    await expect(outside.filter({ hasText: "Test A/B con assegnazione all'edge" })).toContainText("0,7% della settimana");
    await expect(outside.filter({ hasText: "Test A/B con assegnazione all'edge" }).getByTestId("agents-jobs-project-icon")).toBeVisible();
    await expect(outside.filter({ hasText: "Sessione jcode su studio-x" })).toContainText("aspetta un comando");
    await expect(outside.filter({ hasText: "Migra il router di acme-api" })).toContainText("Codex · GPT-5");
    await expect(level).not.toContainText("Sessione che Topics conta già");
    await expect(level.getByTestId("agents-jobs-section-subagents")).toContainText("Sottoagente su acme-web");
    await expect(level.getByTestId("agents-jobs-section-queue")).toContainText("Rigenera gli screenshot della landing di acme-web");
    const flow = level.getByTestId("agents-jobs-section-workflows");
    await expect(flow).toContainText("Revisione di acme-web");
    // A live workflow the hub sees: one row, its agents counted and its tokens summed.
    await expect(flow).toContainText("Workflow per «Protocolli dei canali»");
    await expect(flow).toContainText("4 agenti · 2,3M tok");
    await expect(flow).toContainText("passo 3 di 5 · Verifica · 2 agenti", { timeout: 20_000 });
    await expect(flow.locator("[data-step]")).toHaveCount(5);
    await expect(flow.locator('[data-step="active"]')).toHaveCount(1);
    await expect(level).not.toContainText("PROMPT GREZZO");
    await expect(level).not.toContainText("~/Projects");
    await page.screenshot({ path: testInfo.outputPath("vero-agenti-e-lavori-in-corso-scuro.png") });

    // FINISHED: the failures on top, the command wrapper without its prompt.
    await level.getByTestId("agents-jobs-filter-finished").click();
    const failed = level.getByTestId("agents-jobs-section-failed");
    await expect(failed).toContainText("Pubblica la landing di acme-web");
    await expect(failed).toContainText("Lavoro delegato su acme-api");
    await expect(failed).toContainText("uscito con codice 1");
    await expect(level).not.toContainText("ESATTAMENTE");
    // The proxy's ended session, with the project its commands name (today or yesterday, by the clock);
    // the session still at work is not also among the finished.
    await expect(level).toContainText("Opus 5.5 · acme-docs");
    await expect(level).not.toContainText("Jarvis su WhatsApp");
    // The ended session: its estimated cost, and its timeline (the summaries, never the prompt) on demand.
    const ended = level.getByTestId("agents-jobs-row").filter({ hasText: "Opus 5.5 · acme-docs" });
    await expect(ended).toContainText(/circa [\d,]+\s?€|circa €/);
    await ended.getByTestId("agents-jobs-timeline-toggle").click();
    await expect(ended.getByTestId("agents-jobs-timeline")).toHaveText("Ha aggiornato l'indice dei documenti di acme-docs.");
    await expect(level).not.toContainText("PROMPT GREZZO");
    await page.screenshot({ path: testInfo.outputPath("vero-agenti-e-lavori-finiti-scuro.png") });
    // The whole interface turns light, the sidebar and the menus included.
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    // The level has turned light too, its text dark (colours ease in): the shot waits for it, not for a clock.
    await expect.poll(() => level.evaluate((el) => {
      const [r = 255, g = 255, b = 255] = (getComputedStyle(el).color.match(/\d+(\.\d+)?/g) ?? []).map(Number);
      return (r + g + b) / 3 < 128;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("vero-agenti-e-lavori-chiaro.png") });
    await page.emulateMedia({ colorScheme: "dark" });

    // A job taken out of the line: the hub gets the DELETE, the row leaves.
    await level.getByTestId("agents-jobs-filter-waiting").click();
    const second = level.getByTestId("agents-jobs-section-line").getByTestId("agents-jobs-row").filter({ hasText: "Test unit di studio-x" });
    await second.getByTestId("agents-jobs-withdraw").click();
    await expect.poll(() => hub!.posts.filter((p) => p.path === "queue" && p.method === "DELETE").map((p) => p.id)).toEqual(["j-l2"]);
    await expect(level.getByTestId("agents-jobs-section-line").getByTestId("agents-jobs-row")).toHaveCount(1);
    await expect(level.getByTestId("agents-jobs-count-waiting")).toHaveText(withTopics ? "4" : "3");
  });

  test("a link opens the level on its filter; Automazioni opens on the gate and on the calendar, the late reminder kept", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    // The hub's `#work/<filter>` is Topics' `/lavori/<filter>`: the level opens on it, and the address is consumed.
    await page.goto("/lavori/finiti");
    const level = page.getByTestId("agents-jobs-level");
    await expect(level).toBeVisible({ timeout: 30_000 });
    await expect(level).toHaveAttribute("data-filter", "finished");
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");

    // The gate's card opens Topics' own Automazioni, not the hub's page.
    await level.getByTestId("agents-jobs-filter-waiting").click();
    const gate = level.getByTestId("agents-jobs-decide-card").filter({ hasText: "Pubblica la landing di acme-web" });
    await gate.getByTestId("agents-jobs-open-hub").click();
    const pane = page.getByTestId("automations-pane");
    await expect(pane).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("agents-jobs-level")).toHaveCount(0);

    // The footer's «Automazioni» opens it on its Calendar tab.
    const again = await openLevel(page);
    await again.level.getByTestId("agents-jobs-automations").click();
    await expect(pane.getByTestId("automations-tab-calendar")).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    const cal = pane.getByTestId("automations-calendar");
    const items = cal.getByTestId("automations-calendar-item");
    await expect(items).toHaveCount(3, { timeout: 20_000 });
    // The reminder that did not fire stays, on yesterday, marked late.
    await expect(cal.getByTestId("automations-calendar-day").first()).toContainText("Ieri");
    const late = items.filter({ hasText: "Rispondere al preventivo di acme-api" });
    await expect(late.getByTestId("automations-calendar-late")).toHaveText("in ritardo");
    await expect(late).toContainText("Jarvis · WhatsApp");
    // The job says how often it checks; a reminder that writes nothing says so.
    await expect(items.filter({ hasText: "Controllare il rinnovo del dominio" })).toContainText("controlla ogni mattina alle 9");
    await expect(items.filter({ hasText: "Ricordami di chiudere la PR di studio-x" })).toContainText("Jarvis · non ti scrive");
    // Opened: what it will do, when, the channel, who runs it; the agent's instructions behind their own fold.
    await expect(cal).not.toContainText("ISTRUZIONI DELL'AGENTE");
    await late.getByTestId("automations-calendar-toggle").click();
    const detail = late.getByTestId("automations-calendar-detail");
    await expect(detail).toContainText("un agente esegue le istruzioni qui sotto e ti scrive su WhatsApp. Poi il promemoria si chiude.");
    await expect(detail).toContainText("Esegue");
    await expect(detail).toContainText("Muse");
    await expect(detail).not.toContainText("ISTRUZIONI DELL'AGENTE");
    await detail.getByTestId("automations-calendar-prompt-toggle").click();
    await expect(detail.getByTestId("automations-calendar-prompt")).toHaveText("ISTRUZIONI DELL'AGENTE per il preventivo");
    const pr = items.filter({ hasText: "Ricordami di chiudere la PR di studio-x" });
    await pr.getByTestId("automations-calendar-toggle").click();
    await expect(pr.getByTestId("automations-calendar-detail")).toContainText("Ti ricorda la PR di studio-x se è ancora aperta");
    await expect(pr.getByTestId("automations-calendar-detail")).toContainText("Ti scrive con una nota sulla card");
    await page.screenshot({ path: testInfo.outputPath("vero-automazioni-calendario-scuro.png") });
  });

  test("hub silent: a band says since when, the last answer stays, the retry reads again", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await goToApp(page);
    const { level } = await openLevel(page);
    await level.getByTestId("agents-jobs-filter-waiting").click();
    await expect(level.getByTestId("agents-jobs-section-line")).toBeVisible({ timeout: 20_000 });
    hub!.silent = true;
    // The next round (15 s) finds the hub silent: the band, and the list read before stays.
    const band = level.getByTestId("agents-jobs-hub-down");
    await expect(band).toContainText(/Hub fermo da \d+ min · dati delle \d{2}:\d{2}/, { timeout: 30_000 });
    await expect(band.getByRole("button", { name: "Riprova" })).toBeVisible();
    await expect(level.getByTestId("agents-jobs-freshness")).toContainText("hub giù da");
    await expect(level.getByTestId("agents-jobs-section-line")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("vero-agenti-e-lavori-hub-fermo-scuro.png") });
    hub!.silent = false;
    await band.getByRole("button", { name: "Riprova" }).click();
    await expect(band).toHaveCount(0, { timeout: 10_000 });
    await expect(level.getByTestId("agents-jobs-freshness")).toHaveText("aggiornato ora");
  });

  test("phone, 390 px: the level is a sheet, nothing wider than the screen", async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({
      baseURL: E2E_BASE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "dark", locale: "it-IT",
      recordVideo: { dir: testInfo.outputPath("phone-video"), size: { width: 390, height: 844 } },
    });
    const page = await ctx.newPage();
    try {
      const withTopics = socketOn(testInfo.project.name);
      const open = async (p: Page) => {
        await p.goto("/");
        await expect(p.getByTestId("mobile-chrome-bar")).toBeVisible({ timeout: 30_000 });
      };
      if (withTopics) await stageTopics(page, { working: topicIds[0]!, waiting: topicIds[1]! }, open);
      else await open(page);
      await page.getByTestId("sidebar-topics-menu").tap();
      const menu = page.getByTestId("sidebar-system-menu");
      await expect(menu).toBeVisible({ timeout: 15_000 });
      await menu.getByTestId("menu-system-status").tap();
      const status = page.getByTestId("menu-system-status-menu");
      await expect(status).toBeVisible({ timeout: 10_000 });
      await status.getByTestId("menu-system-agents").tap();
      const level = page.getByTestId("agents-jobs-level");
      await expect(level).toBeVisible({ timeout: 15_000 });
      if (withTopics) {
        await expect(level).toHaveAttribute("data-filter", "waiting");
        await expect(level.getByTestId("agents-jobs-section-decide")).toBeVisible();
      } else {
        await level.getByTestId("agents-jobs-filter-waiting").tap();
      }
      await expect(level.getByTestId("agents-jobs-section-line")).toBeVisible({ timeout: 20_000 });
      // One sheet in sight: the level covers the menus it came from, with its way back and its close.
      await expect(level.getByTestId("agents-jobs-back")).toHaveText("Sistema");
      await expect(level.getByTestId("agents-jobs-close")).toBeVisible();
      const covered = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-testid="agents-jobs-level"]')!;
        const sheet = el.closest<HTMLElement>("[data-popover]")!;
        const top = sheet.getBoundingClientRect().top;
        // What is on top just below the sheet's edge is the sheet itself, not the profile menu.
        const hit = document.elementFromPoint(195, top + 30);
        return { top, own: !!hit && sheet.contains(hit) };
      });
      expect(covered.top).toBeLessThanOrEqual(60);
      expect(covered.own).toBe(true);
      const widths = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        level: document.querySelector<HTMLElement>('[data-testid="agents-jobs-level"]')!.getBoundingClientRect().right,
      }));
      expect(widths.doc).toBeLessThanOrEqual(390);
      expect(widths.level).toBeLessThanOrEqual(390);
      await page.screenshot({ path: testInfo.outputPath("vero-agenti-e-lavori-telefono.png") });
      // Back goes to System, one level up.
      await level.getByTestId("agents-jobs-back").tap();
      await expect(level).toHaveCount(0);
      await expect(page.getByTestId("menu-system-status-menu")).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test("hub gone, after a reload: Topics alone, nothing of the hub, no error", async ({ page, request }) => {
    await hub?.close();
    hub = null;
    await waitForHubDown(request);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await goToApp(page);
    const { level } = await openLevel(page);
    await expect(level.getByTestId("agents-jobs-freshness")).toHaveCount(0);
    for (const id of ["outside", "subagents", "proxy", "queue", "workflows", "line", "quota"]) {
      await expect(level.getByTestId(`agents-jobs-section-${id}`)).toHaveCount(0);
    }
    await expect(level.getByTestId("agents-jobs-row")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
