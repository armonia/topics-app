import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

let _db: Database | null = null;

/**
 * Initialize SQLite database with WAL mode and run pending migrations.
 * Returns a singleton Database instance.
 */
export function initDatabase(baseDir: string, dataRoot: string = baseDir): Database {
  if (_db) return _db;

  // DB file lives under the WRITABLE dataRoot (STATE_DIR); migrations are read
  // from baseDir (the bundle) below. In dev dataRoot === baseDir (unchanged).
  const dataDir = process.env.DATA_DIR || join(dataRoot, "data");
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

  // Ensure schema_migrations table exists for tracking
  _db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

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
 * Run all pending SQL migrations in order.
 * Migrations are .sql files in server/db/migrations/ named NNN-description.sql
 */
function runMigrations(db: Database, baseDir: string): void {
  const migrationsDir = join(baseDir, "server", "db", "migrations");
  if (!existsSync(migrationsDir)) {
    console.warn(`[DB] Migrations directory not found: ${migrationsDir}`);
    return;
  }

  // Get applied versions
  const applied = new Set(
    db.query("SELECT version FROM schema_migrations").all().map((row: any) => row.version)
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
        for (const file of readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort()) {
          const m = file.match(/^(\d+)-(.+)\.sql$/);
          if (!m) continue;
          const v = parseInt(m[1], 10);
          if (v > 8) break; // only backfill pre-fix migrations
          db.run("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
            [v, file, new Date().toISOString()]);
          applied.add(v);
        }
        console.log(`[DB] Backfilled schema_migrations for ${applied.size} previously-applied migration(s)`);
      }
    } catch {}
  }

  // Find migration files
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith(".sql"))
    .sort();

  let ranCount = 0;
  for (const file of files) {
    const match = file.match(/^(\d+)-(.+)\.sql$/);
    if (!match) continue;

    const version = parseInt(match[1], 10);
    if (applied.has(version)) continue;

    const sql = readFileSync(join(migrationsDir, file), "utf-8");

    console.log(`[DB] Running migration ${file}...`);
    try {
      // Run the entire migration in a transaction
      db.transaction(() => {
        db.exec(sql);
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
    if (!applied.has(5)) {
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
