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
 *   IDLE   — no file of the store touched for the number of days the setting
 *            says (60 unless somebody changed it).
 *
 * A THIRD PERMISSION COMES FIRST: THE SETTING. Removing a store cannot be undone
 * (every login and every site's local data in it go too), so the cleanup is a
 * Topics setting (Attilio, approving #425), read from `/api/app-settings` at
 * every start before anything else. Off: nothing is removed, and neither the
 * keep list nor the Tauri command is called. Never touched: on, 60 days. A
 * setting that did not arrive is not a permission, exactly like a keep list
 * that did not arrive. The meaning of the two fields, and the 7..365 clamp
 * applied here again before Tauri, live in `shared/browser-store-reap.ts`.
 *
 * Gira una volta per sessione e in ritardo: non è un lavoro urgente, e all'avvio
 * la macchina ha di meglio da fare. Solo su Tauri — gli store per identifier
 * sono la WKWebView, il browser condiviso (Playwright) tiene il suo barattolo
 * altrove.
 */
import { isTauri } from './shell';
import { tauriInvoke } from './shell/tauri';
import { apiFetch } from './shell/net';
import { resolveBrowserStoreReap, type BrowserStoreReapChoice } from '../../../shared/browser-store-reap';

/** Il tempo che si lascia all'avvio prima di andare a grattare il disco. */
const START_DELAY_MS = 90_000;

let started = false;

/** The setting as the server holds it, resolved; null when it could not be read. */
async function readReapChoice(): Promise<BrowserStoreReapChoice | null> {
  try {
    const res = await apiFetch('/api/app-settings');
    if (!res.ok) return null;
    const body = (await res.json()) as { settings?: unknown };
    if (!body.settings || typeof body.settings !== 'object') return null;
    return resolveBrowserStoreReap(body.settings);
  } catch {
    return null;
  }
}

/**
 * Fa UN giro di reap. Esportata a parte dallo scheduler così un test (o un
 * comando di manutenzione) può eseguirla senza aspettare un minuto e mezzo.
 * Ritorna quanti store sono stati rimossi, -1 se non c'era niente da fare.
 */
export async function reapBrowserDataStores(): Promise<number> {
  if (!isTauri) return -1;
  const choice = await readReapChoice();
  if (!choice || !choice.enabled) return -1;
  let keepIds: string[];
  try {
    const res = await apiFetch('/api/browsers/data-store-keep-list');
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
      maxAgeDays: choice.afterDays,
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
