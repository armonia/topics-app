#!/usr/bin/env bun
/**
 * Rewrites the paths a Topics database saved under the LEGACY app data root
 * (`~/<LEGACY_DATA_DIR_NAME>`) to the folder that root links to, when it is a
 * symbolic link. The files do not move: the old name and the new one are the
 * same folder, so every rewritten path still opens the same file. What changes
 * is that the obsolete name stops showing in chats, cards, tabs and settings.
 *
 * One-off and generic: home, legacy root and target are read at run time, no
 * person's path is written here. A machine whose legacy root is a real folder
 * (not a link) has nothing to rewrite and exits 0.
 *
 * Safe on a live database: a consistent backup first (SQLite online backup),
 * then short transactions of BATCH rows each, so the server is never locked out
 * for long. Key columns (`id`, `*_id`) and slugs are left alone: they identify
 * rows, they are not paths a person reads. A row whose new value would collide
 * with a UNIQUE value already there is skipped and counted.
 *
 *   bun scripts/rewrite-legacy-root-paths.ts --dry-run           # counts only
 *   bun scripts/rewrite-legacy-root-paths.ts --db /path/copy.db   # on a copy
 *   bun scripts/rewrite-legacy-root-paths.ts                      # live, after a backup
 */
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { LEGACY_DATA_DIR_NAME } from "../shared/legacy-data-dir";

const BATCH = 500;
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbPath = resolve(args[args.indexOf("--db") + 1] && args.includes("--db") ? args[args.indexOf("--db") + 1]! : join(import.meta.dir, "..", "data", "topics.db"));

const home = process.env.HOME || homedir();
const legacy = join(home, LEGACY_DATA_DIR_NAME);
if (!existsSync(legacy) || !lstatSync(legacy).isSymbolicLink()) {
  console.log(`nothing to rewrite: ${legacy} is not a link`);
  process.exit(0);
}
const target = realpathSync(legacy);
const relTarget = relative(home, target);
const underHome = !relTarget.startsWith("..");

/** [old, new] pairs, longest and most specific first. */
const pairs: Array<[string, string]> = [];
for (const end of ["/", '"', "'", " ", "\n", ")", "`", ","]) pairs.push([legacy + end, target + end]);
pairs.push([encodeURIComponent(legacy + "/"), encodeURIComponent(target + "/")]);
pairs.push([encodeURIComponent(legacy) + '"', encodeURIComponent(target) + '"']);
if (underHome) {
  pairs.push([`~/${LEGACY_DATA_DIR_NAME}/`, `~/${relTarget}/`]);
  pairs.push([`$HOME/${LEGACY_DATA_DIR_NAME}/`, `$HOME/${relTarget}/`]);
}

const db = new Database(dbPath);
db.run("PRAGMA busy_timeout = 10000");

if (!dryRun) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${dbPath}.before-legacy-root-${stamp}`;
  db.run(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  console.log(`backup: ${backup}`);
}

const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
const anyOld = pairs.map(([o]) => o);
let total = 0;
let skipped = 0;
for (const table of tables) {
  const cols = (db.query(`PRAGMA table_info("${table}")`).all() as { name: string; type: string }[])
    .filter((c) => (c.type === "" || /TEXT|CHAR|CLOB|JSON/i.test(c.type)) && c.name !== "id" && !c.name.endsWith("_id") && c.name !== "slug");
  for (const { name: col } of cols) {
    const where = `(${anyOld.map(() => `instr("${col}", ?) > 0`).join(" OR ")} OR "${col}" = ?)`;
    let rows: { rid: number; v: string }[];
    try {
      rows = db.query(`SELECT rowid AS rid, "${col}" AS v FROM "${table}" WHERE ${where}`).all(...anyOld, legacy) as { rid: number; v: string }[];
    } catch { continue; } // WITHOUT ROWID or a virtual table: not ours to rewrite
    if (!rows.length) continue;
    let changed = 0;
    if (!dryRun) {
      const update = db.prepare(`UPDATE OR IGNORE "${table}" SET "${col}" = ? WHERE rowid = ?`);
      for (let i = 0; i < rows.length; i += BATCH) {
        db.transaction(() => {
          for (const { rid, v } of rows.slice(i, i + BATCH)) {
            let next = v === legacy ? target : v;
            for (const [o, n] of pairs) next = next.split(o).join(n);
            if (next === v) continue;
            changed += update.run(next, rid).changes;
          }
        })();
      }
      skipped += rows.length - changed;
    }
    total += dryRun ? rows.length : changed;
    console.log(`${table}.${col}: ${rows.length} rows${dryRun ? "" : `, ${changed} rewritten`}`);
  }
}
console.log(dryRun ? `would rewrite up to ${total} values` : `rewrote ${total} values, ${skipped} left (collision or no path form)`);
db.close();
