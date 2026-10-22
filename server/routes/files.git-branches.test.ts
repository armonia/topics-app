/**
 * `GET /api/git/branches` takes the distance from each upstream out of the one
 * `git branch` listing (`%(upstream:track)`) instead of one `git rev-list
 * --left-right --count` per branch, in series. The answer must not change: it
 * is compared here with the one the old algorithm builds, on a real clone with
 * a branch level with its upstream, ahead, behind, both, one whose upstream is
 * gone, one with no upstream, and a detached HEAD.
 *
 * @covers FILE-02
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesRouter } from "./files";
import { parseBranchLines } from "../lib/git-branch-refs";
import { gitEnv } from "../../tests/setup/bun-test-preload";

let root = "";
let work = "";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: gitEnv() });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function commit(cwd: string, name: string): void {
  writeFileSync(join(cwd, name), name);
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", name);
}

const router = createFilesRouter({
  readJSON: (req: Request) => req.json(),
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  errorResponse: (status: number, msg: string) => new Response(JSON.stringify({ error: msg }), { status }),
  resolveProjectPath: (p: string) => p,
} as never);

async function branchesRoute(dir: string): Promise<unknown> {
  const url = new URL(`http://x/api/git/branches?path=${encodeURIComponent(dir)}`);
  const res = await router(new Request(url), url, url.pathname, "GET");
  return res!.json();
}

/** The answer as the route built it before: four fields, then a `rev-list` per local branch with an upstream. */
function oldAnswer(dir: string): unknown[] {
  const text = git(dir, "branch", "-a", "--format=%(refname)|%(refname:short)|%(HEAD)|%(upstream:short)").trim();
  const out: Array<Record<string, unknown>> = [];
  for (const ref of parseBranchLines(text)) {
    let ahead = 0, behind = 0;
    if (!ref.isRemote && ref.upstream) {
      const r = Bun.spawnSync(["git", "rev-list", "--left-right", "--count", `${ref.name}...${ref.upstream}`], { cwd: dir, stdout: "pipe", stderr: "pipe", env: gitEnv() });
      const parts = r.stdout.toString().trim().split(/\s+/);
      if (parts.length >= 2) { ahead = parseInt(parts[0]!) || 0; behind = parseInt(parts[1]!) || 0; }
    }
    const entry: Record<string, unknown> = { name: ref.name, current: ref.current, isRemote: ref.isRemote, ahead, behind };
    if (ref.isRemote) { entry.remote = ref.remote; entry.shortName = ref.shortName; }
    out.push(entry);
  }
  if (out.length > 0 && !out.some((b) => b.current)) {
    out.unshift({ name: git(dir, "rev-parse", "--short", "HEAD").trim(), current: true, isRemote: false, ahead: 0, behind: 0 });
  }
  return out;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "git-branches-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  work = join(root, "work");
  git(root, "init", "-q", "--bare", origin);
  git(root, "init", "-q", seed);
  commit(seed, "base");
  git(seed, "remote", "add", "origin", origin);
  for (const b of ["level", "ahead", "behind", "both", "gone"]) git(seed, "branch", b);
  git(seed, "push", "-q", "origin", "--all");
  git(root, "clone", "-q", origin, work);
  for (const b of ["level", "ahead", "behind", "both", "gone"]) git(work, "branch", "-q", "--track", b, `origin/${b}`);
  git(work, "branch", "-q", "local-only");
  // The remote moves: `behind` gains 3, `both` gains 2, `gone` is deleted.
  git(seed, "checkout", "-q", "behind");
  for (const n of ["b1", "b2", "b3"]) commit(seed, n);
  git(seed, "checkout", "-q", "both");
  for (const n of ["c1", "c2"]) commit(seed, n);
  git(seed, "push", "-q", "origin", "behind", "both");
  git(seed, "push", "-q", "origin", "--delete", "gone");
  git(work, "fetch", "-q", "--prune", "origin");
  // The clone moves: `ahead` gains 2, `both` gains 1.
  git(work, "checkout", "-q", "ahead");
  for (const n of ["a1", "a2"]) commit(work, n);
  git(work, "checkout", "-q", "both");
  commit(work, "d1");
  git(work, "checkout", "-q", "main");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("GET /api/git/branches", () => {
  test("the same answer as one rev-list per branch", async () => {
    const answer = await branchesRoute(work);
    expect(answer).toEqual(oldAnswer(work));
    // And the fixture really has every case in it.
    const byName = new Map((answer as Array<{ name: string; ahead: number; behind: number }>).map((b) => [b.name, b]));
    expect(byName.get("ahead")).toMatchObject({ ahead: 2, behind: 0 });
    expect(byName.get("behind")).toMatchObject({ ahead: 0, behind: 3 });
    expect(byName.get("both")).toMatchObject({ ahead: 1, behind: 2 });
    expect(byName.get("gone")).toMatchObject({ ahead: 0, behind: 0 });
    expect(byName.get("level")).toMatchObject({ ahead: 0, behind: 0 });
    expect(byName.get("local-only")).toMatchObject({ ahead: 0, behind: 0 });
  });

  test("a detached HEAD: the same answer, with the HEAD entry first", async () => {
    git(work, "checkout", "-q", "--detach", "ahead");
    try {
      const answer = await branchesRoute(work);
      expect(answer).toEqual(oldAnswer(work));
      expect((answer as Array<{ current: boolean }>)[0]!.current).toBe(true);
    } finally {
      git(work, "checkout", "-q", "main");
    }
  });
});
