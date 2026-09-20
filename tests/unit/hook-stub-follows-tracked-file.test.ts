/**
 * THE HOOK THAT RAN YESTERDAY'S CODE.
 *
 * On 20/09 a fix to `scripts/git-hooks/pre-push` was written, committed and
 * pushed, and the push still ran the version from the night before: the
 * installer used `cp`, so `.git/hooks/pre-push` was a snapshot taken whenever
 * someone last ran the script. Nothing reported the drift, and the symptom was
 * the worst kind: a gate that looks installed and is not the one in the repo.
 *
 * The cure is structural, so this test pins the STRUCTURE rather than the
 * contents: the installed file must FORWARD to the tracked one. A test that
 * compared the two texts would pass with `cp` too, right up to the next edit.
 *
 * It also pins the two properties the forwarding depends on, both load-bearing
 * for the pre-push chain: stdin must reach the real hook (`check-push-clean.ts`
 * reads the refs being pushed from it, and a guard reading an empty stdin
 * blocks nothing), and the exit code must come back unchanged (that guard
 * REFUSES by exiting non-zero).
 */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const INSTALLER = join(ROOT, "scripts", "install-graphify-hooks.sh");

const work = mkdtempSync(join(tmpdir(), "hook-stub-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/**
 * A throwaway repo carrying the REAL installer and a pre-push that reports what
 * it received. The hook is a stand-in on purpose: this measures the wiring, not
 * what the production hook decides.
 */
function repoWithHooks(): string {
  const repo = join(work, "repo");
  mkdirSync(join(repo, "scripts", "git-hooks"), { recursive: true });
  git(work, "init", "--initial-branch=main", repo);

  // Copy the real installer verbatim: rewriting it here would test a replica.
  const installer = Bun.spawnSync(["cat", INSTALLER]).stdout.toString();
  writeFileSync(join(repo, "scripts", "install-graphify-hooks.sh"), installer);

  writeFileSync(
    join(repo, "scripts", "git-hooks", "pre-push"),
    '#!/usr/bin/env bash\nread -r line\necho "STDIN:$line"\necho "ARG:$1"\nexit 7\n',
  );
  chmodSync(join(repo, "scripts", "git-hooks", "pre-push"), 0o755);

  const r = Bun.spawnSync(["bash", join(repo, "scripts", "install-graphify-hooks.sh")], { cwd: repo });
  if (r.exitCode !== 0) throw new Error(`installer: ${r.stderr.toString()}`);
  return repo;
}

const repo = repoWithHooks();
const installed = join(repo, ".git", "hooks", "pre-push");

test("the installed hook forwards to the tracked file instead of copying it", () => {
  const text = Bun.spawnSync(["cat", installed]).stdout.toString();
  expect(text).toContain("scripts/git-hooks/pre-push");
  expect(text).toContain("exec");
  // The stand-in's own body must NOT be there: that would mean a snapshot.
  expect(text).not.toContain("STDIN:");
});

test("an edit to the tracked hook takes effect with no reinstall", () => {
  writeFileSync(
    join(repo, "scripts", "git-hooks", "pre-push"),
    '#!/usr/bin/env bash\necho "SECOND VERSION"\nexit 0\n',
  );
  const r = Bun.spawnSync(["bash", installed], { cwd: repo, stdin: new Blob([""]) });
  expect(r.stdout.toString()).toContain("SECOND VERSION");
});

test("stdin and the exit code survive the forwarding", () => {
  // Both matter to the real chain: the guard reads the refs from stdin and
  // refuses by exiting non-zero.
  writeFileSync(
    join(repo, "scripts", "git-hooks", "pre-push"),
    '#!/usr/bin/env bash\nread -r line\necho "STDIN:$line"\necho "ARG:$1"\nexit 7\n',
  );
  const r = Bun.spawnSync(["bash", installed, "origin"], {
    cwd: repo,
    stdin: new Blob(["refs/heads/main abc123 refs/heads/main def456\n"]),
  });
  expect(r.stdout.toString()).toContain("STDIN:refs/heads/main abc123");
  expect(r.stdout.toString()).toContain("ARG:origin");
  expect(r.exitCode).toBe(7);
});

test("a missing tracked hook is a no-op, not an explosion", () => {
  // Checking out an older commit removes the file: the push must still work.
  rmSync(join(repo, "scripts", "git-hooks", "pre-push"));
  const r = Bun.spawnSync(["bash", installed], { cwd: repo, stdin: new Blob([""]) });
  expect(r.exitCode).toBe(0);
});
