#!/usr/bin/env bun
/**
 * Read-only disk report: what is safe to delete, and why.
 *
 * DELETES NOTHING. It prints a table and the exact commands, so the call stays
 * human. Written as a script rather than a one-off document because a table of
 * sizes and branch states is stale the day after it is pasted somewhere.
 *
 * The safety criterion is NOT "this looks old". It is the project's own
 * worktree GC (`server/services/worktree-gc.ts` + `server/services/
 * branch-status.ts`), restated in plain git:
 *
 *   merged      the branch tip is an ancestor of main, OR every unique source
 *               file it touched is already byte-identical on main
 *               ("content-landed" — branchStatusFromRepo case 2).
 *   dirt        files in the worktree whose CONTENT does not exist anywhere in
 *               the object store. This is stricter than `git status`: a file
 *               that shows as modified but whose exact bytes are already a blob
 *               somewhere is recoverable, so it is not a reason to keep 500 MB
 *               of node_modules alive.
 *
 * A worktree is safe to remove WHOLE only when it is merged AND has zero dirt.
 * Anything else keeps its sources; its node_modules are still fair game (they
 * are gitignored and `bun install` rebuilds them).
 *
 * Usage:  bun run scripts/disk-report.ts [--all]
 *         --all also walks sibling projects' worktrees under ~/.topics/worktrees
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const REPO = process.cwd();
const WT_ROOT = join(homedir(), ".topics", "worktrees");

function sh(args: string[], cwd = REPO): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function du(path: string): number {
  try {
    const out = execFileSync("du", ["-sk", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return parseInt(out.split(/\s+/)[0] ?? "0", 10) * 1024;
  } catch {
    return 0;
  }
}

function human(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** node_modules directories inside a worktree (gitignored, always rebuildable). */
function nodeModulesBytes(root: string): number {
  let total = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (!s.isDirectory()) continue;
      if (e === "node_modules") { total += du(p); continue; }
      if (e === ".git" || e.startsWith(".")) continue;
      walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return total;
}

/** Junk that never counts as work, mirroring WORKTREE_JUNK in
 *  server/services/task-automerge.ts — plus the rebuildable installs, which
 *  that list can omit because the GC only ever sees repos where they are
 *  gitignored. Without them a stray untracked `node_modules/` reads as "unique
 *  content" and pins 500 MB in place forever. */
const JUNK = [
  /^\.topics-daemon\//,
  /^graphify-out\//,
  /^\.claude-task-summary\.md$/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)target(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)dist(\/|$)/,
];

/** Files whose exact content is NOT already an object in this repo. The real
 *  question behind "is it safe to delete" — `git status` alone over-reports:
 *  a file that shows as modified but whose exact bytes are already a blob is
 *  recoverable, and is no reason to keep half a gigabyte alive. */
function unrecoverableDirt(wt: string): string[] {
  const status = sh(["status", "--porcelain"], wt);
  if (!status) return [];
  const out: string[] = [];
  for (const line of status.split("\n")) {
    const path = line.slice(3).trim().replace(/^"|"$/g, "");
    if (!path) continue;
    if (JUNK.some((rx) => rx.test(path))) continue;
    const full = join(wt, path);
    if (!existsSync(full)) continue;
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) { out.push(`${path} (dir)`); continue; }
    const hash = (() => {
      try {
        return execFileSync("git", ["hash-object", full], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch { return ""; }
    })();
    if (!hash) { out.push(path); continue; }
    const known = (() => {
      try {
        execFileSync("git", ["cat-file", "-e", hash], { cwd: wt, stdio: "ignore" });
        return true;
      } catch { return false; }
    })();
    if (!known) out.push(path);
  }
  return out;
}

interface Row {
  name: string;
  path: string;
  branch: string;
  total: number;
  nm: number;
  merged: boolean;
  dirt: string[];
  verdict: "rimuovi" | "solo node_modules" | "NON toccare";
}

function classify(path: string, branch: string): Row {
  const name = path.split("/").pop() ?? path;
  const total = du(path);
  const nm = nodeModulesBytes(path);
  // Ancestor of main is the cheap, unambiguous half of the GC's `merged`.
  const merged = branch ? sh(["merge-base", "--is-ancestor", branch, "main"], REPO) === "" &&
    (() => {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", branch, "main"], { cwd: REPO, stdio: "ignore" });
        return true;
      } catch { return false; }
    })() : false;
  const dirt = unrecoverableDirt(path);
  // `main` is trivially its own ancestor, so the merged test says yes and the
  // worktree looks disposable. It isn't: it is somebody's checkout of the
  // integration branch, and this script must never nominate it.
  const isDefaultBranch = branch === "main" || branch === "master";
  const verdict: Row["verdict"] = isDefaultBranch
    ? "NON toccare"
    : merged && dirt.length === 0
      ? "rimuovi"
      : nm > 0 ? "solo node_modules" : "NON toccare";
  return { name, path, branch, total, nm, merged, dirt, verdict };
}

const lines = sh(["worktree", "list", "--porcelain"]).split("\n\n");
const rows: Row[] = [];
for (const block of lines) {
  const path = /^worktree (.+)$/m.exec(block)?.[1];
  if (!path || path === REPO) continue;
  if (!existsSync(path)) continue;
  const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? "";
  rows.push(classify(path, branch));
}

rows.sort((a, b) => b.total - a.total);

console.log("\n=== Worktree di questo repo ===\n");
console.log("verdetto           totale     node_modules  branch                              worktree");
for (const r of rows) {
  console.log(
    `${r.verdict.padEnd(18)} ${human(r.total).padStart(8)}  ${human(r.nm).padStart(11)}  ${(r.branch || "(nessuno)").padEnd(35)} ${r.name}`,
  );
  if (r.verdict === "NON toccare" && (r.branch === "main" || r.branch === "master")) {
    console.log(`${" ".repeat(20)}↳ è il checkout del branch di integrazione`);
  }
  if (r.dirt.length > 0 && r.verdict === "NON toccare") {
    for (const d of r.dirt.slice(0, 6)) console.log(`${" ".repeat(20)}↳ contenuto unico: ${d}`);
    if (r.dirt.length > 6) console.log(`${" ".repeat(20)}↳ …e altri ${r.dirt.length - 6}`);
  }
}

const sum = (f: (r: Row) => number, p: (r: Row) => boolean) =>
  rows.filter(p).reduce((a, r) => a + f(r), 0);

const wholeSafe = sum((r) => r.total, (r) => r.verdict === "rimuovi");
const nmOnly = sum((r) => r.nm, (r) => r.verdict === "solo node_modules");

console.log(`\nrimuovibili interi : ${human(wholeSafe)}`);
console.log(`solo node_modules  : ${human(nmOnly)}`);
console.log(`totale liberabile  : ${human(wholeSafe + nmOnly)}`);

// ── Rigenerabili: ignorati da git, ricostruibili con un comando ────────────
console.log("\n=== Artefatti rigenerabili (ignorati da git) ===\n");
const REGEN: [string, string][] = [
  ["desktop-tauri/src-tauri/target", "cargo build (~10-25 min)"],
  ["desktop-tauri/webrtc-bridge/target", "cargo build (~3-8 min)"],
  ["desktop-tauri/pty-bridge/target", "cargo build (~1-2 min)"],
  ["spike/webrtc-cdp/bridge/target", "cargo build (~3-8 min)"],
  ["dist", "bun run build:cli (~30 s)"],
  ["test-results", "la suite E2E"],
  ["node_modules", "bun install (~1-2 min) — SERVE ADESSO, non toccare"],
  ["client/node_modules", "bun install — SERVE ADESSO, non toccare"],
];
let regen = 0;
for (const [rel, how] of REGEN) {
  const p = join(REPO, rel);
  if (!existsSync(p)) continue;
  const size = du(p);
  const keep = how.includes("non toccare");
  if (!keep) regen += size;
  console.log(`${human(size).padStart(8)}  ${rel.padEnd(36)} ${how}`);
}
console.log(`\nrigenerabile senza perdite: ${human(regen)}`);

if (process.argv.includes("--all") && existsSync(WT_ROOT)) {
  console.log("\n=== Worktree di ALTRI progetti sotto ~/.topics/worktrees ===\n");
  for (const proj of readdirSync(WT_ROOT)) {
    const p = join(WT_ROOT, proj);
    try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
    const size = du(p);
    if (size < 50 * 1024 * 1024) continue;
    console.log(`${human(size).padStart(8)}  ${proj}`);
  }
  console.log("\nNON sono di questo repo: vanno valutate col GC del LORO progetto.");
}

console.log(`
=== Come si esegue (niente di tutto questo è stato fatto) ===

  trash > rm, sempre. Nota che 'trash' non libera spazio finché non svuoti
  il Cestino: è un rename sullo stesso volume, istantaneo ma invisibile a df.

  Per una worktree REGISTRATA non basta cestinare la directory — poi serve:
      git worktree prune

  Il worktreeManager di Topics la vedrà con diskPresent=false e chiuderà la
  riga fantasma al prossimo sweep (worktree-gc.ts).
`);
