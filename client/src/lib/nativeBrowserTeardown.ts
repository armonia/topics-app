/**
 * Smontaggio di una pane browser NATIVA: i due comandi Tauri e il loro ordine.
 *
 * Vive qui, fuori da usePaneLifecycle, per una ragione sola: l'ordine è una
 * decisione, e una decisione che nessun test tiene ferma torna com'era. Le due
 * righe erano invertite fino al 13/08/2026, e su un Mac sembravano giuste.
 *
 * PERCHÉ SI SVUOTA PRIMA DI CHIUDERE. Su macOS lo store di una pane ha un nome
 * (`WKWebsiteDataStore dataStoreForIdentifier:`), quindi WebKit lo riapre anche
 * a webview già morta e l'ordine non si sente. Su Windows e Linux uno store con
 * un nome non esiste: c'è una cartella, e l'unica strada per il profilo WebView2
 * e per il `WebsiteDataManager` di WebKitGTK passa dalla vista VIVA. Dopo
 * `browser_close` il comando non trova più nessuno a cui chiedere, non svuota
 * niente e non lo dice: il 70% dello spazio dello store non tornava mai.
 *
 * Le due invoke restano fire-and-forget e separate di proposito: partono spesso
 * mentre la pagina si sta chiudendo, e sono due messaggi IPC distinti, che il
 * lato Rust processa in ordine sul thread della UI. Fra l'uno e l'altro il main
 * loop gira, che è quel che serve al motore per portare a termine la pulizia
 * prima che la vista sparisca.
 */

/** La forma di `tauriInvoke` che serve qui: comando, argomenti, promessa. */
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * I comandi dello smontaggio, nell'ordine in cui vanno mandati. È l'unica
 * dichiarazione dell'ordine: il test la legge, e chi la cambia lo fa apposta.
 */
export const NATIVE_BROWSER_TEARDOWN_COMMANDS = ['browser_purge_cache', 'browser_close'] as const;

/**
 * Svuota la cache dello store della pane e poi ne chiude la webview nativa.
 *
 * `browser_purge_cache` recupera lo SPAZIO e non l'identità: cache disco, fetch,
 * memoria e registrazioni dei service worker se ne vanno, cookie, localStorage e
 * IndexedDB restano. Chiudere una tab non disconnette. Lo spazio della coda
 * lunga (store che nessuna pane rivendica più) lo tiene corto il reaper a
 * scadenza, vedi `browserDataStoreReaper`.
 */
export function teardownNativeBrowserPane(contextId: string, invoke: Invoke): void {
  for (const cmd of NATIVE_BROWSER_TEARDOWN_COMMANDS) {
    void invoke(cmd, { id: contextId }).catch(() => {});
  }
}
