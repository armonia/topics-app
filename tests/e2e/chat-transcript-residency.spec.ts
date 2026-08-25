import { expect, test, type Page } from "@playwright/test";
import { createTopic, deleteTopic, seedPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questa spec riparte dalla baseline del globalSetup.
hermetic(test);

/**
 * LO SFRATTO DEI TRASCRITTI.
 *
 * COSA GUARDA. Il tetto di residenza (`pane-residency-cap.spec.ts`) smonta la
 * pane, ma i suoi MESSAGGI vivevano in `messageStore` e da lì non usciva niente:
 * ogni chat aperta anche una volta sola lasciava dentro il trascritto INTERO —
 * `loadHistory` chiede la cronologia senza tetto — per tutta la vita della
 * finestra. Il 2026-07-29 il processo della UI teneva 1844 MB con la curva
 * piatta: memoria presa e mai restituita.
 *
 * LE DUE META' DEL CONTRATTO, e sono i due test qui sotto:
 *
 *  1. SICUREZZA — la chat che l'utente sta guardando non si svuota MAI. Vale
 *     anche forzando lo spazzino al massimo: `evictSessions` rifiuta una
 *     sessione iscritta, quindi la politica e lo store difendono la stessa
 *     invariante da due lati.
 *  2. RECUPERO — un trascritto sfrattato torna INTATTO quando ci rientri. È la
 *     ragione per cui sfrattare è lecito: il server è la fonte di verità e
 *     quella in memoria è una cache. Una cache senza sfratto è solo una perdita
 *     scritta piano; una cache che non si ricarica è un bug.
 *
 * PERCHE' FORZARE LO SPAZZINO. In esercizio gira ogni 30 s e protegge chi è
 * stato lasciato da meno di 60 s. Aspettare quel minuto e mezzo di orologio vero
 * per ogni asserzione renderebbe la spec lentissima senza misurare niente di
 * più: `window.__topicsMessageSweep` è lo stesso identico codice, con le soglie
 * passate da fuori. L'invariante di sicurezza NON è forzabile, ed è appunto ciò
 * che il primo test dimostra.
 *
 * @covers LEAK-01
 */

const BASE = E2E_BASE;

/**
 * Il tetto della classe leggera, da `state/pane/residency/policy.ts`. Ricopiato
 * di proposito: serve solo a scegliere quante tab aprire per far smontare la
 * prima, e la spec del tetto è l'altra.
 */
const LIGHT_BUDGET = 12;
const PANE_COUNT = 16;

/** `MIN_DWELL_MS` (4000) + `EVICT_DELAY_MS` (1500) + margine. */
const SETTLE_MS = 4000 + 1500 + 1500;

/** Le soglie più aggressive possibili: nessuno slot, nessuna grazia. */
const FORCE = { budget: 0, minIdleMs: 0, maxIdleMessages: 0 } as const;

type SweepOpts = { budget?: number; minIdleMs?: number; maxIdleMessages?: number };

async function sweep(page: Page, opts: SweepOpts): Promise<string[]> {
  return page.evaluate((o) => {
    const fn = (window as unknown as { __topicsMessageSweep?: (x: SweepOpts) => string[] })
      .__topicsMessageSweep;
    if (!fn) throw new Error("__topicsMessageSweep assente: lo spazzino non è montato");
    return fn(o);
  }, opts as SweepOpts);
}

test.describe("Sfratto dei trascritti", () => {
  // Sedici montaggi di chat più ~5,5 s di orologio vero per lo smontaggio: sotto
  // sharding i 30 s di default non bastano, e il timeout arriverebbe PRIMA
  // dell'asserzione.
  test.describe.configure({ timeout: 120_000 });

  const topics: { id: string; name: string }[] = [];
  let marker = "";

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    marker = `TRASCRITTO-${stamp}`;
    for (let i = 0; i < PANE_COUNT; i++) {
      topics.push(await createTopic(request, `Trascritto-${stamp}-${i}`));
    }
    // Solo la PRIMA ha un trascritto vero: è quella su cui si misura sia la
    // sicurezza (mentre la guardi) sia il recupero (dopo che è stata sfrattata).
    const sk = `topic:${topics[0]!.id.slice(0, 8)}`;
    await seedMessage(request, { sessionKey: sk, role: "user", content: marker });
    await seedMessage(request, {
      sessionKey: sk,
      role: "assistant",
      content: `risposta a ${marker}`,
    });
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

  async function boot(page: Page): Promise<void> {
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await expect(page.locator("[data-pane-shell]").first()).toBeAttached({ timeout: 15000 });
  }

  function firstTab(page: Page) {
    return page.getByTestId(`pane-tab-${topics[0]!.id}`);
  }

  function markerRow(page: Page) {
    return page.locator(".message-content").filter({ hasText: marker }).first();
  }

  test("TRANSCRIPT-RESIDENCY-01: la chat che stai guardando non si svuota", async ({ page }) => {
    await boot(page);
    await firstTab(page).click({ timeout: 10000 });
    await expect(markerRow(page)).toBeVisible({ timeout: 15000 });

    const sk = `topic:${topics[0]!.id.slice(0, 8)}`;
    const evicted = await sweep(page, FORCE);

    // Zero slot e zero grazia: se il pavimento «guardata» non tenesse, questa
    // sessione uscirebbe per prima. È l'unico modo di sbagliare che si vede.
    expect(evicted, "una sessione iscritta non deve poter essere sfrattata").not.toContain(sk);
    await expect(markerRow(page)).toBeVisible();
  });

  test("TRANSCRIPT-RESIDENCY-02: un trascritto sfrattato rientra intatto", async ({ page }) => {
    await boot(page);

    // Apri la prima chat: da qui il suo trascritto è in memoria.
    await firstTab(page).click({ timeout: 10000 });
    await expect(markerRow(page)).toBeVisible({ timeout: 15000 });

    // Cammina su tutte le altre, così la prima esce dal budget delle pane e
    // viene smontata DAVVERO — cioè nessuno la guarda più.
    for (const t of topics) {
      await page.getByTestId(`pane-tab-${t.id}`).click({ timeout: 10000 });
      await expect(
        page.locator(`[data-pane-shell="${t.id}"][data-pane-visible="1"]`),
      ).toBeAttached({ timeout: 10000 });
    }
    await expect
      .poll(() => page.locator("[data-pane-shell]").count(), {
        timeout: SETTLE_MS + 20000,
        message: `le pane montate devono scendere a ${LIGHT_BUDGET + 1}`,
      })
      .toBeLessThanOrEqual(LIGHT_BUDGET + 1);

    const sk = `topic:${topics[0]!.id.slice(0, 8)}`;
    const evicted = await sweep(page, FORCE);
    expect(evicted, "la chat smontata deve restituire il suo trascritto").toContain(sk);

    // E adesso il punto: tornarci. Il trascritto non è più in memoria, quindi
    // se `loadHistory` non ripartisse — o ripartisse su una cache che si crede
    // ancora idratata — qui si vedrebbe una chat vuota.
    await firstTab(page).click({ timeout: 10000 });
    await expect(markerRow(page)).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator(".message-content").filter({ hasText: `risposta a ${marker}` }).first(),
    ).toBeVisible({ timeout: 15000 });
  });
});
