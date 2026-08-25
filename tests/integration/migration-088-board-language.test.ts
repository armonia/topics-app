/**
 * `088-board-language.sql` — l'override della lingua per singola board.
 *
 * La gemella della 087, e per le stesse tre ragioni: una migration additiva
 * sbaglia in silenzio, e qui il silenzio costa il doppio perché il watcher
 * (`TOPICS_SERVER_WATCH=1`) applica il file al DB VIVO nel momento in cui lo si
 * salva — prima di qualunque verifica.
 *
 * Ma c'è una quarta cosa che vale solo per questa: `board_settings` nasce nella
 * 001 e ha UNA RIGA PER PROGETTO, non una riga sola. Quindi la prova che conta
 * non è «la colonna esiste», è «le N righe esistenti restano quelle di prima e
 * la colonna nuova è NULL su tutte» — NULL significa `'inherit'`, cioè «segui la
 * preferenza globale», cioè il comportamento byte per byte di prima della
 * migration. Una migration che l'avesse riempita con `'it'` avrebbe inchiodato
 * OGNI board di questa macchina a una lingua che nessuno ha scelto.
 *
 * Il DB è sintetico e in memoria, apposta: i dati veri sono già stati toccati
 * dal watcher.
  * @covers SCHEMA-07
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const read = (name: string) =>
  fs.readFileSync(path.join(PROJECT_ROOT, "server/db/migrations", name), "utf-8");

const MIGRATION_SQL = read("088-board-language.sql");

/**
 * `board_settings` com'è oggi, estratta dalla 001 e portata avanti dalle
 * migration che le hanno aggiunto colonne. La si ricava dal FILE della 001 e
 * poi le si applicano gli ALTER veri, invece di riscrivere lo schema a mano:
 * uno schema riscritto qui diverge dal vero senza che nessuno se ne accorga, e
 * il test proverebbe una tabella che non esiste da nessuna parte.
 */
function dbBefore(): Database {
  const db = new Database(":memory:");
  const initial = read("001-initial.sql");
  // La 001 crea tutto lo schema iniziale; qui serve solo che `board_settings`
  // esista con la sua forma di allora.
  for (const stmt of initial.split(/;\s*\n/)) {
    if (!/create\s+table/i.test(stmt)) continue;
    try { db.run(stmt); } catch { /* tabelle con FK verso altre non ancora create: irrilevanti qui */ }
  }
  if (!db.query("SELECT name FROM sqlite_master WHERE name = 'board_settings'").get()) {
    throw new Error("board_settings non è stata creata dalla 001: lo schema è cambiato, aggiorna questo test");
  }
  return db;
}

describe("migration 088 — language per board", () => {
  test("prima della migration la colonna non esiste", () => {
    const db = dbBefore();
    expect(() => db.query("SELECT language FROM board_settings").get()).toThrow();
    db.close();
  });

  test("le righe esistenti restano com'erano, e la colonna nuova è NULL su TUTTE", () => {
    const db = dbBefore();
    // Tre board già configurate: è il caso che conta, perché board_settings ha
    // una riga per progetto e una migration sbagliata le tocca tutte insieme.
    for (const [id, agents] of [["p1", 3], ["p2", 5], ["p3", 1]] as const) {
      db.run("INSERT INTO board_settings (project_id, max_agents) VALUES (?, ?)", [id, agents]);
    }
    db.run(MIGRATION_SQL);

    const rows = db
      .query("SELECT project_id, max_agents, language FROM board_settings ORDER BY project_id")
      .all() as { project_id: string; max_agents: number; language: string | null }[];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.max_agents)).toEqual([3, 5, 1]);
    // NULL = 'inherit' = segui la globale = com'era prima.
    expect(rows.every((r) => r.language === null)).toBe(true);
    db.close();
  });

  test("i valori ammessi si scrivono, e si torna a «non scelto» azzerando", () => {
    const db = dbBefore();
    db.run("INSERT INTO board_settings (project_id) VALUES ('p1')");
    db.run(MIGRATION_SQL);
    for (const v of ["it", "en"]) {
      db.run("UPDATE board_settings SET language = ? WHERE project_id = 'p1'", [v]);
      const row = db.query("SELECT language FROM board_settings WHERE project_id = 'p1'").get() as {
        language: string;
      };
      expect(row.language).toBe(v);
    }
    // `'inherit'` non si scrive: si scrive NULL. È la stessa forma di
    // `dispatch_model`, dove «auto» è l'assenza di scelta e non un valore.
    db.run("UPDATE board_settings SET language = NULL WHERE project_id = 'p1'");
    const row = db.query("SELECT language FROM board_settings WHERE project_id = 'p1'").get() as {
      language: string | null;
    };
    expect(row.language).toBeNull();
    db.close();
  });
});
