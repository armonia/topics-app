/**
 * @covers SUBAGENT-28
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnRemoteChild, type RemoteChildSpawnInput } from "./subagent-remote-spawn";
import type { ChildNodeCandidate } from "./subagent-remote-run";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: gitEnv });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

let roots: string[] = [];
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagent-remote-spawn-"));
  roots.push(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

const node: ChildNodeCandidate = { machineId: "node-1", name: "PC", online: true, slots: 2, load: 0 };

function baseInput(over: Partial<RemoteChildSpawnInput> = {}): RemoteChildSpawnInput {
  return {
    id: "child-1", cwd: tempRepo(), prompt: "do it", name: "a child", model: null, effort: null,
    isGitRepo: true, originUrl: "git@github.com:acme/repo.git", nodes: [node],
    baseUrlOf: () => "https://node.local", tokenOf: () => "tok",
    createRun: async () => ({ runId: "run-1" }),
    ...over,
  };
}

describe("spawnRemoteChild", () => {
  it("decideRemoteSpawn says no (claude-code runtime): null, the caller stays local", async () => {
    const result = await spawnRemoteChild(baseInput({ runtime: "claude-code" }));
    expect(result).toBeNull();
  });

  it("no origin on this repo: null, there is no node door for it yet", async () => {
    const result = await spawnRemoteChild(baseInput({ originUrl: null }));
    expect(result).toBeNull();
  });

  it("no node has a free seat: null, the caller stays local", async () => {
    const result = await spawnRemoteChild(baseInput({ nodes: [] }));
    expect(result).toBeNull();
  });

  it("eligible, a seat is free: snapshots the parent and starts the run on it", async () => {
    const calls: unknown[] = [];
    const result = await spawnRemoteChild(baseInput({
      createRun: async (input) => { calls.push(input); return { runId: "run-9" }; },
    }));
    expect(result).toEqual({ ok: true, machineId: "node-1", runId: "run-9", branch: "topics-child-child-1" });
    expect(calls).toHaveLength(1);
    const body = (calls[0] as { body: { branchBundle?: string; baseBranch?: string | null } }).body;
    expect(body.baseBranch).toBe("topics-child-child-1");
    expect(typeof body.branchBundle).toBe("string");
  });

  it("the node refuses the run: ok:false with its reason, not a throw", async () => {
    const result = await spawnRemoteChild(baseInput({ tokenOf: () => null }));
    expect(result).toEqual({ ok: false, reason: "node address or token unavailable" });
  });
});
