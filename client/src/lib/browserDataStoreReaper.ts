/**
 * Lo spazzino della coda lunga degli store browser.
 *
 * La chiusura di una pane non cancella più la sessione: toglie la cache
 * (`browser_purge_cache`) e lascia cookie e localStorage, perché su un browser
 * che si usa tutto il giorno «chiudi la tab» non può voler dire «rifai il
 * login». Misurato il 2026-08-12 su 45 store veri: NetworkCache 1,65 GB su
 * 2,32 GB totali, cookie 44 KB IN TUTTO. Lo spazio se ne va con la cache;
 * l'identità costa un chilobyte a store.
 *
 * Resta però il residuo: gli store di contesti che non torneranno MAI, che ora
 * nessuno rimuove più. Li rimuove questo, e solo quando valgono due permessi
 * insieme (il pavimento sull'età è nel Rust, `MIN_REAP_AGE_DAYS`):
 *
 *   ORFANO — il contextId non compare più in nessuna riga di `ui_state`
 *            (`/api/browsers/data-store-keep-list`, che vede anche i progetti
 *            chiusi e i device spenti);
 *   FERMO  — nessun file dello store toccato da `REAP_AFTER_DAYS` giorni.
 *
 * Gira una volta per sessione e in ritardo: non è un lavoro urgente, e all'avvio
 * la macchina ha di meglio da fare. Solo su Tauri — gli store per identifier
 * sono la WKWebView, il browser condiviso (Playwright) tiene il suo barattolo
 * altrove.
 */
import { isTauri } from './shell';
import { tauriInvoke } from './shell/tauri';

/** Due mesi. Non è una soglia di spazio, è quanto si concede a un sito prima
 *  di dire che quella tab non tornerà: il 30% di store che questo tocca è la
 *  coda, non la pancia della distribuzione. */
export const REAP_AFTER_DAYS = 60;

/** Il tempo che si lascia all'avvio prima di andare a grattare il disco. */
const START_DELAY_MS = 90_000;

let started = false;

/**
 * Fa UN giro di reap. Esportata a parte dallo scheduler così un test (o un
 * comando di manutenzione) può eseguirla senza aspettare un minuto e mezzo.
 * Ritorna quanti store sono stati rimossi, -1 se non c'era niente da fare.
 */
export async function reapBrowserDataStores(): Promise<number> {
  if (!isTauri) return -1;
  let keepIds: string[];
  try {
    const res = await fetch('/api/browsers/data-store-keep-list');
    if (!res.ok) return -1;
    const body = (await res.json()) as { contextIds?: unknown };
    if (!Array.isArray(body.contextIds)) return -1;
    keepIds = body.contextIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    // Server irraggiungibile = lista NON pervenuta, che è diversa da lista
    // vuota: con una lista vuota il reaper considererebbe orfano tutto.
    return -1;
  }
  try {
    return await tauriInvoke<number>('browser_reap_data_stores', {
      keepIds,
      maxAgeDays: REAP_AFTER_DAYS,
    });
  } catch {
    return -1;
  }
}

/** Arma il giro una volta sola per sessione. Idempotente. */
export function scheduleBrowserDataStoreReap(): void {
  if (started || !isTauri) return;
  started = true;
  setTimeout(() => { void reapBrowserDataStores(); }, START_DELAY_MS);
}
