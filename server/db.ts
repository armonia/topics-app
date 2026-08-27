import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { EMBEDDED_MIGRATIONS } from "./db/migrations-embedded";
import { resolveDataDir } from "./lib/data-dir";

let _db: Database | null = null;

/**
 * Initialize SQLite database with WAL mode and run pending migrations.
 * Returns a singleton Database instance.
 */
export function initDatabase(baseDir: string, dataRoot: string = baseDir): Database {
  if (_db) return _db;

  // DB file lives under the WRITABLE dataRoot (STATE_DIR); migrations are read
  // from baseDir (the bundle) below. In dev dataRoot === baseDir (unchanged).
  const dataDir = resolveDataDir(dataRoot);
  mkdirSync(dataDir, { recursive: true });

  const dbPath = join(dataDir, "topics.db");
  const isNew = !existsSync(dbPath);

  _db = new Database(dbPath);

  // Set busy_timeout FIRST so subsequent PRAGMAs wait instead of failing
  // with SQLITE_BUSY_RECOVERY when the WAL is being checkpointed
  _db.run("PRAGMA busy_timeout = 10000");
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA foreign_keys = ON");
  _db.run("PRAGMA synchronous = NORMAL");
  _db.run("PRAGMA cache_size = -64000"); // 64MB cache

  // Registro delle migration applicate. La chiave è il NOME FILE, non il
  // numero — vedi migrationRegistryByName() per il perché e per la conversione
  // dei database che nascono con la vecchia forma.
  _db.run(REGISTRY_DDL);

  // Run pending migrations
  runMigrations(_db, baseDir);

  if (isNew) {
    console.log(`[DB] Created new database at ${dbPath}`);
  } else {
    console.log(`[DB] Opened existing database at ${dbPath}`);
  }

  return _db;
}

/**
 * Get the singleton database instance. Throws if not initialized.
 */
export function getDatabase(): Database {
  if (!_db) throw new Error("Database not initialized. Call initDatabase() first.");
  return _db;
}

/**
 * Close the database connection (for graceful shutdown).
 */
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
    console.log("[DB] Database closed");
  }
}

/**
 * Il registro delle migration applicate, indicizzato per NOME FILE.
 *
 * Prima la chiave primaria era `version`, cioè il numero in testa al file, e il
 * runner saltava per numero. Il 10/08 due card sviluppate in parallelo hanno
 * prodotto entrambe una `089` (`089-retirements.sql` e
 * `089-project-org-incognito.sql`): il secondo ramo era stato tagliato prima
 * che il primo atterrasse, quindi nessuno dei due poteva accorgersene. Il primo
 * 089 ad applicarsi vinceva e il secondo NON si applicava mai — in silenzio,
 * mentre il codice che presupponeva quelle colonne landava lo stesso. Il guasto
 * si vedeva solo in produzione, come una query su colonne inesistenti.
 *
 * Con la chiave sul nome, due file che condividono il numero si applicano
 * entrambi, in ordine (numero, nome). `version` resta — è l'ORDINAMENTO, non
 * l'identità — e chi la legge (scripts/board-baseline.ts) continua a funzionare.
 * L'ordine di colonne è quello storico apposta: le migration che si registrano
 * da sole elencano sempre le colonne, ma cambiare l'ordine sarebbe una trappola
 * gratuita per il primo `INSERT ... VALUES` posizionale che qualcuno scriverà.
 *
 * Il cancello a monte (scripts/check-migration-numbers.ts) impedisce che due
 * numeri uguali arrivino su main; questo impedisce che, se ci arrivano, il
 * danno sia invisibile.
 */
const REGISTRY_DDL = `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER NOT NULL,
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `;

/**
 * Porta un registro nato con `version` come chiave primaria alla forma nuova.
 *
 * Due cose vanno sistemate, in quest'ordine:
 *
 * 1. IL NOME NON ERA IL NOME DEL FILE. Diverse migration storiche si registrano
 *    da sole con uno stem (`'ui-state'`, `'push-subscriptions'`, `'001-initial'`)
 *    e, essendo `INSERT` fatto DENTRO la transazione prima di quello del runner,
 *    è il loro nome a vincere sul `INSERT OR IGNORE` che segue. Se passassimo
 *    alla chiave sul nome senza normalizzare, `007-ui-state.sql` non
 *    risulterebbe applicata su NESSUN database esistente e verrebbe rieseguita.
 *    Il numero è l'unico ponte fra le due convenzioni, e lo si può attraversare
 *    solo ORA, finché `version` è ancora univoca.
 * 2. La tabella va ricostruita: in SQLite la chiave primaria non si sposta.
 *
 * Idempotente: se la chiave è già sul nome non fa niente. Gira a ogni avvio e
 * costa una `PRAGMA table_info`.
 */
function migrationRegistryByName(db: Database, migrations: MigrationEntry[]): void {
  const columns = db.query("PRAGMA table_info(schema_migrations)").all() as { name: string; pk: number }[];
  if (columns.length === 0) return; // tabella assente: la crea il DDL nuovo
  if (columns.find(c => c.pk === 1)?.name === "name") return; // già convertito

  const fileOf = new Map<number, string>();
  for (const m of migrations) if (!fileOf.has(m.version)) fileOf.set(m.version, m.name);

  db.transaction(() => {
    // 1. stem storici → nome file. Le righe di una versione che non ha più un
    //    file (mai successo qui, ma non è compito di questa conversione
    //    deciderlo) restano come sono: la chiave sul nome le accetta comunque.
    const rows = db.query("SELECT version, name FROM schema_migrations").all() as { version: number; name: string }[];
    const rename = db.prepare("UPDATE schema_migrations SET name = ? WHERE version = ?");
    let normalizzate = 0;
    for (const row of rows) {
      const file = fileOf.get(row.version);
      if (!file || file === row.name) continue;
      rename.run(file, row.version);
      normalizzate++;
    }

    // 2. ricostruzione con la chiave sul nome. `OR IGNORE` + `ORDER BY version`
    //    perché due righe orfane potrebbero teoricamente condividere il nome:
    //    in quel caso vince la più vecchia, che è quella applicata per prima.
    db.run("ALTER TABLE schema_migrations RENAME TO schema_migrations_old");
    db.run(REGISTRY_DDL);
    db.run(
      "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) " +
        "SELECT version, name, applied_at FROM schema_migrations_old ORDER BY version",
    );
    db.run("DROP TABLE schema_migrations_old");

    console.log(
      `[DB] Registro migration convertito alla chiave per nome ` +
        `(${rows.length} riga/he, ${normalizzate} nome/i normalizzato/i dallo stem storico)`,
    );
  })();
}

/**
 * L'ordine di esecuzione: prima il numero, poi il nome.
 *
 * Il numero non è più un'identità (può ripetersi), quindi da solo non è un
 * ordine: due `089` messe in fila da un confronto sul solo numero starebbero
 * in qualsiasi ordine il filesystem o la stabilità di `sort` decidano quel
 * giorno, cioè non-deterministico fra macchine. Il nome rompe il pareggio, e
 * ogni database del mondo applica le stesse migration nella stessa sequenza.
 */
function byVersionThenName(a: string, b: string): number {
  const va = parseInt(a.match(/^(\d+)-/)![1], 10);
  const vb = parseInt(b.match(/^(\d+)-/)![1], 10);
  return va - vb || (a < b ? -1 : a > b ? 1 : 0);
}

/** One migration to apply, from disk or the embedded manifest. */
interface MigrationEntry {
  version: number;
  name: string;
  /** SQL text; loaded lazily on disk (only read when about to run). */
  read: () => string;
}

/**
 * Resolve the ordered migration list from whichever source is available:
 *   • DISK (dev / launchd / bundled-with-source): read server/db/migrations/*.sql.
 *     Byte-identical to the historical behaviour.
 *   • EMBEDDED (the `bun build --compile` server sidecar): `import.meta.dir` is a
 *     virtual path there and the migrations dir isn't on disk, so fall back to
 *     EMBEDDED_MIGRATIONS (migrations-embedded.ts, statically imported → baked into
 *     the binary). Regenerate that manifest with scripts/gen-migrations-manifest.ts.
 * Returns [] only if BOTH are empty (genuinely misconfigured).
 */
function resolveMigrations(migrationsDir: string): MigrationEntry[] {
  if (existsSync(migrationsDir)) {
    return readdirSync(migrationsDir)
      .filter(f => /^\d+-.+\.sql$/.test(f))
      .sort(byVersionThenName)
      .map(file => {
        const version = parseInt(file.match(/^(\d+)-/)![1], 10);
        return { version, name: file, read: () => readFileSync(join(migrationsDir, file), "utf-8") };
      });
  }
  if (EMBEDDED_MIGRATIONS.length > 0) {
    console.log(`[DB] Migrations dir absent — using ${EMBEDDED_MIGRATIONS.length} embedded migration(s) (compiled binary)`);
    return EMBEDDED_MIGRATIONS
      .slice()
      .sort((a, b) => byVersionThenName(a.name, b.name))
      .map(m => ({ version: m.version, name: m.name, read: () => m.sql }));
  }
  console.warn(`[DB] Migrations directory not found and no embedded migrations: ${migrationsDir}`);
  return [];
}

/**
 * Run all pending SQL migrations in order. Source is disk (dev/launchd) or the
 * embedded manifest (compiled sidecar) — see resolveMigrations.
 */
function runMigrations(db: Database, baseDir: string): void {
  const migrationsDir = join(baseDir, "server", "db", "migrations");
  const migrations = resolveMigrations(migrationsDir);
  if (migrations.length === 0) return;

  // Chiave sul nome file, non sul numero: due migration che condividono il
  // numero devono applicarsi entrambe. La conversione dei database nati con la
  // vecchia forma (e la normalizzazione degli stem storici) sta qui dentro.
  migrationRegistryByName(db, migrations);

  const applied = new Set(
    (db.query("SELECT name FROM schema_migrations").all() as { name: string }[]).map(row => row.name)
  );
  // Le domande legacy qui sotto sono ancora sul NUMERO ("le 001-008 girarono
  // prima che esistesse il tracciamento?"): le si risponde da un insieme
  // derivato, non tornando a indicizzare il registro per numero.
  const appliedVersions = new Set(
    (db.query("SELECT version FROM schema_migrations").all() as { version: number }[]).map(row => row.version)
  );

  // Backfill: if schema_migrations is empty but tables exist, prior migrations
  // ran without tracking (the INSERT was missing before this fix).
  // Only mark migrations 001-008 as applied; newer ones will run normally.
  if (applied.size === 0) {
    try {
      const tables = new Set(
        (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
          .map(t => t.name)
      );
      if (tables.has("messages")) {
        for (const mig of migrations) {
          if (mig.version > 8) break; // only backfill pre-fix migrations
          db.run("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
            [mig.version, mig.name, new Date().toISOString()]);
          applied.add(mig.name);
          appliedVersions.add(mig.version);
        }
        console.log(`[DB] Backfilled schema_migrations for ${applied.size} previously-applied migration(s)`);
      }
    } catch {}
  }

  // Un CONTATORE condiviso non è più un guasto silenzioso, ma resta un segnale
  // che il cancello di consegna (scripts/check-migration-numbers.ts) è stato
  // aggirato: dirlo costa una riga di log e fa risparmiare mezz'ora a chi legge.
  //
  // I nomi col prefisso timestamp (`20260812050317-…`, 14 cifre) sono esclusi:
  // lì due numeri uguali vogliono dire "stesso secondo, due worktree che non si
  // vedevano", che è previsto e innocuo — si applicano entrambe in ordine di
  // nome. Vedi scripts/new-migration.ts.
  const perNumero = new Map<number, string[]>();
  for (const m of migrations) {
    if (/^\d{14}-/.test(m.name)) continue;
    perNumero.set(m.version, [...(perNumero.get(m.version) ?? []), m.name]);
  }
  for (const [version, files] of perNumero) {
    if (files.length > 1) {
      console.warn(
        `[DB] Numero di migration ${version} condiviso da ${files.length} file (${files.join(", ")}) — ` +
          `si applicano tutte, in quest'ordine. Atteso solo se il cancello è stato aggirato.`,
      );
    }
  }

  let ranCount = 0;
  for (const mig of migrations) {
    const { version, name: file } = mig;
    if (applied.has(file)) continue;

    const sql = mig.read();

    console.log(`[DB] Running migration ${file}...`);
    try {
      // Run the entire migration in a transaction
      db.transaction(() => {
        db.exec(sql);
        // Diverse migration storiche si registrano da sole con uno STEM
        // (`'ui-state'`, `'push-subscriptions'`). Quando la chiave era il
        // numero, l'`INSERT OR IGNORE` del runner qui sotto ci rimbalzava
        // sopra e il doppione non esisteva; con la chiave sul nome sarebbero
        // due righe per la stessa migration. Il nome canonico è quello del
        // FILE, e solo quello finisce in `.sql`.
        db.run("DELETE FROM schema_migrations WHERE version = ? AND name NOT LIKE '%.sql'", [version]);
        db.run(
          "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          [version, file, new Date().toISOString()]
        );
      })();
      ranCount++;
      console.log(`[DB] Migration ${file} applied successfully`);
    } catch (err: any) {
      // Handle "duplicate column" errors gracefully — the column already exists
      // (can happen when migration previously ran without schema_migrations tracking)
      if (err?.message?.includes("duplicate column name")) {
        db.run(
          "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          [version, file, new Date().toISOString()]
        );
        ranCount++;
        console.log(`[DB] Migration ${file} already applied (column exists), tracked`);
      } else {
        console.error(`[DB] Migration ${file} failed:`, err);
        throw err;
      }
    }
  }

  if (ranCount > 0) {
    console.log(`[DB] Applied ${ranCount} migration(s)`);

    // Post-migration backfill: chain existing messages with parent_id
    if (!appliedVersions.has(5)) {
      backfillParentIds(db);
    }
  } else {
    console.log("[DB] All migrations up to date");
  }
}

/**
 * Backfill parent_id for existing messages after migration 005.
 * Chains messages within each session by sort_order so the tree structure
 * is backward-compatible with the flat list.
 */
function backfillParentIds(db: Database): void {
  const sessions = db.query("SELECT DISTINCT session_key FROM messages").all() as { session_key: string }[];
  if (sessions.length === 0) return;

  console.log(`[DB] Backfilling parent_id for ${sessions.length} session(s)...`);
  const update = db.prepare("UPDATE messages SET parent_id = ? WHERE id = ?");

  db.transaction(() => {
    for (const { session_key } of sessions) {
      const msgs = db.query(
        "SELECT id FROM messages WHERE session_key = ? ORDER BY sort_order ASC"
      ).all(session_key) as { id: string }[];

      for (let i = 1; i < msgs.length; i++) {
        update.run(msgs[i - 1].id, msgs[i].id);
      }
    }
  })();

  console.log("[DB] Backfill complete");
}
