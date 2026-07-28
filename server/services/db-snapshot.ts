/**
 * Fotografia e ripristino dell'INTERO stato SQLite, in-place.
 *
 * Esiste per un problema solo: la suite E2E non è ermetica. Un unico server di
 * test serve ~50 file di spec in serie sullo stesso DB, quindi ogni file eredita
 * quello che i precedenti hanno lasciato — topic accumulate, layout di progetto,
 * tombstoni, pane fantasma. I sintomi misurati lo dicono chiaro: gli stessi test
 * sono verdi da soli e rossi in fondo alla run, i rossi si SPOSTANO quando
 * cambia lo stato, e `grid-split` si rompe solo dopo ~196 test — non dopo il suo
 * vero predecessore. Non è un'asserzione sbagliata: è contaminazione cumulativa.
 *
 * La cura strutturale sarebbe "un DB per test" (è il `TODO(e2e-isolation)` in
 * `playwright.config.ts`). Un DB per test però vuol dire un processo server per
 * test: il server tiene una sola connessione aperta per tutta la sua vita.
 * Questo modulo ottiene lo stesso risultato senza riaccendere nulla — svuota
 * ogni tabella e ci riscrive dentro la fotografia, dentro UNA transazione.
 *
 * Perché tutte le tabelle e non solo `ui_state`: perché la contaminazione non
 * passa solo di lì. Passa dalle topic archiviate che i locator per nome
 * ripescano, dai messaggi seminati, dai progetti, dai task della board, dalle
 * sessioni di terminale. Fotografare tutto è anche l'unica versione che non
 * invecchia: una migration che aggiunge una tabella è coperta senza toccare
 * questo file.
 *
 * NON copre lo stato in RAM del processo (contesti browser vivi, PTY, broker):
 * quello lo chiude il chiamante — vedi `server/routes/e2e.ts`.
 */

import type { Database } from "bun:sqlite";

/** Una riga qualsiasi: chiavi = colonne del `SELECT *`. */
type Row = Record<string, unknown>;

export interface TableSnapshot {
  name: string;
  /** Ordine delle colonne, preso dal `SELECT *`. Vuoto se la tabella era vuota. */
  columns: string[];
  rows: Row[];
}

export interface DbSnapshot {
  takenAt: string;
  tables: TableSnapshot[];
}

/**
 * Tabelle che una fotografia non deve toccare.
 *
 * `sqlite_sequence` è gestita da SQLite per gli AUTOINCREMENT: riscriverla a
 * mano significa litigare col motore. Il prefisso `sqlite_` copre anche il
 * resto del catalogo interno.
 */
function isInternalTable(name: string): boolean {
  return name.startsWith("sqlite_");
}

/** Le tabelle utente del DB, in ordine alfabetico stabile. */
export function listUserTables(db: Database): string[] {
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).filter((n) => !isInternalTable(n));
}

/** Fotografa ogni tabella utente. Il DB di baseline è minuscolo: costa nulla. */
export function snapshotDb(db: Database, now: () => string = () => new Date().toISOString()): DbSnapshot {
  const tables: TableSnapshot[] = [];
  for (const name of listUserTables(db)) {
    const rows = db.query(`SELECT * FROM "${name}"`).all() as Row[];
    tables.push({ name, columns: rows.length > 0 ? Object.keys(rows[0]!) : [], rows });
  }
  return { takenAt: now(), tables };
}

export interface RestoreResult {
  tables: number;
  rows: number;
  /** Tabelle presenti nella fotografia che il DB non ha più (migration rimossa). */
  missing: string[];
}

export interface RestoreOptions {
  /**
   * Eseguito DENTRO la transazione, prima che si cancelli qualsiasi cosa. È
   * l'unico punto in cui si può ancora LEGGERE lo stato di adesso sapendo che
   * nessun altro scriverà nel frattempo (la transazione è IMMEDIATE, quindi il
   * lock di scrittura è già preso).
   */
  beforeDelete?: (db: Database) => void;
  /**
   * Eseguito DENTRO la stessa transazione, dopo i reinserimenti. Serve a chi
   * deve aggiustare qualcosa in modo atomico col ripristino — nel nostro caso i
   * `server_seq` di `ui_state`, che tornerebbero indietro (vedi routes/e2e.ts).
   */
  afterInsert?: (db: Database) => void;
}

/**
 * Riporta il DB ESATTAMENTE alla fotografia. Svuota anche le tabelle che nella
 * fotografia non c'erano affatto (create da una migration successiva): "come
 * allora" vuol dire senza le righe di adesso, non "quasi".
 *
 * Le foreign key restano attive ma DIFFERITE (`defer_foreign_keys`): dentro la
 * transazione l'ordine di svuotamento/reinserimento viola per forza qualche
 * vincolo, mentre a COMMIT il grafo dev'essere di nuovo coerente — che è la
 * proprietà che vogliamo davvero verificata. Spegnere `foreign_keys` del tutto
 * non si può a transazione aperta ed è una PRAGMA globale: su un processo che
 * serve anche altre richieste sarebbe un colpo di fucile.
 */
export function restoreDb(db: Database, snap: DbSnapshot, opts: RestoreOptions = {}): RestoreResult {
  const present = new Set(listUserTables(db));
  const missing = snap.tables.map((t) => t.name).filter((n) => !present.has(n));
  let rows = 0;

  // Va dichiarata PRIMA del BEGIN: SQLite la azzera a ogni COMMIT/ROLLBACK.
  db.run("PRAGMA defer_foreign_keys = ON");
  try {
    db.transaction(() => {
      opts.beforeDelete?.(db);

      // Prima si svuota TUTTO, poi si riscrive: un `DELETE` tabella-per-tabella
      // intercalato agli `INSERT` reintrodurrebbe dipendenze appena cancellate.
      for (const name of present) db.run(`DELETE FROM "${name}"`);

      for (const table of snap.tables) {
        if (!present.has(table.name) || table.rows.length === 0) continue;
        const cols = table.columns.length > 0 ? table.columns : Object.keys(table.rows[0]!);
        const stmt = db.prepare(
          `INSERT INTO "${table.name}" (${cols.map((c) => `"${c}"`).join(", ")}) ` +
            `VALUES (${cols.map(() => "?").join(", ")})`,
        );
        for (const row of table.rows) {
          stmt.run(...(cols.map((c) => row[c] ?? null) as never[]));
          rows += 1;
        }
      }

      opts.afterInsert?.(db);
    }).immediate();
  } finally {
    db.run("PRAGMA defer_foreign_keys = OFF");
  }

  return { tables: snap.tables.length - missing.length, rows, missing };
}
