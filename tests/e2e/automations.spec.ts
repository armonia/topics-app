/**
 * AUTOMAZIONI (hub-smistamento, HUBBR-14 and HUBBR-15), in the place of the Cron panel.
 *
 * The row above the Board says «3 da sistemare» (two broken, one waiting on
 * you) and opens the whole view: «Decidi tu» oldest first, the Jarvis jobs
 * with their three commands, Mac read-only, GitHub, PC and the workflows
 * folded into «Le altre aree», the Calendario tab. The «+» menu offers no Cron
 * panel. Every command of an OpenClaw job reaches Topics' cron routes (faked
 * here with `page.route`, so the real gateway is never called), a refused run
 * leaves its reason (CRONUI-01) and a run that works marks its row
 * (CRONUI-01b). Votes, notes and silences reach the hub's feedback log and the
 * detail shows them as read back; «Risolvi tu» reaches the hub's `fix`.
 *
 * The hub is a fake (helpers/fake-hub.ts with `automations`) on the port the
 * test server reads; the real :3360 is never touched, the names are
 * placeholders.
 *
 * Mutation: with `withCronJobs` (lib/automations.ts) left out of the rows, the
 * switched-off job and every Jarvis command vanish and «the commands reach
 * the cron routes» is red; with the vote drawn from what was clicked instead of
 * the model read back, «Va bene pressed» is red against a hub that refuses it.
 *
 * Video on: the recording is the proof. Screenshots of the built surface go to
 * the test's output (`vero-automazioni-vista-*.png`).
 *
 * @covers HUBBR-14
 * @covers HUBBR-15
 * @covers CRON-01
 * @covers CRONUI-01
 * @covers CRONUI-01b
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const PANE = "automations-pane";
const HOUR = 3_600_000;

async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: { needsYou?: number } }>;
    return snap.automations?.data?.needsYou ?? -1;
  }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBe(1);
}

interface CronFake {
  jobs: Array<Record<string, unknown> & { id: string; enabled: boolean }>;
  calls: Array<{ method: string; path: string; body: unknown }>;
  refuseRun: boolean;
}

/** Topics' cron routes, faked in the page: two jobs on, one the hub knows nothing of because it is off. */
async function fakeCron(page: Page): Promise<CronFake> {
  const fake: CronFake = {
    jobs: [
      { id: "job-docs", name: "Indice dei documenti", enabled: true, schedule: { kind: "every", everyMs: HOUR } },
      { id: "job-week", name: "Riepilogo settimanale su Discord", enabled: true, schedule: { kind: "cron", expr: "0 9 * * 1" } },
      { id: "job-mail", name: "Avviso mail importanti", enabled: true, schedule: { kind: "every", everyMs: 60_000 } },
      { id: "job-day", name: "Giornata di lavoro nel calendario", enabled: true },
      { id: "job-brief", name: "Brief del mattino", enabled: true },
      { id: "job-sync", name: "Promemoria e board allineati", enabled: true },
      { id: "job-costs", name: "Costi della settimana", enabled: true },
      { id: "job-old", name: "Vecchio riepilogo dei costi", enabled: false, schedule: { kind: "cron", expr: "0 8 * * 1" } },
    ],
    calls: [],
    refuseRun: false,
  };
  await page.route("**/api/cron/jobs**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const body = req.postDataJSON() as unknown;
    if (method === "GET" && url.pathname === "/api/cron/jobs") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobs: fake.jobs }) });
    }
    fake.calls.push({ method, path: url.pathname, body });
    const id = url.pathname.split("/")[4] ?? "";
    if (method === "POST" && url.pathname.endsWith("/run")) {
      if (fake.refuseRun) return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Gateway error: unreachable" }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    if (method === "PATCH") {
      fake.jobs = fake.jobs.map((j) => (j.id === id ? { ...j, ...(body as Record<string, unknown>) } : j));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    if (method === "DELETE") {
      fake.jobs = fake.jobs.filter((j) => j.id !== id);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    return route.fallback();
  });
  return fake;
}

const row = (page: Page, key: string) => page.getByTestId(PANE).locator(`[data-testid="automation-row"][data-key="${key}"]`);

test.describe("automations", () => {
  let hub: FakeHub | null = null;

  test.beforeAll(async ({ request }) => {
    hub = await startFakeHub(undefined, { automations: true });
    await waitForHub(request);
  });
  test.afterAll(async () => {
    await hub?.close();
  });

  test("the row above the Board opens the view: Decidi tu, Jarvis with its commands, Mac read-only, no Cron panel", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    const cron = await fakeCron(page);
    await goToApp(page);

    const sidebarRow = page.getByTestId("sidebar-automations");
    await expect(page.getByTestId("sidebar-automations-tail")).toHaveText("3 da sistemare", { timeout: 20_000 });
    const board = page.getByTestId("sidebar-board-generale");
    if (await board.count()) expect((await sidebarRow.boundingBox())!.y).toBeLessThan((await board.boundingBox())!.y);

    // The Cron panel is no longer offered anywhere in the «+» menu.
    await page.getByTestId("pane-add-menu-trigger").first().click();
    await expect(page.getByTestId("pane-add-menu")).toBeVisible();
    await expect(page.getByTestId("pane-add-menu-cron")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await sidebarRow.click();
    const pane = page.getByTestId(PANE);
    await expect(pane).toBeVisible({ timeout: 20_000 });
    await expect(sidebarRow).toHaveAttribute("aria-selected", "true");
    await expect(pane.getByTestId("automations-verdict-title")).toHaveText("3 da sistemare, il resto gira.", { timeout: 20_000 });
    await expect(pane.getByTestId("automations-verdict")).toContainText("1 da decidere · 2 rotte · 12 in ordine su 15 · 412 giri oggi");

    // «Decidi tu»: the broken and the one waiting on you, oldest first.
    const decide = pane.getByTestId("automations-decide-row");
    await expect(decide).toHaveCount(3);
    expect(await decide.evaluateAll((els) => els.map((e) => e.getAttribute("data-key")))).toEqual(["cron:job-week", "launchd:com.example.backup", "cron:job-docs"]);
    // An agent is already on the backup (the hub's queue); the OpenClaw jobs can be run again.
    await expect(decide.nth(1).getByTestId("automations-decide-fixing")).toHaveText("Un agente ci sta già lavorando.");
    await expect(decide.nth(1).getByTestId("automations-decide-run")).toHaveCount(0);
    await expect(decide.nth(2).getByTestId("automations-decide-run")).toBeVisible();

    // Jarvis: every OpenClaw job with the three commands, the switched-off one listed off.
    const jarvis = pane.locator('[data-testid="automations-system"][data-system="jarvis"]');
    await expect(jarvis.getByTestId("automation-run").first()).toBeEnabled({ timeout: 20_000 });
    await jarvis.getByTestId("automation-more").click();
    await expect(row(page, "cron:job-old").getByTestId("automation-toggle")).toHaveAttribute("aria-checked", "false");
    await expect(row(page, "cron:job-old")).toContainText("spenta");
    // The hub says nothing of a switched-off job: its schedule, in the detail, comes from the gateway's list.
    await row(page, "cron:job-old").click();
    await expect(page.getByTestId("automation-detail")).toContainText("pianificata: 0 8 * * 1");
    for (const key of ["cron:job-docs", "cron:job-mail", "cron:job-old"]) {
      await expect(row(page, key).getByTestId("automation-run")).toBeVisible();
      await expect(row(page, key).getByTestId("automation-remove")).toBeVisible();
    }
    // The health finding on a job is Jarvis too, but read-only: it is not a job of the gateway.
    await expect(row(page, "health:job-mail").getByTestId("automation-readonly")).toBeVisible();
    // Mac: read-only, nothing runs or stops a launchd job from here.
    const mac = pane.locator('[data-testid="automations-system"][data-system="mac"]');
    await expect(mac.getByTestId("automation-row")).toHaveCount(3);
    await expect(mac.getByTestId("automation-run")).toHaveCount(0);
    await expect(mac.getByTestId("automation-readonly")).toHaveCount(3);
    await expect(row(page, "launchd:com.example.backup").getByTestId("automation-last")).toContainText("exit 1");
    await expect(pane).not.toContainText("Vecchio controllo spento");
    // The systems all in order fold.
    expect(await pane.getByTestId("automations-area").evaluateAll((els) => els.map((e) => e.getAttribute("data-system")))).toEqual(["github", "pc", "workflow"]);

    // The broken job opened: its status, its runs from the hub, «Risolvi tu».
    await jarvis.getByTestId("automation-row").first().click();
    const detail = page.getByTestId("automation-detail");
    await expect(detail).toHaveAttribute("data-key", "cron:job-docs");
    await expect(detail.getByTestId("automation-status")).toContainText("Fallisce da 2 giri");
    await expect(detail.getByTestId("automation-run-row")).toHaveCount(4, { timeout: 15_000 });
    await expect(detail.getByTestId("automation-run-row").first()).toContainText("cartella non trovata");
    await expect(detail.getByTestId("automation-fix-go")).toBeVisible();
    await jarvis.getByTestId("automation-row").first().scrollIntoViewIfNeeded();
    await pane.evaluate((el) => el.querySelector("section")?.scrollTo(0, 0));
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath("vero-automazioni-vista-scuro.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({ path: testInfo.outputPath("vero-automazioni-vista-chiaro.png") });
    await page.emulateMedia({ colorScheme: "dark" });

    // The three commands reach the cron routes; the run marks its row at once.
    await row(page, "cron:job-mail").getByTestId("automation-run").click();
    await expect(row(page, "cron:job-mail").getByTestId("automation-last")).toHaveText("eseguita ora");
    await row(page, "cron:job-mail").getByTestId("automation-toggle").click();
    await expect(row(page, "cron:job-mail").getByTestId("automation-toggle")).toHaveAttribute("aria-checked", "false");
    await row(page, "cron:job-costs").getByTestId("automation-remove").click();
    await page.getByRole("dialog").getByRole("button", { name: "Elimina" }).click();
    await expect(row(page, "cron:job-costs")).toHaveCount(0);
    expect(cron.calls).toEqual([
      { method: "POST", path: "/api/cron/jobs/job-mail/run", body: null },
      { method: "PATCH", path: "/api/cron/jobs/job-mail", body: { enabled: false } },
      { method: "DELETE", path: "/api/cron/jobs/job-costs", body: null },
    ]);

    // A refused run says why, in Italian, not the gateway's English.
    cron.refuseRun = true;
    await row(page, "cron:job-brief").getByTestId("automation-run").click();
    const refusal = pane.getByTestId("automations-refusal");
    await expect(refusal).toHaveText("Esecuzione non partita: il gateway di Jarvis non risponde.");
    await expect(refusal).not.toContainText("Gateway error");
    await expect(row(page, "cron:job-brief").getByTestId("automation-last")).not.toHaveText("eseguita ora");

    // A system chip: only its rows.
    await pane.getByTestId("automations-chip-mac").click();
    await expect(pane.getByTestId("automations-system")).toHaveCount(1);
    await expect(pane.getByTestId("automations-system")).toHaveAttribute("data-system", "mac");
    await pane.getByTestId("automations-chip-all").click();

    // The calendar: by day, never the prompt.
    await pane.getByTestId("automations-tab-calendar").click();
    const cal = pane.getByTestId("automations-calendar");
    await expect(cal.getByTestId("automations-calendar-item")).toHaveCount(3);
    await expect(cal.getByTestId("automations-calendar-day").first()).toContainText("Oggi");
    await expect(cal).toContainText("Jarvis · WhatsApp");
    await expect(cal).not.toContainText("PROMPT GREZZO");
  });

  test("votes, notes, a silence and «Risolvi tu» reach the hub and are read back", async ({ page, request }) => {
    await request.post(`${E2E_BASE}/api/hub/e2e-reset`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await fakeCron(page);
    await goToApp(page);
    await page.getByTestId("sidebar-automations").click();
    const pane = page.getByTestId(PANE);
    await expect(row(page, "cron:job-docs")).toBeVisible({ timeout: 20_000 });
    await row(page, "cron:job-docs").click();
    const detail = page.getByTestId("automation-detail");

    // «Va bene»: the vote of the model read back, the date it was given.
    await detail.getByTestId("automation-vote-ok").click();
    await expect(detail.getByTestId("automation-vote-ok")).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
    await expect(row(page, "cron:job-docs").getByTestId("automation-vote")).toHaveAttribute("data-vote", "ok");
    expect(hub!.feedback.at(-1)).toMatchObject({ kind: "vote", key: "cron:job-docs", v: "ok", fp: "fp-cron:job-docs" });

    // «Da cambiare» asks its words before writing.
    await detail.getByTestId("automation-vote-cambia").click();
    await expect(detail.getByTestId("automation-vote-save")).toBeDisabled();
    await detail.getByTestId("automation-vote-text").fill("il percorso delle note è cambiato");
    await detail.getByTestId("automation-vote-save").click();
    await expect(detail.getByTestId("automation-vote-cambia")).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
    await expect(detail.getByTestId("automation-vote-ok")).toHaveAttribute("aria-pressed", "false");
    expect(hub!.feedback.at(-1)).toMatchObject({ kind: "vote", v: "cambia", note: "il percorso delle note è cambiato" });

    // A note, listed as the hub reads it.
    await detail.getByTestId("automation-vote-nota").click();
    await detail.getByTestId("automation-vote-text").fill("serve alla ricerca delle schede");
    await detail.getByTestId("automation-vote-text").press("Enter");
    await expect(detail.getByTestId("automation-note")).toContainText("serve alla ricerca delle schede", { timeout: 15_000 });
    await expect(detail.getByTestId("automation-vote-said")).toHaveText("Salvato e riletto dall'hub");

    // A silence for good.
    await detail.getByTestId("automation-vote-muta").click();
    await detail.getByText("sempre").click();
    await detail.getByTestId("automation-vote-text").fill("avvisa già il controllo di salute");
    await detail.getByTestId("automation-vote-save").click();
    await expect(detail.getByTestId("automation-muted")).toHaveText("Non ti avviso più", { timeout: 15_000 });
    expect(hub!.feedback.at(-1)).toMatchObject({ kind: "mute", key: "cron:job-docs", until: null, why: "avvisa già il controllo di salute" });

    // «Risolvi tu»: the hub's fix with the key, and where the outcome lands.
    await detail.getByTestId("automation-fix-go").click();
    await expect(detail.getByTestId("automation-fix-said")).toHaveText("Affidata a un agente: l'esito arriva nella Cronologia della campanella.");
    expect(hub!.posts.filter((p) => p.path === "fix")).toEqual([{ path: "fix", key: "cron:job-docs" }]);

    // A workflow: read-only, its runs with the cost read only when asked.
    await pane.locator('[data-testid="automations-area"][data-system="workflow"]').click();
    await row(page, "workflow:audit-dipendenze").click();
    await expect(detail).toHaveAttribute("data-key", "workflow:audit-dipendenze");
    await expect(detail.getByTestId("automation-votes")).toHaveCount(0);
    await expect(detail.getByTestId("automation-detail-commands")).toHaveCount(0);
    await detail.getByTestId("automation-run-cost-ask").first().click();
    await expect(detail.getByTestId("automation-run-cost").first()).toHaveText("2 agenti · 0,42% della settimana");
  });

  test("phone, 390 px: one column, the detail as a sheet, nothing wider than the screen", async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({
      baseURL: E2E_BASE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "dark", locale: "it-IT",
      recordVideo: { dir: testInfo.outputPath("phone-video"), size: { width: 390, height: 844 } },
    });
    const page = await ctx.newPage();
    try {
      await fakeCron(page);
      await page.goto("/");
      await expect(page.getByTestId("mobile-chrome-bar")).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => page.evaluate(() => {
        window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "automations" } }));
        return document.querySelector('[data-testid="automations-pane"]') !== null;
      }), { timeout: 20_000 }).toBe(true);
      const pane = page.getByTestId(PANE);
      await expect(pane.getByTestId("automations-decide-row")).toHaveCount(3, { timeout: 20_000 });
      await expect(row(page, "cron:job-docs")).toBeVisible();
      const widths = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        pane: document.querySelector<HTMLElement>('[data-testid="automations-pane"]')!.scrollWidth,
      }));
      expect(widths.doc).toBeLessThanOrEqual(390);
      expect(widths.pane).toBeLessThanOrEqual(390);
      await page.screenshot({ path: testInfo.outputPath("vero-automazioni-vista-telefono.png") });
      await pane.getByTestId("automations-decide-row").nth(2).locator("button").first().click();
      const sheet = page.getByTestId("automation-sheet");
      await expect(sheet.getByTestId("automation-detail")).toHaveAttribute("data-key", "cron:job-docs");
      await expect(sheet.getByTestId("automation-detail-run")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("vero-automazioni-vista-telefono-dettaglio.png") });
      await sheet.getByTestId("automation-detail-close").click();
      await expect(sheet).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
});
