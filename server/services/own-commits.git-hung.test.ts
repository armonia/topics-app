/**
 * A `git` that does not answer is "no answer", not "verified outside".
 *
 * `commitIsIn` reads exit 1 of `merge-base --is-ancestor` as `false` ("the commit
 * is NOT in the ref") and the callers act on it (re-dispatch, publish). The
 * runner used to turn a deadline into code 1, which made a hung git look like
 * that verdict. It must stay `null` ("cannot tell: touch nothing").
 *
 * The fake `git` sleeps; the fixture runs in its own process because `Bun.spawn`
 * resolves binaries with the PATH of when the process started.
 * @covers GIT-DEADLINE-01
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
let out: { code: number; verdict: boolean | null } = { code: -1, verdict: false };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "own-commits-hung-"));
  writeFileSync(join(dir, "git"), "#!/bin/sh\nsleep 30\n");
  chmodSync(join(dir, "git"), 0o755);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "own-commits.git-hung.fixture.ts")], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TOPICS_SPAWN_TIMEOUT_CAP_MS: "300" },
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

test("a timed-out git is neither success nor the verdict 'outside'", () => {
  expect(out.code).not.toBe(0);
  expect(out.code).not.toBe(1);
});

test("commitIsIn answers null (cannot tell) when git does not answer", () => {
  expect(out.verdict).toBeNull();
});
