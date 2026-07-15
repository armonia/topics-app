import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { worktreeIsolationHome } from "./daemon-state";

describe("worktreeIsolationHome", () => {
  const HOME = "/Users/x";
  const wt = (name: string) => join(HOME, ".topics", "worktrees", "topics-app", name);

  it("isolates a dispatch-worktree checkout onto its own .topics-daemon home", () => {
    const base = wt("ancient-needle");
    expect(worktreeIsolationHome(base, HOME)).toBe(join(base, ".topics-daemon"));
  });

  it("keeps production defaults (null) for a normal checkout", () => {
    expect(worktreeIsolationHome("/Users/x/Projects/topics-app", HOME)).toBeNull();
  });

  it("keeps production defaults for the packaged app bundle path", () => {
    expect(
      worktreeIsolationHome("/Users/x/Applications/Topics Host.app/Contents/Resources/server", HOME),
    ).toBeNull();
  });

  it("does not false-match a project literally named 'worktrees' outside ~/.topics", () => {
    expect(worktreeIsolationHome("/Users/x/Projects/worktrees/app", HOME)).toBeNull();
  });

  it("does not match ~/.topics itself (only nested worktree checkouts)", () => {
    expect(worktreeIsolationHome(join(HOME, ".topics"), HOME)).toBeNull();
  });

  it("handles a trailing separator on baseDir", () => {
    const base = wt("serene-bulb");
    expect(worktreeIsolationHome(base + "/", HOME)).toBe(join(base + "/", ".topics-daemon"));
  });
});
