/**
 * La lista dei contextId che hanno ancora qualcosa che li rivendica — il
 * permesso «non toccarmi» del reaper degli store nativi
 * (`browser_reap_data_stores`, desktop-tauri/src-tauri/src/lib.rs).
 *
 * Da quando chiudere una tab conserva il login (purge SELETTIVO: via la cache,
 * restano cookie e localStorage), gli store su disco non se ne vanno più da
 * soli. Lo spazzino che li rimuove per intero ha due permessi, e questo è il
 * primo: uno store il cui contextId compare ancora da qualche parte non si
 * tocca a NESSUNA età — il sito che apri due volte l'anno è esattamente quello
 * di cui non vuoi rifare il login.
 *
 * Perché il server e non il client: le pane vivono in `ui_state`, una riga per
 * chiave (`pane-store-v2` per il layout, `task-browser-tabs:<taskId>` per le
 * tab consegnate dai task, più le chiavi legacy). Il client in esecuzione
 * conosce bene la sua finestra, ma la lista COMPLETA — altri progetti, altri
 * device, task chiusi ieri — sta qui.
 *
 * Il taglio è volutamente grossolano: si pescano le stringhe dai blob JSON con
 * una regex invece di parsare gli schemi. È la direzione giusta in cui
 * sbagliare. Tenere uno store di troppo costa qualche megabyte che il purge
 * della cache ha già svuotato al 70%; dimenticarne uno che serviva costa un
 * login. Uno schema nuovo che il parser non conoscesse ancora sparirebbe dalla
 * lista in silenzio — e in silenzio si porterebbe via la sessione.
 */

/** Le pane browser sono `browser:<contextId>` nel pane store. */
const PANE_ID = /"browser:((?:[^"\\]|\\.)+)"/g;

/** Le tab dei task (e i loro gemelli `<ctx>_ws`) portano il ctx come campo. */
const CONTEXT_FIELD = /"contextId"\s*:\s*"((?:[^"\\]|\\.)+)"/g;

/**
 * Ogni contextId nominato dentro questi blob, deduplicato e ordinato.
 *
 * `blobs` sono i valori grezzi delle righe di `ui_state`: non devono nemmeno
 * essere JSON valido (una riga corrotta continua a proteggere il suo store,
 * invece di sparire dalla lista con un `JSON.parse` fallito).
 */
export function collectBrowserContextIds(blobs: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const blob of blobs) {
    if (!blob) continue;
    for (const re of [PANE_ID, CONTEXT_FIELD]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(blob)) !== null) {
        const raw = m[1];
        if (!raw) continue;
        // I blob sono JSON: `\/` e `\"` vanno riportati al valore vero, o il
        // ctx di un progetto (che è un path) non combacerebbe con l'hash dello
        // store.
        let value: string;
        try {
          value = JSON.parse(`"${raw}"`) as string;
        } catch {
          value = raw;
        }
        if (value) found.add(value);
      }
    }
  }
  return [...found].sort();
}
