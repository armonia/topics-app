#!/usr/bin/env bun
/**
 * scripts/check-e2e-touched.ts - the E2E specs of what THIS branch changed.
 *
 * WHY IT EXISTS
 * The six delivery gates (typecheck, lint, check:deadcode, check:emdash,
 * check:migrations, test:unit) contain no end-to-end test, and a land is a
 * LOCAL merge: it never passes through the CI workflow that runs the PR tier of
 * the suite. So a card can be green on every gate, land on main, and break e2e
 * tests that nobody sees until the nightly at 4am. On 27/08 three cards landed
 * that way and the nightly came back with six reds; two of them were a rule and
 * a list changed on one surface only, which is exactly what an e2e test is for.
 *
 * Running the whole suite as a gate is not an option (about twenty minutes, and
 * a gate that costs twenty minutes gets switched off the first day). So this
 * runs the specs that have something to do with what the branch TOUCHED, and
 * nothing else.
 *
 * HOW THE SPECS ARE CHOSEN, and why nothing is written by hand here
 * A hand-kept map of "file -> spec" would be a fourth list to keep aligned, the
 * very defect that produced two of the six reds. Everything is derived:
 *
 *   1. a changed file UNDER tests/e2e that is itself a spec: it runs;
 *   2. a changed source file exporting testids (`data-testid="x"`, `testId:
 *      'x'`, and the static prefix of a template literal like
 *      `pane-add-menu-${type}`): every spec mentioning one of those strings
 *      runs;
 *   3. a changed source file IMPORTED by a spec (by module basename): that
 *      spec runs.
 *
 * WHAT IT DOES NOT CATCH, said out loud: a spec that measures a surface without
 * naming any of its testids (it asks the DOM for `role="tree"`, say) is not
 * linked to the file that draws it. This gate narrows the window, it does not
 * close it; the nightly stays the full measurement.
 *
 * EXIT CODES
 *   0  no related spec, or all the related specs are green
 *   1  a related spec is red
 *   2  the selection could not be made (no git, no base branch to diff against)
 *
 * USAGE
 *   bun run check:e2e-touched            select and RUN (this is the gate)
 *   bun run check:e2e-touched --list     only print what it would run
 *   bun run check:e2e-touched --base=main   diff against another base
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";

/** More than this many specs and it is not a gate any more, it is the suite. */
const MAX_SPECS = 8;

const E2E_DIR = "tests/e2e";

/** Files whose change says nothing about which surface moved. */
const IGNORED = /^(docs|openspec|landing|desktop-tauri|performance|bench)\//;

function sh(cmd: string[]): string {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) return "";
  return new TextDecoder().decode(p.stdout);
}

/** The files this branch changed: committed since the base, plus the worktree. */
export function changedFiles(base: string): string[] {
  const mergeBase = sh(["git", "merge-base", "HEAD", base]).trim();
  const out = new Set<string>();
  if (mergeBase) {
    for (const line of sh(["git", "diff", "--name-only", `${mergeBase}..HEAD`]).split("\n")) {
      if (line.trim()) out.add(line.trim());
    }
  }
  for (const line of sh(["git", "status", "--porcelain"]).split("\n")) {
    const path = line.slice(3).trim();
    if (path) out.add(path.includes(" -> ") ? path.split(" -> ")[1]! : path);
  }
  return [...out].filter((f) => !IGNORED.test(f) && existsSync(f));
}

/**
 * The testids a source file puts in the DOM, template literals included: for
 * `pane-add-menu-${type}` the usable part is the static prefix, because that is
 * what a spec can match on (`[data-testid^="pane-add-menu-"]`).
 *
 * Only the three places that DECLARE a testid are read (`data-testid=`,
 * `testId:`, `getByTestId(`). Reading any string that happens to sit before a
 * `${` selected 75 specs out of 5 changed files on the first run, on tokens
 * like "famil" from a sentence: a gate that runs the whole suite is the suite.
 */
export function testIdsOf(source: string): string[] {
  const ids = new Set<string>();
  const patterns = [
    /data-testid\s*=\s*[{]?\s*["'`]([a-z0-9][a-z0-9-]*)/g,
    /\btestId:\s*["'`]([a-z0-9][a-z0-9-]*)/g,
    /\bgetByTestId\(\s*["'`]([a-z0-9][a-z0-9-]*)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const id = m[1]!.trim().replace(/-+$/, "");
      // A testid worth grepping has a shape: two words at least, and long
      // enough that the match is about this surface and not about a syllable.
      if (id.length >= 8 && id.includes("-")) ids.add(id);
    }
  }
  return [...ids];
}

/** Every spec of the suite, with its text read once. */
function specs(): { file: string; text: string }[] {
  if (!existsSync(E2E_DIR)) return [];
  return readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => ({ file: join(E2E_DIR, f), text: readFileSync(join(E2E_DIR, f), "utf8") }));
}

/**
 * The names of the surface a file belongs to: its folder and its own module
 * name, lowercased. `client/src/components/Sidebar/TopicItem.tsx` gives
 * "sidebar" and "topicitem".
 */
export function areaTokens(file: string): string[] {
  const parts = file.split("/");
  const dir = parts[parts.length - 2] ?? "";
  const mod = basename(file, extname(file));
  return [dir.toLowerCase(), mod.toLowerCase()].filter((t) => t.length >= 5);
}

/**
 * How MANY specs a testid appears in. A testid used by dozens of them is
 * furniture on the way somewhere else (`pane-add-menu` is how 78 specs open a
 * pane), not the subject of any of them: linking a change to all 78 is the same
 * as running the suite, which is the thing this gate exists not to do.
 */
const FURNITURE_AT = 8;

/**
 * Signal strength, lowest first: this is the order the budget is spent in.
 *
 * THE AREA COMES BEFORE THE TESTID, and that order is the whole point. A spec
 * that shares the changed file's area is ABOUT that surface; a spec that merely
 * names one of its testids usually passes through it on the way somewhere else.
 * With the two swapped, a change to the three sidebar row files put eight specs
 * of other features in front of `sidebar-chevron-column.spec.ts`, which is the
 * one that went red in the nightly of 27/08.
 */
const RANK = { spec: 0, imported: 1, area: 2, testid: 3 } as const;

export interface SpecPick {
  file: string;
  why: string;
  rank: number;
}

/** The specs related to a set of changed files, strongest link first. */
export function selectSpecs(
  changed: string[],
  all: { file: string; text: string }[],
): SpecPick[] {
  const picks = new Map<string, SpecPick>();
  const keep = (file: string, why: string, rank: number) => {
    const had = picks.get(file);
    if (!had || rank < had.rank) picks.set(file, { file, why, rank });
  };

  for (const file of changed) {
    if (file.startsWith(E2E_DIR) && file.endsWith(".spec.ts")) {
      keep(file, "the spec itself changed", RANK.spec);
      continue;
    }
    // Only the code that DRAWS a surface. A unit test, a script or a config
    // changing says nothing about which spec to run, and their strings are
    // quoted examples, not testids in the DOM.
    if (!/^(client\/src|server|shared|relay|cli)\//.test(file)) continue;
    if (!/\.(ts|tsx)$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
    let source = "";
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const moduleName = basename(file, extname(file));
    const tokens = areaTokens(file);
    const ids = testIdsOf(source);
    const users = new Map<string, string[]>();
    for (const id of ids) {
      users.set(id, all.filter((s) => s.text.includes(id)).map((s) => s.file));
    }

    for (const spec of all) {
      // An import of the changed module, by path segment: `from "../../shared/
      // terminal-session-types"` for shared/terminal-session-types.ts.
      if (moduleName.length >= 5 && new RegExp(`from\\s+["'][^"']*${moduleName}["']`).test(spec.text)) {
        keep(spec.file, `${file} is imported by the spec`, RANK.imported);
        continue;
      }
      // AND THE SPEC THAT NAMES THE SURFACE. A spec can measure a surface
      // without naming a single testid of it: `sidebar-chevron-column.spec.ts`
      // asks the DOM for `role="tree"` and reads boxes, so no testid links it
      // to the sidebar files it is about. The folder is the link that is left,
      // and it is derived, not written down: `client/src/components/Sidebar/*`
      // to `sidebar-*.spec.ts`.
      const specName = basename(spec.file, ".spec.ts");
      const token = tokens.find((t) => specName === t || specName.startsWith(`${t}-`));
      if (token) {
        keep(spec.file, `${file} is in the "${token}" area`, RANK.area);
        continue;
      }
      const own = ids.find((id) => {
        const list = users.get(id) ?? [];
        return list.includes(spec.file) && list.length <= FURNITURE_AT;
      });
      if (own) keep(spec.file, `${file} draws "${own}"`, RANK.testid);
    }
  }

  return [...picks.values()].sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file));
}

function main(): number {
  const args = process.argv.slice(2);
  const listOnly = args.includes("--list");
  const base = (args.find((a) => a.startsWith("--base="))?.split("=")[1] ?? "main").trim();

  if (!sh(["git", "rev-parse", "--git-dir"]).trim()) {
    console.error("check:e2e-touched: not a git checkout, nothing to compare. NOT MEASURED.");
    return 2;
  }
  if (!sh(["git", "rev-parse", "--verify", base]).trim()) {
    console.error(`check:e2e-touched: base "${base}" does not exist here. NOT MEASURED.`);
    return 2;
  }

  const changed = changedFiles(base);
  if (changed.length === 0) {
    console.log(`check:e2e-touched: nothing changed against ${base}, no spec to run.`);
    return 0;
  }

  const picked = selectSpecs(changed, specs());
  if (picked.length === 0) {
    console.log(
      `check:e2e-touched: ${changed.length} changed file(s), no spec names any of their testids, ` +
        "imports them or shares their area. Nothing to run here; the nightly stays the full measurement.",
    );
    return 0;
  }

  // OVER BUDGET IT RUNS THE STRONGEST LINKS, it does not give up. Skipping
  // altogether is how a wide change gets no gate at all, which is the state
  // this script was written to leave.
  const run = picked.slice(0, MAX_SPECS);
  const left = picked.slice(MAX_SPECS);
  console.log(`check:e2e-touched: ${picked.length} spec(s) related to ${changed.length} changed file(s).`);
  for (const p of run) console.log(`  ${p.file}  (${p.why})`);
  if (left.length) {
    console.log(
      `  ... and ${left.length} more, above the ${MAX_SPECS} this gate runs: ` +
        "a change that wide is measured by the nightly.",
    );
  }
  if (listOnly) return 0;

  const files = run.map((p) => p.file);
  console.log(`\n$ npx playwright test ${files.join(" ")} --reporter=line\n`);
  const proc = Bun.spawnSync(["npx", "playwright", "test", ...files, "--reporter=line"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exitCode === 0 ? 0 : 1;
}

// Only when RUN, never when imported: `selectSpecs` and `testIdsOf` have their
// own unit test, and an import that launches Playwright is a trap.
if (import.meta.main) process.exit(main());
