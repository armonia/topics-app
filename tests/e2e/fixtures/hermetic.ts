/**
 * Il confine ermetico fra un file di spec e il successivo.
 *
 * PERCHÉ. La suite gira in serie contro UN server e UN SQLite: senza confini,
 * ogni file eredita ciò che i ~200 test precedenti hanno lasciato — topic
 * archiviate che i locator per nome ripescano, layout di progetto, tombstoni,
 * pane fantasma, contesti browser vivi. È quello che rende i rossi *mobili*:
 * `grid-split` si rompe solo in fondo alla run, non dopo il suo vero
 * predecessore, e le stesse spec da sole sono verdi. Un test che passa solo se
 * eseguito da solo non sta dimostrando niente su nessuno dei due lati.
 *
 * COSA FA. `hermetic()` registra un `beforeAll` che riporta il server allo stato
 * esatto in cui il `globalSetup` l'aveva lasciato: DB fotografato riga per riga
 * (`POST /api/test/reset`), contesti browser chiusi, sessioni di terminale
 * uccise. Non "azzera": RIPRISTINA una baseline seminata — la topic "Web Search
 * Test" coi suoi messaggi, "Best Ramen", le ui_state resettate. La differenza
 * non è accademica: un reset che svuota e basta fa *auto-skippare* le spec che
 * si aspettano un workspace popolato (misurato: 26 passati diventarono 23
 * passati + 5 skippati, e sembrava un miglioramento).
 *
 * GRANULARITÀ: per FILE, non per test. Dentro un file la contaminazione è
 * voluta — è il `beforeAll` che semina e i test che ci lavorano sopra, in ordine
 * dichiarato. È FRA i file che nessuno ha mai dichiarato niente.
 *
 * DOVE VA. Una riga sola, subito dopo gli import, in ogni spec:
 *
 *     import { hermetic } from "./fixtures/hermetic";
 *     hermetic(test);
 *
 * Deve essere una chiamata esplicita e non un import con effetti collaterali: il
 * modulo viene valutato UNA volta per worker (cache ESM), quindi un hook
 * registrato a livello di modulo finirebbe solo sul primo file che lo importa —
 * e gli altri 77 resterebbero scoperti in silenzio. Il `test` va passato perché
 * metà delle spec non usa quello di `@playwright/test` ma uno esteso
 * (`fixtures/chat.fixture`, `fixtures/browser.fixture`): registrare l'hook
 * sull'oggetto sbagliato è un errore che Playwright rifiuta a runtime.
 * `tests/e2e/hermetic-coverage.spec.ts` verifica che nessuno se la dimentichi.
 */

import { request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { E2E_BASE } from "../helpers/test-server";
import { closeAllBrowserContexts, waitForPaneStoreQuiet } from "../helpers/api-fixtures";

/**
 * Uccide le sessioni di terminale rimaste vive.
 *
 * Il reset del DB cancella la RIGA in `terminal_sessions`, ma la PTY vive nel
 * bridge, fuori da SQLite: senza questo passaggio resterebbe un processo vivo
 * senza riga: il reconcile la vedrebbe come orfana e i file successivi
 * troverebbero tab di terminale che nessuno ha aperto. Chi la chiude davvero è
 * l'endpoint vero, lo stesso che usa la UI — non una copia di test della logica.
 */
async function killLiveTerminalSessions(request: APIRequestContext): Promise<void> {
  const res = await request.get(`${E2E_BASE}/api/terminal/sessions`).catch(() => null);
  if (!res?.ok()) return;
  const body = (await res.json().catch(() => null)) as { sessions?: Array<{ id?: string }> } | null;
  const ids = (body?.sessions ?? []).map((s) => s.id).filter((id): id is string => !!id);
  await Promise.all(
    ids.map((id) => request.delete(`${E2E_BASE}/api/terminal/sessions/${encodeURIComponent(id)}`).catch(() => {})),
  );
}

/**
 * Riporta il server alla baseline del `globalSetup`. Esportata a parte perché
 * una spec può volerla anche a metà file (dopo un test che sporca in modo
 * irreparabile), non solo all'inizio.
 */
export async function resetToBaseline(): Promise<void> {
  const request = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
  try {
    // Prima lo stato in RAM del processo: il reset del DB non lo vede, e un
    // contesto browser vivo si ripresenta a ogni client che si connette dopo.
    await closeAllBrowserContexts(request);
    await killLiveTerminalSessions(request);
    // Poi si aspetta che nessuno stia più scrivendo il pane-store. Le flush di
    // teardown sono CAS-gated (`?base=`) e il reset alza i `server_seq` sopra
    // qualunque cosa sia in volo, quindi questa è cintura in più — ma una PUT
    // debounced di una pagina che sta ancora morendo non è gated, e arriverebbe
    // *dopo* il ripristino.
    await waitForPaneStoreQuiet(request);

    const res = await request.post(`${E2E_BASE}/api/test/reset`);
    if (!res.ok()) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `[hermetic] reset del server fallito: ${res.status()} ${res.statusText()} ${detail}\n` +
          `Un reset che fallisce in silenzio è esattamente ciò che nessuno vede fallire: ` +
          `il file riparte dallo stato lasciato dal precedente e il rosso spunta altrove.`,
      );
    }
  } finally {
    await request.dispose();
  }
}

/**
 * L'oggetto `test` del file chiamante — quello base o uno esteso con
 * `test.extend`. Chiediamo solo `beforeAll`: è tutto ciò che serve, e così
 * qualunque fixture custom va bene senza cast.
 */
type HookRegistrar = { beforeAll: (fn: () => Promise<void>) => void };

/** Registra il confine ermetico per QUESTO file di spec. Va chiamata a top-level. */
export function hermetic(test: HookRegistrar): void {
  test.beforeAll(async () => {
    await resetToBaseline();
  });
}
