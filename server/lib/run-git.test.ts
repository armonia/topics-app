/**
 * One runner, one answer to "git did not answer": exit 124.
 *
 * Four services carried their own copy of the runner, and on a timeout two
 * answered 124 while two answered 1. Exit 1 is a real verdict for many git
 * questions, so the copies that answered 1 turned a silent git into an answer.
 * The fake `git` hangs on `log`; with the deadline capped at 300 ms every
 * runner must come back with 124.
 *
 * @covers GIT-DEADLINE-01
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./run-git";

let dir = "";
let codes: Record<string, number> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "run-git-hung-"));
  const bin = join(dir, "bin");
  const repo = join(dir, "repo");
  mkdirSync(bin);
  mkdirSync(repo);
  writeFileSync(join(bin, "git"), '#!/bin/sh\nfor a; do if [ "$a" = "log" ]; then sleep 30; exit 0; fi; done\nexit 0\n');
  chmodSync(join(bin, "git"), 0o755);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "run-git.timeout.fixture.ts"), repo], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TOPICS_SPAWN_TIMEOUT_CAP_MS: "300" },
  });
  const [text, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  try {
    codes = JSON.parse(text.trim().split("\n").pop() ?? "{}");
  } catch {
    throw new Error(`the fixture printed no JSON: ${text.slice(0, 300)} ${err.slice(0, 300)}`);
  }
}, 40_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a timeout is 124 for every runner, never 1", () => {
  expect(codes).toEqual({
    runGit: 124,
    ownCommits: 124,
    taskAutomerge: 124,
    worktreeResidue: 124,
  });
});

test("a real answer passes through with its own code", async () => {
  const outside = mkdtempSync(join(tmpdir(), "run-git-plain-"));
  try {
    const no = await runGit(outside, ["rev-parse", "--is-inside-work-tree"], { timeoutMs: 30_000 });
    expect(no.code).toBe(128);
    const yes = await runGit(outside, ["--version"], { timeoutMs: 30_000 });
    expect(yes.code).toBe(0);
    expect(yes.stdout).toContain("version");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a missing binary or directory is 1 or a git error, never a timeout", async () => {
  const r = await runGit(join(tmpdir(), "run-git-does-not-exist-xyz"), ["status"], { timeoutMs: 30_000 });
  expect(r.code).not.toBe(0);
  expect(r.code).not.toBe(124);
});
