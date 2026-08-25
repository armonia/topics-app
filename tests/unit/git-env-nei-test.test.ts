/**
 * Whoever launches `git` in a test carries the preload's isolated environment.
 *
 * WHY HAVING FIXED THEM IS NOT ENOUGH. On 24/08 seventeen test files were
 * building a real git repo and making 46 commits in it, inheriting the
 * machine's config, hooks included. On the development one `core.hooksPath`
 * points at a third-party `prepare-commit-msg` that on every commit fires two
 * `curl --max-time 2` at `localhost:3333`: measured, 380ms per commit against
 * 160ms, and under load the tests overran the timeout. The symptom was the
 * worst one available, a red that showed up ONLY in the whole suite and on a
 * different test every time.
 *
 * The seventeen were fixed by hand. This guard exists for the eighteenth, the
 * one that will be born tomorrow: the criterion «does this file launch git?»
 * is written down nowhere, and whoever copies their neighbour will copy the
 * version without `env`. The cost of rediscovering it is a day, because the
 * red does not talk about the file that caused it.
 *
 * WHAT IT DEMANDS, and why so little: that where there is a `git` spawn there
 * is also an `env`, not that it be `gitEnv()`. `landing-verdict.test.ts`
 * passes `process.env` with `GIT_AUTHOR_DATE` inside it to pin the dates, and
 * inherits the isolation all the same, so demanding the function's name would
 * fail it for nothing. The difference that counts is between «I pass an
 * environment» and «I pass none at all», which is the case in which
 * `Bun.spawnSync` does not inherit what the preload set at runtime.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** The test files git tracks: the untracked ones belong to nobody. */
function trackedTestFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "*.test.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // THIS file stays out of the scan, and that is not a shortcut.
  //
  // The proof «the scanner can say NO» contains, of necessity, a LITERAL
  // example of the bad form: `Bun.spawnSync(["git", ...], { stdout })` with no
  // `env`. It is the non-vacuous half of the gate — without it, the scanner
  // could stop recognising the form and the test would pass forever while
  // looking at nothing. But that example is text, not a call: no git is
  // launched, no hook of the machine gets into a test.
  //
  // By scanning itself as well, the gate reported itself: a permanent red,
  // offender `tests/unit/git-env-nei-test.test.ts (1)`, and no way of getting  allow-italian: the file's own path is the quoted output
  // it green again other than deleting the very proof that makes it sharp. A
  // gate that asks to be disarmed in order to go green has a defect in its
  // perimeter, not in its rule.
  const thisFile = "tests/unit/git-env-nei-test.test.ts";
  return out.split("\n").filter(Boolean).filter((f) => f !== thisFile);
}

/**
 * The `git` spawns in a file, with the note of whether they carry an `env`.
 *
 * The call is looked at in full up to the parenthesis that closes it, because
 * `env` lives in the options and those can wrap onto the next line. An `env`
 * that appears AFTER the end of the call is not this call's.
 */
function spawnsWithoutEnv(text: string): number {
  let count = 0;
  const re = /(?:Bun\.)?spawnSync?\(\s*\[\s*["']git["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // From the call, take up to the closing brace of the options or to the
    // final parenthesis: that is where `env` lives.
    const tail = text.slice(m.index, m.index + 600);
    const end = tail.indexOf(");");
    const call = end === -1 ? tail : tail.slice(0, end);
    // `env: something`, or the shorthand form `{ ..., env }`, which
    // `landing-verdict.test.ts` uses to slip GIT_AUTHOR_DATE in: it passes an
    // environment to all intents and purposes, and failing it would be a false
    // positive.
    if (!/\benv\s*[:,}]/.test(call)) count += 1;
  }
  return count;
}

describe("i test che lanciano git si portano l'ambiente isolato", () => {
  test("lo scanner vede qualcosa (guardia contro un elenco vuoto)", () => {
    // Without this line the test would be green even if `git ls-files`
    // returned nothing, i.e. while measuring nothing.
    const files = trackedTestFiles();
    expect(files.length).toBeGreaterThan(100);
  });

  test("lo scanner sa dire di NO (guardia contro un controllo che non morde)", () => {
    // The negative case: if `spawnsWithoutEnv` stopped recognising the form,
    // the test below would pass forever without looking at anything.
    expect(spawnsWithoutEnv(`Bun.spawnSync(["git", "-C", d, "log"], { stdout: "pipe" });`)).toBe(1);
    expect(spawnsWithoutEnv(`Bun.spawnSync(["git", "-C", d, "log"], { stdout: "pipe", env: gitEnv() });`)).toBe(0);
    expect(spawnsWithoutEnv(`Bun.spawnSync(["git", "log"], { env: process.env });`)).toBe(0);
    expect(spawnsWithoutEnv(`Bun.spawnSync(["git", "log"], { stdout: "pipe", env });`)).toBe(0);
  });

  test("nessun file di test lancia git senza passare un env", () => {
    const offenders: string[] = [];
    for (const rel of trackedTestFiles()) {
      let text: string;
      try {
        text = readFileSync(join(REPO_ROOT, rel), "utf-8");
      } catch {
        continue; // deleted between `ls-files` and here: not an offender
      }
      const n = spawnsWithoutEnv(text);
      if (n > 0) offenders.push(`${rel} (${n})`);
    }
    // If this list is not empty: add `env: gitEnv()` to the spawn, with
    // `import { gitEnv } from "<...>/tests/setup/bun-test-preload"`. It serves
    // to keep out the hooks of the machine of whoever runs it, which otherwise
    // fire on every commit of your test repo.
    expect(offenders).toEqual([]);
  });
});
