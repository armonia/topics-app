/**
 * ADOPT, MOVE OR REMOVE A WORKTREE MADE BY ANOTHER TOOL, on real git: refused
 * when dirty, with a submodule, locked, with a live session or an active card;
 * after a move `git worktree list` agrees with the row. Real repos and folders
 * under `mkdtemp`; the row store is a fake that records what it is asked.
 *
 * @covers WORKTREE-STD-07
 * @covers WORKTREE-STD-08
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRunGit } from "./own-commits";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { canonicalPath, listRepoWorktrees, readOwnerMarker } from "./worktree-owner";
import { checkRelocation, runRelocation, type RelocateDeps, type RelocateRow } from "./worktree-relocate";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
}

describe("relocating worktrees made outside the root", () => {
  let base: string, repo: string, root: string, outside: string;
  let rows: Array<RelocateRow & { branchName: string | null; mode: string }>;
  let live: string[];
  let activeRows: Set<string>;
  let removed: string[];
  let deps: RelocateDeps;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "wt-relocate-"));
    dirs.push(base);
    repo = join(base, "repo");
    root = join(base, "wts");
    outside = join(base, "elsewhere");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    git(base, "init", "-q", "-b", "main", "repo");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    rows = [];
    live = [];
    activeRows = new Set();
    removed = [];
    deps = {
      git: defaultRunGit,
      root: () => root,
      projects: () => [{ id: "p1", slug: "repo", path: repo }],
      rowAt: (p) => rows.find((r) => canonicalPath(r.absPath) === canonicalPath(p)) ?? null,
      namesFor: (projectId) => new Set(rows.filter((r) => r.projectId === projectId).map((r) => r.name)),
      createRow: (input) => {
        const id = `row-${rows.length + 1}`;
        rows.push({ id, projectId: input.projectId, name: input.name, absPath: input.absPath, branchName: input.branchName, mode: input.mode });
        return { id };
      },
      setRowPath: (id, absPath) => {
        const r = rows.find((x) => x.id === id);
        if (!r) return false;
        r.absPath = absPath;
        return true;
      },
      removeRow: async (id) => {
        const r = rows.find((x) => x.id === id)!;
        const res = await defaultRunGit(repo, ["worktree", "remove", r.absPath]);
        if (res.code !== 0) return false;
        rows = rows.filter((x) => x.id !== id);
        removed.push(id);
        return true;
      },
      liveInside: (p) => live.some((l) => canonicalPath(l) === canonicalPath(p)),
      taskActive: (id) => activeRows.has(id),
      dirt: async (p) => {
        const r = await defaultRunGit(p, ["status", "--porcelain"]);
        return { ok: r.code === 0, paths: r.stdout.split("\n").filter(Boolean) };
      },
    };
  });

  const addForeign = (name: string): string => {
    const path = join(outside, name);
    expect(git(repo, "worktree", "add", "-q", "-b", `feat-${name}`, path).code).toBe(0);
    return path;
  };

  test("adopt makes one reuse row and is idempotent", async () => {
    const path = addForeign("wt-a");
    const preview = await checkRelocation(deps, "adopt", path);
    expect(preview.ok).toBe(true);
    expect(preview.rowId).toBeNull();
    const first = await runRelocation(deps, "adopt", path);
    expect(first.ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mode).toBe("reuse");
    expect(rows[0]!.branchName).toBe("feat-wt-a");
    const second = await runRelocation(deps, "adopt", path);
    expect(second.ok).toBe(true);
    expect(second.check.warnings).toContain("already-adopted");
    expect(rows).toHaveLength(1);
  });

  test("a clean worktree moves under the root and git list agrees with the row", async () => {
    const path = addForeign("wt-b");
    await runRelocation(deps, "adopt", path);
    const preview = await checkRelocation(deps, "move", path);
    expect(preview.ok).toBe(true);
    expect(preview.to).toBe(join(root, "repo", "wt-b"));
    expect(preview.warnings).toContain("transcripts");
    expect(existsSync(path)).toBe(true); // the preview moved nothing

    const res = await runRelocation(deps, "move", path);
    expect(res.ok).toBe(true);
    expect(res.to).toBe(join(root, "repo", "wt-b"));
    expect(existsSync(path)).toBe(false);
    expect(existsSync(res.to!)).toBe(true);
    expect(rows[0]!.absPath).toBe(res.to!);
    const listed = await listRepoWorktrees(defaultRunGit, repo);
    expect(listed!.map((w) => canonicalPath(w.path))).toContain(canonicalPath(res.to!));
    expect(listed!.map((w) => canonicalPath(w.path))).not.toContain(canonicalPath(path));
    expect(readOwnerMarker(res.to!)?.worktreeId).toBe(rows[0]!.id);
  });

  test("a worktree with no row gets one when it moves", async () => {
    const path = addForeign("wt-c");
    const res = await runRelocation(deps, "move", path);
    expect(res.ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.absPath).toBe(res.to!);
  });

  test("a name taken in the target folder gets a suffix, nothing is overwritten", async () => {
    mkdirSync(join(root, "repo", "wt-d"), { recursive: true });
    const path = addForeign("wt-d");
    const res = await runRelocation(deps, "move", path);
    expect(res.ok).toBe(true);
    expect(res.to).toBe(join(root, "repo", "wt-d-2"));
  });

  test("a dirty worktree is refused and stays where it is", async () => {
    const path = addForeign("wt-e");
    writeFileSync(join(path, "new.txt"), "x");
    const res = await runRelocation(deps, "move", path);
    expect(res.ok).toBe(false);
    expect(res.check.refusals).toContain("dirty");
    expect(existsSync(path)).toBe(true);
    expect(rows).toHaveLength(0);
    expect((await runRelocation(deps, "remove", path)).check.refusals).toContain("dirty");
  });

  test("a worktree with a submodule is refused", async () => {
    const sub = join(base, "sub");
    git(base, "init", "-q", "-b", "main", "sub");
    git(sub, "config", "user.email", "t@t.t");
    git(sub, "config", "user.name", "t");
    writeFileSync(join(sub, "s.txt"), "s\n");
    git(sub, "add", "-A");
    git(sub, "commit", "-q", "-m", "sub");
    const path = addForeign("wt-f");
    expect(git(path, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mod").code).toBe(0);
    git(path, "config", "user.email", "t@t.t");
    git(path, "config", "user.name", "t");
    expect(git(path, "commit", "-q", "-m", "add module").code).toBe(0);
    const check = await checkRelocation(deps, "move", path);
    expect(check.ok).toBe(false);
    expect(check.refusals).toContain("submodules");
    expect((await checkRelocation(deps, "adopt", path)).ok).toBe(true);
  });

  test("a live session or an active card refuses the move", async () => {
    const path = addForeign("wt-g");
    live.push(path);
    expect((await checkRelocation(deps, "move", path)).refusals).toContain("live-session");
    live.length = 0;
    await runRelocation(deps, "adopt", path);
    activeRows.add(rows[0]!.id);
    expect((await checkRelocation(deps, "move", path)).refusals).toContain("active-task");
    expect((await checkRelocation(deps, "remove", path)).refusals).toContain("active-task");
  });

  test("a locked worktree is refused", async () => {
    const path = addForeign("wt-h");
    expect(git(repo, "worktree", "lock", "--reason", "somebody else", path).code).toBe(0);
    const check = await checkRelocation(deps, "move", path);
    expect(check.refusals).toContain("locked");
  });

  test("a folder inside the root, a missing one, the main checkout and a stranger are refused", async () => {
    const inside = join(root, "repo", "wt-i");
    expect(git(repo, "worktree", "add", "-q", "-b", "feat-i", inside).code).toBe(0);
    expect((await checkRelocation(deps, "move", inside)).refusals).toEqual(["inside-root"]);
    expect((await checkRelocation(deps, "adopt", join(outside, "nope"))).refusals).toEqual(["missing"]);
    expect((await checkRelocation(deps, "move", repo)).refusals).toEqual(["not-linked"]);
    const stranger = join(base, "stranger");
    mkdirSync(stranger);
    git(base, "init", "-q", "-b", "main", "stranger");
    expect((await checkRelocation(deps, "adopt", stranger)).ok).toBe(false);
  });

  test("remove takes the folder away and keeps the branch, with or without a row", async () => {
    const withRow = addForeign("wt-j");
    await runRelocation(deps, "adopt", withRow);
    const a = await runRelocation(deps, "remove", withRow);
    expect(a.ok).toBe(true);
    expect(existsSync(withRow)).toBe(false);
    expect(removed).toHaveLength(1);
    expect(git(repo, "rev-parse", "--verify", "feat-wt-j").code).toBe(0);

    const noRow = addForeign("wt-k");
    const b = await runRelocation(deps, "remove", noRow);
    expect(b.ok).toBe(true);
    expect(existsSync(noRow)).toBe(false);
    expect(git(repo, "rev-parse", "--verify", "feat-wt-k").code).toBe(0);
    expect(b.check.warnings).toContain("branch-kept");
  });

  test("remove refuses a detached HEAD whose commits are on no branch and not on main, and says no branch is kept", async () => {
    const detached = join(outside, "wt-detached");
    expect(git(repo, "worktree", "add", "-q", "--detach", detached, "main").code).toBe(0);
    writeFileSync(join(detached, "only-here.txt"), "work\n");
    git(detached, "add", "-A");
    expect(git(detached, "commit", "-q", "-m", "only on this HEAD").code).toBe(0);
    const preview = await checkRelocation(deps, "remove", detached);
    expect(preview.refusals).toContain("unmerged-commits");
    expect(preview.warnings).not.toContain("branch-kept");
    const r = await runRelocation(deps, "remove", detached);
    expect(r.ok).toBe(false);
    expect(existsSync(join(detached, "only-here.txt"))).toBe(true);

    // Level with main: nothing on that HEAD is lost, so it may go.
    const level = join(outside, "wt-level");
    expect(git(repo, "worktree", "add", "-q", "--detach", level, "main").code).toBe(0);
    const ok = await runRelocation(deps, "remove", level);
    expect(ok.ok).toBe(true);
    expect(ok.check.warnings).not.toContain("branch-kept");
  });
});
