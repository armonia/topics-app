/**
 * @covers RUNTIME-06
 *
 * EVERY ROW OF THE REGISTRY IS A MIGRATION THAT EXISTS.
 *
 * `schema_migrations` is keyed by FILE NAME, and the runner sweeps the historic
 * stems of the migrations that register themselves with
 * `DELETE ... WHERE version = ? AND name NOT LIKE '%.sql'`, where `?` is the
 * number OF THE FILE. It is enough for the stem to have been recorded under a
 * number DIFFERENT from the one the file carries today and the sweep never
 * finds it: that is `101-push-device-prefs.sql`, born 100, renumbered 101 when
 * main took that number, whose own INSERT still says 100.
 *
 * Measured, not deduced: on the live database (a read-only copy) and on one
 * created from scratch by `initDatabase`, `schema_migrations` held 163 rows for
 * 162 files, and the extra one was `(100, 'push-device-prefs')`.
 *
 * This test does not look at that one name, it looks at the PROPERTY: every row
 * of the registry must map to a migration that exists, on a database freshly
 * built from today's migrations. A future renumbering repeating the same
 * mistake falls here.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { initDatabase, closeDatabase } from "../db";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const dataRoot = mkdtempSync(join(tmpdir(), "registro-migrazioni-"));

afterAll(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* gone */ }
});

function migrationFilesOnDisk(): string[] {
  return readdirSync(join(REPO_ROOT, "server", "db", "migrations")).filter((f) => /^\d+-.+\.sql$/.test(f));
}

describe("the migration registry of a freshly created database", () => {
  test("holds no row that is not a migration", () => {
    const db = initDatabase(join(REPO_ROOT, "server"), dataRoot);
    const rows = db.query("SELECT version, name FROM schema_migrations").all() as { version: number; name: string }[];
    const files = new Set(migrationFilesOnDisk());

    const orphans = rows.filter((r) => !files.has(r.name));
    expect(
      orphans,
      `rows with no matching file: ${orphans.map((r) => `${r.version}/${r.name}`).join(", ")}`,
    ).toEqual([]);
    expect(rows.length).toBe(files.size);
  });

  test("no number is claimed by two rows", () => {
    // The number is no longer the identity (two timestamps in the same second
    // are legal), but TWO ROWS ON ONE NUMBER under different names was the
    // visible symptom of the ghost row, and readers that query the registry by
    // version (scripts/board-baseline.ts) pick one of them at random.
    const db = initDatabase(join(REPO_ROOT, "server"), dataRoot);
    const shared = db
      .query(
        "SELECT version, COUNT(*) AS n, GROUP_CONCAT(name) AS names FROM schema_migrations " +
          "GROUP BY version HAVING n > 1",
      )
      .all() as { version: number; n: number; names: string }[];
    const legacy = shared.filter((d) => String(d.version).length < 14);
    expect(legacy, `shared numbers: ${legacy.map((d) => `${d.version} -> ${d.names}`).join(" | ")}`).toEqual([]);
  });
});

describe("the sweep is surgical, not a broom", () => {
  const CURE = readdirSync(join(REPO_ROOT, "server", "db", "migrations")).find((f) =>
    f.endsWith("-registro-senza-righe-fantasma.sql"),
  )!;
  const sql = () =>
    Bun.file(join(REPO_ROOT, "server", "db", "migrations", CURE)).text();

  test("the stem stays when the real migration is NOT recorded", async () => {
    // The guarantee that matters: if `101-push-device-prefs.sql` were not
    // recorded under its own name, that stem is the only trace the migration
    // ran, and deleting it would make it RUN AGAIN on a database that already
    // took it.
    const db = new Database(":memory:");
    db.run("CREATE TABLE schema_migrations (version INTEGER NOT NULL, name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    db.run("INSERT INTO schema_migrations VALUES (100, 'push-device-prefs', 'x')");
    db.exec(await sql());
    const left = db.query("SELECT name FROM schema_migrations").all() as { name: string }[];
    expect(left.map((r) => r.name)).toEqual(["push-device-prefs"]);
    db.close();
  });

  test("the stem goes when its migration is recorded under the file name, and nothing else moves", async () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE schema_migrations (version INTEGER NOT NULL, name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    db.run("INSERT INTO schema_migrations VALUES (100, 'push-device-prefs', 'x')");
    db.run("INSERT INTO schema_migrations VALUES (101, '101-push-device-prefs.sql', 'x')");
    db.run("INSERT INTO schema_migrations VALUES (100, '100-task-labels.sql', 'x')");
    const cure = await sql();
    db.exec(cure);
    expect((db.query("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name))
      .toEqual(["100-task-labels.sql", "101-push-device-prefs.sql"]);
    // Idempotent: run twice it deletes nothing more (the runner does not
    // replay it, but a database restored from a half-way backup does).
    db.exec(cure);
    expect((db.query("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(2);
    db.close();
  });
});
