/**
 * @covers GATE-03
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * THE GATE THAT KEEPS THE TOOLING IN ONE LANGUAGE.
 *
 * WHY IT EXISTS. Three gates shipped with Italian names: `check:sicurezza`,
 * `check:fluido`, `check:rotte`, plus their files and baselines. Nothing was
 * wrong with them except that a reader had to know two languages to find the
 * security gate, and every new contributor coined the next name by imitation:
 * the drift was self-reinforcing. Renaming them once fixes today; this test is
 * what stops tomorrow, because a convention nobody executes is a preference.
 *
 * WHAT IT LOOKS AT: NAMES, not prose. The npm script keys under `check:*` and
 * the file names under `scripts/`. Comments and console output in this repo are
 * still Italian by design and are deliberately out of scope here - a test that
 * tried to police prose would either be red on arrival or be reduced to a list
 * of exceptions nobody maintains.
 *
 * WHY THE LIST IS SHORT. It carries the words that were actually removed, and
 * nothing more. Two Italian names survive under `scripts/` on purpose:
 * `licenza.ts` and `conio-licenze.ts` belong to another owner and to another
 * rename. Adding `licenza`/`licenze` here today would make this test red on
 * arrival, and a gate that is born red gets deleted rather than obeyed. Add
 * them in the same commit that renames those two files.
 *
 * Matching is on WHOLE TOKENS, never on substrings: `check:scroll-fluidity`
 * must stay legal while `check:fluido` must not, and a substring rule on
 * "fluid" cannot tell them apart.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The Italian words that this repo's tooling names must not carry again. */
const STOPWORDS = [
  "sicurezza",
  "segreti",
  "dipendenze",
  "fluido",
  "fluida",
  "fluidita",
  "rotta",
  "rotte",
] as const;

/** Directories with no hand-written names in them: build output and vendored deps. */
const SKIP_DIRS = new Set(["node_modules", ".build", "out", "dist", "target"]);

/** `check-scroll-fluidity.ts` -> ["check", "scroll", "fluidity", "ts"]. */
function tokens(name: string): string[] {
  return name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

function offendingWords(name: string): string[] {
  const found = new Set(tokens(name));
  return STOPWORDS.filter((w) => found.has(w));
}

/** Every path under `scripts/`, relative to it, directories included. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    out.push(rel);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      out.push(...walk(join(dir, entry.name), rel));
    }
  }
  return out;
}

describe("tooling names are English", () => {
  test("no `check:*` npm script carries an Italian stopword", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const checks = Object.keys(pkg.scripts).filter((k) => k.startsWith("check:"));
    // A guard that measured zero scripts would pass forever without looking.
    expect(checks.length).toBeGreaterThan(5);

    const bad = checks
      .map((name) => ({ name, words: offendingWords(name) }))
      .filter((x) => x.words.length > 0)
      .map((x) => `${x.name} (${x.words.join(", ")})`);
    expect(bad).toEqual([]);
  });

  test("no file under scripts/ carries an Italian stopword in its name", () => {
    const paths = walk(join(REPO_ROOT, "scripts"));
    // Same reason as above: an empty walk must not read as a clean tree.
    expect(paths.length).toBeGreaterThan(50);

    const bad = paths
      .map((p) => ({ p, words: offendingWords(p.split("/").pop()!) }))
      .filter((x) => x.words.length > 0)
      .map((x) => `scripts/${x.p} (${x.words.join(", ")})`);
    expect(bad).toEqual([]);
  });

  test("the matcher takes whole tokens, so the English replacements stay legal", () => {
    // Both halves matter. Without the first this test could not fail; without
    // the second the rename it is meant to protect would be illegal.
    expect(offendingWords("check-sicurezza.ts")).toEqual(["sicurezza"]);
    expect(offendingWords("check:rotte")).toEqual(["rotte"]);
    expect(offendingWords("fluido-baseline.json")).toEqual(["fluido"]);

    expect(offendingWords("check-security.ts")).toEqual([]);
    expect(offendingWords("check:scroll-fluidity")).toEqual([]);
    expect(offendingWords("check-route-latency.ts")).toEqual([]);
    expect(offendingWords("scroll-fluidity-baseline.json")).toEqual([]);
  });
});
