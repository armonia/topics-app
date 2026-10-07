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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
let out: Record<string, { ms: number; status: number }> & { leftovers?: { target: boolean; srcCopy: boolean } } = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "git-hung-"));
  writeFileSync(join(dir, "git"), "#!/bin/sh\nsleep 30\n");
  chmodSync(join(dir, "git"), 0o755);
  // A `cp` that writes part of the destination and then does not finish.
  writeFileSync(join(dir, "cp"), '#!/bin/sh\nfor a; do d="$a"; done\nmkdir -p "$d"; touch "$d/partial"\nsleep 30\n');
  chmodSync(join(dir, "cp"), 0o755);
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

describe("copy routes: a deadline removes the half copy", () => {
  test("POST /api/files/copy answers 504 and leaves no destination (a retry would be 409)", () => {
    expect(out.copy!.ms).toBeLessThan(3000);
    expect(out.copy!.status).toBe(504);
    expect(out.leftovers!.target).toBe(false);
  });

  test("POST /api/files/duplicate answers 504 and leaves no `copy` behind", () => {
    expect(out.duplicate!.ms).toBeLessThan(3000);
    expect(out.duplicate!.status).toBe(504);
    expect(out.leftovers!.srcCopy).toBe(false);
  });
});

describe("deadlines for legitimate long work", () => {
  // The values themselves cannot be observed from a test that caps every deadline,
  // so the choice is pinned in the text: 120 s is a limit near 250k files for `cp -r`
  // (about 2100 files/s measured) and a pre-push hook may take minutes.
  test("cp -r and duplicate use the long deadline, not the write one", () => {
    const src = readFileSync(join(import.meta.dir, "files.ts"), "utf8");
    const cp = src.match(/spawnBounded\(args, \{ stdout: "pipe", stderr: "pipe", timeoutMs: SPAWN_TIMEOUT\.(\w+) \}\)/g) ?? [];
    expect(cp.length).toBe(2);
    for (const c of cp) expect(c).toContain("SPAWN_TIMEOUT.long");
  });

  test("the publish push uses the long deadline", () => {
    const src = readFileSync(join(import.meta.dir, "tasks.ts"), "utf8");
    expect(src).toContain('runGitCap(path, ["push", "origin", branch], SPAWN_TIMEOUT.long)');
  });
});
