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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptCarriedBranch, snapshotParentAsBundle } from "./subagent-bundle";
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

/** Test-only child checkout: a fresh repo that fetches the snapshot bundle and checks the branch out. */
async function materializeChildCheckout(input: { targetDir: string; branch: string; bytes: Uint8Array }): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { targetDir, branch, bytes } = input;
  git(targetDir, "init", "-q", "-b", "__topics-bootstrap__");
  const file = join(tempDir("subagent-bundle-file-"), "snapshot.bundle");
  writeFileSync(file, bytes);
  try {
    git(targetDir, "bundle", "verify", file);
    git(targetDir, "fetch", "--no-tags", file, `${branch}:refs/heads/${branch}`);
    git(targetDir, "checkout", "-q", branch);
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
  return { ok: true };
}

describe("subagent-bundle: andata, commit sul ramo, ritorno", () => {
  it("file identici tra il ramo del figlio e quello adottato dal genitore, albero del genitore intatto", async () => {
    // The parent repo: no `origin`, a plain local checkout, like an agent's home.
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

  it("un file nuovo mai aggiunto arriva al figlio, l'indice del genitore resta com'era", async () => {
    const parent = tempDir("subagent-parent-");
    git(parent, "init", "-q", "-b", "main");
    writeFileSync(join(parent, "a.txt"), "base\n");
    writeFileSync(join(parent, ".gitignore"), "secret.env\n");
    git(parent, "add", ".");
    git(parent, "commit", "-q", "-m", "base");
    writeFileSync(join(parent, "new.txt"), "never added\n");
    writeFileSync(join(parent, "secret.env"), "ignored\n");
    const statusBefore = git(parent, "status", "--porcelain");

    const bundle = await snapshotParentAsBundle({ repoPath: parent, snapshotBranch: "topics/untracked-snapshot" });
    expect(bundle).not.toBeNull();
    expect(git(parent, "status", "--porcelain")).toBe(statusBefore);
    expect(git(parent, "stash", "list")).toBe("");

    const node = tempDir("subagent-node-");
    expect(await materializeChildCheckout({ targetDir: node, branch: "topics/untracked-snapshot", bytes: bundle! })).toEqual({ ok: true });
    expect(readFileSync(join(node, "new.txt"), "utf8")).toBe("never added\n");
    expect(() => readFileSync(join(node, "secret.env"), "utf8")).toThrow();
  });

  it("un ramo del genitore con commit che il figlio non ha non viene sovrascritto all'adozione", async () => {
    const parent = tempDir("subagent-parent-");
    git(parent, "init", "-q", "-b", "main");
    writeFileSync(join(parent, "a.txt"), "base\n");
    git(parent, "add", ".");
    git(parent, "commit", "-q", "-m", "base");
    const bundle = await snapshotParentAsBundle({ repoPath: parent, snapshotBranch: "topics/s" });
    const node = tempDir("subagent-node-");
    await materializeChildCheckout({ targetDir: node, branch: "topics/s", bytes: bundle! });
    git(node, "switch", "-q", "-c", "topics/shared");
    writeFileSync(join(node, "b.txt"), "child\n");
    git(node, "add", ".");
    git(node, "commit", "-q", "-m", "child");
    const { bundleBranch } = await import("../services/branch-on-origin");
    const back = await bundleBranch(node, "topics/shared");

    // Meanwhile the parent has its own branch of the same name, with a commit of its own.
    git(parent, "switch", "-q", "-c", "topics/shared");
    writeFileSync(join(parent, "c.txt"), "parent's own\n");
    git(parent, "add", ".");
    git(parent, "commit", "-q", "-m", "parent work");
    git(parent, "switch", "-q", "main");
    const parentTip = git(parent, "rev-parse", "topics/shared");

    expect(await plantCarriedBranch(parent, "topics/shared", back!)).toEqual({ ok: true });
    const adopted = await adoptCarriedBranch({ repoPath: parent, branch: "topics/shared" });
    expect(adopted.ok).toBe(false);
    expect(git(parent, "rev-parse", "topics/shared")).toBe(parentTip);
  });

  it("un ramo in checkout nel genitore non viene spostato sotto i file aperti, anche se in avanti", async () => {
    const parent = tempDir("subagent-parent-");
    git(parent, "init", "-q", "-b", "main");
    writeFileSync(join(parent, "a.txt"), "base\n");
    git(parent, "add", ".");
    git(parent, "commit", "-q", "-m", "base");
    git(parent, "switch", "-q", "-c", "topics/open");
    const bundle = await snapshotParentAsBundle({ repoPath: parent, snapshotBranch: "topics/s-open" });
    const node = tempDir("subagent-node-");
    await materializeChildCheckout({ targetDir: node, branch: "topics/s-open", bytes: bundle! });
    git(node, "switch", "-q", "-c", "topics/open");
    writeFileSync(join(node, "b.txt"), "child\n");
    git(node, "add", ".");
    git(node, "commit", "-q", "-m", "child");
    const { bundleBranch } = await import("../services/branch-on-origin");
    const back = await bundleBranch(node, "topics/open");
    const before = git(parent, "rev-parse", "topics/open");

    expect(await plantCarriedBranch(parent, "topics/open", back!)).toEqual({ ok: true });
    const adopted = await adoptCarriedBranch({ repoPath: parent, branch: "topics/open" });
    expect(adopted.ok).toBe(false);
    expect(git(parent, "rev-parse", "topics/open")).toBe(before);
    expect(git(parent, "status", "--porcelain")).toBe("");
  });

  it("a branch that moves between the read and the update is not overwritten (compare-and-swap)", async () => {
    const parent = tempDir("subagent-parent-");
    git(parent, "init", "-q", "-b", "main");
    writeFileSync(join(parent, "a.txt"), "base\n");
    git(parent, "add", ".");
    git(parent, "commit", "-q", "-m", "base");
    const baseTip = git(parent, "rev-parse", "main");
    // The parent already has the branch at the base commit; the carried tip is a commit ahead of it.
    git(parent, "branch", "topics/race", baseTip);
    const { carriedRef } = await import("../services/branch-on-origin");
    git(parent, "update-ref", carriedRef("topics/race"), git(parent, "commit-tree", "-m", "carried", "-p", baseTip, `${baseTip}^{tree}`));

    // A runner that moves the branch right before the update-ref lands: a concurrent writer.
    let rival = "";
    const racing = async (cwd: string, args: string[]) => {
      if (args[0] === "update-ref") {
        rival = git(cwd, "commit-tree", "-m", "rival", "-p", baseTip, `${baseTip}^{tree}`);
        git(cwd, "update-ref", "refs/heads/topics/race", rival);
      }
      const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: gitEnv });
      return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    };
    const adopted = await adoptCarriedBranch({ repoPath: parent, branch: "topics/race", run: racing as never });
    expect(adopted.ok).toBe(false);
    expect(git(parent, "rev-parse", "topics/race")).toBe(rival);
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
