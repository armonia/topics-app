/**
 * The rule that decides which worktrees are orphans, one spoiled condition at a time.
 *
 * @covers WORKTREE-16
 */
import { describe, expect, it } from "bun:test";
import { ownerOf, verdict, type WorktreeFacts } from "../../scripts/worktree-orphans";

const NOW = Date.UTC(2026, 9, 23);
const DAY = 86_400_000;

/** A worktree that IS an orphan: every test below spoils exactly one condition. */
const orphan: WorktreeFacts = {
  path: "/work/wt",
  branch: "topics/done",
  isMain: false,
  locked: false,
  boardManaged: false,
  liveProcess: false,
  dirty: false,
  lastActivityMs: NOW - 8 * DAY,
  landed: true,
};

describe("worktree-orphans verdict", () => {
  it("calls an orphan only when every condition holds", () => {
    expect(verdict(orphan, NOW).orphan).toBe(true);
  });

  // Each row is a way a worktree with live work would be trashed if its condition were missing.
  const KEEPS: [string, Partial<WorktreeFacts>][] = [
    ["main checkout", { isMain: true }],
    ["managed by worktree-gc", { boardManaged: true }],
    ["locked", { locked: true }],
    ["a process inside", { liveProcess: true }],
    ["uncommitted work", { dirty: true }],
    ["touched 6 days ago", { lastActivityMs: NOW - 6 * DAY }],
    ["detached HEAD", { branch: null }],
    ["branch not landed", { landed: false }],
  ];
  for (const [name, spoil] of KEEPS) {
    it(`keeps a worktree that is ${name}`, () => {
      expect(verdict({ ...orphan, ...spoil }, NOW).orphan).toBe(false);
    });
  }

  it("says why it keeps", () => {
    expect(verdict({ ...orphan, dirty: true }, NOW).reason).toBe("uncommitted work");
  });
});

describe("worktree-orphans owner", () => {
  it("reads the maker off the path", () => {
    const repo = "/repo";
    expect(ownerOf("/repo/.claude/worktrees/agent-abc", repo)).toBe("Claude Code subagent");
    expect(ownerOf("/repo/.claude/worktrees/gc-t12", repo)).toBe("desktop app session");
    expect(ownerOf("/tmp/x/scratchpad/wt", repo)).toBe("agent session scratch");
    expect(ownerOf("/elsewhere/wt", repo)).toBe("by hand, next to the repo");
  });
});
