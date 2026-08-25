/**
 * @covers SWCACHE-01
 */
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
 *   1. server che rimbalza (riavvio) → il retry cavalca fino alla shell NUOVA;
 *   2. rete davvero giù (offline) → cade sulla shell cachata, la PWA regge.
 *
 * PERCHÉ DUE TECNICHE DIVERSE per staccare la rete. Il caso 2 usa
 * `context.setOffline`, che è la cosa vera. Il caso 1 NON può usarlo, ed è stato
 * misurato invece che supposto: con `setOffline(true)` → `reload()` →
 * `setOffline(false)` dopo 150ms, la navigazione ci mette comunque ~620ms e
 * finisce sulla shell stantia. Ritornare online a 0ms dà la shell fresca in 5ms,
 * a 150ms e a 400ms no: l'emulazione di rete di Playwright NON raggiunge il
 * service worker mentre una sua fetch è in volo, quindi tutti e tre i tentativi
 * falliscono comunque e il rimbalzo non è rappresentabile così. Intercettare la
 * richiesta con `context.route` invece funziona — le fetch del SW ci passano — ed
 * è anche più fedele: un server che si riavvia RIFIUTA la connessione
 * (`connectionrefused`), non fa sparire la rete.
 */

// Marcatore di una shell di build PRECEDENTE, seminato a mano nella cache del SW.
// Se compare a schermo, il SW ha servito la copia stantia invece della rete.
const OLD_SHELL_MARKER = "OLD-STALE-SHELL-vPREV";

/**
 * PERCHÉ QUI NON C'È NESSUN NUMERO SCRITTO A MANO.
 *
 * Il nome della cache e il numero di retry vivevano qui come costanti copiate da
 * `client/public/sw.js`, con sopra scritto «deve combaciare». Non hanno
 * combaciato: il bump a `topics-v12` del 12/08 (i tasti nella notifica push) ha
 * lasciato indietro il `topics-v11` di questo file, e da allora il seme finiva
 * in una cache che il SW non guarda più. Il test non diceva «il nome è vecchio»,
 * diceva «la PWA non serve la shell cachata» — cioè accusava il prodotto di un
 * guasto che non aveva.
 *
 * Una copia di una costante non si può tenere allineata a mano, quindi non si
 * copia: entrambi i valori si LEGGONO dal service worker vivo, e se non si
 * leggono il test muore invece di misurare la cosa sbagliata.
 */

/** Il nome della cache lo decide `CACHE_NAME` in sw.js e cambia a ogni bump.
 *  Quello VIVO è l'unico autorevole: dopo l'`activate` il SW cancella ogni
 *  chiave diversa dalla propria, quindi ne sopravvive esattamente una ed è
 *  quella in cui cercherà il fallback. */
async function swCacheName(page: import("@playwright/test").Page): Promise<string> {
  let keys: string[] = [];
  await expect
    .poll(
      async () => {
        keys = await page.evaluate(() => caches.keys());
        return keys.length;
      },
      { timeout: 15_000, message: "il SW non ha ancora aperto la sua cache" },
    )
    .toBe(1);
  return keys[0];
}

/** `NAV_RETRIES` letto dal sorgente SERVITO — lo stesso file che il browser ha
 *  registrato, non una copia sul disco che potrebbe non essere nel bundle. */
async function swNavRetries(page: import("@playwright/test").Page): Promise<number> {
  const src = await page.evaluate(() =>
    fetch("/sw.js", { cache: "no-store" }).then((r) => r.text()),
  );
  const found = /^const NAV_RETRIES = (\d+);/m.exec(src);
  if (!found) throw new Error("sw.js non dichiara più `const NAV_RETRIES = <n>;`: il test non sa quanti tentativi aspettarsi");
  return Number(found[1]);
}

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
  const cacheName = await swCacheName(page);
  await page.evaluate(async ([name, marker]) => {
    const cache = await caches.open(name);
    const html =
      `<!doctype html><html><head><title>STALE</title></head>` +
      `<body><div id="stale">${marker}</div></body></html>`;
    await cache.put(
      new Request(new URL("/", self.location.origin).href),
      new Response(html, { headers: { "content-type": "text/html" } }),
    );
  }, [cacheName, OLD_SHELL_MARKER] as const);
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

  test("riavvio (~mezzo secondo di server giù) → il retry cavalca fino alla shell NUOVA, non alla cache", async ({
    page,
    context,
  }) => {
    await bootWithControllingSW(page);
    await seedStaleShell(page);

    // Il server "si riavvia": rifiuta le connessioni per 150ms, poi torna su —
    // esattamente il rimbalzo di `bun --watch`. Il backoff è di 300ms, quindi il
    // primo tentativo cade e il secondo trova il server già tornato.
    let refused = 0;
    let served = 0;
    let downUntil = 0;
    await context.route(
      (u) => u.pathname === "/",
      async (route) => {
        if (Date.now() < downUntil) {
          refused += 1;
          await route.abort("connectionrefused");
        } else {
          served += 1;
          await route.continue();
        }
      },
    );

    downUntil = Date.now() + 150;
    await page.reload({ waitUntil: "commit" });

    // Il primo tentativo DEVE essere caduto: senza questo il test resterebbe
    // verde anche se il rimbalzo non fosse mai avvenuto, cioè non proverebbe
    // niente. E almeno una richiesta deve poi essere arrivata al server.
    expect(refused).toBeGreaterThanOrEqual(1);
    expect(served).toBeGreaterThanOrEqual(1);

    // Server tornato → l'app VERA fa boot; la shell stantia non compare mai.
    await expect(page.locator('[aria-label="Topics sidebar"]')).toBeVisible();
    await expect(page.locator("#stale")).toHaveCount(0);
  });

  test("server giù a oltranza → esaurisce i retry e cade sulla shell cachata: la PWA regge", async ({
    page,
    context,
  }) => {
    await bootWithControllingSW(page);
    await seedStaleShell(page);
    const navRetries = await swNavRetries(page);

    // Nessun ritorno del server: dopo aver esaurito i retry il SW DEVE servire
    // la shell cachata — il fallback offline è voluto, il fix non lo rompe.
    let refused = 0;
    await context.route(
      (u) => u.pathname === "/",
      async (route) => {
        refused += 1;
        await route.abort("connectionrefused");
      },
    );

    await page.reload({ waitUntil: "commit" }).catch(() => {});

    await expect(page.locator("#stale")).toHaveText(OLD_SHELL_MARKER);
    // Ha ritentato il numero di volte previsto prima di arrendersi: è la
    // differenza fra "cade sulla cache dopo aver insistito" e il vecchio
    // comportamento, che ci cadeva al primo fallimento.
    expect(refused).toBe(navRetries);
  });

  test("offline VERO (rete staccata) → la PWA continua a servire la shell", async ({
    page,
    context,
  }) => {
    // Il caso d'uso originale della PWA, con la cosa vera invece di
    // un'intercettazione: niente rete, la app si apre lo stesso.
    await bootWithControllingSW(page);
    await seedStaleShell(page);

    await context.setOffline(true);
    await page.reload({ waitUntil: "commit" }).catch(() => {});

    await expect(page.locator("#stale")).toHaveText(OLD_SHELL_MARKER);
    await context.setOffline(false);
  });
});
