/**
 * A `git` that does not answer must not hold the request hanging.
 *
 * The `/api/git/*` routes launched git with `Bun.spawn` and waited for the end
 * of the STREAM: a blocked git (slow file system, a hook, a credential helper)
 * or one of its children holding the pipe kept the request, and with it the
 * panel's spinner, until the process died on its own. Every call now has a real
 * deadline (`lib/bounded-spawn.ts`).
 *
 * The `git` here is fake: a script that launches a `sleep 30` child (the case a
 * bare `proc.kill()` does not settle: the `sleep` holds the pipe). It runs in a
 * separate process because `Bun.spawn` uses the PATH of when the process
 * started. `TOPICS_SPAWN_TIMEOUT_CAP_MS` brings every call's deadline down to
 * 300 ms, otherwise the test would last as long as the real one (30 s and more).
 *
 * @covers GIT-DEADLINE-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
let out: Record<string, { ms: number; status: number }> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "git-hung-"));
  writeFileSync(join(dir, "git"), "#!/bin/sh\nsleep 30\n");
  chmodSync(join(dir, "git"), 0o755);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "files.git-hung.fixture.ts"), dir], {
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

describe("git routes with a git that does not answer", () => {
  test("GET /api/git/diff returns at the deadline, not after 30 seconds", () => {
    expect(out.diff!.ms).toBeLessThan(3000);
  });

  test("GET /api/git/log returns at the deadline", () => {
    expect(out.log!.ms).toBeLessThan(3000);
  });

  test("POST /api/git/stage-all answers with an error at the deadline", () => {
    expect(out.stageAll!.ms).toBeLessThan(3000);
    expect(out.stageAll!.status).toBe(400);
  });

  test("POST /api/git/pull: the declared timeout is a deadline on the answer", () => {
    expect(out.pull!.ms).toBeLessThan(3000);
    expect(out.pull!.status).toBe(504);
  });
});
