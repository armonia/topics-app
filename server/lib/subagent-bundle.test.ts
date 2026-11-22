/**
 * The round trip of a `spawn_agent` child sent to a node as a bundle
 * (sottoagenti-nodo, traccia 3): the parent's own snapshot goes out, the
 * child's branch comes back, and the parent's tree is never touched by the
 * step that leaves.
 *
 * Two temporary repos stand in for the parent (this Mac) and the node: no
 * `origin` anywhere, an agent's home, the case the proposal names.
 *
 * @covers SUBAGENT-26
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotParentAsBundle } from "./subagent-bundle";
import { plantCarriedBranch } from "../services/branch-on-origin";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: gitEnv });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

let roots: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe("subagent-bundle: andata, commit sul ramo, ritorno", () => {

  it("niente da fare due volte: un nome di ramo che esiste già viene rifiutato, non sovrascritto", async () => {
    const parent = tempDir("subagent-parent-");
    git(parent, "init", "-q", "-b", "main");
    writeFileSync(join(parent, "a.txt"), "base\n");
    git(parent, "add", ".");
    git(parent, "commit", "-q", "-m", "base");
    git(parent, "branch", "topics/already-here");

    const bundle = await snapshotParentAsBundle({ repoPath: parent, snapshotBranch: "topics/already-here" });
    expect(bundle).toBeNull();
    // The real branch is still pointing at the commit it had, untouched.
    expect(git(parent, "rev-parse", "topics/already-here")).toBe(git(parent, "rev-parse", "main"));
  });

  it("repo senza origin: bundleBranch cade sulla storia intera, non fallisce", async () => {
    const parent = tempDir("subagent-parent-");
    git(parent, "init", "-q", "-b", "main");
    writeFileSync(join(parent, "a.txt"), "base\n");
    git(parent, "add", ".");
    git(parent, "commit", "-q", "-m", "base");

    const bundle = await snapshotParentAsBundle({ repoPath: parent, snapshotBranch: "topics/no-origin-snapshot" });
    expect(bundle).not.toBeNull();
    expect(git(parent, "branch", "--list", "topics/no-origin-snapshot")).toBe("");
  });
});

describe("plantCarriedBranch on a node whose checkout is behind origin", () => {
  it("fetches origin once when the bundle's prerequisite commits are missing, then plants", async () => {
    // origin moves on; the sender has fetched it, the node has not.
    const origin = tempDir("subagent-origin-");
    git(origin, "init", "-q", "--bare", "-b", "main");
    const seed = tempDir("subagent-seed-");
    git(seed, "clone", "-q", origin, ".");
    writeFileSync(join(seed, "a.txt"), "base\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "base");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const node = tempDir("subagent-node-");
    git(node, "clone", "-q", origin, ".");
    writeFileSync(join(seed, "a.txt"), "moved\n");
    git(seed, "commit", "-q", "-am", "main moves on");
    git(seed, "push", "-q", "origin", "HEAD:main");

    const sender = tempDir("subagent-sender-");
    git(sender, "clone", "-q", origin, ".");
    git(sender, "remote", "set-head", "origin", "main");
    git(sender, "switch", "-q", "-c", "topics/child-behind");
    writeFileSync(join(sender, "b.txt"), "child\n");
    git(sender, "add", ".");
    git(sender, "commit", "-q", "-m", "child work");
    const { bundleBranch } = await import("../services/branch-on-origin");
    const bundle = await bundleBranch(sender, "topics/child-behind");
    expect(bundle).not.toBeNull();

    expect(await plantCarriedBranch(node, "topics/child-behind", bundle!)).toEqual({ ok: true });
  });
});

describe("snapshotParentAsBundle with a margin, for a node that has not fetched lately", () => {
  it("carries the last commits of origin's default so an old node checkout still has every prerequisite", async () => {
    const origin = tempDir("subagent-origin-");
    git(origin, "init", "-q", "--bare", "-b", "main");
    const seed = tempDir("subagent-seed-");
    git(seed, "clone", "-q", origin, ".");
    writeFileSync(join(seed, "a.txt"), "base\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "base");
    git(seed, "push", "-q", "origin", "HEAD:main");
    // The node clones now and never fetches again; its origin is then gone, so planting
    // cannot fetch what it lacks: the bundle alone has to carry it.
    const node = tempDir("subagent-node-");
    git(node, "clone", "-q", origin, ".");
    git(node, "remote", "remove", "origin");
    for (const n of [1, 2, 3]) {
      writeFileSync(join(seed, "a.txt"), `main ${n}\n`);
      git(seed, "commit", "-q", "-am", `main moves ${n}`);
    }
    git(seed, "push", "-q", "origin", "HEAD:main");

    const parent = tempDir("subagent-parent-");
    git(parent, "clone", "-q", origin, ".");
    git(parent, "remote", "set-head", "origin", "main");
    writeFileSync(join(parent, "b.txt"), "work in progress\n");

    const thin = await snapshotParentAsBundle({ repoPath: parent, snapshotBranch: "topics-child-thin" });
    expect((await plantCarriedBranch(node, "topics-child-thin", thin!)).ok).toBe(false);

    const carried = await snapshotParentAsBundle({ repoPath: parent, snapshotBranch: "topics-child-margin", marginCommits: 5 });
    expect(await plantCarriedBranch(node, "topics-child-margin", carried!)).toEqual({ ok: true });
  });
});
