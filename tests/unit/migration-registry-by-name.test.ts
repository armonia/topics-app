/**
 * Il registro delle migration è indicizzato per NOME FILE, non per numero.
 *
 * Prima la chiave era `version` e il runner faceva `if (applied.has(version))
 * continue`: la seconda migration con lo stesso numero veniva saltata in
 * SILENZIO, per sempre, mentre il codice che presupponeva quelle colonne
 * landava lo stesso — un guasto che si vedeva solo in produzione. Il 10/08 è
 * successo davvero, con due `089`.
 *
 * Qui si guida il runner VERO (`initDatabase`) su una cartella di migration
 * sintetica: è l'unico modo di provare che due file con lo stesso numero si
 * applicano entrambi e che un database nato con la vecchia forma non riesegue
 * niente. Il cancello che impedisce che due `089` arrivino su main sta in
 * tests/unit/migration-number-collision.test.ts.
  * @covers SCHEMA-05
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase } from "../../server/db";

const daPulire: string[] = [];

// initDatabase is idempotent (`if (_db) return _db`) and runs `mkdirSync(dataDir)`
// ONLY when it really opens. If an earlier file in the same process leaves the
// singleton open, our initDatabase becomes a no-op and the dataDir is never
// born: "unable to open database file". Resetting BEFORE every test makes this
// file robust to any upstream leaker (the convention of every other db test in
// the repo). Serial order used to hide it; sharded order does not.
beforeEach(() => {
  closeDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env.DATA_DIR;
  for (const d of daPulire.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Il primo file di OGNI fixture. Dopo aver applicato qualcosa il runner chiama
 * `backfillParentIds`, che interroga `messages`: senza quella tabella ogni
 * fixture morirebbe lì, per un motivo che non c'entra col registro. Vuota, la
 * query esce subito. `IF NOT EXISTS` perché il test sul database vecchio la
 * tabella ce l'ha già.
 */
const BASE_FILE = "000-base.sql";
const BASE_SQL =
  "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_key TEXT, sort_order INTEGER, parent_id TEXT);";

/** Un baseDir con `server/db/migrations/` popolata a mano, più il suo DATA_DIR. */
function baseConMigrations(files: Record<string, string>): { baseDir: string; dataDir: string } {
  const baseDir = mkdtempSync(join(tmpdir(), "registry-"));
  daPulire.push(baseDir);
  const dir = join(baseDir, "server", "db", "migrations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, BASE_FILE), BASE_SQL);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  const dataDir = join(baseDir, "data");
  process.env.DATA_DIR = dataDir;
  return { baseDir, dataDir };
}

/** Il registro come lo si legge: nome → versione, in ordine di applicazione. Senza l'impalcatura. */
function registro(dataDir: string): { name: string; version: number }[] {
  const db = new Database(join(dataDir, "topics.db"));
  const rows = db
    .query("SELECT name, version FROM schema_migrations ORDER BY applied_at, rowid")
    .all() as { name: string; version: number }[];
  db.close();
  return rows.filter(r => r.name !== BASE_FILE);
}

function tabelle(dataDir: string): string[] {
  const db = new Database(join(dataDir, "topics.db"));
  const rows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  db.close();
  return rows.map(r => r.name).sort();
}

describe("registro migration per nome", () => {
  it("due migration con lo STESSO numero si applicano ENTRAMBE", () => {
    // Il caso del 10/08, in miniatura: due card, due 089, una sola sopravviveva.
    const { baseDir, dataDir } = baseConMigrations({
      "001-initial.sql": "CREATE TABLE topics (id TEXT PRIMARY KEY);",
      "089-retirements.sql": "CREATE TABLE retirements (id TEXT PRIMARY KEY);",
      "089-project-org-incognito.sql": "CREATE TABLE incognito (id TEXT PRIMARY KEY);",
    });
    initDatabase(baseDir);
    closeDatabase();

    expect(tabelle(dataDir)).toContain("retirements");
    expect(tabelle(dataDir)).toContain("incognito"); // ← saltata in silenzio, prima
    expect(registro(dataDir).map(r => r.name)).toEqual([
      "001-initial.sql",
      "089-project-org-incognito.sql", // l'ordine a parità di numero è il NOME…
      "089-retirements.sql",
    ]);
  });

  it("…e quell'ordine è lo stesso a ogni avvio e su ogni macchina", () => {
    // Senza il tie-break sul nome l'ordine dipenderebbe da come il filesystem
    // elenca la cartella, cioè sarebbe diverso fra due macchine.
    const files = {
      "090-zzz.sql": "CREATE TABLE zzz (id TEXT PRIMARY KEY);",
      "090-aaa.sql": "CREATE TABLE aaa (id TEXT PRIMARY KEY);",
      "089-mid.sql": "CREATE TABLE mid (id TEXT PRIMARY KEY);",
    };
    const a = baseConMigrations(files);
    initDatabase(a.baseDir);
    closeDatabase();
    const orderA = registro(a.dataDir).map(r => r.name);

    const b = baseConMigrations(files);
    initDatabase(b.baseDir);
    closeDatabase();

    expect(orderA).toEqual(["089-mid.sql", "090-aaa.sql", "090-zzz.sql"]);
    expect(registro(b.dataDir).map(r => r.name)).toEqual(orderA);
  });

  it("un secondo avvio non riapplica niente", () => {
    const { baseDir, dataDir } = baseConMigrations({
      "001-initial.sql": "CREATE TABLE topics (id TEXT PRIMARY KEY);",
      "089-a.sql": "CREATE TABLE a (id TEXT PRIMARY KEY);",
      "089-b.sql": "CREATE TABLE b (id TEXT PRIMARY KEY);",
    });
    initDatabase(baseDir);
    closeDatabase();
    const primo = registro(dataDir);

    // Senza `IF NOT EXISTS` un CREATE TABLE rieseguito esploderebbe: se questo
    // non lancia, e il registro è identico, il secondo giro non ha fatto nulla.
    initDatabase(baseDir);
    closeDatabase();
    expect(registro(dataDir)).toEqual(primo);
  });

  it("una migration che si registra da sola con uno STEM non lascia doppioni", () => {
    // È la convenzione storica di 006/007/012: `VALUES (7, 'ui-state', …)`.
    // Con la chiave sul numero la riga del runner ci rimbalzava sopra; con la
    // chiave sul nome sarebbero due righe per la stessa migration.
    const { baseDir, dataDir } = baseConMigrations({
      "007-ui-state.sql":
        "CREATE TABLE ui_state (id TEXT PRIMARY KEY);\n" +
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (7, 'ui-state', datetime('now'));",
    });
    initDatabase(baseDir);
    closeDatabase();
    expect(registro(dataDir)).toEqual([{ name: "007-ui-state.sql", version: 7 }]);
  });

  it("un database con la VECCHIA forma si converte senza riapplicare niente", () => {
    const files = {
      "001-initial.sql": "CREATE TABLE topics (id TEXT PRIMARY KEY);",
      "007-ui-state.sql": "CREATE TABLE ui_state (id TEXT PRIMARY KEY);",
      "012-payload.sql": "CREATE TABLE payload (id TEXT PRIMARY KEY);",
    };
    const { baseDir, dataDir } = baseConMigrations(files);

    // Il database com'era prima: chiave sul numero e nomi che NON sono nomi di
    // file (gli stem che le migration storiche si scrivono da sole).
    mkdirSync(dataDir, { recursive: true });
    const vecchio = new Database(join(dataDir, "topics.db"));
    vecchio.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE topics (id TEXT PRIMARY KEY);
      CREATE TABLE ui_state (id TEXT PRIMARY KEY);
      CREATE TABLE payload (id TEXT PRIMARY KEY);
      INSERT INTO schema_migrations VALUES (1, '001-initial', '2025-01-01');
      INSERT INTO schema_migrations VALUES (7, 'ui-state', '2025-01-02');
      INSERT INTO schema_migrations VALUES (12, 'ui-state-payload-version', '2025-01-03');
    `);
    vecchio.close();

    // Se la conversione non traducesse gli stem in nomi file, TUTTE E TRE
    // risulterebbero non applicate e il runner le rieseguirebbe: i CREATE TABLE
    // qui sopra sono senza `IF NOT EXISTS`, quindi initDatabase lancerebbe.
    expect(() => initDatabase(baseDir)).not.toThrow();
    closeDatabase();

    expect(registro(dataDir)).toEqual([
      { name: "001-initial.sql", version: 1 },
      { name: "007-ui-state.sql", version: 7 },
      { name: "012-payload.sql", version: 12 },
    ]);
    expect(tabelle(dataDir)).not.toContain("schema_migrations_old");
  });

  it("dopo la conversione la chiave primaria è il nome, non il numero", () => {
    const { baseDir, dataDir } = baseConMigrations({
      "001-initial.sql": "CREATE TABLE topics (id TEXT PRIMARY KEY);",
    });
    initDatabase(baseDir);
    closeDatabase();

    const db = new Database(join(dataDir, "topics.db"));
    const cols = db.query("PRAGMA table_info(schema_migrations)").all() as { name: string; pk: number }[];
    db.close();
    expect(cols.find(c => c.pk === 1)?.name).toBe("name");
    // L'ordine delle colonne resta quello storico: qualunque
    // `INSERT ... VALUES` posizionale già scritto continua a funzionare.
    expect(cols.map(c => c.name)).toEqual(["version", "name", "applied_at"]);
  });
});
