#!/usr/bin/env bun
/**
 * Moves the paths a Topics database saved under one folder to where that folder
 * went: `--map OLD=NEW`, as many as needed, the most specific applied first
 * whatever order they come in. Written for the move of the app data and the
 * agents' homes into the Topics home (change `agents-in-topics-home`), and the
 * way any machine that still keeps its data under an older root migrates.
 *
 * What it rewrites:
 *   - every text column (paths in chats, cards, tabs, settings), in the plain,
 *     `~/`, `$HOME/` and URL-encoded spellings of each folder. Key columns
 *     (`id`, `*_id`, `slug`) identify rows and are left alone, save
 *     `retirements.ref_id`, which is a pane id made of a path;
 *   - the board ids (`project_id`). A board's id is a hash of its folder's
 *     path, so a moved folder is a new board and its cards would be orphaned:
 *     every path the DB holds under an OLD folder gives a pair old id -> new id.
 *     `--alias FORM=OLD` names a former spelling of OLD (a link that was
 *     resolved since): its text is rewritten too and the boards keyed on it
 *     are rekeyed, which no earlier rewrite did;
 *   - one `board_aliases` row per rekeyed board (old id -> new id, old path),
 *     the record `resolveBoardAlias` reads: a link, a script or a message that
 *     still names the old id lands on the moved board instead of an empty one.
 *     The `old_path` of the rows already there is history and stays as is.
 *
 * Safe on a live database: a consistent backup first (SQLite online backup),
 * then short transactions of BATCH rows. A row whose new value would collide
 * with a UNIQUE value already there is left as it is and counted. Nobody's
 * path is written here: everything comes from the arguments.
 *
 *   bun scripts/rewrite-root-paths.ts --map /x/old=/x/new --dry-run    # counts only
 *   bun scripts/rewrite-root-paths.ts --map /x/old=/x/new --db copy.db # on a copy
 *   bun scripts/rewrite-root-paths.ts --map /x/old=/x/new              # live, after a backup
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { projectIdForPath } from "../shared/board";

const BATCH = 500;
/** Text columns that are keys AND paths: a closed pane is retired by its id, `project:<encoded path>`. */
const PATH_KEYS = new Set(["retirements.ref_id"]);
/** Columns that record where something WAS: rewriting them would erase the record. */
const HISTORY = new Set(["board_aliases.old_path"]);
/** Where the DB keeps folders a board can be keyed on. */
const FOLDER_COLUMNS: Array<[string, string]> = [["projects", "path"], ["topics", "project_path"], ["worktrees", "abs_path"], ["subagents", "cwd"]];

export interface Move { from: string; to: string }

/** `A=B` pairs of absolute paths, most specific first; throws on anything else. */
export function parseMoves(args: string[], flag: string): Move[] {
  const out: Move[] = [];
  args.forEach((a, i) => {
    if (a !== flag) return;
    const v = args[i + 1] ?? "";
    const eq = v.indexOf("=");
    const from = v.slice(0, eq).replace(/\/+$/, "");
    const to = v.slice(eq + 1).replace(/\/+$/, "");
    if (eq < 1 || !isAbsolute(from) || !isAbsolute(to) || from === to) throw new Error(`${flag} wants OLD=NEW, two different absolute paths: ${v}`);
    out.push({ from, to });
  });
  return out.sort((a, b) => b.from.length - a.from.length);
}

/** Where a path goes, or null when no move covers it. */
export function remap(path: string, moves: Move[]): string | null {
  for (const m of moves) if (path === m.from || path.startsWith(`${m.from}/`)) return m.to + path.slice(m.from.length);
  return null;
}

/** The moves plus the same moves under each former spelling of their folder. */
export function withAliases(moves: Move[], aliases: Move[]): Move[] {
  const extra: Move[] = [];
  for (const a of aliases) for (const m of moves) {
    if (m.from === a.to || m.from.startsWith(`${a.to}/`)) extra.push({ from: a.from + m.from.slice(a.to.length), to: m.to });
  }
  return [...moves, ...extra].sort((a, b) => b.from.length - a.from.length);
}

/** Each moved folder as text can spell it (plain, URL-encoded, `~/`, `$HOME/`, `${HOME}/`) -> the same spelling of where it went. */
export interface Spellings { find: RegExp; to: Map<string, string>; any: string[] }

export function spellings(moves: Move[], home: string): Spellings {
  const to = new Map<string, string>();
  for (const m of moves) {
    to.set(m.from, m.to);
    to.set(encodeURIComponent(m.from), encodeURIComponent(m.to));
    const rf = relative(home, m.from);
    const rt = relative(home, m.to);
    if (!rf.startsWith("..") && !rt.startsWith("..")) for (const pre of ["~/", "$HOME/", "${HOME}/"]) to.set(pre + rf, pre + rt);
  }
  // Longest first: at the same position the most specific folder wins. The folder ends where the name
  // stops: not before a letter, digit, `_` or `-` (`.agent-home2`, `.agent-home-old`), nor before `.x`
  // (`.agent-home.json`); a `.`, `:` or backtick that closes a sentence or a code span does end it.
  const alts = [...to.keys()].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return { find: new RegExp(`(?:${alts.join("|")})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, "g"), to, any: [...to.keys()] };
}

/** A text value with every moved folder in it rewritten, in one pass: a new path is never rewritten again. */
export function rewriteText(v: string, s: Spellings): string {
  return v.replace(s.find, (m) => s.to.get(m)!);
}

/** Old board id -> new board id and the old folder, for every folder in `folders` a move covers (and its former spellings). */
export function movedBoardIds(folders: Iterable<string>, moves: Move[], aliases: Move[]): Map<string, { to: string; path: string }> {
  const out = new Map<string, { to: string; path: string }>();
  const add = (oldPath: string, newPath: string) => {
    const a = projectIdForPath(oldPath);
    const b = projectIdForPath(newPath);
    if (a !== b) out.set(a, { to: b, path: oldPath });
  };
  for (const f of new Set([...folders, ...moves.map((m) => m.from)])) {
    const to = remap(f, moves);
    if (to === null) continue;
    add(f, to);
    for (const a of aliases) if (f === a.to || f.startsWith(`${a.to}/`)) add(a.from + f.slice(a.to.length), to);
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dbPath = resolve(args.includes("--db") ? args[args.indexOf("--db") + 1]! : join(import.meta.dir, "..", "data", "topics.db"));
  const home = process.env.HOME || homedir();
  const aliases = parseMoves(args, "--alias");
  const direct = parseMoves(args, "--map");
  if (!direct.length) {
    console.error("nothing to do: give at least one --map OLD=NEW");
    process.exit(2);
  }
  const moves = withAliases(direct, aliases);
  const sp = spellings(moves, home);

  const db = new Database(dbPath);
  db.run("PRAGMA busy_timeout = 10000");
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  const columns = (t: string) => db.query(`PRAGMA table_info("${t}")`).all() as { name: string; type: string; pk: number }[];

  // Board ids first, from the folders as they are BEFORE the text rewrite.
  const folders: string[] = [];
  for (const [t, c] of FOLDER_COLUMNS) {
    if (!tables.includes(t)) continue;
    for (const { v } of db.query(`SELECT DISTINCT "${c}" AS v FROM "${t}" WHERE "${c}" IS NOT NULL`).all() as { v: string }[]) folders.push(v);
  }
  const movedIds = movedBoardIds(folders, direct, aliases);

  if (!dryRun) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${dbPath}.before-root-paths-${stamp}`;
    db.run(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`backup: ${backup}`);
  }

  let total = 0;
  let left = 0;
  for (const t of tables) {
    if (!columns(t).some((c) => c.name === "project_id")) continue;
    for (const [from, { to }] of movedIds) {
      const n = (db.query(`SELECT count(*) AS n FROM "${t}" WHERE project_id = ?`).get(from) as { n: number }).n;
      if (!n) continue;
      const done = dryRun ? n : db.query(`UPDATE OR IGNORE "${t}" SET project_id = ? WHERE project_id = ?`).run(to, from).changes;
      total += done;
      left += n - done;
      console.log(`${t}.project_id: ${n} ${from} -> ${to}${dryRun || done === n ? "" : `, ${n - done} left (collision)`}`);
    }
  }

  if (tables.includes("board_aliases")) {
    // REPLACE: an older alias of the same id pointed at a board that is moving too.
    const put = db.prepare("INSERT OR REPLACE INTO board_aliases (old_id, new_id, old_path, created_at) VALUES (?, ?, ?, ?)");
    if (!dryRun) db.transaction(() => { for (const [from, { to, path }] of movedIds) put.run(from, to, path, Date.now()); })();
    console.log(`board_aliases: ${movedIds.size} ${dryRun ? "would be recorded" : "recorded"}`);
  }

  // What the scan looks for: every spelling bare, so a value that ENDS with the folder (a pane id
  // `project:<encoded folder>`, "ended in <folder>") is found too. rewriteText decides what changes.
  const anyOld = sp.any;
  for (const t of tables) {
    const cols = columns(t).filter((c) => (c.type === "" || /TEXT|CHAR|CLOB|JSON/i.test(c.type))
      && !HISTORY.has(`${t}.${c.name}`)
      && (PATH_KEYS.has(`${t}.${c.name}`) || (c.name !== "id" && !c.name.endsWith("_id") && c.name !== "slug")));
    for (const { name: col } of cols) {
      const where = `(${anyOld.map(() => `instr("${col}", ?) > 0`).join(" OR ")})`;
      let rows: { rid: number; v: string }[];
      try {
        rows = db.query(`SELECT rowid AS rid, "${col}" AS v FROM "${t}" WHERE ${where}`).all(...anyOld) as { rid: number; v: string }[];
      } catch { continue; } // WITHOUT ROWID or a virtual table: not ours to rewrite
      if (!rows.length) continue;
      let changed = 0;
      if (!dryRun) {
        const update = db.prepare(`UPDATE OR IGNORE "${t}" SET "${col}" = ? WHERE rowid = ?`);
        // A key made of a path (a retired pane) whose new value is already there: the same record
        // twice, the old one goes. Anywhere else a collision is left and counted.
        const merge = PATH_KEYS.has(`${t}.${col}`) ? db.prepare(`DELETE FROM "${t}" WHERE rowid = ?`) : null;
        for (let i = 0; i < rows.length; i += BATCH) {
          db.transaction(() => {
            for (const { rid, v } of rows.slice(i, i + BATCH)) {
              const next = rewriteText(v, sp);
              if (next === v) continue;
              const n = update.run(next, rid).changes;
              changed += n || (merge ? merge.run(rid).changes : 0);
            }
          })();
        }
        left += rows.length - changed;
      }
      total += dryRun ? rows.length : changed;
      console.log(`${t}.${col}: ${rows.length} rows${dryRun ? "" : `, ${changed} rewritten`}`);
    }
  }
  console.log(dryRun ? `would rewrite up to ${total} values` : `rewrote ${total} values, ${left} left (collision or no path form)`);
  db.close();
}
