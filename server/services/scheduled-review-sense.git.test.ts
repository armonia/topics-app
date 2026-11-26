/**
 * "Already on main" against a real remote: the fetch comes first, and "could not tell" is never "false".
 *
 * @covers LAND-17
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { falseMainClaims, isOnMain } from "./scheduled-review-sense";

const root = mkdtempSync(join(tmpdir(), "sense-git-"));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

function commitFile(dir: string, name: string): string {
  writeFileSync(join(dir, name), name);
  git(dir, "add", name);
  git(dir, "commit", "-q", "-m", name);
  return git(dir, "rev-parse", "HEAD");
}

function setup() {
  const remote = join(root, `remote-${Math.random().toString(36).slice(2)}`);
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const mine = `${remote}-mine`;
  const other = `${remote}-other`;
  git(root, "clone", "-q", remote, mine);
  git(root, "clone", "-q", remote, other);
  git(mine, "checkout", "-q", "-B", "main");
  commitFile(mine, "base.txt");
  git(mine, "push", "-q", "origin", "main");
  return { mine, other };
}

describe("already on main, checked against the remote as it is now", () => {
  test("a commit pushed after this machine last fetched is found on main", async () => {
    const { mine, other } = setup();
    git(other, "pull", "-q", "origin", "main");
    const sha = commitFile(other, "late.txt");
    git(other, "push", "-q", "origin", "main");
    // `mine` has not fetched: without the fetch first, origin/main does not have it yet.
    expect(await isOnMain(mine, sha)).toBe(true);
    expect(await falseMainClaims(mine, `già su main ${sha.slice(0, 8)}`)).toEqual([]);
  });

  test("a commit that is not on main, and one the repository never had, are a clean false", async () => {
    const { mine } = setup();
    const local = commitFile(mine, "local.txt");
    expect(await isOnMain(mine, local)).toBe(false);
    expect(await isOnMain(mine, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBe(false);
    expect(await falseMainClaims(mine, `già su main ${local.slice(0, 8)} e 31423024`)).toContain(local.slice(0, 8));
  });

  test("a fetch that fails says nothing: null, never false", async () => {
    const { mine } = setup();
    const sha = commitFile(mine, "x.txt");
    git(mine, "remote", "set-url", "origin", join(root, "does-not-exist"));
    expect(await isOnMain(mine, sha)).toBeNull();
    expect(await falseMainClaims(mine, `already on main ${sha.slice(0, 8)}`)).toBeNull();
  });

  test("a repository that does not exist is not a verdict either", async () => {
    expect(await isOnMain(join(root, "nowhere"), "abcdef1234")).toBeNull();
  });
});
