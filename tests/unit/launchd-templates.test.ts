/**
 * A launchd job is committed as a TEMPLATE, never as a ready-made plist.
 *
 * WHY, and it is not style. A concrete plist has to spell out absolute paths:
 * `WorkingDirectory`, `HOME`, the log, the interpreter. Those are the home
 * directory and the username of whoever installed it, and this repo is public.
 * On 22/10/2026 one went in for real (PR #405, six occurrences) and the two
 * gates that look for a home path stayed green in CI, because they look for
 * the home of WHOEVER RUNS them, which on a CI runner is nobody's. The
 * leak is only visible on the machine it names, which is the one place nobody
 * runs the suite to find leaks.
 *
 * This check does not depend on who runs it: a literal `/Users/<name>/` or
 * `/home/<name>/` in a file under `scripts/launchd/` is red everywhere.
 * `scripts/install-db-snapshot.ts` fills the placeholders in at install time.
 *
 * @covers GATE-20
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { gitEnv } from "../setup/bun-test-preload";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const HOME_PATH = /\/(?:Users|home)\/[a-z][a-z0-9_.-]*\//i;

/** The files git tracks under `scripts/launchd/`. */
function launchdFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "scripts/launchd"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: gitEnv(),
  });
  return out.split("\n").filter(Boolean);
}

describe("i lavori launchd si committano come modello, non come plist pronto", () => {
  test("ce n'e' almeno uno da guardare (guardia contro un elenco vuoto)", () => {
    expect(launchdFiles().length).toBeGreaterThan(0);
  });

  test("il controllo sa dire di NO (guardia contro un controllo che non morde)", () => {
    expect(HOME_PATH.test("<string>/Users/qualcuno/Projects/topics-app</string>")).toBe(true);
    expect(HOME_PATH.test("<string>/home/qualcuno/.bun/bin/bun</string>")).toBe(true);
    expect(HOME_PATH.test("<string>__REPO__</string>")).toBe(false);
    // A path that belongs to the system, and not to a person, stays legitimate.
    expect(HOME_PATH.test("<string>/usr/bin:/bin:/opt/homebrew/bin</string>")).toBe(false);
  });

  test("nessun file in scripts/launchd scrive la home di una persona", () => {
    const offenders: string[] = [];
    for (const rel of launchdFiles()) {
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      const hits = text.split("\n").filter((l) => HOME_PATH.test(l)).length;
      if (hits > 0) offenders.push(`${rel} (${hits})`);
    }
    // If this list is not empty: turn the plist into a `.plist.in` with
    // `__HOME__` / `__REPO__` / `__BUN__` / `__LOG__` placeholders and let
    // `scripts/install-db-snapshot.ts` fill them in on the machine.
    expect(offenders).toEqual([]);
  });

  test("chi e' un modello lo dice nel nome", () => {
    const jobFiles = launchdFiles().filter((f) => f.includes(".plist"));
    expect(jobFiles.length).toBeGreaterThan(0);
    expect(jobFiles.filter((f) => !f.endsWith(".plist.in"))).toEqual([]);
  });
});
