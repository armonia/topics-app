/**
 * `/api/git/log` and `/api/git/commit-files` both open with a `git rev-parse
 * --show-toplevel` to find the subdirectory scope (`repoPrefixOf`). That
 * lookup's result was read without ever checking `timedOut`: a TIMEOUT
 * (slow filesystem, a stuck git) produced the exact same empty string as "not
 * a git repo", so the route silently fell back to an UNSCOPED log/commit-files
 * lookup with 200, instead of surfacing the real failure.
 *
 * Mutant check (done by hand, not asserted here): remove the `timedOut` guard
 * on the rev-parse lookup in server/routes/files.ts and these two tests go
 * from 500 back to 200.
 *
 * Regression this must NOT break: a fresh `git init` repo with no commits yet
 * is a LEGITIMATE "no log", not a failure — `git log`'s own non-zero exit
 * (not a timeout) must still answer 200 with an empty list.
 *
 * The fake `git` here always sleeps, same technique as `files.git-hung.test.ts`:
 * a separate process picks up the fake PATH entry (`Bun.spawn` snapshots PATH
 * at process start), and `TOPICS_SPAWN_TIMEOUT_CAP_MS` brings every deadline
 * down from 30 s to 300 ms.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesRouter } from "./files";
import { gitEnv } from "../../tests/setup/bun-test-preload";

let out: { log: { status: number; body: unknown }; commitFiles: { status: number; body: unknown } };

beforeAll(async () => {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "git-log-timeout-bin-"));
  writeFileSync(join(fakeBinDir, "git"), "#!/bin/sh\nsleep 30\n");
  chmodSync(join(fakeBinDir, "git"), 0o755);
  const repoDir = mkdtempSync(join(tmpdir(), "git-log-timeout-repo-"));
  const proc = Bun.spawn(["bun", join(import.meta.dir, "files.git-log-timeout.fixture.ts"), repoDir], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, TOPICS_SPAWN_TIMEOUT_CAP_MS: "300" },
  });
  const [text, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  try {
    out = JSON.parse(text.trim().split("\n").pop() ?? "{}");
  } catch {
    throw new Error(`the fixture printed no JSON: ${text.slice(0, 300)} ${err.slice(0, 300)}`);
  }
  rmSync(fakeBinDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
}, 20_000);

describe("rev-parse timeout must surface as a real error, not a silently unscoped 200", () => {
  test("GET /api/git/log answers 500 when the scope lookup times out", () => {
    expect(out.log.status).toBe(500);
  });

  test("GET /api/git/commit-files answers 500 when the scope lookup times out", () => {
    expect(out.commitFiles.status).toBe(500);
  });
});

describe("regression: a repo with no commits yet is 200 [], not an error", () => {
  let repo = "";
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "git-log-no-commits-"));
    Bun.spawnSync(["git", "-c", "init.defaultBranch=main", "init"], { cwd: repo, env: gitEnv() });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("GET /api/git/log on an unborn branch answers 200 with an empty list", async () => {
    const router = createFilesRouter({
      readJSON: (req: Request) => req.json(),
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      errorResponse: (status: number, msg: string) => new Response(JSON.stringify({ error: msg }), { status }),
      resolveProjectPath: (p: string) => p,
    } as never);
    const url = new URL(`http://x/api/git/log?path=${encodeURIComponent(repo)}`);
    const res = await router(new Request(url), url, url.pathname, "GET");
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual([]);
  });
});
