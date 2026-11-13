/**
 * Planting a node's delivery branch, with real temporary git repos and no network:
 * a bare `origin`, a `node` clone (where the work happens) and a `mac` clone (the
 * checkout the branch is planted in).
 *
 * The case that matters: the node forked from an `origin/main` newer than the
 * Mac's last fetch. The base commit is then missing on the Mac only because the
 * clone is behind, and ONE fetch of origin must repair it. When origin does not
 * have it either, the card gets the reason, not a full-history bundle.
 *
 * @covers KANBAN-76
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
    expect(r).toEqual({ planted: true, commit: nodeTip, commitCount: 1, reason: null });
    expect(git(repo, "rev-parse", "refs/heads/card/work")).toBe(nodeTip);
  }, T);

  test("base missing on the Mac but present on origin: one fetch, then planted", async () => {
    const repo = freshMac("mac-behind");
    expect(() => git(repo, "cat-file", "-e", `${baseSha}^{commit}`)).toThrow();
    const r = await planterFor(repo).plantBranch({ projectId: "p", branch: "card/work", baseSha, bundle: bundleBytes });
    expect(r).toEqual({ planted: true, commit: nodeTip, commitCount: 1, reason: null });
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
    expect(r.reason).toContain(own.slice(0, 8));
    expect(git(repo, "rev-parse", "refs/heads/card/work")).toBe(own);
  }, T);
});

describe("plantBranch, re-delivery from the same node", () => {
  // The node restarted FROM ITS OWN BRANCH, without the realign merge the
  // board had put on the local branch before the previous round (KANBAN-76
  // follow-up): the local branch is `bundleOld + "bring main in"`, the new
  // bundle is `bundleOld + one more commit`. Neither is an ancestor of the
  // other, so the plain fetch is a non-fast-forward — and the branch should
  // still move, because the local-only commits carry nothing of the card's own.
  test("local-only commits that are ONLY a board realign are fast-forwarded past", async () => {
    const repo = join(root, "mac-realign-only");
    execFileSync("git", ["clone", "-q", "--no-local", mac, repo], { env: GIT_ENV });
    git(repo, "remote", "set-url", "origin", origin);
    git(repo, "fetch", "-q", "origin");

    // First round: plant the bundle as-is (base -> one commit).
    const first = await planterFor(repo).plantBranch({ projectId: "p", branch: "card/work", baseSha, bundle: bundleBytes });
    expect(first.planted).toBe(true);
    const bundleOldTip = first.commit!;

    // Origin moves on: this is what the board's realign merges into the branch.
    const seed2 = join(root, "seed2");
    execFileSync("git", ["clone", "-q", origin, seed2], { env: GIT_ENV });
    commit(seed2, "d.txt", "four");
    git(seed2, "push", "-q", "origin", "main");

    // The board's own realign, before a land that never happened.
    git(repo, "fetch", "-q", "origin");
    git(repo, "switch", "-q", "card/work");
    git(repo, "merge", "-q", "--no-edit", "-m", "Riporta main nel ramo prima del land", "origin/main");
    const localTip = git(repo, "rev-parse", "card/work");
    expect(localTip).not.toBe(bundleOldTip);
    git(repo, "switch", "-q", "main");

    // The node, unaware of the realign, restarted from its OWN bundle tip and
    // added one more commit.
    const extraTip = commit(node, "e.txt", "five");
    const bundle2File = join(root, "redelivered.bundle");
    git(node, "bundle", "create", bundle2File, "card/work", "--not", baseSha);
    const bundle2 = new Uint8Array(readFileSync(bundle2File));

    const second = await planterFor(repo).plantBranch({ projectId: "p", branch: "card/work", baseSha, bundle: bundle2 });
    expect(second).toEqual({ planted: true, commit: extraTip, commitCount: 2, reason: null });
    expect(git(repo, "rev-parse", "card/work")).toBe(extraTip);
  }, T);
});
