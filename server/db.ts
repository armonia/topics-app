import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

let _db: Database | null = null;

/**
 * Initialize SQLite database with WAL mode and run pending migrations.
 * Returns a singleton Database instance.
 */
export function initDatabase(baseDir: string): Database {
  if (_db) return _db;

  const dataDir = join(baseDir, "data");
  mkdirSync(dataDir, { recursive: true });

  const dbPath = join(dataDir, "topics.db");
  const isNew = !existsSync(dbPath);

  _db = new Database(dbPath);

  // Performance pragmas
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA foreign_keys = ON");
  _db.run("PRAGMA busy_timeout = 5000");
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
        // Split by semicolons but handle multi-line statements
        // We run the entire SQL as exec for better compatibility
        db.exec(sql);
      })();
      ranCount++;
      console.log(`[DB] Migration ${file} applied successfully`);
    } catch (err) {
      console.error(`[DB] Migration ${file} failed:`, err);
      throw err;
    }
  }

  if (ranCount > 0) {
    console.log(`[DB] Applied ${ranCount} migration(s)`);
  } else {
    console.log("[DB] All migrations up to date");
  }
}
