#!/usr/bin/env bun
/**
 * scripts/check-bloat.ts - two numbers for "how much of this codebase resists
 * being worked on by two people at once": FILE SIZE and DUPLICATED BLOCKS.
 *
 * WHY THIS EXISTS, measured. `check:deadcode` (knip) already covers code that
 * nobody calls, and it is green. Nothing covered the opposite failure: code
 * that everybody calls, all of it inside the same file. On the night of
 * 13-14/08/2026 `client/src/components/Board/TaskDetail.tsx` (3.2k lines) and
 * `client/src/components/Board/KanbanBoardPane.tsx` (2.0k lines) produced THREE
 * semantic conflicts across three different merges in one night: two branches
 * renaming the same prop, two rewriting the same state machine, two adding the
 * same function under different names. Git merged all three cleanly. The
 * conflict was in the meaning, and a human found it afterwards.
 *
 * A file over a couple of thousand lines is not ugly. It is a file two people
 * cannot work on at the same time, and this repo runs a dozen agents at once.
 *
 * TWO MEASURES, because they fail differently:
 *
 *   size       lines per tracked source file. A file nobody can split is a
 *              lock: every branch that touches the feature touches that file.
 *   duplication  blocks of >= N identical normalised lines appearing in two or
 *              more places. This is the OTHER way the same edit lands twice:
 *              two branches fix the same logic in their own copy, both merge,
 *              and only one copy is fixed.
 *
 * RATCHET, not an absolute bar. Today's tree already has files well past any
 * sane threshold, so an absolute gate would be red on arrival and switched off
 * within a week. The baseline (`scripts/bloat-baseline.json`) freezes today's
 * offenders; the gate fails when a NEW file crosses the threshold, when a
 * baselined file GROWS past its recorded size, or when total duplication rises.
 * Shrinking never fails: it prints a line asking for `--update-baseline`.
 *
 * EXIT CODES
 *   0  within the baseline (or, in absolute mode, within the given thresholds)
 *   1  over: a new offender, a file that grew, or duplication that rose
 *   2  the measurement could not be taken (no git, unreadable baseline)
 *
 * USAGE
 *   bun run check:bloat                        ratchet against the baseline
 *   bun run check:bloat --json                 same, machine readable
 *   bun run check:bloat --update-baseline      rewrite the baseline from today
 *   bun run check:bloat --max-lines=800        ABSOLUTE mode (see below)
 *   bun run check:bloat --min-clone-lines=20   ABSOLUTE mode
 *   bun run check:bloat --top=30               how many rows to print
 *   bun run check:bloat --root=<dir>           measure another checkout
 *   bun run check:bloat --baseline=<file>      compare against another baseline
 *
 * ABSOLUTE MODE. Passing `--max-lines` or `--min-clone-lines` on the command
 * line means "answer the question I am asking, not the one the baseline froze":
 * the baseline is ignored and the gate fails if anything at all exceeds the
 * thresholds given. That is also how the exit code is proven in both
 * directions without editing a file:
 *
 *   bun run scripts/check-bloat.ts --max-lines=200      -> 1
 *   bun run scripts/check-bloat.ts --max-lines=999999   -> 0
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_ROOT = resolve(import.meta.dir, "..");

/** Source we own. `.rs` is in because the Tauri shell is one 12k-line file. */
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".rs"];

/**
 * A baselined file may always grow by this much regardless of the percentage.
 * Five percent of an 810-line file is 40 lines, and refusing 40 lines turns the
 * gate into a toll booth that everyone learns to pay with `--update-baseline`.
 */
const GROWTH_FLOOR = 120;

/**
 * Paths that are tracked but are not code a person maintains by hand. A
 * generated manifest is long by construction, and nobody merges into it: the
 * generator is the thing to review.
 */
const EXCLUDED = [
  "server/db/migrations-embedded.ts", // written by scripts/gen-migrations-manifest.ts
  "client/src/lib/generated-shortcuts.ts", // written by scripts/gen-shortcuts.ts
];

/**
 * Roots kept out of the DUPLICATION measure only, never out of the size one.
 *
 * Tests repeat on purpose. A spec that spells out its own arrange block reads
 * as one story per file, and factoring that into a shared helper is how a suite
 * becomes impossible to read at 3am. Counting those repeats would bury the real
 * clones (in `server/` and `client/src`) under hundreds of rows nobody reads.
 * Size still counts them: a 2.9k-line spec is a merge magnet like any other.
 */
const NO_CLONE_SCAN = /(?:^|\/)tests\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

interface Options {
  root: string;
  baselinePath: string;
  maxLines: number;
  minCloneLines: number;
  absolute: boolean;
  json: boolean;
  updateBaseline: boolean;
  top: number;
}

interface Baseline {
  $schema: string;
  _comment: string[];
  updated: string;
  tolerance_pct: number;
  max_lines: number;
  min_clone_lines: number;
  /** path -> line count, for every file over `max_lines` on the day recorded. */
  files: Record<string, number>;
  duplicated_lines: number;
  clone_groups: number;
}

interface CloneGroup {
  /** Normalised-line length of the block. */
  lines: number;
  /** One entry per occurrence: file plus the ORIGINAL first/last line numbers. */
  sites: { file: string; from: number; to: number }[];
}

// ---------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------

/**
 * Files git knows about: tracked, PLUS untracked ones that are not ignored.
 * Walking the filesystem instead would have to re-implement `.gitignore`, and
 * the first thing it would swallow is `node_modules` (200k files) and
 * `public/assets` (a minified bundle, which is one enormous "duplicated block"
 * against itself).
 *
 * `--others --exclude-standard` is the half that was missing, and its absence
 * cost a red build on 2026-08-15. A new 906-line file
 * (`client/src/lib/i18n-en.ts`) was created, this gate was run locally and said
 * OK, the commit landed, and CI went red on the same file the same minute. The
 * gate had been blind to it for exactly as long as it was untracked, which is
 * precisely the window in which somebody is deciding whether to commit it. A
 * gate that only sees a file after it lands cannot stop it from landing.
 */
function trackedSources(root: string): string[] {
  const res = spawnSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    console.error(`[check-bloat] cannot list tracked files under ${root}: git exited ${res.status}`);
    process.exit(2);
  }
  return res.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((p) => EXTENSIONS.some((e) => p.endsWith(e)))
    .filter((p) => !EXCLUDED.includes(p))
    .sort();
}

// ---------------------------------------------------------------------------
// Normalising, so that "the same code" survives reformatting
// ---------------------------------------------------------------------------

/**
 * One entry per line that carries meaning: the normalised text plus the line
 * number it came from, so a clone can be reported at a place you can open.
 *
 * Comments go out because a copied block is usually copied WITH its comment,
 * and because a licence header repeated in forty files is not a clone worth
 * anyone's time. Whitespace collapses because a re-indent is not a rewrite.
 */
function normalise(src: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const lines = src.split(/\r?\n/);
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    let text = "";
    let quote: string | null = null;

    for (let j = 0; j < raw.length; j++) {
      const c = raw[j]!;
      if (inBlockComment) {
        if (c === "*" && raw[j + 1] === "/") {
          inBlockComment = false;
          j++;
        }
        continue;
      }
      if (quote) {
        text += c;
        if (c === "\\") {
          const next = raw[j + 1];
          if (next !== undefined) {
            text += next;
            j++;
          }
          continue;
        }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        text += c;
        continue;
      }
      if (c === "/" && raw[j + 1] === "/") break; // line comment: drop the rest
      if (c === "/" && raw[j + 1] === "*") {
        inBlockComment = true;
        j++;
        continue;
      }
      text += c;
    }

    const collapsed = text.replace(/\s+/g, " ").trim();
    if (collapsed.length === 0) continue;
    out.push({ text: collapsed, line: i + 1 });
  }
  return out;
}

/** `});` and `}` are punctuation, not code. A window made of those is not a clone. */
function substantial(text: string): boolean {
  return text.replace(/[^A-Za-z0-9_]/g, "").length >= 4;
}

// ---------------------------------------------------------------------------
// Clone detection
// ---------------------------------------------------------------------------

interface Slot {
  file: string;
  id: number;
  line: number;
  substantial: boolean;
}

/**
 * Blocks of `k` or more normalised lines that appear in two or more places.
 *
 * The method is the standard one and deliberately line-based, not token-based:
 * every distinct normalised line gets an integer id, a rolling hash over `k`
 * consecutive ids finds candidate windows, candidates are confirmed by
 * comparing the ids themselves (a hash bucket is a suspicion, not a match), and
 * confirmed windows are extended as far as they agree so the report says "62
 * lines" rather than forty overlapping windows of 40.
 *
 * A token-based detector would additionally catch clones that renamed their
 * variables. That is a real class, and it is not the one that produced the
 * three conflicts this gate was written for: those were copies, not
 * paraphrases. Line-based is what can be trusted with zero dependencies.
 */
function findClones(files: { file: string; lines: { text: string; line: number }[] }[], k: number): CloneGroup[] {
  const ids = new Map<string, number>();
  const slots: Slot[] = [];
  const fileStart = new Map<string, number>();

  for (const f of files) {
    fileStart.set(f.file, slots.length);
    for (const l of f.lines) {
      let id = ids.get(l.text);
      if (id === undefined) {
        id = ids.size;
        ids.set(l.text, id);
      }
      slots.push({ file: f.file, id, line: l.line, substantial: substantial(l.text) });
    }
  }

  // Rolling polynomial hash over the id stream. BASE and MOD are ordinary
  // large primes; collisions are expected and resolved by the exact compare
  // below, so their only cost is a few wasted comparisons.
  const BASE = 1_000_003n;
  const MOD = (1n << 61n) - 1n;
  const n = slots.length;
  const buckets = new Map<bigint, number[]>();

  if (n >= k) {
    let power = 1n;
    for (let i = 1; i < k; i++) power = (power * BASE) % MOD;

    let hash = 0n;
    for (let i = 0; i < k; i++) hash = (hash * BASE + BigInt(slots[i]!.id + 1)) % MOD;

    for (let start = 0; start + k <= n; start++) {
      if (start > 0) {
        hash = (hash + MOD - ((power * BigInt(slots[start - 1]!.id + 1)) % MOD)) % MOD;
        hash = (hash * BASE + BigInt(slots[start + k - 1]!.id + 1)) % MOD;
      }
      if (!windowIsInteresting(slots, start, k)) continue;
      const bucket = buckets.get(hash);
      if (bucket) bucket.push(start);
      else buckets.set(hash, [start]);
    }
  }

  // Positions already reported, so an extended clone is not re-reported by
  // every window inside it.
  const covered = new Uint8Array(n);
  const groups: CloneGroup[] = [];

  const starts = [...buckets.values()].filter((b) => b.length >= 2).flat();
  starts.sort((a, b) => a - b);

  for (const start of starts) {
    if (covered[start]) continue;
    const bucket = buckets.get(hashOf(slots, start, k))!;
    const peers = bucket.filter((p) => p !== start && p > start && sameWindow(slots, start, p, k));
    if (peers.length === 0) continue;

    // Keep occurrences that neither overlap the anchor nor each other.
    const members = [start];
    for (const p of peers) {
      if (p - members[members.length - 1]! < k) continue;
      if (covered[p]) continue;
      members.push(p);
    }
    if (members.length < 2) continue;

    // Two occurrences of the same block may sit close together in one file.
    // Extending past the gap between them would report a block overlapping
    // itself, so the gap is the hard ceiling on how far this can grow.
    let minGap = Number.POSITIVE_INFINITY;
    for (let i = 1; i < members.length; i++) minGap = Math.min(minGap, members[i]! - members[i - 1]!);

    // Extend while every member still agrees and stays inside its own file.
    let len = k;
    while (len < minGap) {
      const firstNext = members[0]! + len;
      if (firstNext >= n) break;
      const wantedId = slots[firstNext]!.id;
      let ok = true;
      for (let i = 0; i < members.length; i++) {
        const idx = members[i]! + len;
        if (idx >= n || slots[idx]!.file !== slots[members[i]!]!.file || slots[idx]!.id !== wantedId) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      len++;
    }

    for (const m of members) for (let i = 0; i < len; i++) covered[m + i] = 1;

    groups.push({
      lines: len,
      sites: members.map((m) => ({
        file: slots[m]!.file,
        from: slots[m]!.line,
        to: slots[m + len - 1]!.line,
      })),
    });
  }

  groups.sort((a, b) => b.lines * b.sites.length - a.lines * a.sites.length);
  return groups;
}

function hashOf(slots: Slot[], start: number, k: number): bigint {
  const BASE = 1_000_003n;
  const MOD = (1n << 61n) - 1n;
  let hash = 0n;
  for (let i = 0; i < k; i++) hash = (hash * BASE + BigInt(slots[start + i]!.id + 1)) % MOD;
  return hash;
}

/** A hash bucket is a suspicion. This is the confirmation. */
function sameWindow(slots: Slot[], a: number, b: number, k: number): boolean {
  for (let i = 0; i < k; i++) {
    if (slots[a + i]!.id !== slots[b + i]!.id) return false;
  }
  return true;
}

/**
 * Filters out the windows whose repetition means nothing: runs of closing
 * braces, and blocks made of one line repeated. Without this the report is
 * dominated by `});` and by long literal tables.
 */
function windowIsInteresting(slots: Slot[], start: number, k: number): boolean {
  const file = slots[start]!.file;
  let subs = 0;
  const distinct = new Set<number>();
  for (let i = 0; i < k; i++) {
    const s = slots[start + i]!;
    if (s.file !== file) return false; // straddles two files
    if (s.substantial) subs++;
    distinct.add(s.id);
  }
  // Both numbers were tuned against this repo, not guessed. At 0.6/8 the filter
  // was also throwing away two REAL clones (a 20-line block repeated four times
  // in useChat.ts, and one inside check-emdash.ts) while removing no noise at
  // all: 0.5/6 reports 15 groups instead of 13, and all 15 were read.
  return subs >= Math.ceil(k * 0.5) && distinct.size >= 6;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Arguments first, baseline second, defaults last: the baseline holds the
 * thresholds, so it cannot be read until `--root`/`--baseline` are known.
 */
function parseOptions(argv: string[]): { opts: Options; baseline: Baseline | null } {
  let root = DEFAULT_ROOT;
  let baselineArg: string | null = null;
  let maxLines: number | null = null;
  let minCloneLines: number | null = null;
  let json = false;
  let updateBaseline = false;
  let top = 20;

  for (const arg of argv) {
    const num = (v: string): number => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1) {
        console.error(`[check-bloat] not a positive number: ${arg}`);
        process.exit(2);
      }
      return Math.trunc(n);
    };
    if (arg.startsWith("--root=")) {
      root = resolve(arg.slice("--root=".length));
    } else if (arg.startsWith("--baseline=")) {
      baselineArg = resolve(arg.slice("--baseline=".length));
    } else if (arg.startsWith("--max-lines=")) {
      maxLines = num(arg.slice("--max-lines=".length));
    } else if (arg.startsWith("--min-clone-lines=")) {
      minCloneLines = num(arg.slice("--min-clone-lines=".length));
    } else if (arg.startsWith("--top=")) {
      top = num(arg.slice("--top=".length));
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--update-baseline") {
      updateBaseline = true;
    } else {
      console.error(`[check-bloat] unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  const baselinePath = baselineArg ?? join(root, "scripts/bloat-baseline.json");
  const baseline = loadBaseline(baselinePath);
  return {
    opts: {
      root,
      baselinePath,
      maxLines: maxLines ?? baseline?.max_lines ?? 800,
      minCloneLines: minCloneLines ?? baseline?.min_clone_lines ?? 20,
      // A threshold given on the command line means "answer THIS question", so
      // the frozen inventory no longer applies and the bar becomes absolute.
      absolute: maxLines !== null || minCloneLines !== null,
      json,
      updateBaseline,
      top,
    },
    baseline,
  };
}

function loadBaseline(path: string): Baseline | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Baseline;
  } catch (err) {
    console.error(`[check-bloat] baseline unreadable at ${path} (${String(err)})`);
    process.exit(2);
  }
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, " ");
}

function main(): void {
  const { opts, baseline } = parseOptions(process.argv.slice(2));

  const paths = trackedSources(opts.root);
  if (paths.length === 0) {
    console.error(
      `[check-bloat] no tracked source file under ${opts.root} matched ${EXTENSIONS.join(" ")}. ` +
        `Wrong repo, or the extension list drifted.`,
    );
    process.exit(2);
  }

  const sizes: { file: string; lines: number }[] = [];
  const forClones: { file: string; lines: { text: string; line: number }[] }[] = [];

  for (const p of paths) {
    let src: string;
    try {
      src = readFileSync(join(opts.root, p), "utf8");
    } catch {
      continue; // deleted between `git ls-files` and now
    }
    // A file ending in a newline has one fewer line than it has separators.
    const count = src.length === 0 ? 0 : src.split("\n").length - (src.endsWith("\n") ? 1 : 0);
    sizes.push({ file: p, lines: count });
    if (!NO_CLONE_SCAN.test(p)) forClones.push({ file: p, lines: normalise(src) });
  }

  sizes.sort((a, b) => b.lines - a.lines);
  const over = sizes.filter((s) => s.lines > opts.maxLines);
  const clones = findClones(forClones, opts.minCloneLines);
  const duplicatedLines = clones.reduce((sum, g) => sum + g.lines * (g.sites.length - 1), 0);
  const totalLines = sizes.reduce((sum, s) => sum + s.lines, 0);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          measured_at: new Date().toISOString().slice(0, 10),
          mode: opts.absolute ? "absolute" : baseline ? "ratchet" : "absolute",
          max_lines: opts.maxLines,
          min_clone_lines: opts.minCloneLines,
          files_scanned: sizes.length,
          total_lines: totalLines,
          over_threshold: over,
          duplicated_lines: duplicatedLines,
          clone_groups: clones.length,
          clones: clones.slice(0, opts.top),
        },
        null,
        2,
      ),
    );
  } else {
    const overLines = over.reduce((sum, f) => sum + f.lines, 0);
    const pctFiles = ((100 * over.length) / sizes.length).toFixed(1);
    const pctLines = ((100 * overLines) / Math.max(1, totalLines)).toFixed(1);
    console.log(`[check-bloat] ${sizes.length} tracked source files, ${totalLines.toLocaleString("en-US")} lines.`);
    console.log("");
    console.log(
      `SIZE  files over ${opts.maxLines} lines: ${over.length} ` +
        `(${pctFiles}% of the files, holding ${pctLines}% of the lines)`,
    );
    for (const f of over.slice(0, opts.top)) {
      const was = baseline?.files[f.file];
      const note = was === undefined ? "  NEW" : f.lines > was ? `  (baseline ${was}, +${f.lines - was})` : "";
      console.log(`  ${pad(f.lines, 6)}  ${f.file}${note}`);
    }
    if (over.length > opts.top) console.log(`  ... and ${over.length - opts.top} more (--top=${over.length})`);
    console.log("");
    console.log(
      `DUPLICATION  blocks of >= ${opts.minCloneLines} normalised lines: ` +
        `${clones.length} groups, ${duplicatedLines} redundant lines`,
    );
    for (const g of clones.slice(0, opts.top)) {
      console.log(`  ${pad(g.lines, 5)} lines x${g.sites.length}`);
      for (const s of g.sites) console.log(`          ${s.file}:${s.from}-${s.to}`);
    }
    if (clones.length > opts.top) console.log(`  ... and ${clones.length - opts.top} more (--top=${clones.length})`);
    console.log("");
  }

  if (opts.updateBaseline) {
    const next: Baseline = {
      $schema: "bloat-baseline-v1",
      _comment: baseline?._comment ?? [],
      updated: new Date().toISOString().slice(0, 10),
      tolerance_pct: baseline?.tolerance_pct ?? 2,
      max_lines: opts.maxLines,
      min_clone_lines: opts.minCloneLines,
      files: Object.fromEntries(over.map((f) => [f.file, f.lines])),
      duplicated_lines: duplicatedLines,
      clone_groups: clones.length,
    };
    writeFileSync(opts.baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`[check-bloat] baseline rewritten: ${opts.baselinePath}`);
    process.exit(0);
  }

  // ---- verdict --------------------------------------------------------
  if (opts.absolute || !baseline) {
    const failures: string[] = [];
    if (over.length > 0) failures.push(`${over.length} file(s) over ${opts.maxLines} lines`);
    if (clones.length > 0) failures.push(`${clones.length} duplicated block(s) of >= ${opts.minCloneLines} lines`);
    if (failures.length === 0) {
      console.log(`[check-bloat] OK (absolute) - nothing over ${opts.maxLines} lines, no clone >= ${opts.minCloneLines}.`);
      process.exit(0);
    }
    console.error(`[check-bloat] FAIL (absolute) - ${failures.join("; ")}.`);
    process.exit(1);
  }

  const tol = 1 + baseline.tolerance_pct / 100;
  const problems: string[] = [];

  for (const f of over) {
    const was = baseline.files[f.file];
    if (was === undefined) {
      problems.push(
        `NEW offender  ${f.file} is ${f.lines} lines (threshold ${opts.maxLines}).\n` +
          `    Split it, or record it with \`bun run check:bloat --update-baseline\` in the same\n` +
          `    commit that made it big, so the diff shows what the size bought.`,
      );
      continue;
    }
    // The floor matters more than the percentage on the small end: 5% of an
    // 810-line file is 40 lines, which is one honest bug fix. The gate is not
    // trying to stop a commit, it is trying to stop a file from doubling.
    const ceiling = Math.max(was + GROWTH_FLOOR, Math.floor(was * tol));
    if (f.lines > ceiling) {
      problems.push(
        `GREW  ${f.file}: ${was} -> ${f.lines} lines (+${f.lines - was}, ceiling ${ceiling}).\n` +
          `    Take something out of it, or record the new size with \`--update-baseline\` in the\n` +
          `    same commit, so the diff shows what those lines bought.`,
      );
    }
  }

  const dupCeiling = Math.floor(baseline.duplicated_lines * tol);
  if (duplicatedLines > dupCeiling) {
    problems.push(
      `DUPLICATION rose: ${baseline.duplicated_lines} -> ${duplicatedLines} redundant lines (ceiling ${dupCeiling}).`,
    );
  }

  // Improvements never fail. They do get said out loud, or the baseline rots.
  for (const [file, was] of Object.entries(baseline.files)) {
    const now = sizes.find((s) => s.file === file);
    if (!now) {
      console.log(`[check-bloat] baseline entry gone (renamed or deleted): ${file} (was ${was})`);
    } else if (now.lines <= opts.maxLines) {
      console.log(`[check-bloat] cured: ${file} is down to ${now.lines}. Run --update-baseline to lock it in.`);
    }
  }
  if (duplicatedLines < Math.floor(baseline.duplicated_lines * 0.95)) {
    console.log(
      `[check-bloat] duplication is down (${baseline.duplicated_lines} -> ${duplicatedLines}). ` +
        `Run --update-baseline to lock it in.`,
    );
  }

  if (problems.length === 0) {
    console.log(
      `[check-bloat] OK - ${over.length} file(s) over ${opts.maxLines} lines and ${duplicatedLines} ` +
        `duplicated lines, all within the baseline of ${baseline.updated}.`,
    );
    process.exit(0);
  }

  console.error(`[check-bloat] FAIL - ${problems.length} regression(s) against the baseline of ${baseline.updated}:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

main();
