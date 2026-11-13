#!/usr/bin/env bun
/**
 * scripts/test-touched.ts - the unit tests of what THIS branch changed.
 *
 * WHY IT EXISTS. The delivery rule says "run the files you touched and the
 * tests that import them", and every agent applied it by hand: some ran too
 * few, others ran the whole suite. On 12/11 the sessions launched 1214 heavy
 * commands (11.6 h). `bun test` has no `--changed` (Vitest and Playwright do),
 * so the selection is derived here from the import graph.
 *
 * HOW THE TESTS ARE CHOSEN
 *   1. a changed file that is itself a test runs;
 *   2. a changed module runs every test that imports it, directly or through
 *      any chain of modules (reverse walk of the import graph).
 *
 * THE SAFE FALLBACK. Some changes reach tests with no import between them:
 * config, lockfile, tsconfig, the test preload, shared type declarations, or a
 * data file nobody imports (a workflow, a migration read through fs). For
 * those the whole suite runs, and the output says so. CI always runs the whole
 * suite anyway: a false negative here costs a CI round, not a broken main.
 * `package.json` (root or `client/`) is the one exception with its own check:
 * a change confined to "scripts" cannot affect a unit test, so it only
 * selects the tests that name it, same as `knip.jsonc`; any other field
 * (dependencies, overrides, workspaces, type...) still runs the whole suite.
 *
 * WHAT IT DOES NOT CATCH, said out loud:
 *   - a test that reads a file as text through a path built at run time (not a
 *     string literal) is not linked to it, unless it walks the whole tree;
 *   - a test that depends on the machine or on timing (a flake) is red or green
 *     whatever the diff; the measurement script counts those as proven noise;
 *   - code outside the graph roots never reaches the graph: the selector does
 *     not skip it, it runs the whole suite instead.
 *
 * USAGE
 *   bun run test:touched                  diff against origin/main (or main)
 *   bun run test:touched --base origin/x  diff against another base
 *   bun run test:touched --list           print the selection, run nothing
 * The run itself goes through scripts/test-unit-shards.ts, behind the slot in
 * the package.json script.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { SUITE_ROOTS, enumerateTestFiles } from "./test-unit-shards.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * Where modules a test may import live, beyond the suite roots. `knip.jsonc`, `package.json` and
 * `client/package.json` are here as files only: nothing imports them, so a change selects the tests
 * that name them (literal path) instead of the whole suite — unless the comparison in `selectTests`
 * decides otherwise (see `PACKAGE_JSON_PATTERN` below).
 */
export const GRAPH_ROOTS = [...SUITE_ROOTS, "tests/helpers", "tests/setup", "tests/fixtures", "tests/e2e", "server.ts", "knip.jsonc", "package.json", "client/package.json"] as const;

const CODE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".json"] as const;

/** Changed files that cannot affect a unit test. */
const INERT_EXTENSIONS = new Set([".md", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff2", ".webp"]);

/**
 * `package.json` (root or `client/`) is handled on its own, not as a blanket full-suite pattern: a
 * change confined to "scripts" cannot affect a unit test, so `selectTests` treats it as a regular graph
 * leaf (path-literal matches only) once `scriptsOnly` says the rest of the file is unchanged.
 */
const PACKAGE_JSON_PATTERN = /^(client\/)?package\.json$/;

const FULL_SUITE_PATTERNS: readonly RegExp[] = [
  /^(bun\.lockb?|client\/bun\.lockb?|package-lock\.json)$/,
  /^bunfig\.toml$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^tests\/setup\//,
  /\.d\.ts$/,
  /^shared\/types[^/]*$/,
  /(^|\/)(vite|vitest|playwright)\.config\.[cm]?[jt]s$/,
];

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bmodule\s*\(\s*)["'`]([^"'`\n]+)["'`]/g;

/** The module specifiers a source text names: static, dynamic and mocked. */
export function specifiersOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(SPECIFIER)) out.add(m[1]);
  return [...out];
}

/** Resolves one specifier written in `fromFile` to a repo-relative file, or null. */
export function resolveSpecifier(spec: string, fromFile: string, exists: (rel: string) => boolean): string | null {
  let base: string;
  if (spec.startsWith("./") || spec.startsWith("../")) base = normalize(join(dirname(fromFile), spec));
  else if (spec.startsWith("@/")) base = join("client/src", spec.slice(2));
  else return null;
  base = base.replaceAll("\\", "/");
  const bare = base.replace(/\.m?js$/, "");
  const candidates = [base, ...CODE_EXTENSIONS.map((e) => base + e), ...CODE_EXTENSIONS.map((e) => `${base}/index${e}`), ...CODE_EXTENSIONS.map((e) => bare + e)];
  return candidates.find((c) => exists(c)) ?? null;
}

const QUOTED_PATH = /["'\`]([^"'\`\s]{3,160})["'\`]/g;

/**
 * A test that reads a source file as TEXT (a size budget, a banned-name scan,
 * a "this call is still in that file" guard) has no import to the file. Its
 * path in a string literal is the link: either the whole repo-relative path
 * or, for the usual `join(ROOT, "server", "lib", "x.ts")`, a file name that
 * only one file in the graph has.
 */
export function pathLiterals(text: string, files: readonly string[]): Set<string> {
  const bySuffix = new Map<string, string[]>();
  const add = (key: string, f: string) => bySuffix.set(key, [...(bySuffix.get(key) ?? []), f]);
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 0; i < parts.length; i++) if (i === 0 || i === parts.length - 1 || parts.length - i >= 2) add(parts.slice(i).join("/"), f);
  }
  const out = new Set<string>();
  for (const m of text.matchAll(QUOTED_PATH)) {
    const token = m[1].replace(/^(\.\.?\/)+/, "");
    if (!/\.[a-z]{2,5}$/.test(token)) continue;
    const hits = bySuffix.get(token);
    if (!hits) continue;
    // A bare file name is evidence only when it names one file, unless one of the
    // candidates sits at the repo root and so equals the bare token outright (e.g.
    // "package.json" means the root one even though "client/package.json" shares the name).
    const atRoot = hits.find((h) => h === token);
    if (!token.includes("/") && hits.length > 1 && !atRoot) continue;
    for (const h of atRoot ? [atRoot] : hits) out.add(h);
  }
  return out;
}

/** A test that walks the tree looking at every file: whatever changed, it may care. */
const TREE_WALKER = /ls-files|\.scanSync\(|\.scan\(|readdirSync\([^)]*recursive/;

/** file -> the files it imports or reads, built from `files` (repo-relative) and a reader. */
export function buildGraph(files: readonly string[], read: (rel: string) => string): Map<string, Set<string>> {
  const known = new Set(files);
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const deps = new Set<string>();
    if (!file.endsWith(".json")) {
      const text = read(file);
      for (const spec of specifiersOf(text)) {
        const target = resolveSpecifier(spec, file, (c) => known.has(c));
        if (target && target !== file) deps.add(target);
      }
      if (isTestFile(file)) for (const t of pathLiterals(text, files)) if (t !== file) deps.add(t);
    }
    graph.set(file, deps);
  }
  return graph;
}

/** The tests that walk the whole tree; they run on any change that reaches no other test. */
export function treeWalkers(files: readonly string[], read: (rel: string) => string): Set<string> {
  return new Set(files.filter((f) => isTestFile(f) && TREE_WALKER.test(read(f))));
}

export function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

export type Selection = { kind: "tests"; tests: string[] } | { kind: "full"; reason: string };

/**
 * The tests to run for `changed`. `suiteTests` is the set `test:unit` would
 * run; `graph` the import graph over every module a test can reach. `gone`
 * says a changed path no longer exists (a deletion selects nothing by itself:
 * whoever imported it changed too).
 */
export function selectTests(
  changed: readonly string[],
  graph: Map<string, Set<string>>,
  suiteTests: ReadonlySet<string>,
  gone: (file: string) => boolean = () => false,
  walkers: ReadonlySet<string> = new Set(),
  scriptsOnly: (file: string) => boolean = () => false,
): Selection {
  const reverse = new Map<string, Set<string>>();
  for (const [file, deps] of graph) {
    for (const d of deps) {
      if (!reverse.has(d)) reverse.set(d, new Set());
      reverse.get(d)!.add(file);
    }
  }

  const selected = new Set<string>();
  for (const file of changed) {
    if (!INERT_EXTENSIONS.has(extname(file)) && !gone(file)) for (const w of walkers) if (suiteTests.has(w)) selected.add(w);
    if (PACKAGE_JSON_PATTERN.test(file) && !scriptsOnly(file)) return { kind: "full", reason: `${file} changed a field other than "scripts"` };
    if (!PACKAGE_JSON_PATTERN.test(file) && FULL_SUITE_PATTERNS.some((p) => p.test(file))) return { kind: "full", reason: `${file} is config, lockfile, test setup or shared types` };
    if (!graph.has(file)) {
      if (INERT_EXTENSIONS.has(extname(file)) || gone(file)) continue;
      return { kind: "full", reason: `${file} is outside the import graph, a test may read it directly` };
    }
    const stack = [file];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (isTestFile(cur) && suiteTests.has(cur)) selected.add(cur);
      for (const parent of reverse.get(cur) ?? []) stack.push(parent);
    }
  }
  return { kind: "tests", tests: [...selected].sort() };
}

/** The merge base commit of `base` with `HEAD`. */
export function mergeBaseSha(base: string, cwd = REPO_ROOT): string {
  const r = Bun.spawnSync(["git", "merge-base", base, "HEAD"], { cwd });
  if (r.exitCode !== 0) throw new Error(`git merge-base ${base} HEAD: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

/** Repo-relative files changed against the merge base with `base`, plus the working tree. */
export function changedFiles(base: string, cwd = REPO_ROOT): string[] {
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
    return r.stdout.toString();
  };
  const mergeBase = mergeBaseSha(base, cwd);
  const names = new Set<string>();
  for (const out of [git("diff", "--name-only", mergeBase), git("ls-files", "--others", "--exclude-standard")]) {
    for (const line of out.split("\n")) if (line.trim()) names.add(line.trim());
  }
  return [...names].sort();
}

/**
 * True when `file`'s JSON at `mergeBase` differs from its current content only in "scripts". An
 * unreadable or unparsable file at either end counts as NOT scripts-only, so the caller falls back
 * to the whole suite rather than assume a dependency bump is harmless.
 */
export function isScriptsOnlyChange(file: string, mergeBase: string, cwd = REPO_ROOT): boolean {
  const shown = Bun.spawnSync(["git", "show", `${mergeBase}:${file}`], { cwd });
  if (shown.exitCode !== 0) return false;
  let base: unknown;
  let head: unknown;
  try {
    base = JSON.parse(shown.stdout.toString());
    head = JSON.parse(readFileSync(join(cwd, file), "utf8"));
  } catch {
    return false;
  }
  if (typeof base !== "object" || base === null || typeof head !== "object" || head === null) return false;
  const withoutScripts = (o: Record<string, unknown>) => {
    const rest = { ...o };
    delete rest.scripts;
    return rest;
  };
  return JSON.stringify(withoutScripts(base as Record<string, unknown>)) === JSON.stringify(withoutScripts(head as Record<string, unknown>));
}

export function graphFiles(cwd: string): string[] {
  const out = new Set<string>();
  for (const root of GRAPH_ROOTS) {
    if (/\.[a-z]+$/.test(root)) {
      if (existsSync(join(cwd, root))) out.add(root);
      continue;
    }
    for (const ext of ["ts", "tsx", "mjs", "js", "json"]) {
      for (const rel of new Bun.Glob(`${root}/**/*.${ext}`).scanSync({ cwd, onlyFiles: true })) {
        const norm = rel.replaceAll("\\", "/");
        if (!norm.includes("node_modules/")) out.add(norm);
      }
    }
  }
  return [...out];
}

/** The files `main` would run for `base`, or "full" with the reason. Shared with the measurement. */
export function selectForBase(base: string, cwd = REPO_ROOT): Selection & { changed: string[] } {
  const changed = changedFiles(base, cwd);
  const files = graphFiles(cwd);
  const read = (rel: string) => readFileSync(join(cwd, rel), "utf8");
  const graph = buildGraph(files, read);
  const suiteTests = new Set(enumerateTestFiles(SUITE_ROOTS, cwd).map((f) => f.replaceAll("\\", "/")));
  let mergeBase: string | null = null;
  const scriptsOnly = (file: string) => {
    mergeBase ??= mergeBaseSha(base, cwd);
    return isScriptsOnlyChange(file, mergeBase, cwd);
  };
  return { ...selectTests(changed, graph, suiteTests, (f) => !existsSync(join(cwd, f)), treeWalkers(files, read), scriptsOnly), changed };
}

async function runShards(tests: string[], listOnly: boolean): Promise<number> {
  if (listOnly) {
    console.log(tests.length ? tests.join("\n") : "(whole suite)");
    return 0;
  }
  const proc = Bun.spawn(["bun", "run", "scripts/test-unit-shards.ts", ...tests], { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  return await proc.exited;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const refExists = (ref: string) => Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", ref], { cwd: REPO_ROOT }).exitCode === 0;
  const baseIdx = argv.findIndex((a) => a === "--base" || a.startsWith("--base="));
  const explicit = baseIdx < 0 ? null : argv[baseIdx].includes("=") ? argv[baseIdx].split("=")[1] : argv[baseIdx + 1];
  const base = explicit ?? ["origin/main", "main"].find(refExists) ?? "main";
  const listOnly = argv.includes("--list");

  let selection: Selection & { changed: string[] };
  try {
    selection = selectForBase(base);
  } catch (e) {
    console.error(`test-touched: cannot select against ${base} (${(e as Error).message}); running the whole suite`);
    return runShards([], listOnly);
  }
  if (selection.kind === "full") {
    console.error(`test-touched: WHOLE SUITE, ${selection.reason}`);
    return runShards([], listOnly);
  }
  if (selection.tests.length === 0) {
    console.error(`test-touched: ${selection.changed.length} changed file(s) against ${base}, no unit test reaches them; nothing to run`);
    return 0;
  }
  console.error(`test-touched: ${selection.tests.length} test file(s) for ${selection.changed.length} changed file(s) against ${base}`);
  return runShards(selection.tests, listOnly);
}

if (import.meta.main) process.exit(await main());
