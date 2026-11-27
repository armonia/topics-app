/**
 * A card's own branch reaches origin before the card runs elsewhere, and a
 * node's mirror is born from it (df5fd8c5, 30/10/2026): real git, a bare
 * origin and two checkouts (this Mac and the other machine).
 *
 * @covers KANBAN-76
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchGit, bundleBranch, bundleBranchForNode, carriedBranch, carriedRef, ensureBranchOnOrigin, isPlainBranchName, plantCarriedBranch, pushRefusalReason } from "./branch-on-origin";
import type { GitRunner } from "./own-commits";
import { resolveBranchBaseRef } from "./worktree-for-agent";
import { nodeRunBaseBranch } from "../routes/nodes";

const sh = (args: string[], cwd?: string) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};
const commit = (cwd: string, file: string, msg: string) => {
  writeFileSync(join(cwd, file), `${msg}\n`);
  sh(["add", "."], cwd);
  sh(["commit", "-q", "-m", msg], cwd);
  return sh(["rev-parse", "HEAD"], cwd);
};

let root: string, origin: string, mac: string, pc: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "branch-on-origin-"));
  origin = join(root, "origin.git");
  mac = join(root, "mac");
  pc = join(root, "pc");
  sh(["init", "--bare", "-q", "-b", "main", origin]);
  sh(["clone", "-q", origin, mac]);
  commit(mac, "a.txt", "base");
  sh(["push", "-q", "origin", "main"], mac);
  sh(["clone", "-q", origin, pc]);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("il ramo della card su origin", () => {
  test("un ramo solo locale viene pushato, e il nodo nasce dalla sua punta", async () => {
    sh(["switch", "-q", "-c", "topics/endless-calf"], mac);
    commit(mac, "b.txt", "uno");
    commit(mac, "c.txt", "due");
    const tip = commit(mac, "d.txt", "tre");
    sh(["switch", "-q", "main"], mac);

    expect(await ensureBranchOnOrigin(mac, "topics/endless-calf")).toEqual({ ok: true });
    expect(sh(["rev-parse", "refs/heads/topics/endless-calf"], origin)).toBe(tip);

    // The other machine: its worktree base is origin/<branch>, with all three commits.
    const base = await resolveBranchBaseRef(pc, "topics/endless-calf");
    expect(base).toEqual({ baseRef: "origin/topics/endless-calf", fallback: false, reason: "" });
    expect(sh(["rev-parse", base.baseRef], pc)).toBe(tip);
  });

  test("un ramo già su origin con la stessa punta: va bene, niente da fare", async () => {
    expect(await ensureBranchOnOrigin(mac, "topics/endless-calf")).toEqual({ ok: true });
  });

  test("un ramo che su origin ha preso un'altra strada: rifiutato, la card resta", async () => {
    // Somebody else moved origin's copy meanwhile.
    sh(["fetch", "-q", "origin"], pc);
    sh(["switch", "-q", "-c", "topics/endless-calf", "origin/topics/endless-calf"], pc);
    commit(pc, "e.txt", "altrove");
    sh(["push", "-q", "origin", "topics/endless-calf"], pc);
    sh(["switch", "-q", "main"], pc);
    sh(["switch", "-q", "topics/endless-calf"], mac);
    commit(mac, "f.txt", "qui");
    sh(["switch", "-q", "main"], mac);

    const r = await ensureBranchOnOrigin(mac, "topics/endless-calf");
    expect(r.ok).toBe(false);
    // The reason names the refusal, not git's closing "failed to push some refs".
    expect(r).toMatchObject({ reason: expect.stringContaining("[rejected]") });
  });

  test("the refusal reason skips git's closing line and its hints", () => {
    const out = [
      "To github.com:acme/alpha.git",
      " ! [remote rejected] topics/x -> topics/x (cannot lock ref 'refs/heads/topics/x')",
      "error: failed to push some refs to 'github.com:acme/alpha.git'",
      "hint: Updates were rejected",
    ].join("\n");
    expect(pushRefusalReason(out, 1)).toContain("cannot lock ref");
    expect(pushRefusalReason("error: failed to push some refs to 'x'", 1)).toBe("error: failed to push some refs to 'x'");
    expect(pushRefusalReason("", 128)).toBe("exit 128");
  });

  test("a branch origin is only ahead on: already there, and the local copy stays put", async () => {
    // 27/11/2026: the land's merge of main reached origin, then this checkout went back one commit.
    sh(["switch", "-q", "-c", "topics/quiet-heron"], mac);
    const here = commit(mac, "h.txt", "qui");
    sh(["push", "-q", "origin", "topics/quiet-heron"], mac);
    sh(["switch", "-q", "main"], mac);
    sh(["fetch", "-q", "origin"], pc);
    sh(["switch", "-q", "-c", "topics/quiet-heron", "origin/topics/quiet-heron"], pc);
    const ahead = commit(pc, "i.txt", "avanti");
    sh(["push", "-q", "origin", "topics/quiet-heron"], pc);
    sh(["switch", "-q", "main"], pc);

    expect(await ensureBranchOnOrigin(mac, "topics/quiet-heron")).toEqual({ ok: true });
    expect(sh(["rev-parse", "refs/heads/topics/quiet-heron"], mac)).toBe(here);
    expect(sh(["rev-parse", "refs/heads/topics/quiet-heron"], origin)).toBe(ahead);
  });

  test("un ramo che non c'è né qui né su origin", async () => {
    const r = await ensureBranchOnOrigin(mac, "topics/mai-esistito");
    expect(r).toEqual({ ok: false, reason: "il ramo non c'è né qui né su origin" });
    await expect(resolveBranchBaseRef(pc, "topics/mai-esistito")).rejects.toThrow(/not on origin/);
  });

  test("un nome che git leggerebbe come opzione non arriva a git", async () => {
    expect(await ensureBranchOnOrigin(mac, "--force")).toMatchObject({ ok: false });
    expect(isPlainBranchName("topics/endless-calf")).toBe(true);
    expect(isPlainBranchName("-x")).toBe(false);
    expect(isPlainBranchName("a..b")).toBe(false);
    expect(nodeRunBaseBranch(undefined)).toBeNull();
    expect(nodeRunBaseBranch("topics/endless-calf")).toBe("topics/endless-calf");
    expect(nodeRunBaseBranch("--upload-pack=x")).toBeUndefined();
    expect(nodeRunBaseBranch(42)).toBeUndefined();
  });
});

describe("il ramo della card verso un nodo che non vede origin", () => {
  test("un ramo che c'è solo su origin parte lo stesso come bundle, e qui non resta niente", async () => {
    // Born on the other machine and pushed: this checkout never had it (or pruned it after a land).
    sh(["fetch", "-q", "origin"], pc);
    sh(["switch", "-q", "-c", "topics/burly-verbena", "origin/main"], pc);
    const tip = commit(pc, "g.txt", "solo su origin");
    sh(["push", "-q", "origin", "topics/burly-verbena"], pc);
    sh(["switch", "-q", "main"], pc);
    expect(await ensureBranchOnOrigin(mac, "topics/burly-verbena")).toEqual({ ok: true });

    // ed621d32 (25/11): without a local ref there was nothing to pack.
    expect(await bundleBranch(mac, "topics/burly-verbena")).toBeNull();
    const bytes = await bundleBranchForNode(mac, "topics/burly-verbena");
    expect(bytes).not.toBeNull();

    // The node plants it with no access to origin's branch.
    const node = join(root, "node");
    sh(["clone", "-q", origin, node]);
    expect(await plantCarriedBranch(node, "topics/burly-verbena", bytes!)).toEqual({ ok: true });
    expect(sh(["rev-parse", carriedRef("topics/burly-verbena")], node)).toBe(tip);

    // The borrowed ref is gone: the checkout looks as it did before.
    expect(() => sh(["rev-parse", "--verify", "-q", "refs/heads/topics/burly-verbena"], mac)).toThrow();
  });

  test("un ramo locale si impacchetta come prima, e resta", async () => {
    const bytes = await bundleBranchForNode(mac, "topics/endless-calf");
    expect(bytes).not.toBeNull();
    expect(sh(["rev-parse", "--verify", "-q", "refs/heads/topics/endless-calf"], mac)).toMatch(/^[0-9a-f]{40}$/);
  });

  test("«whole» porta la storia intera anche quando origin/HEAD c'è", async () => {
    // The last step of the card ladder (node-bundle-ladder.ts): a node without origin lacks even the margin.
    try { sh(["rev-parse", "--verify", "-q", "refs/remotes/origin/HEAD"], mac); } catch { sh(["remote", "set-head", "origin", "main"], mac); }
    const cuts: string[][] = [];
    const spy: GitRunner = (cwd, args) => { if (args[0] === "bundle") cuts.push(args.slice(4)); return branchGit(cwd, args); };
    expect(await bundleBranch(mac, "topics/endless-calf", spy, "whole")).not.toBeNull();
    expect(cuts).toEqual([[]]);
  });

  test("un ramo che non c'è da nessuna parte: null, senza ref lasciati", async () => {
    expect(await bundleBranchForNode(mac, "topics/mai-esistito")).toBeNull();
    expect(await bundleBranchForNode(mac, "--force")).toBeNull();
    expect(await bundleBranchForNode(null, "topics/endless-calf")).toBeNull();
  });
});

describe("carriedBranch", () => {
  test("the live delivery branch first, then the one kept on the way back to the queue, else none", () => {
    expect(carriedBranch({ deliveryBranch: "topics/a", priorBranch: "topics/b" })).toBe("topics/a");
    expect(carriedBranch({ deliveryBranch: null, priorBranch: "topics/b" })).toBe("topics/b");
    expect(carriedBranch({ deliveryBranch: " ", priorBranch: undefined })).toBeNull();
    expect(carriedBranch({})).toBeNull();
  });
});
