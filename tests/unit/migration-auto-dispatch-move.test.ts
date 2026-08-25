/**
 * IL TRAVASO DELL'INTERRUTTORE GLOBALE, e perche' ha un test suo.
 *
 * La migration `20260816112635-board-settings-drop-dead-auto-dispatch` fa due
 * cose in un colpo: sposta l'auto-dispatch da `board_settings` (riga riservata
 * `'*'`) ad `app_settings`, e cancella la colonna che sulle righe per-progetto
 * era un default letto due volte come una scelta.
 *
 * IL RISCHIO E' TUTTO NEL MEZZO. Se il valore vivo non arriva dall'altra parte,
 * ogni installazione con l'auto-dispatch ACCESO si risveglia spenta: la coda si
 * ferma, e non se ne accorge nessuno finche' qualcuno non guarda perche' i task
 * non partono piu'. E' un difetto che non fa rumore, quindi va provato prima e
 * non dopo.
 *
 * Si esegue lo SQL vero, letto dal file, contro un DB in memoria con lo schema
 * di partenza: riscrivere qui le istruzioni vorrebbe dire provare una copia e
 * lasciare l'originale senza cancello.
  * @covers SCHEMA-06
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SQL = readFileSync(
  resolve(import.meta.dir, "../../server/db/migrations/20260816112635-board-settings-drop-dead-auto-dispatch.sql"),
  "utf8",
);

/** Lo schema com'era PRIMA: la colonna su ogni riga, il valore vero sulla '*'. */
function dbPrima(globale: 0 | 1, conAppSettings = true): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY,
    max_agents INTEGER DEFAULT 5,
    auto_dispatch INTEGER NOT NULL DEFAULT 0,
    dispatch_effort TEXT NOT NULL DEFAULT 'medium'
  )`);
  if (conAppSettings) {
    db.run(`CREATE TABLE app_settings (id INTEGER PRIMARY KEY CHECK (id = 1), ai_provider TEXT)`);
    db.run(`INSERT INTO app_settings (id, ai_provider) VALUES (1, 'claude-code')`);
  }
  // La riga riservata porta il valore vero…
  db.run(`INSERT INTO board_settings (project_id, auto_dispatch, max_agents) VALUES ('*', ?, 2)`, [globale]);
  // …e le board vere portano lo zero che non vuol dire niente.
  db.run(`INSERT INTO board_settings (project_id, auto_dispatch) VALUES ('topics-app-ar3jt5', 0)`);
  db.run(`INSERT INTO board_settings (project_id, auto_dispatch) VALUES ('quadra-lh40qh', 0)`);
  return db;
}

describe("migration: l'auto-dispatch trasloca in app_settings", () => {
  it("ACCESO resta acceso: e' il caso che non si puo' sbagliare", () => {
    // Se questo si rompesse, ogni macchina con la coda accesa si sveglierebbe
    // ferma, in silenzio.
    const db = dbPrima(1);
    db.run(SQL);
    const r = db.query("SELECT auto_dispatch FROM app_settings").get() as { auto_dispatch: number };
    expect(r.auto_dispatch).toBe(1);
  });

  it("SPENTO resta spento", () => {
    const db = dbPrima(0);
    db.run(SQL);
    const r = db.query("SELECT auto_dispatch FROM app_settings").get() as { auto_dispatch: number };
    expect(r.auto_dispatch).toBe(0);
  });

  it("la colonna che mentiva non esiste piu'", () => {
    const db = dbPrima(1);
    db.run(SQL);
    expect(() => db.query("SELECT auto_dispatch FROM board_settings").all()).toThrow();
  });

  it("le righe per progetto sopravvivono: si toglie una colonna, non i dati", () => {
    const db = dbPrima(1);
    db.run(SQL);
    const righe = db.query("SELECT project_id, max_agents FROM board_settings ORDER BY project_id").all() as Array<{
      project_id: string;
    }>;
    expect(righe.map((r) => r.project_id)).toEqual(["*", "quadra-lh40qh", "topics-app-ar3jt5"]);
  });

  it("il tetto globale sulla riga '*' non si tocca", () => {
    // L'auto-dispatch trasloca, il tetto NO: restano due cose diverse, e
    // portarsi via anche quello sarebbe stato un cambio non chiesto.
    const db = dbPrima(1);
    db.run(SQL);
    const r = db.query("SELECT max_agents FROM board_settings WHERE project_id = '*'").get() as { max_agents: number };
    expect(r.max_agents).toBe(2);
  });

  it("senza la riga '*' non si inventa un acceso", () => {
    // Il verso in cui sbagliare: chi non aveva mai toccato l'interruttore lo
    // ritrova spento, non acceso. L'errore opposto manderebbe agenti veri su
    // una macchina dove nessuno lo aveva chiesto.
    const db = dbPrima(1);
    db.run(`DELETE FROM board_settings WHERE project_id = '*'`);
    db.run(SQL);
    const r = db.query("SELECT auto_dispatch FROM app_settings").get() as { auto_dispatch: number };
    expect(r.auto_dispatch).toBe(0);
  });
});
