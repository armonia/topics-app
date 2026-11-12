/**
 * `GET /api/git/log` on a directory that is not a git repository used to
 * answer 200 with `[]`: `git log`'s own non-zero exit was never checked, so a
 * real fault read exactly like "this repo has no commits yet".
 *
 * @covers FILE-02
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesRouter } from "./files";
import { gitEnv } from "../../tests/setup/bun-test-preload";

let root = "";
let repo = "";
let notARepo = "";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: gitEnv() });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

const router = createFilesRouter({
  readJSON: (req: Request) => req.json(),
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  errorResponse: (status: number, msg: string) => new Response(JSON.stringify({ error: msg }), { status }),
  resolveProjectPath: (p: string) => p,
} as never);

async function logRoute(dir: string) {
  const url = new URL(`http://x/api/git/log?path=${encodeURIComponent(dir)}`);
  const res = (await router(new Request(url), url, url.pathname, "GET"))!;
  return { status: res.status, body: await res.json() };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "git-log-fault-"));
  repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "one");

  notARepo = join(root, "plain");
  mkdirSync(notARepo, { recursive: true });
  writeFileSync(join(notARepo, "f.txt"), "f");
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe("GET /api/git/log", () => {
  test("a real repository still answers 200 with its commits", async () => {
    const r = await logRoute(repo);
    expect(r.status).toBe(200);
    expect((r.body as unknown[]).length).toBe(1);
  });

  test("a directory that is not a git repository answers an error, never 200 with []", async () => {
    const r = await logRoute(notARepo);
    expect(r.status).not.toBe(200);
    expect(r.body).toHaveProperty("error");
  });
});
