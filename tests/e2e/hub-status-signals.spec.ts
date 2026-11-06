/**
 * THE HUB'S STATUS SIGNALS IN TOPICS (hub-smistamento: Panoramica, Diario,
 * Servizi; HUBBR-06, HUBBR-07, HUBBR-09).
 *
 * What the hub's status line said and Topics did not: the bell now carries the
 * subscription that runs out before its reset at today's pace (first among
 * the quotas), the PC that cannot be reached (broken) and the Mac under
 * strain (to look at), each with its way to the view where it lives.
 * History splits «Automazioni e agenti» into the hub's own kinds with their
 * counts, a workflow's line opens its row in Automazioni and a job born from a
 * card opens the task, an item linked to a hub page that moved into Topics
 * opens that place. Processi groups the services as the hub did (your apps
 * first) and says when the hub read them.
 *
 * The hub is a fake (helpers/fake-hub.ts) on the port the test server reads;
 * its forecast, PC, Mac and diary are replaced whole for this scene
 * (`answersOverride`). The real :3360 and :3335 are never touched, and the
 * names are placeholders.
 *
 * The shots are taken in the mockups' workspace (helpers/shot-scene.ts).
 * Video on: the recording is the proof; the screenshots go to the test's
 * output (`vero-segnali-hub-*.png`).
 *
 * Mutation: with `quotaOutlooks` (lib/hubSignals.ts) answering an empty list,
 * «the forecast leads Quote e account» is red: the first row of the group is
 * the 92% week, not Claude running out.
 *
 * @covers HUBBR-06
 * @covers HUBBR-07
 * @covers HUBBR-09
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { openMainChat, seedScene, type Scene } from "./helpers/shot-scene";
import { goToApp } from "./helpers";
import { defaultFakeHubItems, startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE, canonicalTmpRoot } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const HOUR = 3_600_000;
const TASK_ID = "e2e-task-42";

/** Claude runs out in three hours and stays without for a day; Codex holds until Friday but not to its reset. */
function overrides(now: number): Record<string, unknown> {
  return {
    forecast: { at: now, providers: [
      { id: "claude", status: "corto", level: 2, runsOutAt: now + 3 * HOUR, right: "finisce oggi alle 18:00", sub: "3 account · al ritmo di oggi (93% al giorno), poi 1 g 6 h senza" },
      { id: "codex", status: "stretto", level: 1, runsOutAt: now + 40 * HOUR, right: "regge fino a ven 18:00", sub: "al ritmo di oggi, poi 10 h senza" },
      { id: "muse", status: "ok", level: 0, runsOutAt: null, right: "arriva al reset", sub: "" },
    ] },
    pc: { pc: "chiuso", perche: "" },
    mac: {
      at: now, cores: 12, swapUsedGB: 1.2, swapTotalGB: 8, swapSustained: false, mem: { totalGB: 32, usedGB: 27 }, hogs: [], trees: [],
      effort: { level: 2, label: "sotto sforzo", why: "disco al 97%", parts: [{ key: "cpu", pct: 75 }, { key: "mem", pct: 65 }] },
    },
    diario: { at: now, days: 7, items: [
      { at: now - 20 * 60_000, kind: "workflow", who: "Workflow", title: "Audit delle dipendenze", outcome: "error", what: "1 agente, 3 min", ref: "wf:audit-dipendenze", link: "#automations/wf%3Aaudit-dipendenze" },
      { at: now - 30 * 60_000, kind: "agente", who: "Agente · Codex", title: "Card «Rilascio di acme-web»", outcome: "ok", what: "progetto acme-web", ref: `card:acme-board/${TASK_ID}`, link: `#automations/card%3Aacme-board%2F${TASK_ID}` },
      { at: now - 40 * 60_000, kind: "auto", who: "GitHub", title: "Reindex dell'indice documenti", outcome: "error", what: "uscito con codice 1", link: "#automations/gh%3Adocs-reindex" },
      { at: now - 50 * 60_000, kind: "tu", who: "Tu", title: "Hai detto «va bene» su Backup del Mac", outcome: null, what: "" },
      { at: now - 60 * 60_000, kind: "app", who: "Mac", title: "Topics app", outcome: "error", what: "" },
    ] },
  };
}

/** The reader holds this scene's forecast and PC: the bell can read them. */
async function waitForSignals(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: { pc?: string; providers?: Array<{ level?: number }> } }>;
    return `${snap.pc?.data?.pc ?? "-"}|${snap.forecast?.data?.providers?.some((p) => p.level === 2) ?? false}`;
  }, { timeout: 90_000, message: "the live reader never read the scene's forecast and PC" }).toBe("chiuso|true");
}

const panel = (page: Page) => page.getByTestId("inbox-panel");

async function openBell(page: Page): Promise<void> {
  await page.getByTestId("inbox-button").click();
  await expect(panel(page)).toBeVisible();
}

test.describe("the hub's status signals", () => {
  let hub: FakeHub | null = null;
  let scene: Scene | null = null;

  test.beforeAll(async ({ request }) => {
    scene = await seedScene(request, `${canonicalTmpRoot()}/e2e-hub-signals-${Date.now().toString(36)}`);
    // One more item, linked to a page of the hub that now lives in Topics.
    const services = { id: "e2e-services", tipo: "vista" as const, title: "Indice dei documenti da guardare", from: "guardiano", link: "#services", at: Date.now() - HOUR };
    hub = await startFakeHub([...defaultFakeHubItems(), services], { automations: true });
    hub.answersOverride = overrides(Date.now());
    await waitForSignals(request);
  });

  test.afterAll(async ({ request }) => {
    await hub?.close();
    await scene?.cleanup(request);
  });

  test("the bell says which quota runs out, which machine needs a look, and each row leads to its view", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await goToApp(page);
    await openMainChat(page, scene!);
    await openBell(page);

    // The forecast leads «Quote e account»: the worst first, red; the one that holds until Friday amber.
    const quota = panel(page).getByTestId("bell-group-quota");
    const outlooks = quota.locator('[data-source="outlook"]');
    await expect(quota.getByTestId("bell-row").first()).toHaveAttribute("data-source", "outlook", { timeout: 20_000 });
    await expect(outlooks).toHaveCount(2);
    await expect(outlooks.first()).toHaveAttribute("data-provider", "claude");
    await expect(outlooks.first()).toHaveAttribute("data-tone", "bad");
    await expect(outlooks.first()).toContainText("Claude finisce oggi alle 18:00");
    await expect(outlooks.first().getByTestId("bell-outlook-sub")).toContainText("poi 1 g 6 h senza");
    await expect(outlooks.nth(1)).toHaveAttribute("data-tone", "warn");
    await expect(outlooks.nth(1)).toContainText("Codex regge fino a ven 18:00");
    // A provider that reaches its reset is not news.
    await expect(quota).not.toContainText("Muse arriva al reset");

    // The PC that cannot be reached is broken, amber: a command away on the PC.
    const pc = panel(page).getByTestId("bell-group-broken").locator('[data-source="machine"]');
    await expect(pc).toHaveAttribute("data-machine", "pc");
    await expect(pc).toHaveAttribute("data-tone", "warn");
    await expect(pc).toContainText("PC: acceso, ssh chiuso");
    await expect(pc.getByTestId("bell-machine-hint")).toHaveText("il firewall di Windows blocca ssh: serve un comando sul PC");
    // The Mac under strain is the first thing to look at, with the hub's why.
    const mac = panel(page).getByTestId("bell-group-look").getByTestId("bell-row").first();
    await expect(mac).toHaveAttribute("data-machine", "mac");
    await expect(mac).toContainText("Mac: sotto sforzo");
    await expect(mac.getByTestId("bell-machine-hint")).toHaveText("disco al 97%");
    await page.screenshot({ path: testInfo.outputPath("vero-segnali-hub-campanella-scuro.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({ path: testInfo.outputPath("vero-segnali-hub-campanella-chiaro.png") });
    await page.emulateMedia({ colorScheme: "dark" });

    // The forecast opens Account e quote, the machine opens Processi.
    await outlooks.first().getByTestId("bell-open-accounts").click();
    await expect(page.getByTestId("accounts-pane")).toBeVisible({ timeout: 20_000 });
    await expect(panel(page)).toHaveCount(0);
    // An item linked to the hub's Servizi page opens Processi in Topics, not the hub's page.
    await openBell(page);
    const item = panel(page).getByTestId("inbox-waiting").locator("li").filter({ hasText: "Indice dei documenti da guardare" }).getByTestId("bell-open");
    await expect(item).toHaveAttribute("data-target", "utility");
    expect(await item.evaluate((el) => el.tagName)).toBe("BUTTON");
    await item.click();
    const processes = page.getByTestId("machine-processes");
    await expect(processes).toBeVisible({ timeout: 20_000 });
    await openBell(page);
    await panel(page).getByTestId("bell-group-look").getByTestId("bell-row").first().getByTestId("bell-open-processes").click();
    await expect(panel(page)).toHaveCount(0);
    await expect(processes).toBeVisible();

    // Processi: the services in the hub's groups, your apps first, and when the hub read them.
    const services = processes.getByTestId("machine-processes-services");
    const groups = services.getByTestId("machine-services-group");
    await expect(groups.first()).toHaveAttribute("data-group", "apps", { timeout: 20_000 });
    await expect(groups.first()).toContainText("Le tue app");
    await expect(groups.first()).toContainText("Hub dei consumi");
    // The area with the service in trouble comes right after; each area says how many.
    await expect(groups.nth(1)).toHaveAttribute("data-group", "group:Strumenti");
    await expect(groups.nth(1)).toContainText("Indice dei documenti");
    expect(await groups.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.group))).toEqual(["apps", "group:Strumenti", "group:Consumi", "group:Assistente", "group:Agenti"]);
    await expect(services.getByTestId("machine-services-read")).toHaveText(/^letto alle \d{2}:\d{2}$/);
    await page.screenshot({ path: testInfo.outputPath("vero-segnali-hub-servizi-scuro.png") });
  });

  test("History splits the hub's diary by kind, and a workflow or a card's job opens where it lives", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await goToApp(page);
    await openMainChat(page, scene!);
    await openBell(page);
    await panel(page).getByTestId("inbox-tab-history").click();
    await panel(page).getByTestId("bell-history-hub").click();
    const kinds = panel(page).getByTestId("bell-history-kinds");
    await expect(kinds).toBeVisible({ timeout: 20_000 });
    // The hub's kinds, in its order, each with its count.
    expect(await kinds.getByRole("button").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-testid")}=${e.getAttribute("data-count")}`))).toEqual([
      "bell-history-kind-auto=1", "bell-history-kind-agente=1", "bell-history-kind-workflow=1", "bell-history-kind-tu=1", "bell-history-kind-app=1",
    ]);
    const diary = panel(page).getByTestId("bell-diary-row");
    await expect(diary).toHaveCount(5);
    await kinds.getByTestId("bell-history-kind-workflow").click();
    await expect(diary).toHaveCount(1);
    await expect(diary).toContainText("Audit delle dipendenze");
    await page.screenshot({ path: testInfo.outputPath("vero-segnali-hub-cronologia-scuro.png") });
    // Clicking the chosen kind again shows the whole lump.
    await kinds.getByTestId("bell-history-kind-workflow").click();
    await expect(diary).toHaveCount(5);

    // A workflow's line opens its row in Automazioni, under Topics' own key.
    const workflow = diary.filter({ hasText: "Audit delle dipendenze" }).getByTestId("bell-diary-open");
    await expect(workflow).toHaveAttribute("data-target", "automation");
    await workflow.click();
    await expect(page.getByTestId("automations-pane")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("automation-detail")).toHaveAttribute("data-key", "workflow:audit-dipendenze", { timeout: 20_000 });

    // A job born from a card of the board opens that task.
    await openBell(page);
    await panel(page).getByTestId("inbox-tab-history").click();
    await panel(page).getByTestId("bell-history-hub").click();
    await panel(page).getByTestId("bell-history-kinds").getByTestId("bell-history-kind-agente").click();
    const job = panel(page).getByTestId("bell-diary-row").getByTestId("bell-diary-open");
    await expect(job).toHaveAttribute("data-target", "task");
    await expect(job).toHaveAttribute("aria-label", "Apri «Card «Rilascio di acme-web»» nella Board");
    await job.click();
    await expect(page).toHaveURL(new RegExp(TASK_ID), { timeout: 20_000 });
  });
});
