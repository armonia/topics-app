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
import { carriedBranch, ensureBranchOnOrigin, isPlainBranchName } from "./branch-on-origin";
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

describe("carriedBranch", () => {
  test("the live delivery branch first, then the one kept on the way back to the queue, else none", () => {
    expect(carriedBranch({ deliveryBranch: "topics/a", priorBranch: "topics/b" })).toBe("topics/a");
    expect(carriedBranch({ deliveryBranch: null, priorBranch: "topics/b" })).toBe("topics/b");
    expect(carriedBranch({ deliveryBranch: " ", priorBranch: undefined })).toBeNull();
    expect(carriedBranch({})).toBeNull();
  });
});
