/**
 * The guard of git isolation in the tests.
 *
 * The fault it protects against: seventeen test files build real git repos and
 * make 46 commits in them, inheriting the machine's config. On this one,
 * `core.hooksPath` points at a third-party hook that on every commit calls
 * `localhost:3333` with two `curl --max-time 2`. The result was a red that
 * showed up ONLY in the whole suite, on a different test every time, with the
 * error «this test timed out after 5000ms»: it looked like a collision between
 * tests, it was the machine getting in.
 *
 * Why a guard and not just the fix: the isolation lives in a preload nobody
 * looks at, and the line that applies it (`env: gitEnv()`) is easy to forget
 * in the next file that will be born. What is measured here is the effect, not
 * the presence of the code.
  * @covers GATE-09
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitEnv } from "../setup/bun-test-preload";

function gitOut(args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): string {
  const r = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    env: opts.env,
  });
  return new TextDecoder().decode(r.stdout).trim();
}

describe("i test non ereditano gli hook git della macchina", () => {
  test("gitEnv() impone un hooksPath che non esiste", () => {
    // Not the empty string: git would resolve it as a path relative to the
    // repo and would end up using `<repo>/.git/hooks`, i.e. exactly what we
    // want to avoid. Measured: it answered `/Users/.../topics-app/.git/hooks`.
    expect(gitOut(["config", "--get", "core.hooksPath"], { env: gitEnv() })).toBe(
      "/nonexistent/topics-test-hooks",
    );
  });

  test("gitEnv() spegne la firma dei commit", () => {
    // Whoever signs their commits must not be asked for the passphrase by a
    // test suite: the prompt reaches nobody and the test hangs.
    expect(gitOut(["config", "--get", "commit.gpgsign"], { env: gitEnv() })).toBe("false");
  });

  test("un commit vero riesce, senza identita' configurata sulla macchina", () => {
    // The isolation must not break what it isolates: git refuses to commit with
    // no identity, so the test SUPPLIES one — with the two variables git reads
    // before any config file.
    //
    // The comment here used to say `gitEnv()` provided it. It does not, and
    // deliberately: the note above `isolateGitFromEnvironment` explains why an
    // identity must not go into the preload (it would make
    // `git-identity.test.ts`, which simulates a machine WITHOUT one, impossible
    // to write) and even names the consequence — "the commit that on a runner
    // with no identity exits 128".
    //
    // That is exactly what happened on 2026-08-26: green on every developer Mac,
    // where git falls back to user@host, and red on the CI runner, which has no
    // identity at all. The fault was not in the isolation: it was a test relying
    // on a courtesy of the machine it was written on. Reproduced locally by
    // taking that courtesy away (`user.useConfigOnly=true` plus no global
    // config): exit 128, "no email was given and auto-detection is disabled".
    const d = mkdtempSync(join(tmpdir(), "guardia-hook-"));
    const env = gitEnv({
      GIT_AUTHOR_NAME: "Prova", GIT_AUTHOR_EMAIL: "prova@example.invalid",
      GIT_COMMITTER_NAME: "Prova", GIT_COMMITTER_EMAIL: "prova@example.invalid",
    });
    Bun.spawnSync(["git", "-C", d, "init", "-q", "-b", "main"], { env });
    writeFileSync(join(d, "f.txt"), "x");
    Bun.spawnSync(["git", "-C", d, "add", "-A"], { env });
    const r = Bun.spawnSync(["git", "-C", d, "commit", "-q", "-m", "prova"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    // The message on failure, not just the number: `128` alone sends you to read
    // git's source, while its own line says what is missing.
    expect(`${r.exitCode} ${new TextDecoder().decode(r.stderr).split("\n")[0]}`.trim()).toBe("0");
  });

  test("gitEnv() accetta aggiunte senza perdere le chiavi di git", () => {
    // Whoever needs a variable of their own must not rebuild the environment
    // by hand: doing so is the way the isolation gets lost again.
    const env = gitEnv({ MIA_VARIABILE: "42" });
    expect(env.MIA_VARIABILE).toBe("42");
    expect(gitOut(["config", "--get", "core.hooksPath"], { env })).toBe("/nonexistent/topics-test-hooks");
  });

  test("il preload da solo NON basta: senza env esplicito l'isolamento si perde", () => {
    // This is the lesson that costs: `Bun.spawnSync` does not inherit what the
    // preload added to `process.env` at runtime. If one day bun changed its
    // mind, this test would go red and rightly so: it would mean that
    // `env: gitEnv()` is no longer needed, and this guard is to be rewritten.
    expect(gitOut(["config", "--get", "core.hooksPath"])).not.toBe("/nonexistent/topics-test-hooks");
  });
});
