/**
 * Un silo di dati di sito, come lo si mostra prima di cancellarlo.
 *
 * Sta in `shared/` perché lo dicono in due: il client lo riceve e lo elenca nel
 * dialogo «Dimentica questo sito», e il server condiviso lo produce dal
 * barattolo di Playwright (`server/browser-site-data.ts`). Sul Mac la stessa
 * forma la costruisce il Rust dai record di `WKWebsiteDataStore`. Ricopiarlo su
 * due lati vorrebbe dire due forme che divergono in silenzio, ed è esattamente
 * il guasto che `tests/unit/no-type-mirrors.test.ts` esiste per impedire.
 *
 * `displayName` NON è l'host della barra degli indirizzi: è il nome del silo,
 * che sul nativo è il dominio registrabile (`google.com` anche per
 * `mail.google.com`) e sulla pane condivisa è un host preciso. Il dialogo mostra
 * questo nome, e questo nome è quello che si cancella.
 */
export interface SiteDataRecord {
  displayName: string;
  types: string[];
}
