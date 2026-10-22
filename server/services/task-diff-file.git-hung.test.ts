/**
 * A blob streamed with a fixed `Content-Length` must not end short and look done.
 *
 * `serveDiffBlob` promises `size` bytes and streams git's stdout; when git's
 * deadline closed the pipe halfway, the client got fewer bytes than promised as a
 * clean end of body, under `Cache-Control: immutable` for a year. The body now
 * errors when it ends short, so the transfer is aborted and nothing truncated is
 * cached. A complete blob is unaffected.
 *
 * The fake `git` writes ten bytes and then hangs (or writes everything). It runs
 * in a separate process because `Bun.spawn` resolves binaries with the PATH of
 * when the process started.
 * @covers GIT-DEADLINE-01
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Out { status: number; contentLength: string | null; outcome: string; bytes: number; ms: number }
let dir = "";

async function run(fakeGit: string, size: number): Promise<Out> {
  writeFileSync(join(dir, "git"), fakeGit);
  chmodSync(join(dir, "git"), 0o755);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "task-diff-file.git-hung.fixture.ts"), String(size)], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TOPICS_SPAWN_TIMEOUT_CAP_MS: "300" },
  });
  const [text, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  try {
    return JSON.parse(text.trim().split("\n").pop() ?? "{}");
  } catch {
    throw new Error(`the fixture printed no JSON: ${text.slice(0, 300)} ${err.slice(0, 300)}`);
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "diff-blob-hung-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a git that stops halfway aborts the body instead of ending it short", async () => {
  const out = await run("#!/bin/sh\nprintf 0123456789\nsleep 30\n", 100);
  expect(out.status).toBe(200);
  expect(out.contentLength).toBe("100");
  expect(out.outcome).toBe("errored");
  expect(out.ms).toBeLessThan(3000);
}, 20_000);

test("a blob that arrives whole is served whole", async () => {
  const out = await run("#!/bin/sh\nprintf 0123456789\n", 10);
  expect(out.outcome).toBe("complete");
  expect(out.bytes).toBe(10);
}, 20_000);
