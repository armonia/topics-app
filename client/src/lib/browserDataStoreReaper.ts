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
 * nessuno ripulisce più. Li ripulisce questo, e solo quando valgono due permessi
 * insieme (il pavimento sull'età è nel Rust, `MIN_REAP_AGE_DAYS`):
 *
 *   ORFANO — il contextId non compare più in nessuna riga di `ui_state`
 *            (`/api/browsers/data-store-keep-list`, che vede anche i progetti
 *            chiusi e i device spenti);
 *   IDLE   — no file of the store touched for the number of days the setting
 *            says (60 unless somebody changed it).
 *
 * A THIRD PERMISSION COMES FIRST: THE SETTING, AND IT HAS TWO LEVELS (Attilio,
 * on #425: cookies and history are what keep the logins, so the whole-store
 * removal cannot be the default). It is read from `/api/app-settings` at every
 * start before anything else, resolved in `shared/browser-store-reap.ts` to a
 * mode, and each mode calls ONE command and never the other:
 *
 *   off   — nothing is called, not even the keep list;
 *   cache — LEVEL 1, the default: `browser_reap_store_caches`, which empties
 *           the cache of the idle orphan stores and keeps their logins;
 *   all   — LEVEL 1 and LEVEL 2 on: `browser_reap_data_stores`, which removes
 *           the whole store. It cannot be undone.
 *
 * The cache level NEVER falls back to the whole-store command. If the command
 * is not there (an older shell, which does not know it) the call throws, and the
 * answer is "nothing removed": a fallback would turn a harmless setting into
 * the destructive one on exactly the installs that cannot do the harmless thing.
 * That is also why level 1 is a command of its own and not a flag on the old
 * one: an older shell ignores a flag it does not know and would remove stores.
 *
 * A setting that did not arrive is not a permission, exactly like a keep list
 * that did not arrive.
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

/** LEVEL 1: empties the cache of the idle orphan stores, keeps the logins. */
const REAP_CACHES_COMMAND = 'browser_reap_store_caches';
/** LEVEL 2: removes the whole idle orphan stores. */
const REAP_STORES_COMMAND = 'browser_reap_data_stores';

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
  if (!choice || choice.mode === 'off') return -1;
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
  // ONE command per mode, chosen here and nowhere else. A throw from the cache
  // command is the end of the round: see the header, no fallback.
  const command = choice.mode === 'all' ? REAP_STORES_COMMAND : REAP_CACHES_COMMAND;
  try {
    return await tauriInvoke<number>(command, {
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
