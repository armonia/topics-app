/**
 * `092-project-org-incognito.sql` — a chi appartiene un progetto.
 *
 * Il file va provato PRIMA di esistere sotto `server/db/migrations/`: il server
 * di produzione gira con `bun --watch`, e salvare lì dentro applica il file al
 * DB VIVO nel giro di secondi, prima di qualunque verifica. Per questo il test
 * legge il FILE e lo esegue su un DB sintetico in memoria.
 *
 * Le tre cose che questa migration può sbagliare in silenzio, e che qui si
 * guardano una per una:
 *   1. `incognito` NOT NULL su una tabella già piena — se il default mancasse,
 *      l'ALTER cadrebbe e con lui l'intera migration;
 *   2. il riempimento con `installation` VUOTA — deve lasciare `org_id` NULL,
 *      cioè il comportamento di prima, non una FK verso un'org inesistente;
 *   3. il riempimento con un'org — deve toccare TUTTE le righe esistenti e
 *      nessun'altra colonna.
  * @covers SCHEMA-07
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const read = (name: string) =>
  fs.readFileSync(path.join(PROJECT_ROOT, "server/db/migrations", name), "utf-8");

const MIGRATION_SQL = read("092-project-org-incognito.sql");

/**
 * Lo schema com'è alla 088: `projects` dalla 016, `people`/`orgs`/
 * `installation`/`installation_owners` dalla 084. Ricavato dai FILE veri e non
 * riscritto a mano — uno schema riscritto qui diverge dal vero senza che
 * nessuno se ne accorga, e il test proverebbe tabelle che non esistono.
 */
function dbBefore(): Database {
  const db = new Database(":memory:");
  for (const file of ["016-projects.sql", "084-people-orgs.sql"]) {
    for (const stmt of read(file).split(/;\s*\n/)) {
      if (!/create\s+table/i.test(stmt)) continue;
      try { db.run(stmt); } catch { /* FK verso tabelle non ancora create: irrilevanti qui */ }
    }
  }
  for (const t of ["projects", "orgs", "people", "installation", "installation_owners"]) {
    if (!db.query("SELECT name FROM sqlite_master WHERE name = ?").get(t)) {
      throw new Error(`${t} non è stata creata: lo schema è cambiato, aggiorna questo test`);
    }
  }
  return db;
}

function seedProjects(db: Database, n: number) {
  for (let i = 1; i <= n; i++) {
    db.run(
      "INSERT INTO projects (id, name, slug, path, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'x', 'x')",
      [`p${i}`, `Progetto ${i}`, `progetto-${i}`, `/tmp/p${i}`],
    );
  }
}

function seedOrg(db: Database) {
  db.run("INSERT INTO orgs (id, name, created_at, updated_at) VALUES ('o1', 'Armonia', 0, 0)");
  db.run(
    "INSERT INTO people (id, display_name, created_at, updated_at) VALUES ('pers1', 'Attilio', 0, 0)",
  );
  db.run("INSERT INTO installation (singleton, org_id, created_at) VALUES (1, 'o1', 0)");
  db.run("INSERT INTO installation_owners (person_id, added_at, is_default) VALUES ('pers1', 0, 1)");
}

describe("migration 092 — progetti d'organizzazione e incognito", () => {
  test("prima della migration le tre colonne non esistono", () => {
    const db = dbBefore();
    expect(() => db.query("SELECT org_id FROM projects").get()).toThrow();
    expect(() => db.query("SELECT incognito FROM projects").get()).toThrow();
    expect(() => db.query("SELECT owner_person_id FROM projects").get()).toThrow();
    db.close();
  });

  test("con un'org, TUTTE le righe esistenti la prendono e nessuna nasce incognito", () => {
    const db = dbBefore();
    seedProjects(db, 3);
    seedOrg(db);
    db.run(MIGRATION_SQL);

    const rows = db
      .query("SELECT id, name, path, org_id, owner_person_id, incognito FROM projects ORDER BY id")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.org_id === "o1")).toBe(true);
    expect(rows.every((r) => r.owner_person_id === "pers1")).toBe(true);
    // Il default che conta: la funzione nasce spenta, nessun progetto sparisce
    // a nessuno per effetto della sola migration.
    expect(rows.every((r) => r.incognito === 0)).toBe(true);
    // E nient'altro si è mosso.
    expect(rows.map((r) => r.name)).toEqual(["Progetto 1", "Progetto 2", "Progetto 3"]);
    expect(rows.map((r) => r.path)).toEqual(["/tmp/p1", "/tmp/p2", "/tmp/p3"]);
    db.close();
  });

  test("senza installazione, org_id resta NULL — cioè il comportamento di prima", () => {
    const db = dbBefore();
    seedProjects(db, 2);
    db.run(MIGRATION_SQL);

    const rows = db.query("SELECT org_id, owner_person_id, incognito FROM projects").all() as Array<
      Record<string, unknown>
    >;
    expect(rows.every((r) => r.org_id === null)).toBe(true);
    expect(rows.every((r) => r.owner_person_id === null)).toBe(true);
    expect(rows.every((r) => r.incognito === 0)).toBe(true);
    db.close();
  });

  test("una tabella VUOTA passa la migration (il riempimento non è obbligatorio)", () => {
    const db = dbBefore();
    seedOrg(db);
    expect(() => db.run(MIGRATION_SQL)).not.toThrow();
    db.close();
  });

  test("incognito accetta solo 0 e 1", () => {
    const db = dbBefore();
    seedProjects(db, 1);
    seedOrg(db);
    db.run(MIGRATION_SQL);
    db.run("UPDATE projects SET incognito = 1 WHERE id = 'p1'");
    expect(
      (db.query("SELECT incognito FROM projects WHERE id = 'p1'").get() as { incognito: number })
        .incognito,
    ).toBe(1);
    expect(() => db.run("UPDATE projects SET incognito = 2 WHERE id = 'p1'")).toThrow();
    expect(() => db.run("UPDATE projects SET incognito = NULL WHERE id = 'p1'")).toThrow();
    db.close();
  });

  test("una riga nuova nasce non-incognito senza che nessuno lo dica", () => {
    const db = dbBefore();
    seedOrg(db);
    db.run(MIGRATION_SQL);
    db.run(
      "INSERT INTO projects (id, name, slug, path, archived, created_at, updated_at) VALUES ('nuovo', 'N', 'n', '/tmp/n', 0, 'x', 'x')",
    );
    const r = db.query("SELECT org_id, incognito FROM projects WHERE id = 'nuovo'").get() as {
      org_id: string | null;
      incognito: number;
    };
    expect(r.incognito).toBe(0);
    // L'org NON viene messa dalla migration: la scrive chi crea il progetto.
    expect(r.org_id).toBeNull();
    db.close();
  });
});
