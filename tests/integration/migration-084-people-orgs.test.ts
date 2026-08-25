/**
 * La 084 su un DB sintetico, prima che tocchi qualcosa di vero.
 *
 * Perché serve un test e non basta averla provata su una copia: la copia dice
 * che *quel* database sopravvive, non che la migration sia giusta. I casi che
 * contano sono quelli che sulla mia macchina non ci sono — un dispositivo senza
 * ruolo, un ospite già revocato, un `grants` con righe da preservare — e sono
 * esattamente quelli che non si scoprono guardando i propri dati.
 *
 * La regola di questo repo è che creare `server/db/migrations/NNN-*.sql`
 * APPLICA il file al database VIVO in pochi secondi. Quindi l'ordine è: backup,
 * prova su copia, questo test, e solo alla fine il file.
  * @covers SCHEMA-07
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RADICE = join(import.meta.dir, "..", "..");
const M084 = join(RADICE, "server", "db", "migrations", "084-people-orgs.sql");

/**
 * Lo stato del mondo PRIMA della 084: 080 + 082 + 083.
 *
 * Sottoinsieme deliberato, come in migration-078: si misura una migration, e lo
 * schema di `tasks` deve essere quello del giorno in cui la 084 gira. `TASKS_DDL`
 * (server/db/test-schema.ts) è la catena di oggi, colonne più giovani comprese.
 */
function dbPrima(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, text TEXT, preview_image TEXT)");
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT)");
  for (const m of ["080-devices.sql", "082-task-shares.sql", "083-grants.sql"]) {
    db.run(readFileSync(join(RADICE, "server", "db", "migrations", m), "utf8"));
  }
  return db;
}

function applica(db: Database): void {
  db.run(readFileSync(M084, "utf8"));
}

/** Il confinamento come lo calcolerà il risolutore: nessuna persona, o persona
 *  revocata, o persona che non è proprietaria dell'installazione. */
function confinato(db: Database, deviceId: string): boolean {
  const r = db.query(`
    SELECT CASE WHEN d.person_id IS NULL THEN 1
                WHEN p.revoked_at IS NOT NULL THEN 1
                WHEN io.person_id IS NULL THEN 1
                ELSE 0 END AS confinato
      FROM devices d
      LEFT JOIN people p ON p.id = d.person_id
      LEFT JOIN installation_owners io ON io.person_id = d.person_id
     WHERE d.id = ?`).get(deviceId) as { confinato: number } | undefined;
  return !!r?.confinato;
}

function aggiungiDispositivo(db: Database, id: string, nome: string, role: string, revoked: number | null = null) {
  db.query(
    "INSERT INTO devices (id, name, token_hash, created_at, role, revoked_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, nome, `hash-${id}`, 1, role, revoked);
}

describe("084 · nasce il proprietario, senza login e senza rete", () => {
  let db: Database;
  beforeEach(() => { db = dbPrima(); });

  test("una persona proprietaria e un'organizzazione da una", () => {
    aggiungiDispositivo(db, "d1", "Mac di casa", "owner");
    applica(db);

    // Una migration è SQL: non può leggere `git config` né chiamare nessuno.
    // Quindi il proprietario nasce anonimo e rinominabile, non «sconosciuto».
    const persone = db.query("SELECT display_name FROM people").all() as Array<{ display_name: string }>;
    expect(persone.map((p) => p.display_name)).toContain("Proprietario");
    expect(db.query("SELECT COUNT(*) c FROM orgs").get()).toEqual({ c: 1 });
    expect(db.query("SELECT COUNT(*) c FROM installation_owners").get()).toEqual({ c: 1 });
  });

  test("i dispositivi `owner` finiscono sulla persona proprietaria", () => {
    aggiungiDispositivo(db, "d1", "Mac", "owner");
    aggiungiDispositivo(db, "d2", "iPhone", "owner");
    applica(db);

    const persone = db.query("SELECT DISTINCT person_id FROM devices WHERE role='owner'").all();
    expect(persone).toHaveLength(1);
    expect(confinato(db, "d1")).toBe(false);
    expect(confinato(db, "d2")).toBe(false);
  });

  test("un OSPITE prende una persona sua, che NON è proprietaria", () => {
    aggiungiDispositivo(db, "d1", "Mac", "owner");
    aggiungiDispositivo(db, "d9", "Telefono di Luca", "guest");
    applica(db);

    const suo = db.query("SELECT person_id FROM devices WHERE id='d9'").get() as { person_id: string | null };
    const del = db.query("SELECT person_id FROM devices WHERE id='d1'").get() as { person_id: string | null };
    expect(suo.person_id).toBeTruthy();
    expect(suo.person_id).not.toBe(del.person_id);
    // È il punto per cui la 084 esiste: il confinamento smette di essere una
    // colonna e diventa una relazione, e deve dare la STESSA risposta di prima.
    expect(confinato(db, "d9")).toBe(true);
  });
});

describe("084 · il confinamento derivato coincide con il ruolo di prima", () => {
  test("su ogni combinazione, compreso il revocato", () => {
    const db = dbPrima();
    aggiungiDispositivo(db, "o1", "Mac", "owner");
    aggiungiDispositivo(db, "o2", "iPhone", "owner");
    aggiungiDispositivo(db, "g1", "Ospite A", "guest");
    aggiungiDispositivo(db, "g2", "Ospite B revocato", "guest", 999);
    aggiungiDispositivo(db, "o3", "Owner revocato", "owner", 999);
    applica(db);

    for (const [id, atteso] of [["o1", false], ["o2", false], ["o3", false], ["g1", true], ["g2", true]] as const) {
      expect(`${id}:${confinato(db, id)}`).toBe(`${id}:${atteso}`);
    }
  });
});

describe("084 · le concessioni sopravvivono", () => {
  test("le righe di grants restano tutte, con lo stesso significato", () => {
    const db = dbPrima();
    aggiungiDispositivo(db, "g1", "Ospite", "guest");
    db.run("INSERT INTO tasks (id, text) VALUES ('t1','x')");
    db.run("INSERT INTO topics (id, name) VALUES ('c1','y')");
    db.query(
      "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES (?,?,?,?,?,?,?)",
    ).run("g-1", "device", "g1", "task", "t1", "read", 1);
    db.query(
      "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, via_type, via_id, granted_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("g-2", "device", "g1", "topic", "c1", "read", "project", "p1", 2);

    applica(db);

    const righe = db.query("SELECT id, subject_type, subject_id, resource_type, resource_id, via_type, via_id FROM grants ORDER BY id").all();
    expect(righe).toEqual([
      { id: "g-1", subject_type: "device", subject_id: "g1", resource_type: "task", resource_id: "t1", via_type: null, via_id: null },
      { id: "g-2", subject_type: "device", subject_id: "g1", resource_type: "topic", resource_id: "c1", via_type: "project", via_id: "p1" },
    ]);
  });

  test("il CHECK si allarga: person e org diventano scrivibili", () => {
    // È lo scopo dichiarato della migration, e finché non passa, `putGrant`
    // verso una persona non fallisce — non fa NIENTE, perché `INSERT OR IGNORE`
    // inghiotte anche le violazioni di CHECK.
    const db = dbPrima();
    applica(db);
    db.run("INSERT INTO tasks (id, text) VALUES ('t1','x')");
    for (const tipo of ["person", "org"]) {
      db.query(
        "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES (?,?,?,?,?,?,?)",
      ).run(`g-${tipo}`, tipo, "s1", "task", "t1", "read", 1);
    }
    expect(db.query("SELECT COUNT(*) c FROM grants").get()).toEqual({ c: 2 });
  });

  test("un soggetto inventato resta rifiutato", () => {
    // Allargare non vuol dire aprire: il CHECK deve restare una lista chiusa,
    // allineata all'union TypeScript.
    const db = dbPrima();
    applica(db);
    db.run("INSERT INTO tasks (id, text) VALUES ('t1','x')");
    let esploso = false;
    try {
      db.query(
        "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('x','team','s1','task','t1','read',1)",
      ).run();
    } catch { esploso = true; }
    expect(esploso).toBe(true);
  });

  test("`deny` diventa un livello legale", () => {
    const db = dbPrima();
    applica(db);
    db.run("INSERT INTO tasks (id, text) VALUES ('t1','x')");
    db.query(
      "INSERT INTO grants (id, subject_type, subject_id, resource_type, resource_id, level, granted_at) VALUES ('x','person','p1','task','t1','deny',1)",
    ).run();
    expect(db.query("SELECT level FROM grants").get()).toEqual({ level: "deny" });
  });
});

describe("084 · il contatore dei principali", () => {
  test("cambia quando cambia un'appartenenza", () => {
    // È il segnale con cui una socket già aperta si accorge che il suo insieme
    // di principali non vale più: senza, il filtro resta fermo a com'era al
    // momento dell'upgrade.
    const db = dbPrima();
    aggiungiDispositivo(db, "d1", "Mac", "owner");
    applica(db);
    const prima = (db.query("SELECT rev FROM principals_rev").get() as { rev: number }).rev;

    const org = (db.query("SELECT id FROM orgs").get() as { id: string }).id;
    db.query("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('p9','Nuova',1,'local',1,1)").run();
    db.query("INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES (?,?,?,?,?,?)")
      .run(org, "p9", "member", 1, 1, 1);

    const dopo = (db.query("SELECT rev FROM principals_rev").get() as { rev: number }).rev;
    expect(dopo).toBeGreaterThan(prima);
  });

  test("cambia quando un dispositivo passa a un'altra persona", () => {
    const db = dbPrima();
    aggiungiDispositivo(db, "d1", "Mac", "owner");
    applica(db);
    const prima = (db.query("SELECT rev FROM principals_rev").get() as { rev: number }).rev;
    db.query("UPDATE devices SET person_id = NULL WHERE id='d1'").run();
    const dopo = (db.query("SELECT rev FROM principals_rev").get() as { rev: number }).rev;
    expect(dopo).toBeGreaterThan(prima);
  });
});

describe("084 · cosa succede se la si rigioca", () => {
  test("lo SCHEMA non è ripetibile, ed è il contratto del runner — non una svista", () => {
    // `ALTER TABLE devices ADD COLUMN person_id` esplode la seconda volta, come
    // esplode `ADD COLUMN role` della 082. Va bene: il runner consulta
    // `schema_migrations` PRIMA e applica ogni file una volta sola. Quel che
    // NON va bene è crederlo idempotente e scoprirlo durante un ripristino,
    // quindi lo si scrive qui invece di lasciarlo alla sorpresa.
    const db = dbPrima();
    aggiungiDispositivo(db, "d1", "Mac", "owner");
    applica(db);
    let esploso = false;
    try { applica(db); } catch { esploso = true; }
    expect(esploso).toBe(true);
  });

  test("i DATI però non si duplicano: le insert sono OR IGNORE", () => {
    // È la metà che conta se un ripristino parziale rigioca la coda del file:
    // il proprietario resta uno, non ne nascono due.
    const db = dbPrima();
    aggiungiDispositivo(db, "d1", "Mac", "owner");
    applica(db);
    const conta = () => db.query(
      "SELECT (SELECT COUNT(*) FROM people) p, (SELECT COUNT(*) FROM orgs) o, (SELECT COUNT(*) FROM installation_owners) io",
    ).get();
    const prima = conta();

    const sql = readFileSync(M084, "utf8");
    // Si rigioca tutto tranne l'ALTER, che è la sola riga non ripetibile.
    for (const stmt of sql.split(/;\s*$/m)) {
      if (/ALTER TABLE devices ADD COLUMN/i.test(stmt)) continue;
      if (!stmt.trim()) continue;
      try { db.run(stmt); } catch { /* i CREATE hanno già IF NOT EXISTS */ }
    }
    expect(conta()).toEqual(prima);
  });
});
