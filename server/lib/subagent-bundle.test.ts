/**
 * The round trip of a `spawn_agent` child sent to a node as a bundle
 * (sottoagenti-nodo, traccia 3): the parent's own snapshot goes out, the
 * child's branch comes back, and the parent's tree is never touched by the
 * step that leaves.
 *
 * Two temporary repos stand in for the parent (this Mac) and the node: no
 * `origin` anywhere, the `~/.claude/jarvis/home` case the proposal names.
 *
 * @covers SUBAGENT-26
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptCarriedBranch, materializeChildCheckout, snapshotParentAsBundle } from "./subagent-bundle";
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
  it("file identici tra il ramo del figlio e quello adottato dal genitore, albero del genitore intatto", async () => {
    // The parent repo: no `origin`, a plain local checkout, like `~/.claude/jarvis/home`.
    const parent = tempDir("subagent-parent-");
    git(parent, "init", "-q", "-b", "main");
    writeFileSync(join(parent, "a.txt"), "base\n");
    git(parent, "add", ".");
    git(parent, "commit", "-q", "-m", "base");
    // Uncommitted work sitting in the parent's tree when the child is spawned.
    writeFileSync(join(parent, "a.txt"), "base\nwip\n");
    const treeBeforeSnapshot = readFileSync(join(parent, "a.txt"), "utf8");
    const statusBeforeSnapshot = git(parent, "status", "--porcelain");

    const bundle = await snapshotParentAsBundle({ repoPath: parent, snapshotBranch: "topics/subagent-snapshot-1" });
    expect(bundle).not.toBeNull();

    // The parent's own checkout: no new branch, no new ref, the dirty file untouched.
    expect(git(parent, "branch", "--list", "topics/subagent-snapshot-1")).toBe("");
    expect(readFileSync(join(parent, "a.txt"), "utf8")).toBe(treeBeforeSnapshot);
    expect(git(parent, "status", "--porcelain")).toBe(statusBeforeSnapshot);

    // The node: a fresh directory, no clone of anything (no `origin` to clone from).
    const node = tempDir("subagent-node-");
    const materialized = await materializeChildCheckout({
      targetDir: node, branch: "topics/subagent-snapshot-1", bytes: bundle!,
    });
    expect(materialized).toEqual({ ok: true });
    expect(readFileSync(join(node, "a.txt"), "utf8")).toBe("base\nwip\n");

    // The child works on its own branch, past the snapshot.
    git(node, "switch", "-q", "-c", "topics/child-work");
    writeFileSync(join(node, "b.txt"), "child did this\n");
    git(node, "add", ".");
    git(node, "commit", "-q", "-m", "child work");
    const childTip = git(node, "rev-parse", "HEAD");

    // Return trip: the node's own branch bundled (reusing `bundleBranch` via the
    // card lane's own module), planted in the parent as `plantCarriedBranch` does
    // for a card, then adopted as a real branch there.
    const { bundleBranch } = await import("../services/branch-on-origin");
    const resultBundle = await bundleBranch(node, "topics/child-work");
    expect(resultBundle).not.toBeNull();

    const planted = await plantCarriedBranch(parent, "topics/child-work", resultBundle!);
    expect(planted).toEqual({ ok: true });

    const adopted = await adoptCarriedBranch({ repoPath: parent, branch: "topics/child-work" });
    expect(adopted).toEqual({ ok: true });

    expect(git(parent, "rev-parse", "topics/child-work")).toBe(childTip);
    expect(git(parent, "show", "topics/child-work:a.txt")).toBe(readFileSync(join(node, "a.txt"), "utf8").trim());
    expect(git(parent, "show", "topics/child-work:b.txt")).toBe(readFileSync(join(node, "b.txt"), "utf8").trim());

    // The parent's own tree, through all of this, never moved: still the
    // uncommitted edit it had before the child was ever spawned.
    expect(readFileSync(join(parent, "a.txt"), "utf8")).toBe(treeBeforeSnapshot);
    expect(git(parent, "status", "--porcelain")).toBe(statusBeforeSnapshot);
  });

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
