/**
 * The embedded migrations branch of `server/db.ts`, in a process where nothing
 * imported the manifest before: what the compiled sidecar does, on every Bun.
 *
 * `resolveMigrations` loads `./db/migrations-embedded` with a lazy `require`
 * (cloud-quality-pass T3: the manifest stays out of the boot graph when the
 * folder exists). The manifest used to import every `.sql` with
 * `with { type: "text" }`, and through `require` Bun 1.3.8 (the production
 * server's runtime) ignores that attribute and hands back the FILE PATH of each
 * migration instead of its text: the schema did not build
 * (`near "/": syntax error`), and the paths stayed in the module cache for any
 * later static import in the same process (13 order-dependent reds in the unit
 * suite on 1.3.8, verification V3, defect D1). The manifest now carries the SQL
 * as string literals (scripts/gen-migrations-manifest.ts).
 *
 * Here the branch runs in a fresh process, as the server would. Red on Bun
 * 1.3.8 with the text-import manifest, green on 1.3.8 and on the latest Bun
 * with the literal one. Run it with both:
 *   /tmp/bun138/node_modules/.bin/bun test server/db/embedded-fallback-fresh-process.test.ts
 *
 * @covers SCHEMA-01
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("without the migrations folder, in a fresh process, the schema is built from the manifest's SQL", () => {
  const root = mkdtempSync(join(tmpdir(), "embedded-fresh-"));
  try {
    const script = `
      const { initDatabase, closeDatabase } = await import(${JSON.stringify(join(import.meta.dir, "..", "db.ts"))});
      let applied = -1, error = null;
      try {
        const db = initDatabase(${JSON.stringify(join(root, "bundle"))}, ${JSON.stringify(root)});
        applied = db.query("SELECT COUNT(*) AS n FROM schema_migrations").get().n;
        closeDatabase();
      } catch (e) { error = String(e && e.message || e).slice(0, 200); }
      // The order case of the unit suite: a static import of the manifest AFTER
      // the require, in the same process, reads the module cache the require filled.
      const { EMBEDDED_MIGRATIONS } = await import(${JSON.stringify(join(import.meta.dir, "migrations-embedded.ts"))});
      const notSql = EMBEDDED_MIGRATIONS.filter((m) => typeof m.sql !== "string" || m.sql.trim().endsWith(".sql")).length;
      console.log(JSON.stringify({ applied, error, notSql }));
    `;
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.DATA_DIR;
    const out = Bun.spawnSync([process.execPath, "-e", script], { cwd: import.meta.dir, env: env as Record<string, string> });
    const last = out.stdout.toString().trim().split("\n").at(-1) ?? "";
    console.log(`[embedded-fresh] bun ${Bun.version}: ${last}`);
    const res = JSON.parse(last || "{}") as { applied?: number; error?: string | null; notSql?: number };
    expect(res.error ?? null, "a migration failed: the manifest gave something other than SQL").toBeNull();
    expect(res.applied ?? 0).toBeGreaterThan(100);
    expect(res.notSql ?? -1, "a later import of the manifest got file paths from the module cache").toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
