/**
 * The isolation reaches git WITHOUT the call spelling out `env`, as long as it
 * is in the environment the process was BORN with.
 *
 * This is the measurement the whole design rests on, and it has two halves
 * that are both load bearing:
 *
 *   - born with it  -> a git call that passes nothing still sees it. This is
 *     why `scripts/test-unit-shards.ts` builds every file's environment in
 *     `fileEnv()`, which wraps the base in `gitIsolationEnv`: from there the
 *     hooks of the machine cannot get into a test repo even when a call
 *     forgets `env`.
 *   - added at runtime -> it does NOT. This is the Bun limitation that makes
 *     the preload alone insufficient. If a future Bun passes runtime variables
 *     down, THIS test goes red first and says so: the extra layer can then go.
 *
 * `bun -e` does not load the preload (`bunfig.toml` declares it under
 * `[test]`), so the child's environment is only what we hand it.
 *
 * @covers GATE-09
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { GIT_ISOLATION_MARKER, gitIsolationEnv } from "../setup/git-isolation";
import { gitEnv } from "../setup/bun-test-preload";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const HOOKS = "/nonexistent/topics-test-hooks";

/** `git config --get core.hooksPath` from a child, passing git NO env at all. */
const READS_HOOKS = `const r = Bun.spawnSync(["git", "config", "--get", "core.hooksPath"]);
console.log((r.stdout.toString() || "").trim());`;

/** What the child printed on stdout, trimmed. */
function hooksPathSeenBy(env: Record<string, string>, code: string): string {
  const r = Bun.spawnSync(["bun", "-e", code], { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString().trim();
}

/** `process.env` with every trace of the isolation taken back out. */
function withoutIsolation(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(gitEnv())) {
    if (/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(k)) continue;
    if (k === GIT_ISOLATION_MARKER) continue;
    out[k] = v;
  }
  return out;
}

describe("l'isolamento di git si eredita se c'e' alla nascita del processo", () => {
  test("nato con l'isolamento: git lo vede anche senza env sulla chiamata", () => {
    expect(hooksPathSeenBy(gitIsolationEnv(withoutIsolation()), READS_HOOKS)).toBe(HOOKS);
  });

  test("scritto a runtime: git NON lo vede (il limite di Bun per cui esiste il resto)", () => {
    const clean = withoutIsolation();
    const written = gitIsolationEnv(clean);
    const mutation = `Object.assign(process.env, ${JSON.stringify({
      GIT_CONFIG_COUNT: written.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: written.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: written.GIT_CONFIG_VALUE_0,
      GIT_CONFIG_KEY_1: written.GIT_CONFIG_KEY_1,
      GIT_CONFIG_VALUE_1: written.GIT_CONFIG_VALUE_1,
    })});\n`;
    // Guard against a vacuous green: if the mutation itself failed to land,
    // the child would print nothing for a reason that has nothing to do with
    // inheritance. It reads its own `process.env` back first.
    const guard = `if (process.env.GIT_CONFIG_KEY_0 !== ${JSON.stringify(
      written.GIT_CONFIG_KEY_0,
    )}) { console.error("la mutation non e' arrivata"); process.exit(3); }\n`;
    expect(hooksPathSeenBy(clean, mutation + guard + READS_HOOKS)).not.toBe(HOOKS);
  });

  test("appende a un conteggio che c'e' gia', senza buttare via le chiavi di chi ci ha lanciati", () => {
    const base = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.pager", GIT_CONFIG_VALUE_0: "cat" };
    const out = gitIsolationEnv(base);
    expect(out.GIT_CONFIG_KEY_0).toBe("core.pager");
    expect(out.GIT_CONFIG_KEY_1).toBe("core.hooksPath");
    expect(out.GIT_CONFIG_VALUE_1).toBe(HOOKS);
    expect(out.GIT_CONFIG_KEY_2).toBe("commit.gpgsign");
    expect(out.GIT_CONFIG_COUNT).toBe("3");
  });

  // The mechanism above is worth nothing if the runner stops using it, and
  // that failure is silent: every test stays green while the hooks come back
  // in. The same shape cost this repo a whole defect once already, a correct
  // module whose only caller hid its entry point.
  test("the runner really hands the isolated environment to its `bun test`", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts/test-unit-shards.ts"), "utf8");
    // The isolation is applied in `fileEnv()`, not at the spawn site: the
    // wrapped base has to be that function's, not some other env in the file.
    const fileEnvAt = src.indexOf("export function fileEnv");
    expect(fileEnvAt).toBeGreaterThan(-1);
    expect(src.slice(fileEnvAt, fileEnvAt + 600)).toContain("gitIsolationEnv(");
    // And the `bun test` spawn has to receive an environment at all: the
    // function above is worth nothing if `runFile` spawns without it.
    const spawnAt = src.indexOf('["bun", "test"');
    expect(spawnAt).toBeGreaterThan(-1);
    expect(src.slice(spawnAt, spawnAt + 600)).toContain("env");
  });

  test("applicato due volte non raddoppia le chiavi", () => {
    const una = gitIsolationEnv({});
    const due = gitIsolationEnv(una);
    expect(due).toEqual(una);
  });
});
