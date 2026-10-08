/**
 * V3 · B1 (cloud-quality-pass, verification): the embedded migrations branch of
 * `server/db.ts`, in a process where nothing imported the manifest before.
 *
 * T3 turned the static import of `./db/migrations-embedded` into a lazy
 * `require` (`resolveMigrations`). The manifest imports every `.sql` with
 * `with { type: "text" }`. Through `require`, Bun 1.3.8 (the server's production
 * runtime) ignores that attribute and hands back the FILE PATH of each
 * migration instead of its text: measured, `EMBEDDED_MIGRATIONS[0].sql` is
 * "/…/server/db/migrations/001-initial.sql" on 1.3.8 and the SQL on 1.4.2.
 * `migrations-embedded.test.ts` does not see it alone, because its own static
 * import fills the module cache with the right text before `initDatabase`
 * requires it; in a unit shard where another file reached the `require` first,
 * it and `db-nasce-da-zero.test.ts` go red (head, Bun 1.3.8, 4 shards).
 *
 * Here the branch runs in a fresh process, as the server would: RED on Bun
 * 1.3.8, green on 1.4.2. Production today does not reach it (the source server
 * has the folder, the sidecar is compiled, and a `bun build --compile` made with
 * 1.3.8 embeds the text correctly: smoke verified). V3 does not fix.
 *
 * @covers SCHEMA-01
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("without the migrations folder, in a fresh process, the schema is built from the manifest's SQL", () => {
  const root = mkdtempSync(join(tmpdir(), "v3-embedded-fresh-"));
  try {
    const script = `
      const { initDatabase, closeDatabase } = await import(${JSON.stringify(join(import.meta.dir, "..", "db.ts"))});
      let applied = -1, error = null;
      try {
        const db = initDatabase(${JSON.stringify(join(root, "bundle"))}, ${JSON.stringify(root)});
        applied = db.query("SELECT COUNT(*) AS n FROM schema_migrations").get().n;
        closeDatabase();
      } catch (e) { error = String(e && e.message || e).slice(0, 200); }
      console.log(JSON.stringify({ applied, error }));
    `;
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.DATA_DIR;
    const out = Bun.spawnSync([process.execPath, "-e", script], { cwd: import.meta.dir, env: env as Record<string, string> });
    const last = out.stdout.toString().trim().split("\n").at(-1) ?? "";
    console.log(`[v3-embedded-fresh] bun ${Bun.version}: ${last}`);
    const res = JSON.parse(last || "{}") as { applied?: number; error?: string | null };
    expect(res.error ?? null, "a migration failed: the manifest gave something other than SQL").toBeNull();
    expect(res.applied ?? 0).toBeGreaterThan(100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
