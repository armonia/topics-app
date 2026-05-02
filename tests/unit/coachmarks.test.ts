/**
 * Unit test for the coachmark queue picking logic.
 * Pure function — no React, no DOM. We test `pickNextCoachmark` and
 * `_shouldFire` directly so the test stays light.
 */
import { describe, expect, test } from "bun:test";
import {
  COACHMARK_ORDER,
  pickNextCoachmark,
  _shouldFire,
  type CoachmarkFlags,
  type CoachmarkId,
} from "../../client/src/hooks/useCoachmarks";

const all: CoachmarkFlags = {
  hasOpenedTopic: true,
  hasProject: true,
  hasWorktree: false,
  hasGitStatus: false,
  machineOffline: false,
};

describe("coachmark queue", () => {

  test("COACHMARK_ORDER pins the canonical sequence", () => {
    expect(COACHMARK_ORDER.length).toBeGreaterThan(0);
    expect(COACHMARK_ORDER[0]).toBe("first-chat");
    expect(COACHMARK_ORDER).toContain("worktree-picker");
    expect(COACHMARK_ORDER).toContain("machine-disconnected");
  });

  test("pickNextCoachmark returns the first matching id", () => {
    expect(pickNextCoachmark(new Set(), all)).toBe("first-chat");
  });

  test("ack-and-advance: skipping seen ids returns the next match", () => {
    const seen = new Set<CoachmarkId>(["first-chat"]);
    expect(pickNextCoachmark(seen, all)).toBe("worktree-picker");
  });

  test("returns null when nothing matches", () => {
    const flags: CoachmarkFlags = {
      hasOpenedTopic: false,
      hasProject: false,
      hasWorktree: false,
      hasGitStatus: false,
      machineOffline: false,
    };
    expect(pickNextCoachmark(new Set(), flags)).toBeNull();
  });

  test("machine-disconnected only fires when machineOffline=true", () => {
    const offline: CoachmarkFlags = { ...all, machineOffline: true };
    expect(_shouldFire("machine-disconnected", all)).toBe(false);
    expect(_shouldFire("machine-disconnected", offline)).toBe(true);
  });

  test("git-integration fires after worktree exists but before status arrives", () => {
    const flags: CoachmarkFlags = {
      ...all,
      hasOpenedTopic: false, // skip first-chat
      hasWorktree: true,
      hasGitStatus: false,
    };
    expect(pickNextCoachmark(new Set(), flags)).toBe("git-integration");
  });

  test("walking the full queue: ack, repeat, ack, repeat, …", () => {
    let seen = new Set<CoachmarkId>();
    const flags: CoachmarkFlags = {
      hasOpenedTopic: true,
      hasProject: true,
      hasWorktree: true,
      hasGitStatus: true,
      machineOffline: true,
    };
    const visited: CoachmarkId[] = [];
    while (true) {
      const next = pickNextCoachmark(seen, flags);
      if (next === null) break;
      visited.push(next);
      seen = new Set([...seen, next]);
      if (visited.length > 20) throw new Error("loop guard");
    }
    // Every coachmark whose predicate fires under these flags should
    // have been visited exactly once.
    const expected = COACHMARK_ORDER.filter((id) => _shouldFire(id, flags));
    expect(visited).toEqual(expected as unknown as CoachmarkId[]);
    // The visit order must match COACHMARK_ORDER.
    expect(visited).toEqual([...visited].sort((a, b) =>
      COACHMARK_ORDER.indexOf(a) - COACHMARK_ORDER.indexOf(b),
    ));
  });
});
