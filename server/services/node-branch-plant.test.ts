/**
 * Planting a node's delivery branch, with real temporary git repos and no network:
 * a bare `origin`, a `node` clone (where the work happens) and a `mac` clone (the
 * checkout the branch is planted in).
 *
 * The case that matters: the node forked from an `origin/main` newer than the
 * Mac's last fetch. The base commit is then missing on the Mac only because the
 * clone is behind, and ONE fetch of origin must repair it. When origin does not
 * have it either, the card gets the reason, not a full-history bundle.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeBranchPlanter } from "./node-branch-plant";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();
}

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `edit ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

let root: string;
let origin: string;
let node: string;
let mac: string;
let baseSha: string;
let bundleBytes: Uint8Array;
let nodeTip: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "topics-plant-test-"));
  origin = join(root, "origin.git");
  node = join(root, "node");
  mac = join(root, "mac");
  const seed = join(root, "seed");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: GIT_ENV });
  execFileSync("git", ["init", "-q", "-b", "main", seed], { env: GIT_ENV });
  commit(seed, "a.txt", "one");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  // The Mac clones NOW, so it will be behind the commit pushed next.
  execFileSync("git", ["clone", "-q", origin, mac], { env: GIT_ENV });
  // Origin moves on: this is the newer main the node fetched.
  baseSha = commit(seed, "b.txt", "two");
  git(seed, "push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, node], { env: GIT_ENV });
  git(node, "switch", "-q", "-c", "card/work");
  nodeTip = commit(node, "c.txt", "three");
  const bundleFile = join(root, "work.bundle");
  git(node, "bundle", "create", bundleFile, "card/work", "--not", baseSha);
  bundleBytes = new Uint8Array(readFileSync(bundleFile));
}, 120_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function freshMac(name: string): string {
  const dir = join(root, name);
  execFileSync("git", ["clone", "-q", "--no-local", mac, dir], { env: GIT_ENV });
  // Same origin as the real Mac checkout, so a fetch there reaches the bare repo.
  git(dir, "remote", "set-url", "origin", origin);
  return dir;
}

function planterFor(repo: string) {
  return createNodeBranchPlanter({ repoPathOf: () => repo });
}

// Real git on a busy machine: generous per-test deadlines, the work itself is tiny.
const T = 60_000;

describe("plantBranch, base commit precondition", () => {
  test("base present on the Mac: the bundle is planted", async () => {
    const repo = freshMac("mac-present");
    git(repo, "fetch", "-q", "origin");
    expect(git(repo, "cat-file", "-t", baseSha)).toBe("commit");
    const r = await planterFor(repo).plantBranch({ projectId: "p", branch: "card/work", baseSha, bundle: bundleBytes });
    expect(r).toEqual({ planted: true, commit: nodeTip, reason: null });
    expect(git(repo, "rev-parse", "refs/heads/card/work")).toBe(nodeTip);
  }, T);

  test("base missing on the Mac but present on origin: one fetch, then planted", async () => {
    const repo = freshMac("mac-behind");
    expect(() => git(repo, "cat-file", "-e", `${baseSha}^{commit}`)).toThrow();
    const r = await planterFor(repo).plantBranch({ projectId: "p", branch: "card/work", baseSha, bundle: bundleBytes });
    expect(r).toEqual({ planted: true, commit: nodeTip, reason: null });
    expect(git(repo, "cat-file", "-t", baseSha)).toBe("commit");
  }, T);

  test("base missing everywhere: declined, and the reason says a fetch was tried", async () => {
    const repo = freshMac("mac-nowhere");
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const r = await planterFor(repo).plantBranch({ projectId: "p", branch: "card/work", baseSha: missing, bundle: bundleBytes });
    expect(r.planted).toBe(false);
    expect(r.commit).toBeNull();
    expect(r.reason).toContain("01234567");
    expect(r.reason).toContain("nemmeno dopo un fetch di origin");
    expect(() => git(repo, "rev-parse", "--verify", "-q", "refs/heads/card/work")).toThrow();
  }, T);

  test("the fetch is asked once, bounded, and never prompts", async () => {
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const planter = createNodeBranchPlanter({
      repoPathOf: () => "/nowhere",
      runGit: async (_cwd, args, opts) => {
        calls.push({ args, env: opts?.env });
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    const r = await planter.plantBranch({ projectId: "p", branch: "card/work", baseSha, bundle: bundleBytes });
    expect(r.planted).toBe(false);
    const fetches = calls.filter((c) => c.args[0] === "fetch");
    expect(fetches).toHaveLength(1);
    expect(fetches[0].args).toEqual(["fetch", "--no-tags", "origin"]);
    expect(fetches[0].env?.GIT_TERMINAL_PROMPT).toBe("0");
  }, T);

  test("a branch of the same name that is not an ancestor is refused, not rewritten", async () => {
    const repo = freshMac("mac-diverged");
    git(repo, "fetch", "-q", "origin");
    git(repo, "switch", "-q", "-c", "card/work", baseSha);
    const own = commit(repo, "local.txt", "mine");
    git(repo, "switch", "-q", "main");
    const r = await planterFor(repo).plantBranch({ projectId: "p", branch: "card/work", baseSha, bundle: bundleBytes });
    expect(r.planted).toBe(false);
    expect(r.reason).toContain("git fetch dal bundle è fallito");
    expect(git(repo, "rev-parse", "refs/heads/card/work")).toBe(own);
  }, T);
});
