/**
 * @covers EXTSESS-04
 */
import { describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { resolveAdoptedCheckout, type CheckoutFs } from "./adopted-checkout";

/** A tiny in-memory filesystem: files with content, and the dirs they imply. */
function fakeFs(files: Record<string, string>): CheckoutFs {
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) for (let d = dirname(p); d !== "/"; d = dirname(d)) dirs.add(d);
  return { readFile: (p) => files[p] ?? null, isDir: (p) => dirs.has(p) };
}

describe("resolveAdoptedCheckout", () => {
  it("a linked worktree belongs to its repository", () => {
    const fs = fakeFs({
      "/r/quadra/.git/HEAD": "ref: refs/heads/main\n",
      "/r/quadra/.claude/worktrees/x/.git": "gitdir: /r/quadra/.git/worktrees/x\n",
      "/r/quadra/.git/worktrees/x/commondir": "../..\n",
    });
    expect(resolveAdoptedCheckout("/r/quadra/.claude/worktrees/x", fs)).toEqual({
      projectDir: "/r/quadra", worktreeDir: "/r/quadra/.claude/worktrees/x", worktreeName: "x",
    });
  });

  it("a relative gitdir and an absolute commondir resolve the same", () => {
    const fs = fakeFs({
      "/r/app/.git/HEAD": "x",
      "/w/feat/.git": "gitdir: ../../r/app/.git/worktrees/feat",
      [join("/r/app/.git/worktrees/feat", "commondir")]: "/r/app/.git",
    });
    expect(resolveAdoptedCheckout("/w/feat", fs).projectDir).toBe("/r/app");
  });

  it("a plain checkout, a non-git folder and a submodule stay what they are", () => {
    const plain = { worktreeDir: null, worktreeName: null };
    expect(resolveAdoptedCheckout("/r/app", fakeFs({ "/r/app/.git/HEAD": "x" }))).toEqual({ projectDir: "/r/app", ...plain });
    expect(resolveAdoptedCheckout("/tmp/scratch", fakeFs({}))).toEqual({ projectDir: "/tmp/scratch", ...plain });
    // A submodule's `.git` file points at `.git/modules/<name>`: no commondir.
    const sub = fakeFs({ "/r/app/.git/HEAD": "x", "/r/app/lib/.git": "gitdir: ../.git/modules/lib" });
    expect(resolveAdoptedCheckout("/r/app/lib", sub)).toEqual({ projectDir: "/r/app/lib", ...plain });
  });

  it("a worktree whose repository is gone is not attached to a missing folder", () => {
    const fs = fakeFs({
      "/w/orphan/.git": "gitdir: /gone/.git/worktrees/orphan",
      "/gone2/.git/worktrees/orphan/commondir": "../..",
    });
    expect(resolveAdoptedCheckout("/w/orphan", fs).worktreeDir).toBeNull();
  });
});
