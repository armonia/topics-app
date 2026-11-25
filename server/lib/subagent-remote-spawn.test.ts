/**
 * @covers SUBAGENT-28
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnRemoteChild, MAX_CHILD_BUNDLE_BYTES, nodeModelOf, type RemoteChildSpawnInput } from "./subagent-remote-spawn";
import { childAnswerOf, macOnlyResourceOf } from "./subagent-remote-wiring";
import { randomBytes } from "node:crypto";
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

  it("the node throws on create (no checkout of this origin): null, the child stays local instead of a 500", async () => {
    const result = await spawnRemoteChild(baseInput({ createRun: async () => { throw new Error("create run answered 404: no_such_repo"); } }));
    expect(result).toBeNull();
  });

  it("a mac-only resource the child needs: null, the run is never created", async () => {
    let created = 0;
    const result = await spawnRemoteChild(baseInput({ macOnlyResource: "browser", createRun: async () => { created += 1; return { runId: "x" }; } }));
    expect(result).toBeNull();
    expect(created).toBe(0);
  });

  it("a parent snapshot over the cap stays here instead of riding a huge JSON body", async () => {
    const cwd = tempRepo();
    // Incompressible bytes over a small cap: the same path as an unignored artefact over the real one.
    writeFileSync(join(cwd, "artefact.bin"), randomBytes(256 * 1024));
    let created = 0;
    const result = await spawnRemoteChild(baseInput({ cwd, maxBundleBytes: 64 * 1024, createRun: async () => { created += 1; return { runId: "x" }; } }));
    expect(result).toBeNull();
    expect(created).toBe(0);
    expect(MAX_CHILD_BUNDLE_BYTES).toBe(64 * 1024 * 1024);
  });

  // The catalogs read on 16/11: the cloud node and the PC list different Claude ids.
  const CLOUD = ["claude-opus-5", "claude-opus-5[1m]", "claude-sonnet-5", "claude-haiku-5-5", "claude-haiku-4-5", "claude-fable-5"];
  const PC = ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-opus-4-8", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-haiku-4-5", "claude-fable-5-1"];

  it("an alias goes to the node as the newest id of that family in the node's own catalog", async () => {
    for (const [model, models, want] of [["haiku", CLOUD, "claude-haiku-5-5"], ["haiku", PC, "claude-haiku-5-5"], ["opus", CLOUD, "claude-opus-5"], ["opus", PC, "claude-opus-5-5"]] as const) {
      const bodies: { model: string | null }[] = [];
      const result = await spawnRemoteChild(baseInput({
        model, nodeModels: async () => models,
        createRun: async (input) => { bodies.push(input.body); return { runId: "r" }; },
      }));
      expect(result).toMatchObject({ ok: true });
      expect(bodies[0]!.model).toBe(want);
    }
  });

  it("the node reads its token and address: the catalog is asked of the picked node", async () => {
    const asked: unknown[] = [];
    await spawnRemoteChild(baseInput({ model: "opus", nodeModels: async (n) => { asked.push(n); return CLOUD; } }));
    expect(asked).toEqual([{ baseUrl: "https://node.local", token: "tok" }]);
  });

  it("a family the node does not list, or a catalog that cannot be read: null, the child stays here", async () => {
    for (const nodeModels of [async () => ["claude-opus-5"], async () => null, async () => { throw new Error("down"); }, undefined]) {
      let created = 0;
      const result = await spawnRemoteChild(baseInput({ model: "haiku", nodeModels, createRun: async () => { created += 1; return { runId: "x" }; } }));
      expect(result).toBeNull();
      expect(created).toBe(0);
    }
  });

  it("no model or a full id: sent as is, without asking the node", async () => {
    for (const model of [null, "claude-sonnet-5-5"]) {
      let asked = 0;
      const bodies: { model: string | null }[] = [];
      await spawnRemoteChild(baseInput({ model, nodeModels: async () => { asked += 1; return CLOUD; }, createRun: async (input) => { bodies.push(input.body); return { runId: "r" }; } }));
      expect(asked).toBe(0);
      expect(bodies[0]!.model).toBe(model);
    }
  });
});

describe("nodeModelOf", () => {
  it("resolves the family and the long window against the given catalog", () => {
    const cat = ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-opus-4-8", "claude-haiku-5-5", "claude-haiku-4-5"];
    expect(nodeModelOf("opus", cat)).toBe("claude-opus-5-5");
    expect(nodeModelOf("Opus[1m]", cat)).toBe("claude-opus-5-5[1m]");
    // Haiku has no 1M variant listed: the bare id, never a suffix the API refuses.
    expect(nodeModelOf("haiku[1m]", cat)).toBe("claude-haiku-5-5");
    expect(nodeModelOf("sonnet", cat)).toBeUndefined();
    expect(nodeModelOf("claude-opus-4-8", cat)).toBe("claude-opus-4-8");
    expect(nodeModelOf(null, cat)).toBeNull();
  });
});

describe("macOnlyResourceOf", () => {
  it("names the resource a prompt needs from this Mac, and nothing for plain code work", () => {
    expect(macOnlyResourceOf("open the page in the browser and take a screenshot", null)).toBe("browser");
    expect(macOnlyResourceOf("ask Jarvis to send it on WhatsApp", null)).toBe("jarvis");
    expect(macOnlyResourceOf("read the tmux pane of the build", null)).toBe("session");
    expect(macOnlyResourceOf("edit ~/.claude/settings.json", null)).toBe("macos");
    expect(macOnlyResourceOf("collect the red checks with gh pr checks on #1315", null)).toBe("gh");
    expect(macOnlyResourceOf("refactor server/lib/foo.ts and add a test", null)).toBeNull();
  });

  it("does not trip on an ordinary CI/PR mention with no gh command", () => {
    expect(macOnlyResourceOf("fix the failing CI check on this PR", null)).toBeNull();
  });
});

describe("childAnswerOf", () => {
  const c = (author: string, kind: string, content: string) => ({ id: content, author, kind, content, createdAt: "2026-11-16T08:00:00Z" });
  it("the agent's delivery, not a service comment written after it", () => {
    expect(childAnswerOf([
      c("system", "service", "Card specchiata"), c("agent:a", "comment", "question first"),
      c("agent:a", "delivery", "Added note-1.txt"), c("agent:a", "status", "in_progress→review"),
      c("verifier", "service", "Anteprima: non allegata."),
    ])).toBe("Added note-1.txt");
  });
  it("no delivery: the agent's last word; no agent at all: the last comment", () => {
    expect(childAnswerOf([c("agent:a", "comment", "half way"), c("verifier", "service", "x")])).toBe("half way");
    expect(childAnswerOf([c("system", "service", "parked")])).toBe("parked");
    expect(childAnswerOf([])).toBe("");
  });
});
