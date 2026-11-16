/**
 * @covers SUBAGENT-28
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleRemoteChildBranch } from "./subagent-remote-return";
import { bundleBranch } from "../services/branch-on-origin";

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

describe("settleRemoteChildBranch", () => {
  it("plants the node's bundle and adopts it as an ordinary branch in the parent", async () => {
    const parent = tempDir("subagent-return-parent-");
    git(parent, "init", "-q", "-b", "main");
    writeFileSync(join(parent, "a.txt"), "base\n");
    git(parent, "add", ".");
    git(parent, "commit", "-q", "-m", "base");

    // A second checkout stands in for the node's own: it commits on the child's branch.
    const node = tempDir("subagent-return-node-");
    git(node, "clone", "-q", parent, ".");
    git(node, "checkout", "-q", "-b", "topics-child-1");
    writeFileSync(join(node, "b.txt"), "from the child\n");
    git(node, "add", ".");
    git(node, "commit", "-q", "-m", "child work");
    const bytes = await bundleBranch(node, "topics-child-1");
    expect(bytes).not.toBeNull();

    const result = await settleRemoteChildBranch({
      repoPath: parent, branch: "topics-child-1",
      fetchBundle: async () => ({ empty: false, bytes: bytes! }),
    });
    expect(result).toEqual({ ok: true });
    git(parent, "checkout", "-q", "topics-child-1");
    expect(readFileSync(join(parent, "b.txt"), "utf8")).toBe("from the child\n");
  });

  it("the node answers with no bundle: ok:false, not a throw", async () => {
    const parent = tempDir("subagent-return-parent-empty-");
    git(parent, "init", "-q", "-b", "main");
    const result = await settleRemoteChildBranch({
      repoPath: parent, branch: "topics-child-2",
      fetchBundle: async () => ({ empty: true }),
    });
    expect(result).toEqual({ ok: false, reason: "the node answered with no branch bundle" });
  });

  it("fetchBundle throws (the node did not answer): ok:false with the error, not an unhandled rejection", async () => {
    const parent = tempDir("subagent-return-parent-fail-");
    git(parent, "init", "-q", "-b", "main");
    const result = await settleRemoteChildBranch({
      repoPath: parent, branch: "topics-child-3",
      fetchBundle: async () => { throw new Error("network down"); },
    });
    expect(result.ok).toBeFalse();
    expect((result as { reason: string }).reason).toMatch(/network down/);
  });
});
