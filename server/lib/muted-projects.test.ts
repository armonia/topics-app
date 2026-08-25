/**
 * Il verso di LETTURA del mute per-progetto, su sqlite vero.
 *
 * Il gate della push (`isTopicSilenced`) è puro e testato in
 * `server/push-triggers.test.ts`; qui si fissa l'altra metà — che il dato
 * arrivi davvero dalla riga che il client scrive. È la metà dove il bug si
 * nasconde meglio: una chiave sbagliata o una busta non scartata non rompono
 * niente, tornano solo lista vuota, cioè il comportamento di PRIMA (push che
 * parte) senza un rosso da nessuna parte.
 *
 * @covers MUTE-03
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readMutedProjects } from "./muted-projects";

let db: Database;

/** Lo scheletro della tabella `ui_state` — solo le colonne che serve leggere. */
beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE ui_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    payload_version INTEGER DEFAULT 2,
    server_seq INTEGER DEFAULT 0
  )`);
});

function writeSettings(value: unknown): void {
  db.run("INSERT OR REPLACE INTO ui_state (key, value) VALUES ('settings', ?)", [JSON.stringify(value)]);
}

describe("readMutedProjects", () => {
  // Il caso che conta: la forma ESATTA che `saveSettings` pubblica su
  // `PUT /api/ui-state/settings` (le AppSettings intere, mutedProjects incluso).
  test("legge la lista dalla riga che il client scrive davvero", () => {
    writeSettings({
      fontSize: 13,
      notificationsEnabled: true,
      mutedProjects: ["/Users/x/Projects/alfa", "/Users/x/Projects/beta"],
      language: "auto",
    });
    expect(readMutedProjects(db)).toEqual(["/Users/x/Projects/alfa", "/Users/x/Projects/beta"]);
  });

  test("lista vuota → lista vuota", () => {
    writeSettings({ fontSize: 13, mutedProjects: [] });
    expect(readMutedProjects(db)).toEqual([]);
  });

  // Tutto ciò che è storto vale «nessun progetto mutato»: si sbaglia verso la
  // push, mai verso il silenzio.
  test("riga assente → nessun progetto mutato", () => {
    expect(readMutedProjects(db)).toEqual([]);
  });

  test("settings senza il campo → nessun progetto mutato", () => {
    writeSettings({ fontSize: 13, language: "auto" });
    expect(readMutedProjects(db)).toEqual([]);
  });

  test("JSON illeggibile → nessun progetto mutato, nessuna eccezione", () => {
    db.run("INSERT INTO ui_state (key, value) VALUES ('settings', '{non json')");
    expect(readMutedProjects(db)).toEqual([]);
  });

  test("campo di forma sbagliata (non un array) → nessun progetto mutato", () => {
    writeSettings({ mutedProjects: "/Users/x/Projects/alfa" });
    expect(readMutedProjects(db)).toEqual([]);
    writeSettings({ mutedProjects: { "/Users/x/Projects/alfa": true } });
    expect(readMutedProjects(db)).toEqual([]);
  });

  test("scarta gli elementi non-stringa e le stringhe vuote, tiene il resto", () => {
    writeSettings({ mutedProjects: ["/w/alfa", null, 42, "", "/w/beta"] });
    expect(readMutedProjects(db)).toEqual(["/w/alfa", "/w/beta"]);
  });

  // La chiave è `settings` e basta: `sidebar-state`, `panels` e le pane keys
  // vivono nella stessa tabella e non devono finire in questa lettura.
  test("non pesca da altre chiavi di ui_state", () => {
    db.run("INSERT INTO ui_state (key, value) VALUES ('sidebar-state', ?)", [
      JSON.stringify({ mutedProjects: ["/w/sbagliato"] }),
    ]);
    expect(readMutedProjects(db)).toEqual([]);
  });

  // La tabella non esiste (DB pre-migration, o aperto a metà spegnimento): la
  // push è best-effort e non deve mai buttare giù il broadcast che la innesca.
  test("tabella assente → lista vuota invece di un'eccezione", () => {
    const bare = new Database(":memory:");
    expect(() => readMutedProjects(bare)).not.toThrow();
    expect(readMutedProjects(bare)).toEqual([]);
  });
});
