/**
 * `087-output-language.sql` — la colonna in cui vive la lingua delle risposte.
 *
 * Di una migration additiva vale la pena provare tre cose, e sono le tre che si
 * possono sbagliare in silenzio:
 *
 *  1. che il FILE giri davvero contro la tabella com'è oggi (non contro una sua
 *     copia riscritta qui): `app_settings` nasce in 054 e la 087 le si appoggia
 *     sopra — se qualcuno rinominasse la tabella, questo test rosseggia prima
 *     che il server di prod la applichi al DB vivo;
 *
 *  2. che la riga ESISTENTE non cambi: la colonna è NULLABLE e nasce NULL, e
 *     NULL significa «auto», cioè nessuna direttiva al modello. È l'invariante
 *     di tutta la tabella (vedi l'intestazione di 054-app-settings.sql): finché
 *     l'utente non tocca il selettore, il comportamento è byte per byte quello
 *     di prima. Una migration che avesse riempito la colonna con 'it' avrebbe
 *     cambiato la lingua di ogni agente di questa macchina senza che nessuno
 *     l'avesse chiesto;
 *
 *  3. che ci si possa scrivere e rileggere i tre valori ammessi.
 *
 * Il DB è sintetico e in memoria: la migration vera è già stata applicata al DB
 * di prod dal watcher (`TOPICS_SERVER_WATCH=1`) nel momento in cui il file è
 * stato creato — motivo in più perché questa prova esista contro una copia
 * usa-e-getta invece che contro i dati veri.
  * @covers SCHEMA-07
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const read = (name: string) =>
  fs.readFileSync(path.join(PROJECT_ROOT, "server/db/migrations", name), "utf-8");

const CREATE_APP_SETTINGS = read("054-app-settings.sql");
const MIGRATION_SQL = read("087-output-language.sql");

/** Il DB com'era il minuto prima della 087: la tabella creata dalla 054. */
function dbBefore(): Database {
  const db = new Database(":memory:");
  db.run(CREATE_APP_SETTINGS);
  return db;
}

type Row = Record<string, unknown> | null;

describe("migration 087 — output_language", () => {
  test("prima della migration la colonna non esiste", () => {
    const db = dbBefore();
    expect(() => db.query("SELECT output_language FROM app_settings").get()).toThrow();
    db.close();
  });

  test("la migration gira sulla tabella della 054 e aggiunge la colonna", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    const row = db.query("SELECT output_language FROM app_settings WHERE id = 1").get() as Row;
    expect(row).not.toBeNull();
    db.close();
  });

  test("la riga esistente resta com'era: NULL = «auto» = nessuna direttiva", () => {
    const db = dbBefore();
    // Una riga già configurata dall'utente: dopo la migration deve essere
    // identica, colonna nuova a parte.
    db.run("UPDATE app_settings SET claude_model = ?, claude_effort = ? WHERE id = 1", [
      "claude-opus-5[1m]",
      "xhigh",
    ]);
    db.run(MIGRATION_SQL);
    const row = db
      .query("SELECT claude_model, claude_effort, output_language FROM app_settings WHERE id = 1")
      .get() as { claude_model: string; claude_effort: string; output_language: string | null };
    expect(row.claude_model).toBe("claude-opus-5[1m]");
    expect(row.claude_effort).toBe("xhigh");
    expect(row.output_language).toBeNull();
    // E una sola riga: la migration non ne semina.
    expect((db.query("SELECT COUNT(*) AS n FROM app_settings").get() as { n: number }).n).toBe(1);
    db.close();
  });

  test("i tre valori ammessi si scrivono e si rileggono", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    for (const v of ["auto", "it", "en"]) {
      db.run("UPDATE app_settings SET output_language = ? WHERE id = 1", [v]);
      const row = db.query("SELECT output_language FROM app_settings WHERE id = 1").get() as {
        output_language: string;
      };
      expect(row.output_language).toBe(v);
    }
    // E si può tornare a «non scelto» azzerandola.
    db.run("UPDATE app_settings SET output_language = NULL WHERE id = 1");
    expect(
      (db.query("SELECT output_language FROM app_settings WHERE id = 1").get() as Row)!
        .output_language,
    ).toBeNull();
    db.close();
  });
});
