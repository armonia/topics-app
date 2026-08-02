import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: riparte dalla baseline del globalSetup. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * Service worker — un riavvio del server NON deve servire la shell VECCHIA dalla
 * cache (client/public/sw.js).
 *
 * Il difetto storico: `fetch(...).catch(() => caches.match(...))` trattava
 * "server locale giù per mezzo secondo perché `bun --watch` si riavvia" come
 * "offline" e serviva subito la shell CACHATA — che è di una build precedente —
 * innescando il client stantìo e il loop del banner "nuova versione". Il fix
 * (v11) ritenta la navigazione con un backoff corto prima di arrendersi alla
 * cache: un riavvio-watch risponde entro ~1s, un offline vero no.
 *
 * È comportamento nel TEMPO, quindi la prova è un VIDEO (E2E_EVIDENCE=1). Due
 * facce dello stesso contratto:
 *   1. rete che rimbalza (riavvio) → il retry cavalca fino alla shell NUOVA;
 *   2. rete davvero giù (offline) → cade sulla shell cachata, la PWA regge.
 */

// Marcatore di una shell di build PRECEDENTE, seminato a mano nella cache del SW.
// Se compare a schermo, il SW ha servito la copia stantia invece della rete.
const OLD_SHELL_MARKER = "OLD-STALE-SHELL-vPREV";
// Deve combaciare con CACHE_NAME in client/public/sw.js.
const SW_CACHE_NAME = "topics-v11";

/** Carica l'app e assicura che il SW registrato CONTROLLI la pagina.
 *  boot.js registra il SW al `load` ma NON fa `clients.claim()`, quindi il
 *  primo documento è non-controllato: serve un reload perché il SW attivo
 *  intercetti le navigazioni di questa pagina. */
async function bootWithControllingSW(page: import("@playwright/test").Page) {
  await goToApp(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
}

/** Semina nella cache del SW, sotto la chiave canonica `/`, una shell che finge
 *  di essere di una build PRECEDENTE. È esattamente ciò che il vecchio fallback
 *  serviva durante un riavvio. */
async function seedStaleShell(page: import("@playwright/test").Page) {
  await page.evaluate(async ([cacheName, marker]) => {
    const cache = await caches.open(cacheName);
    const html =
      `<!doctype html><html><head><title>STALE</title></head>` +
      `<body><div id="stale">${marker}</div></body></html>`;
    await cache.put(
      new Request(new URL("/", self.location.origin).href),
      new Response(html, { headers: { "content-type": "text/html" } }),
    );
  }, [SW_CACHE_NAME, OLD_SHELL_MARKER] as const);
}

test.describe("service worker: riavvio-server non serve la shell vecchia", () => {
  test.afterEach(async ({ page, context }) => {
    // Torna online e ripulisci SW + cache così il test dopo riparte pulito.
    await context.setOffline(false).catch(() => {});
    await page
      .evaluate(async () => {
        if ("serviceWorker" in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
        if (window.caches) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
      })
      .catch(() => {});
  });

  test("riavvio (~mezzo secondo di rete giù) → il retry cavalca fino alla shell NUOVA, non alla cache", async ({
    page,
    context,
  }) => {
    await bootWithControllingSW(page);
    await seedStaleShell(page);

    // Simula il riavvio `bun --watch`: rete giù per un attimo, poi torna su con
    // la build fresca. Andare offline PRIMA di far partire la navigazione e
    // tornare online quasi subito è robusto: il retry ha ~600ms di finestra
    // (NAV_RETRIES=3 × 300ms), tornare online a 150ms garantisce che un
    // tentativo successivo colpisca la rete — mai la cache stantia.
    await context.setOffline(true);
    const navigating = page.reload({ waitUntil: "commit" });
    // Attesa deliberata: rappresenta la DURATA del riavvio del server, che è
    // proprio il comportamento sotto test (non una sincronizzazione arbitraria).
    await page.waitForTimeout(150);
    await context.setOffline(false);
    await navigating;

    // Rete tornata → l'app VERA fa boot; la shell stantia non compare mai.
    await expect(page.locator('[aria-label="Topics sidebar"]')).toBeVisible();
    await expect(page.locator("#stale")).toHaveCount(0);
  });

  test("offline vero (rete giù a oltranza) → cade sulla shell cachata: la PWA regge", async ({
    page,
    context,
  }) => {
    await bootWithControllingSW(page);
    await seedStaleShell(page);

    // Nessun ritorno della rete: dopo aver esaurito i retry il SW DEVE servire
    // la shell cachata — il fallback offline è voluto, il fix non lo rompe.
    await context.setOffline(true);
    await page.reload().catch(() => {});

    await expect(page.locator("#stale")).toHaveText(OLD_SHELL_MARKER);
    await context.setOffline(false);
  });
});
