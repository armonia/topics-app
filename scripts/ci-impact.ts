#!/usr/bin/env bun
/**
 * scripts/ci-impact.ts - which e2e specs and which unit tests a pull request
 * needs, chosen from its diff. The test-side "tree shaking" of the CI.
 *
 * WHY. Measured on PR 1680 (7 files touched): 21.5 minutes, of which unit 8.5
 * and e2e 13-17 per runner, and the e2e plan held 562 of the 596 specs: the
 * whole PR tier for a 7 file change. What can change the verdict of a diff is
 * what the diff reaches, so a pull request runs that, and the whole suite runs
 * where nobody waits for it: the push to main and the nightly.
 *
 * WHAT A PULL REQUEST RUNS
 *   e2e   the specs that `selectSpecs` links to the changed files (testid,
 *         import, area, the spec itself), the specs sharing an `@covers`
 *         requirement with a changed test, a fixed smoke, and (in
 *         prepare-e2e) what `playwright test --only-changed` reads from the
 *         import graph of the specs.
 *   unit  `scripts/test-touched.ts`: the tests that import what changed.
 * Anything it cannot link falls back to the whole tier, never to less. The
 * pull request run is a prefix of the push run, not a replacement of it, so
 * a reduced pull request does NOT mark its tree as judged (ci.yml): main
 * runs it in full.
 *
 * FAILS OPEN. A changed source file that no spec is linked to, a config or
 * helper that every spec reads, more than MAX_REDUCED specs: `full`.
 *
 * USAGE
 *   bun run scripts/ci-impact.ts --base origin/main [--github-output] [--out file.json]
 *                                [--plan-out only.json]
 * `--plan-out` writes `{ "files": [...] }` for `e2e-plan-shards.ts --only`: the reduced selection plus
 * the specs `playwright test --only-changed` (1.46+) reads from the import graph. When the e2e scope
 * is full, or Playwright cannot answer, no file is written and the plan stays the whole tier.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { changedFiles, selectSpecs } from "./check-e2e-touched.ts";
import { selectForBase } from "./test-touched.ts";

/** Always part of a reduced plan: the shell boots and the three surfaces everything hangs from. */
export const SMOKE_SPECS = ["sidebar.spec.ts", "chat.spec.ts", "terminal.spec.ts", "topics-archive-boot.spec.ts"] as const;

/** More than this and the change is wide: the whole tier is the honest answer. */
export const MAX_REDUCED = 60;

/**
 * Files every spec reads, directly or through the server and the bundle they
 * start. A change here has no import path to a particular spec.
 */
const EVERYTHING_PATTERNS: readonly RegExp[] = [
  /^playwright\.config\.ts$/,
  /^tests\/e2e\/(global-setup|global-teardown)[^/]*$/,
  /^tests\/e2e\/fixtures\//,
  /^(package\.json|bun\.lock|bun\.lockb|tsconfig[^/]*\.json)$/,
  /^client\/(package\.json|bun\.lock|index\.html|vite\.config[^/]*|tsconfig[^/]*\.json)$/,
  /^\.github\//,
  /^server\.ts$/,
];

/** Paths a source change can be traced from, to the specs that draw them. */
const LINKABLE_SOURCE = /^(client\/src|server|shared|relay|cli)\/.*\.(ts|tsx)$/;

export type E2eScope = { kind: "full"; reason: string } | { kind: "reduced"; files: string[]; reason: string };

const isTestFile = (f: string) => /\.test\.tsx?$/.test(f);
const isSpec = (f: string) => /^tests\/e2e\/[^/]+\.spec\.ts$/.test(f);
const isE2eSupport = (f: string) => f.startsWith("tests/e2e/") && !isSpec(f) && !isTestFile(f);

/** The `@covers` ids written in a file. */
export function coversOf(text: string): string[] {
  return [...text.matchAll(/@covers\s+([A-Z][A-Z0-9]*-\d+)/g)].map((m) => m[1]!);
}

/**
 * The e2e scope of a change. `specs` is every spec with its text, `read` reads
 * a changed file (a deleted one throws or returns null, and selects nothing).
 */
export function scopeE2e(
  changed: readonly string[],
  specs: readonly { file: string; text: string }[],
  read: (file: string) => string | null,
  smoke: readonly string[] = SMOKE_SPECS,
): E2eScope {
  const picked = new Set<string>();
  for (const file of changed) {
    const hit = EVERYTHING_PATTERNS.find((p) => p.test(file));
    if (hit) return { kind: "full", reason: `${file} is read by every spec` };
    if (isSpec(file)) {
      picked.add(file);
      continue;
    }
    // A helper or an e2e-side file: its dependents come from `--only-changed` in prepare-e2e.
    if (isE2eSupport(file)) continue;
    if (isTestFile(file)) {
      const text = read(file);
      const ids = text ? coversOf(text) : [];
      for (const id of ids) {
        for (const s of specs) if (coversOf(s.text).includes(id)) picked.add(s.file);
      }
      continue;
    }
    if (!LINKABLE_SOURCE.test(file)) continue;
    const linked = selectSpecs([file], specs as { file: string; text: string }[]);
    if (linked.length === 0) {
      // Deleted files and pure type files have no DOM to trace: only a file that still exists is blamed.
      if (read(file) === null) continue;
      return { kind: "full", reason: `${file} is linked to no spec (testid, import or area)` };
    }
    for (const l of linked) picked.add(l.file);
  }
  for (const s of smoke) picked.add(`tests/e2e/${s}`);
  if (picked.size > MAX_REDUCED) return { kind: "full", reason: `${picked.size} specs are reached: a wide change` };
  return { kind: "reduced", files: [...picked].map((f) => basename(f)).sort(), reason: `${picked.size} specs from ${changed.length} changed files` };
}

function readSpecs(): { file: string; text: string }[] {
  const dir = "tests/e2e";
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => ({ file: `${dir}/${f}`, text: readFileSync(join(dir, f), "utf8") }));
}

/** The spec files named by `playwright test --list --reporter=json`. */
export function specFilesOfList(json: string): string[] {
  type Suite = { file?: string; suites?: Suite[]; specs?: Array<{ file?: string }> };
  const files = new Set<string>();
  const walk = (s: Suite) => {
    for (const child of s.suites ?? []) walk(child);
    for (const spec of s.specs ?? []) {
      const f = spec.file ?? s.file;
      if (f) files.add(basename(f));
    }
  };
  for (const s of (JSON.parse(json) as { suites?: Suite[] }).suites ?? []) walk(s);
  return [...files].sort();
}

export interface Impact {
  e2e: E2eScope;
  unit: { kind: "tests"; tests: string[] } | { kind: "full"; reason: string };
  /** True when this run is a strict subset of the push run: its tree is not judged. */
  reduced: boolean;
}

export function impactOf(base: string): Impact {
  const diff = changedFiles(base);
  if (!diff) {
    const reason = "no merge base with the base branch";
    return { e2e: { kind: "full", reason }, unit: { kind: "full", reason }, reduced: false };
  }
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : null);
  // `changedFiles` of check-e2e-touched drops docs; test-touched keeps its own list.
  const e2e = scopeE2e(diff.files, readSpecs(), read);
  let unit: Impact["unit"];
  try {
    const s = selectForBase(base);
    unit = s.kind === "full" ? { kind: "full", reason: s.reason } : { kind: "tests", tests: s.tests };
  } catch (e) {
    unit = { kind: "full", reason: `selection failed: ${(e as Error).message}` };
  }
  return { e2e, unit, reduced: e2e.kind === "reduced" || unit.kind === "tests" };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
    if (i < 0) return undefined;
    return argv[i]!.includes("=") ? argv[i]!.split("=")[1] : argv[i + 1];
  };
  const base = arg("--base") ?? "origin/main";
  const out = arg("--out");
  let impact: Impact;
  try {
    impact = impactOf(base);
  } catch (e) {
    const reason = `impact failed: ${(e as Error).message}`;
    impact = { e2e: { kind: "full", reason }, unit: { kind: "full", reason }, reduced: false };
  }
  console.log(`ci-impact: e2e ${impact.e2e.kind} (${impact.e2e.reason}); unit ${impact.unit.kind}${impact.unit.kind === "tests" ? ` (${impact.unit.tests.length} files)` : ` (${impact.unit.reason})`}`);
  if (out) writeFileSync(out, JSON.stringify(impact, null, 2));
  const planOut = arg("--plan-out");
  if (planOut && impact.e2e.kind === "reduced") {
    const listed = spawnSync("npx", ["playwright", "test", "--list", "--reporter=json", `--only-changed=${base}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    try {
      if (listed.status !== 0) throw new Error(`playwright exited ${listed.status}`);
      const files = [...new Set([...impact.e2e.files, ...specFilesOfList(listed.stdout)])].sort();
      writeFileSync(planOut, JSON.stringify({ files }));
      console.log(`ci-impact: reduced e2e plan of ${files.length} specs (${files.length - impact.e2e.files.length} from --only-changed)`);
    } catch (e) {
      console.log(`ci-impact: --only-changed unusable (${(e as Error).message}); the whole tier runs`);
    }
  }
  if (argv.includes("--github-output") && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `e2e_scope=${impact.e2e.kind}\nunit_scope=${impact.unit.kind}\nreduced=${impact.reduced}\n`,
    );
  }
}
