/**
 * AUTOMAZIONI, what the hub's own page told and Topics now tells too
 * (hub-smistamento, HUBBR-14 and HUBBR-15).
 *
 * Head and foot: the hub served its last good copy and the view says so; the
 * tokens per provider, the unmeasured ones and the silent sources in pills;
 * each source with its time, «?» for the silent one, «PC dorme», and the
 * hidden jobs opening into the list of why.
 *
 * Lists: «Decidi tu» says how many runs in a row failed, what you could lose,
 * the brake on the agent; the workflow step waiting for an ok is counted
 * apart. The status filter (Tutte, Ok, Problemi), the search on who runs it
 * («/» brings the focus there), the grouping by purpose with its counts and
 * «Computer e app». A row carries its project, brake or remark, where it runs
 * and its steps (opened with the chevron or «p»), the strip's words, the
 * state glyph, the cost of 7 days and the next run («~» when guessed); j/k
 * move between rows.
 *
 * Detail: the level, the sources fused, every fact (ticks, cost, delivery,
 * proof, «se si rompe», who, what it writes, area), the scheme step by step
 * with who answered and the exact command, the runs in full (by hand, wrote
 * or why not, the error whole, the report, the model), the technical details
 * and the run on GitHub, no «Risolvi tu» on a gate. Votes: the vote's note
 * read back, «Annulla» for 5 seconds, the letters from the keyboard.
 * Calendar: a row opens on what it will do and what it writes.
 *
 * The hub is a fake (helpers/fake-hub.ts with `automations`); Topics' cron
 * routes are faked in the page. Names are placeholders.
 *
 * Mutation: with `readHead` (lib/automationsHead.ts) left out of
 * `readAutomations`, the pills, the foot and the brake vanish and the first
 * test is red; with `toDecide` counting the gates, «Decidi tu» holds four rows.
 *
 * Video on: the recording is the proof; the screenshots go to the test's output.
 *
 * @covers HUBBR-14
 * @covers HUBBR-15
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore } from "./helpers/api-fixtures";
import { goToApp } from "./helpers";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const PANE = "automations-pane";

async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: { needsYou?: number } }>;
    return snap.automations?.data?.needsYou ?? -1;
  }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBe(2);
}

/** Topics' cron routes, read only: the gateway lists the docs index and the mail alert. */
async function fakeCron(page: Page): Promise<void> {
  await page.route("**/api/cron/jobs**", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ jobs: [{ id: "job-docs", name: "Indice dei documenti", enabled: true }, { id: "job-mail", name: "Avviso mail importanti", enabled: true }] }),
  }));
}

async function openView(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await fakeCron(page);
  await goToApp(page);
  await page.getByTestId("sidebar-automations").click();
  await expect(page.getByTestId(PANE).getByTestId("automations-verdict-title")).toHaveText("4 da sistemare, il resto gira.", { timeout: 20_000 });
}

const row = (page: Page, key: string) => page.getByTestId(PANE).locator(`[data-testid="automation-row"][data-key="${key}"]`);

test.describe("automations, as the hub told them", () => {
  let hub: FakeHub | null = null;

  test.beforeAll(async ({ request }) => {
    hub = await startFakeHub(undefined, { automations: true });
    await waitForHub(request);
  });
  test.afterAll(async () => {
    await hub?.close();
  });
  test.beforeEach(async ({ request }) => {
    await request.post(`${E2E_BASE}/api/hub/e2e-reset`);
    await resetPaneStore(request, []);
  });

  test("head, foot, «Decidi tu», filters, search, purpose, «Computer e app» and the rows", async ({ page }, testInfo) => {
    await openView(page);
    const pane = page.getByTestId(PANE);

    // The hub's last good copy is said as such, never «dal vivo».
    await expect(pane.getByTestId("automations-live")).toContainText("ultima lettura fallita, dati delle");
    await expect(pane.getByTestId("automations-live")).toHaveAttribute("data-stale", "true");
    // The pills: tokens per provider, the unmeasured, the silent source.
    await expect(pane.locator('[data-testid="automations-pill-tokens"][data-provider="muse"]')).toHaveText("Muse12 k oggi · 80 k in 7 g");
    await expect(pane.locator('[data-testid="automations-pill-tokens"][data-provider="claude"]')).toContainText("4 k in 7 g");
    await expect(pane.getByTestId("automations-pill-unmeasured")).toHaveText("1 non misurata");
    await expect(pane.getByTestId("automations-pill-sources")).toHaveText("1 fonte su 4 non risponde");

    // «Decidi tu»: failures in a row, what you could lose, the brake; the gate apart.
    const docsDecide = pane.locator('[data-testid="automations-decide-row"][data-key="cron:job-docs"]');
    await expect(docsDecide.getByTestId("automations-decide-sub")).toContainText("fallita le ultime 2 volte");
    await expect(docsDecide.getByTestId("automations-decide-ifbroken")).toHaveText("Finché resta così potresti cercare una nota di acme-docs e non trovarla.");
    await expect(docsDecide.getByTestId("automations-decide-brake")).toHaveText("in pausa fino alle 23:00 perché Claude è al 92%");
    await expect(pane.locator('[data-testid="automations-decide-row"][data-key="lobster:release"]')).toHaveCount(0);
    await expect(pane.getByTestId("automations-gates")).toContainText("1 passo di un workflow aspetta un ok");

    // The rows: project, brake, where and steps, strip words, glyph, cost, next.
    const docs = row(page, "cron:job-docs");
    await expect(docs.getByTestId("automation-project")).toHaveAttribute("data-project", "acme-docs");
    await expect(docs.getByTestId("automation-brake")).toContainText("Claude è al 92%");
    await expect(docs.getByTestId("automation-flow")).toContainText("3 passi");
    await expect(docs.getByTestId("automation-strip")).toHaveAttribute("aria-label", /giri nelle ultime 22 ore, 2 falliti/);
    await expect(docs.locator("[data-glyph]")).toHaveAttribute("data-glyph", "rotto");
    await expect(docs.getByTestId("automation-usage")).toHaveText("84 k");
    await expect(docs.getByTestId("automation-strip").locator('[data-cell="next"]')).toHaveCount(1);
    const mail = row(page, "cron:job-mail");
    await expect(mail.getByTestId("automation-warn")).toHaveText("si sta riprendendo dopo 3 errori di fila");
    await expect(mail.locator("[data-glyph]")).toHaveAttribute("data-glyph", "ok");
    await expect(mail.getByTestId("automation-usage")).toHaveText("non misurato");
    await expect(mail.getByTestId("automation-next")).toHaveText(/^~/);
    await expect(row(page, "launchd:com.example.memlog").getByTestId("automation-usage")).toHaveText("solo script");

    // The steps open in the row, with the chevron or «p»; j/k move between rows.
    await docs.getByTestId("automation-flow").click();
    await expect(docs.getByTestId("automation-flow-steps")).toContainText("legge le note");
    await expect(docs.getByTestId("automation-flow-steps")).toContainText("Sonnet");
    await docs.focus();
    await page.keyboard.press("p");
    await expect(docs.getByTestId("automation-flow-steps")).toHaveCount(0);
    await page.keyboard.press("j");
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-key"))).toBe("cron:job-week");
    await page.keyboard.press("k");
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-key"))).toBe("cron:job-docs");

    // The foot: each source with its time, «?» for the silent one, the PC asleep, the hidden ones.
    const foot = pane.getByTestId("automations-footer");
    await expect(foot.locator('[data-source="github"]')).toContainText("GitHub ?");
    await expect(foot.locator('[data-source="github"]')).toHaveAttribute("data-ok", "false");
    await expect(foot.locator('[data-source="pc"]')).toContainText("PC dorme");
    await foot.getByTestId("automations-hidden").click();
    await expect(foot.getByTestId("automations-hidden-list")).toContainText("Vecchio controllo spento");
    await expect(foot.getByTestId("automations-hidden-list")).toContainText("silenziata fino al 12/11");
    await pane.evaluate((el) => el.querySelector("section")?.scrollTo(0, 0));
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath("vero-automazioni-parita-vista.png") });

    // Status filter: «Ok» hides «Decidi tu», «Problemi» hides the ones in order and «Computer e app».
    await expect(pane.getByTestId("automations-status-ok")).toContainText("11");
    await expect(pane.getByTestId("automations-status-problems")).toContainText("4");
    await pane.getByTestId("automations-status-ok").click();
    await expect(pane.getByTestId("automations-decide")).toHaveCount(0);
    await expect(row(page, "cron:job-docs")).toHaveCount(0);
    await expect(row(page, "cron:job-mail")).toHaveCount(1);
    await pane.getByTestId("automations-status-problems").click();
    await expect(row(page, "cron:job-mail")).toHaveCount(0);
    await expect(pane.getByTestId("automations-own")).toHaveCount(0);
    await pane.getByTestId("automations-status-all").click();

    // The search: by who runs it; «/» brings the focus there, Esc empties it.
    await row(page, "cron:job-mail").focus();
    await page.keyboard.press("/");
    await expect(pane.getByTestId("automations-search")).toBeFocused();
    await page.keyboard.type("muse spark");
    await expect(pane.getByTestId("automation-row")).toHaveCount(1);
    await expect(row(page, "cron:job-docs")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(pane.getByTestId("automations-search")).toHaveValue("");

    // By purpose: the hub's areas, the ones with a problem first, with their counts.
    await pane.getByTestId("automations-group-area").click();
    const jarvisArea = pane.locator('[data-testid="automations-area-group"][data-area="jarvis-agenti"]');
    await expect(jarvisArea.locator('[data-key="cron:job-docs"]')).toHaveCount(1);
    await expect(jarvisArea.getByTestId("automations-area-counts")).toContainText("1 rotta");
    await expect(pane.locator('[data-testid="automations-area-group"][data-area="posta-avvisi"]').locator('[data-key="cron:job-mail"]')).toHaveCount(1);
    await expect(pane.getByTestId("automations-own")).toContainText("Computer e app");
    await page.screenshot({ path: testInfo.outputPath("vero-automazioni-parita-scopo.png") });
  });

  test("the detail: facts, scheme, runs in full, technical details, gate, vote lines, «Annulla», keys", async ({ page }, testInfo) => {
    await openView(page);
    const pane = page.getByTestId(PANE);
    await row(page, "cron:job-docs").click();
    const detail = page.getByTestId("automation-detail");
    await expect(detail.getByTestId("automation-level")).toHaveText("Rotta");
    await expect(detail.getByTestId("automation-detail-brake")).toContainText("Claude è al 92%");
    await expect(detail.getByTestId("automation-ticks")).toContainText("8/10 riusciti");
    await expect(detail.getByTestId("automation-fact-usage")).toContainText("84 k token in 7 giorni, 12 k oggi");
    await expect(detail.getByTestId("automation-fact-ifbroken")).toContainText("cercare una nota di acme-docs");
    await expect(detail.getByTestId("automation-fact-who")).toHaveText("Muse Spark, poi Sonnet");
    await expect(detail.getByTestId("automation-fact-means")).toHaveText("niente, se va tutto bene");
    await expect(detail.getByTestId("automation-facts")).toContainText("Jarvis e agenti");

    // The scheme: who answered and why, the queue, the exact command behind the fold.
    const graph = detail.getByTestId("automation-graph");
    await expect(graph.getByTestId("automation-graph-node")).toHaveCount(4, { timeout: 15_000 });
    await expect(graph.locator('[data-kind="model"]')).toContainText("Ha risposto Claude Sonnet 5.5.");
    await expect(graph.getByTestId("automation-graph-why")).toHaveText("Prima: Muse Spark 1.3 è fallito (quota finita).");
    await expect(graph.getByTestId("automation-graph-queue").locator("li")).toHaveCount(3);
    await graph.locator('[data-kind="step"]').getByTestId("automation-graph-more").locator("summary").click();
    await expect(graph.getByTestId("automation-graph-command")).toHaveText("node ~/bin/reindex.mjs --root acme-docs/notes");

    // The runs in full: by hand, why it did not write, the error whole, the report, the model.
    const runs = detail.getByTestId("automation-runs");
    await expect(runs.getByTestId("automation-runs-summary")).toHaveText("ultimi 4 · 2 falliti · ti ha scritto 1 volta", { timeout: 15_000 });
    const first = runs.getByTestId("automation-run-row").first();
    await expect(first).toContainText("lanciato a mano");
    await expect(first).toContainText("non ti ha scritto: niente da dire");
    await first.locator("summary").click();
    await expect(first.getByTestId("automation-run-error")).toContainText("at reindex");
    const third = runs.getByTestId("automation-run-row").nth(2);
    await expect(third.getByTestId("automation-run-said")).toHaveText("ti ha scritto su WhatsApp");
    await third.locator("summary").click();
    await expect(third.getByTestId("automation-run-report")).toContainText("412 schede, 3 nuove");
    await expect(third.getByTestId("automation-run-model")).toHaveText("Modello: Sonnet 5.5 · 12 k token");

    // The technical details: the exit code and the exact command.
    await detail.getByTestId("automation-tech").locator("summary").click();
    await expect(detail.getByTestId("automation-tech-exit")).toHaveText("codice 1");
    await expect(detail.getByTestId("automation-tech-command")).toContainText("reindex.mjs");
    await page.screenshot({ path: testInfo.outputPath("vero-automazioni-parita-dettaglio.png") });

    // A vote with its note, read back; «Annulla» takes it back.
    await detail.getByTestId("automation-vote-cambia").click();
    await detail.getByTestId("automation-vote-text").fill("il percorso delle note è cambiato");
    await detail.getByTestId("automation-vote-save").click();
    await expect(detail.getByTestId("automation-vote-lines")).toContainText("Hai detto: da cambiare", { timeout: 15_000 });
    await expect(detail.getByTestId("automation-vote-lines")).toContainText("«il percorso delle note è cambiato»");
    await detail.getByTestId("automation-vote-undo").click();
    await expect(detail.getByTestId("automation-vote-said")).toHaveText("Annullato e riletto dall'hub");
    await expect(detail.getByTestId("automation-vote-cambia")).toHaveAttribute("aria-pressed", "false");
    expect(hub!.feedback.at(-1)).toMatchObject({ kind: "undo", ref: "fb-1" });

    // The letters vote from the keyboard, with the focus in the view.
    await detail.getByTestId("automation-level").click();
    await page.keyboard.press("v");
    await expect(detail.getByTestId("automation-vote-ok")).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
    expect(hub!.feedback.at(-1)).toMatchObject({ kind: "vote", key: "cron:job-docs", v: "ok" });

    // Esc closes the detail and gives the focus back to its row.
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-key"))).toBe("cron:job-docs");

    // A row in order: its remark, delivery, proof and the two sources fused.
    await row(page, "cron:job-mail").click();
    await expect(detail.getByTestId("automation-status")).toHaveText("si sta riprendendo dopo 3 errori di fila");
    await expect(detail.getByTestId("automation-source")).toContainText("2 fonti");
    await expect(detail.getByTestId("automation-fact-delivered")).toHaveText("ti è arrivato");
    await expect(detail.getByTestId("automation-fact-proof")).toHaveText("ultimo avviso arrivato alle 22:25");
    await expect(detail.getByTestId("automation-fact-next")).toContainText("verso le");

    // GitHub: the run on GitHub. The gate: no «Risolvi tu», no «Scrivi a Jarvis».
    await pane.locator('[data-testid="automations-area"][data-system="github"]').click();
    await row(page, "gh:acme/acme-web/nightly.yml").click();
    await detail.getByTestId("automation-tech").locator("summary").click();
    await expect(detail.getByTestId("automation-tech-github")).toHaveAttribute("href", "https://github.com/acme/acme-web/actions/runs/42");
    await row(page, "lobster:release").click();
    await expect(detail.getByTestId("automation-gate")).toBeVisible();
    await expect(detail.getByTestId("automation-fix")).toHaveCount(0);
    await expect(detail.getByTestId("automation-jarvis")).toHaveCount(0);

    // The calendar: a row opens on what it will do and what it writes; one that writes nothing says so.
    await pane.getByTestId("automations-tab-calendar").click();
    const pr = pane.locator('[data-testid="automations-calendar-item"][data-key="cron:rem-pr"]');
    await pr.getByTestId("automations-calendar-toggle").click();
    await expect(pr.getByTestId("automations-calendar-detail")).toContainText("Ti ricorda di chiudere la PR di acme-api prima di sera.");
    await expect(pr.getByTestId("automations-calendar-detail")).toContainText("un messaggio breve con il link alla PR");
    await expect(pr.getByTestId("automations-calendar-who")).toHaveText("Jarvis su OpenClaw");
    await expect(pane.locator('[data-testid="automations-calendar-item"][data-key="cron:rem-domain"]')).toContainText("Jarvis · non ti scrive");
    await expect(pane.getByTestId("automations-calendar")).not.toContainText("PROMPT GREZZO");
  });

  test("phone, 390 px: the search is there, nothing wider than the screen", async ({ browser }, testInfo) => {
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
      await expect(pane.getByTestId("automations-search")).toBeVisible();
      await pane.getByTestId("automations-search").fill("muse spark");
      await expect(pane.getByTestId("automation-row")).toHaveCount(1);
      const widths = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        pane: document.querySelector<HTMLElement>('[data-testid="automations-pane"]')!.scrollWidth,
      }));
      expect(widths.doc).toBeLessThanOrEqual(390);
      expect(widths.pane).toBeLessThanOrEqual(390);
      await page.screenshot({ path: testInfo.outputPath("vero-automazioni-parita-telefono.png") });
    } finally {
      await ctx.close();
    }
  });
});
