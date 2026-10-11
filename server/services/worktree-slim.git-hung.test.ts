/**
 * The slim step deletes directories only when git SAYS nothing tracked lives under
 * them. A git that does not answer must not be read as "nothing tracked".
 *
 * `ls-files` is gate 2. With a deadline on every git call, a timed-out `ls-files`
 * comes back as code 128 and an empty output; read without looking at the code
 * that is an empty list, the guard skips, and a directory with a tracked file in
 * it (`git add -f` inside an ignored path) is deleted. Gate 1 already looked at
 * the code; gate 2 now does too.
 *
 * The fake `git` answers `check-ignore` ("everything is ignored") and hangs on
 * `ls-files`. It runs in a separate process because `Bun.spawn` resolves binaries
 * with the PATH of when the process started.
 * @covers GIT-DEADLINE-01
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
let out: { result: { removed: unknown[]; refused: { relPath: string; reason: string }[] }; stillThere: boolean } = {
  result: { removed: [{}], refused: [] },
  stillThere: false,
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "slim-hung-"));
  const bin = join(dir, "bin");
  const root = join(dir, "wt");
  mkdirSync(bin);
  mkdirSync(join(root, ".next"), { recursive: true });
  writeFileSync(join(root, ".next", "tracked.txt"), "a tracked file nobody told us about");
  writeFileSync(join(bin, "git"), '#!/bin/sh\nfor a; do if [ "$a" = "ls-files" ]; then sleep 30; exit 0; fi; done\ncat\n');
  chmodSync(join(bin, "git"), 0o755);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "worktree-slim.git-hung.fixture.ts"), root], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TOPICS_SPAWN_TIMEOUT_CAP_MS: "300" },
  });
  const [text, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  try {
    out = JSON.parse(text.trim().split("\n").pop() ?? "{}");
  } catch {
    throw new Error(`the fixture printed no JSON: ${text.slice(0, 300)} ${err.slice(0, 300)}`);
  }
}, 40_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a git that does not answer on ls-files leaves the directory alone", () => {
  expect(out.stillThere).toBe(true);
  expect(out.result.removed).toEqual([]);
});

test("and says why: git did not answer", () => {
  expect(out.result.refused).toEqual([{ relPath: ".next", reason: "git non ha risposto" }]);
});
