/**
 * UN DATABASE NUOVO DEVE NASCERE.
 *
 * Il difetto, capitato oggi: `20260816230500-grants-project.sql` ricopiava una
 * colonna `granted_by` che non esiste — si chiama `granted_by_person_id`. Su
 * una macchina che ha già il database non succede niente di visibile, perché
 * quella migration gira su una tabella che c'è. Su un'INSTALLAZIONE NUOVA la
 * catena si ferma e il server muore prima di ascoltare:
 *
 *     SQLiteError: no such column: granted_by
 *       at runMigrations (server/db.ts)
 *
 * Nessun test lo prendeva, ed è la parte che conta: l'intera suite parte da
 * stub DDL scritti a mano o da un database già migrato. Nessuno faceva la cosa
 * che fa un utente nuovo — applicare la catena dal nulla, in ordine.
 *
 * È un difetto che colpisce SOLO chi installa, cioè esattamente le persone che
 * non possono dirti che è rotto: non hanno ancora l'app per farlo.
 *
 * Questo caso è la prova che mancava, e vale finché resta l'unica cosa che
 * esercita la catena vera invece della sua copia.
  * @covers SCHEMA-04
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { EMBEDDED_MIGRATIONS } from "../../server/db/migrations-embedded";

describe("un'installazione nuova si avvia", () => {
  it("la catena delle migration gira dal nulla, in ordine", () => {
    // Le migration sono INCORPORATE nel binario (`with { type: "text" }`), non
    // lette dal disco: qui gira esattamente ciò che l'app spedita eseguirà, non
    // una copia dei file che potrebbe divergere.
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");

    const applicate: string[] = [];
    for (const m of EMBEDDED_MIGRATIONS) {
      try {
        db.run(m.sql);
        applicate.push(m.name);
      } catch (e) {
        // Il messaggio nomina la migration: senza, l'errore di SQLite dice
        // «no such column» e lascia a chi legge il compito di indovinare quale
        // dei cento file l'abbia prodotto.
        throw new Error(
          `la migration ${m.name} non si applica su un database nuovo:\n  ${(e as Error).message}\n`
          + `  (${applicate.length} applicate prima di lei)`,
        );
      }
    }

    expect(applicate.length, "nessuna migration incorporata: il test guarda un elenco vuoto")
      .toBeGreaterThan(50);
  });

  it("l'ordine è quello dichiarato, e le versioni non si ripetono", () => {
    // Una catena che si applica ma fuori ordine è un database che nasce diverso
    // da quello di chi ha aggiornato: due schemi con lo stesso numero di
    // versione. `check:migrations` guarda i FILE; questo guarda l'elenco
    // incorporato, che è ciò che gira davvero.
    const versioni = EMBEDDED_MIGRATIONS.map((m) => m.version);
    const ordinate = [...versioni].sort((a, b) => a - b);
    expect(versioni, "l'elenco incorporato non è in ordine di versione").toEqual(ordinate);
    expect(new Set(versioni).size, "due migration con la stessa versione").toBe(versioni.length);
  });

  it("il database nato dal nulla ha le tabelle che il prodotto usa", () => {
    // Applicare senza errori non basta: una migration può «riuscire» e lasciare
    // uno schema monco (un CREATE dentro un ramo mai preso, un DROP senza il
    // suo CREATE). Si chiedono le tabelle su cui il server scrive al primo
    // avvio: se una manca, l'app parte e cade al primo gesto.
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    for (const m of EMBEDDED_MIGRATIONS) db.run(m.sql);

    const presenti = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((r) => r.name),
    );
    for (const t of ["tasks", "topics", "projects", "grants", "devices", "people", "terminal_sessions"]) {
      expect(presenti.has(t), `manca la tabella ${t} in un database appena nato`).toBe(true);
    }
  });
});
