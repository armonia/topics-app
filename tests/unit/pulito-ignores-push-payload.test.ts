/**
 * THE GATE THAT REPORTED ITSELF.
 *
 * On 20/09 a `git push` of two commits printed, inside the very command that
 * was publishing them, this line:
 *   main ha 2 commit non spinti -> git push   allow-italian: the gate's own output, asserted verbatim below
 * This is not any old false positive: it is a warning that shows up on EVERY
 * push, because during pre-push the incoming commits are not on the remote yet
 * and `git rev-list upstream..main` is bound to count them. A gate that always
 * talks teaches people not to read it, and the day it is right nobody looks.
 *
 * Measured here on a real repo with a real remote (a `--bare` clone on disk),
 * because the defect lives exactly in the relation between `main` and its
 * upstream: with a fake one it would not exist.
 *
 * THE TWO HALVES OF THE SAME PROOF, and both are needed:
 *  - without `--in-push` the count MUST still see the commits (otherwise the
 *    cure would be "stop counting", and the gate would die quietly);
 *  - with `--in-push <sha>` it must go silent about THAT payload and nothing else.
 *
 * @covers GATE-15
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "check-repo-pulito.ts");

const work = mkdtempSync(join(tmpdir(), "pulito-push-"));
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
      // The real repo's hooks must not run inside the test bed.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }
  return r.stdout.toString().trim();
}

/** A repo with an upstream and two local unpushed commits, as at push time. */
function testBed(): { repo: string; shas: string[] } {
  const remote = join(work, "remote.git");
  const repo = join(work, "work");
  git(work, "init", "--bare", "--initial-branch=main", remote);
  git(work, "clone", remote, repo);

  writeFileSync(join(repo, "a.txt"), "uno\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "push", "-u", "origin", "main");

  const shas: string[] = [];
  for (const n of ["due", "tre"]) {
    writeFileSync(join(repo, "a.txt"), `${n}\n`);
    git(repo, "commit", "-am", n);
    shas.push(git(repo, "rev-parse", "HEAD"));
  }
  return { repo, shas };
}

function count(repo: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["bun", "run", SCRIPT, ...args], {
    cwd: repo,
    env: { ...process.env, TOPICS_PULITO_OK: "" },
  });
  return {
    code: r.exitCode ?? 1,
    out: r.stdout.toString() + r.stderr.toString(),
  };
}

const { repo, shas } = testBed();

test("without --in-push the unpushed commits are still reported", () => {
  const { code, out } = count(repo);
  expect(out).toContain("commit non spinti");
  expect(code).not.toBe(0);
});

test("with --in-push the push payload is not reported as a leftover", () => {
  // git passes the branch TIP: `--not <tip>` excludes its ancestors too.
  const { code, out } = count(repo, "--in-push", shas[shas.length - 1]!);
  expect(out).not.toContain("commit non spinti");
  expect(code).toBe(0);
});

test("a zero sha does not silence the count", () => {
  // A branch deletion arrives as an all-zero sha: it publishes nothing, and if
  // it reached `--not` the count would go quiet for the wrong reason.
  const { out } = count(repo, "--in-push", "0000000000000000000000000000000000000000");
  expect(out).toContain("commit non spinti");
});
