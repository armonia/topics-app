import { expect, test, type Page } from "@playwright/test";
import { createTopic, deleteTopic, seedPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questa spec riparte dalla baseline del globalSetup.
hermetic(test);

/**
 * IL TETTO DI RESIDENZA DELLE PANE.
 *
 * COSA GUARDA. Quante pane restano MONTATE mentre l'utente ne visita tante. Fino
 * al 2026-07-29 la risposta era "tutte quelle mai visitate, per sempre": due
 * `Set<string>` chiamati `visitedKeys` (uno in `GroupLayout`, uno in
 * `StandaloneChatGroup`) a cui ogni pane attivata veniva aggiunta e da cui usciva
 * solo alla chiusura della pane. Per una chat è un albero DOM congelato; per una
 * pane browser è un processo WKWebView da 155-637 MB. Misurato sull'app viva
 * quel giorno: 65 processi WebContent, 13,95 GB di footprint.
 *
 * PERCHÉ CONTARE I GUSCI E NON I PROCESSI. Playwright gira sulla build web, in
 * Chromium: non c'è nessuna WKWebView da contare, e stubbare `usePerfMetrics`
 * (che ritorna `null` senza `window.__TAURI_INTERNALS__`) vorrebbe dire misurare
 * il proprio mock. Il guscio DOM è la proxy ONESTA, perché in Tauri un guscio
 * `PaneKeepAlive` montato È una WKWebView viva: `useTauriBrowser` apre la view
 * al montaggio e la chiude allo smontaggio. Contare i gusci conta le view.
 *
 * NON è un test di memoria travestito: è un test sul contratto "il numero di
 * pane montate ha un tetto", che è la cosa che il codice promette e l'unica
 * verificabile qui.
 *
 * @covers LEAK-01
 */

const BASE = E2E_BASE;

/**
 * Il tetto della classe leggera (chat, terminali, utility), da
 * `client/src/state/pane/residency/policy.ts`. Sono slot AGGIUNTIVI oltre alle
 * pane visibili, quindi il massimo atteso con una sola pane attiva è
 * `LIGHT_BUDGET + 1`.
 *
 * Deliberatamente ricopiato invece di importato: il test deve fallire se
 * qualcuno alza il tetto, non adeguarsi in silenzio. Un tetto che segue la sua
 * stessa implementazione non è un tetto.
 */
const LIGHT_BUDGET = 12;

/**
 * Quante chat seminare. Deve superare `LIGHT_BUDGET + 1` per mordere, e non di
 * più: ogni tab in più è un `ChatPane` montato con la sua `loadHistory`, e la
 * passeggiata è già la cosa più lenta di questa spec. Con venti, sotto sharding
 * a quattro processi, i tre test sforavano i 30 s di default — passavano da soli
 * e cadevano in compagnia, che è il modo peggiore di fallire.
 */
const PANE_COUNT = 16;

/**
 * Attesa perché la decisione si applichi: `MIN_DWELL_MS` (4000) protegge chi è
 * stato lasciato un istante fa, `EVICT_DELAY_MS` (1500) è la grazia fra la
 * decisione e lo smontaggio. Più un margine.
 */
const SETTLE_MS = 4000 + 1500 + 1500;

function shells(page: Page) {
  return page.locator("[data-pane-shell]");
}

async function shellCount(page: Page): Promise<number> {
  return shells(page).count();
}

test.describe("Tetto di residenza delle pane", () => {
  // Il tetto si misura ASPETTANDO: `MIN_DWELL_MS` + `EVICT_DELAY_MS` sono ~5,5 s
  // di orologio vero che non si possono accorciare senza misurare un'altra cosa,
  // e prima ci sono sedici montaggi di chat. Sotto sharding i 30 s di default
  // non bastano, e il timeout arriva PRIMA dell'asserzione: un rosso che non
  // dice niente su ciò che il test doveva dimostrare.
  test.describe.configure({ timeout: 120_000 });

  const topics: { id: string; name: string }[] = [];

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    for (let i = 0; i < PANE_COUNT; i++) {
      topics.push(await createTopic(request, `Residency-${stamp}-${i}`));
    }
  });

  test.afterAll(async ({ request }) => {
    for (const t of topics) await deleteTopic(request, t.id).catch(() => {});
  });

  // Ri-seminato prima di OGNI test (anche ai retry): Playwright non rigira il
  // beforeAll su un retry, e il primo tentativo ha già mosso lo stato.
  test.beforeEach(async ({ request }) => {
    await seedPaneStore(request, () => ({
      panes: Object.fromEntries(
        topics.map((t) => [t.id, { id: t.id, type: "chat", title: t.name, topicId: t.id }]),
      ),
      groups: {
        "group:default": {
          id: "group:default",
          paneIds: topics.map((t) => t.id),
          splitRatio: 1,
          splitAxis: "horizontal",
        },
      },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
    }));
    await request
      .put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: topics.map((t) => t.id) },
        ignoreHTTPSErrors: true,
      })
      .catch(() => {});
  });

  /**
   * Cammina su ogni tab, una volta. È la passeggiata che prima lasciava venti
   * gusci montati — e, in Tauri con pane browser, venti WKWebView.
   */
  async function visitEveryTab(page: Page): Promise<void> {
    for (const t of topics) {
      await page.getByTestId(`pane-tab-${t.id}`).click({ timeout: 10000 });
      // Il guscio della pane appena attivata deve ESSERE VISIBILE prima di
      // passare oltre: senza, la passeggiata corre più veloce del montaggio e
      // il test misurerebbe una cosa che non è successa.
      await expect(page.locator(`[data-pane-shell="${t.id}"][data-pane-visible="1"]`)).toBeAttached({
        timeout: 10000,
      });
    }
  }

  test("RESIDENCY-01: visitare venti chat non lascia venti pane montate", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LEAK-01" });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect(shells(page).first()).toBeAttached({ timeout: 15000 });

    await visitEveryTab(page);

    // Prima del tetto, qui i gusci erano PANE_COUNT. La soglia è il contratto:
    // le visibili (una sola, non siamo in split) più il budget della classe.
    await expect
      .poll(() => shellCount(page), {
        timeout: SETTLE_MS + 20000,
        message: `i gusci montati devono scendere a ${LIGHT_BUDGET + 1}`,
      })
      .toBeLessThanOrEqual(LIGHT_BUDGET + 1);
  });

  test("RESIDENCY-02: la pane visibile non viene mai smontata", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect(shells(page).first()).toBeAttached({ timeout: 15000 });

    await visitEveryTab(page);
    await page.waitForTimeout(SETTLE_MS);

    // Il pavimento: esattamente un guscio visibile, e non è mai zero. Sfrattare
    // ciò che l'utente sta guardando è il solo modo di sbagliare in modo che si
    // veda, e l'invariante `evicted ∩ visible = ∅` esiste per questo.
    await expect(page.locator('[data-pane-shell][data-pane-visible="1"]')).toHaveCount(1);
  });

  test("RESIDENCY-03: la bozza sopravvive allo sfratto", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect(shells(page).first()).toBeAttached({ timeout: 15000 });

    const first = topics[0]!;
    const draft = `bozza-che-deve-sopravvivere-${Date.now()}`;

    // Scrivi nella prima chat…
    const firstTab = page.getByTestId(`pane-tab-${first.id}`);
    await firstTab.click({ timeout: 10000 });
    const composer = page.locator("textarea").first();
    await composer.waitFor({ state: "visible", timeout: 10000 });
    await composer.fill(draft);

    // …poi visita tutte le altre, così la prima esce dal budget e viene
    // smontata davvero.
    await visitEveryTab(page);
    await page.waitForTimeout(SETTLE_MS);

    // Torna: il contenuto deve essere ancora lì. La bozza è persistita
    // (`ChatPane` la scrive in localStorage), quindi lo sfratto non la perde —
    // questo test è la guardia che quella persistenza resti vera quando
    // smontare diventa una cosa NORMALE e non più un caso raro.
    await firstTab.click({ timeout: 10000 });
    await expect(page.locator("textarea").first()).toHaveValue(draft, { timeout: 10000 });
  });
});
