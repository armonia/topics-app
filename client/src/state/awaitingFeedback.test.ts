/**
 * The phase sets of a claude-code terminal: which phases spin, which rest, and
 * which tier the session's activity LABEL names. Since notifications-redesign
 * no phase lights a tab or a row: that is the server's attention state, and
 * the blue "awaiting feedback" sets that used to derive it from the phase are
 * gone (`attention.surfaces.test.ts` pins the new contract).
 *
 * @covers STATUSLINE-01
 */
import { describe, test, expect } from "bun:test";
import { derivePhaseTerminals, visibleTopicSignalCount, attentionTierForPhase, type TerminalPhaseLite, type TerminalRosterTypeEntry } from "./signals";
import type { Topic, ClaudeSessionPhase } from "../types";

const rosterEntry = (id: string, type: string, claudeSessionId?: string | null): TerminalRosterTypeEntry =>
  ({ id, type, claudeSessionId });
const phaseLite = (phase: ClaudeSessionPhase): TerminalPhaseLite => ({ phase });

describe("derivePhaseTerminals — awaiting set", () => {
  test("a claude-code terminal awaiting the user lands in awaiting AND resting, not active", () => {
    const roster = [rosterEntry("t1", "claude-code", "c1")];
    const byCsid = new Map([["c1", phaseLite("awaiting-user")]]);
    const { active, resting, awaiting } = derivePhaseTerminals(roster, byCsid);
    expect(awaiting.has("t1")).toBe(true);
    expect(resting.has("t1")).toBe(true); // awaiting ⊂ resting (no spinner)
    expect(active.has("t1")).toBe(false);
  });

  test("claude-code-team with paused is awaiting too", () => {
    const roster = [rosterEntry("t1", "claude-code-team", "c1")];
    const byCsid = new Map([["c1", phaseLite("paused")]]);
    expect(derivePhaseTerminals(roster, byCsid).awaiting.has("t1")).toBe(true);
  });

  test("running/tool-running are active, never awaiting", () => {
    for (const phase of ["running", "tool-running"] as ClaudeSessionPhase[]) {
      const roster = [rosterEntry("t1", "claude-code", "c1")];
      const byCsid = new Map([["c1", phaseLite(phase)]]);
      const { active, awaiting } = derivePhaseTerminals(roster, byCsid);
      expect(active.has("t1")).toBe(true);
      expect(awaiting.has("t1")).toBe(false);
    }
  });

  test("completed/error/dormant are resting but NOT awaiting", () => {
    for (const phase of ["completed", "error", "dormant"] as ClaudeSessionPhase[]) {
      const roster = [rosterEntry("t1", "claude-code", "c1")];
      const byCsid = new Map([["c1", phaseLite(phase)]]);
      const { resting, awaiting } = derivePhaseTerminals(roster, byCsid);
      expect(resting.has("t1")).toBe(true);
      expect(awaiting.has("t1")).toBe(false);
    }
  });

  test("codex and shell terminals are excluded from every set (no Claude phase plumbing)", () => {
    const roster = [
      rosterEntry("cdx", "codex", "c1"),
      rosterEntry("sh", "shell", "c2"),
    ];
    const byCsid = new Map([
      ["c1", phaseLite("awaiting-user")],
      ["c2", phaseLite("awaiting-user")],
    ]);
    const { active, resting, awaiting } = derivePhaseTerminals(roster, byCsid);
    for (const set of [active, resting, awaiting]) {
      expect(set.has("cdx")).toBe(false);
      expect(set.has("sh")).toBe(false);
    }
  });

  test("a claude-code terminal with no claudeSessionId or no phase entry is excluded", () => {
    const roster = [
      rosterEntry("noCsid", "claude-code", null),
      rosterEntry("noPhase", "claude-code", "missing"),
    ];
    const { awaiting } = derivePhaseTerminals(roster, new Map());
    expect(awaiting.size).toBe(0);
  });
});

/**
 * The gate that stops the status-bar count from advertising sessions nobody can
 * see. Regression: the bar read "24 in attesa" while the sidebar showed none —
 * 22 of them were ARCHIVED topics (some belonging to worktrees reaped weeks
 * earlier), because the signal Sets are deliberately not archived-filtered and
 * `.size` has no surface behind it to gate on.
 *
 * The Sets stay unfiltered on purpose: every per-row / per-tab consumer is
 * already gated by the existence of its row or tab. Only the count needs this.
 */
describe("visibleTopicSignalCount", () => {
  const archived = (id: string): Topic => ({ id, name: id, archived: true } as Topic);
  const open = (id: string): Topic => ({ id, name: id, archived: false } as Topic);

  test("counts only topics that are not archived", () => {
    const topics = { a: open("a"), b: archived("b"), c: open("c") };
    expect(visibleTopicSignalCount(new Set(["a", "b", "c"]), topics)).toBe(2);
  });

  test("an all-archived set counts zero — the exact shape of the 22-vs-0 bug", () => {
    const topics = { x: archived("x"), y: archived("y"), z: archived("z") };
    expect(visibleTopicSignalCount(new Set(["x", "y", "z"]), topics)).toBe(0);
  });

  test("an id with no topic at all is dropped, not counted", () => {
    // A deleted topic must not keep nagging from the status bar.
    expect(visibleTopicSignalCount(new Set(["ghost"]), { a: open("a") })).toBe(0);
  });

  test("an empty set counts zero", () => {
    expect(visibleTopicSignalCount(new Set(), { a: open("a") })).toBe(0);
  });

  test("does not mutate its inputs", () => {
    const ids = new Set(["a", "b"]);
    const topics = { a: open("a"), b: archived("b") };
    visibleTopicSignalCount(ids, topics);
    expect(ids).toEqual(new Set(["a", "b"]));
    expect(Object.keys(topics).sort()).toEqual(["a", "b"]);
  });
});

describe("the phase LABEL tiers", () => {
  test("awaiting-user is 'done' (calm), awaiting-approval is 'input' (loud)", () => {
    expect(attentionTierForPhase("awaiting-user")).toBe("done");
    expect(attentionTierForPhase("paused")).toBe("done");
    expect(attentionTierForPhase("awaiting-approval")).toBe("input");
  });
});
