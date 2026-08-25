/**
 * Tests for the blue "awaiting feedback" signal — the subset of Claude phases
 * that means "this chat is STOPPED and waiting for you" (awaiting-user /
 * awaiting-approval / paused). It drives the blue tab/row fill, and is kept
 * distinct from the attention badge (which also counts `error` + unread).
 *
 * The contract worth pinning, churn-immune (no store / WS needed):
 *   - the three awaiting-* phases map a topic into the set;
 *   - working (running/tool-running), ended (completed/dormant), failed (error)
 *     and the not-yet-confirmed `starting` phase do NOT;
 *   - a topic with no sessionKey, or whose session isn't in the map, is ignored;
 *   - the set holds TOPIC ids, keyed via each topic's sessionKey.
 *
 * @covers STATUSLINE-01
 */
import { describe, test, expect } from "bun:test";
import { deriveAwaitingFeedbackTopics, deriveAwaitingInputTopics, derivePhaseTerminals, visibleTopicSignalCount, attentionTierForPhase, AWAITING_FEEDBACK_PHASES, AWAITING_INPUT_PHASES, type TerminalPhaseLite, type TerminalRosterTypeEntry } from "./signals";
import type { Topic, ClaudeSessionState, ClaudeSessionPhase } from "../types";

// Minimal Topic factory — only id + sessionKey are read by the derivation.
const topic = (id: string, sessionKey?: string): Topic =>
  ({ id, name: id, sessionKey } as Topic);

// Minimal session — only `phase` is read; the rest is cast away.
const session = (phase: ClaudeSessionPhase): ClaudeSessionState =>
  ({ phase } as ClaudeSessionState);

describe("AWAITING_FEEDBACK_PHASES", () => {
  test("is exactly the three 'stopped, waiting for you' phases (NOTABLE minus error)", () => {
    // Annotato, non lasciato a `string[]`: cosi' un nome che smette di essere
    // una fase non compila piu' invece di fallire a runtime a lista cambiata.
    const attese: ClaudeSessionPhase[] = ["awaiting-approval", "awaiting-user", "paused"];
    expect([...AWAITING_FEEDBACK_PHASES].sort()).toEqual(attese.sort());
  });
});

describe("deriveAwaitingFeedbackTopics", () => {
  test("includes the three awaiting-* phases", () => {
    const topics = {
      u: topic("u", "k-u"),
      a: topic("a", "k-a"),
      p: topic("p", "k-p"),
    };
    const sessions = new Map<string, ClaudeSessionState>([
      ["k-u", session("awaiting-user")],
      ["k-a", session("awaiting-approval")],
      ["k-p", session("paused")],
    ]);
    expect(deriveAwaitingFeedbackTopics(topics, sessions)).toEqual(new Set(["u", "a", "p"]));
  });

  test("excludes working / ended / failed / starting phases", () => {
    for (const phase of ["starting", "running", "tool-running", "completed", "error", "dormant"] as ClaudeSessionPhase[]) {
      const topics = { t: topic("t", "k") };
      const sessions = new Map([["k", session(phase)]]);
      expect(deriveAwaitingFeedbackTopics(topics, sessions).has("t")).toBe(false);
    }
  });

  test("ignores a topic with no sessionKey", () => {
    const topics = { t: topic("t") }; // no sessionKey
    const sessions = new Map([["k", session("awaiting-user")]]);
    expect(deriveAwaitingFeedbackTopics(topics, sessions).size).toBe(0);
  });

  test("ignores a topic whose session isn't in the map", () => {
    const topics = { t: topic("t", "missing") };
    expect(deriveAwaitingFeedbackTopics(topics, new Map()).size).toBe(0);
  });

  test("keys the set by topic id, not sessionKey", () => {
    const topics = { "topic-1": topic("topic-1", "sess-9") };
    const sessions = new Map([["sess-9", session("awaiting-user")]]);
    const out = deriveAwaitingFeedbackTopics(topics, sessions);
    expect(out.has("topic-1")).toBe(true);
    expect(out.has("sess-9")).toBe(false);
  });

  test("partitions a mixed roster correctly", () => {
    const topics = {
      waiting: topic("waiting", "k1"),
      working: topic("working", "k2"),
      errored: topic("errored", "k3"),
      noKey: topic("noKey"),
    };
    const sessions = new Map<string, ClaudeSessionState>([
      ["k1", session("awaiting-user")],
      ["k2", session("running")],
      ["k3", session("error")],
    ]);
    expect(deriveAwaitingFeedbackTopics(topics, sessions)).toEqual(new Set(["waiting"]));
  });

  test("every awaiting phase is also NOTABLE (badge stays a superset of blue)", () => {
    // Guards the invariant that the blue fill never appears without the badge
    // also lighting — they share the same underlying phases, blue ⊂ notable.
    for (const phase of AWAITING_FEEDBACK_PHASES) {
      const topics = { t: topic("t", "k") };
      const sessions = new Map([["k", session(phase)]]);
      expect(deriveAwaitingFeedbackTopics(topics, sessions).has("t")).toBe(true);
    }
  });
});

// ── Terminal twin: derivePhaseTerminals' `awaiting` set ────────────────────
// Terminal Claude-Code sessions key on claudeSessionId (NOT topic.sessionKey).
// `awaiting` must be a subset of `resting` and exclude active/codex/shell.

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

/**
 * The two tiers must stay separable: `awaiting-approval` is the LOUD one (a
 * permission gate — answer me now), `awaiting-user`/`paused` merely mean the
 * turn ended. The status-bar chip painted the whole union amber, so a pile of
 * finished turns read as a pile of prompts.
 */
describe("awaiting tiers stay separable", () => {
  test("the input subset is strictly inside the feedback set", () => {
    for (const phase of [...AWAITING_INPUT_PHASES]) {
      expect(AWAITING_FEEDBACK_PHASES.has(phase)).toBe(true);
    }
    expect(AWAITING_INPUT_PHASES.size).toBeLessThan(AWAITING_FEEDBACK_PHASES.size);
  });

  test("awaiting-user is 'done' (calm), awaiting-approval is 'input' (loud)", () => {
    expect(attentionTierForPhase("awaiting-user")).toBe("done");
    expect(attentionTierForPhase("paused")).toBe("done");
    expect(attentionTierForPhase("awaiting-approval")).toBe("input");
  });

  test("deriveAwaitingInputTopics picks only the loud phase", () => {
    const topics = { u: topic("u", "k-u"), a: topic("a", "k-a"), p: topic("p", "k-p") };
    const sessions = new Map<string, ClaudeSessionState>([
      ["k-u", session("awaiting-user")],
      ["k-a", session("awaiting-approval")],
      ["k-p", session("paused")],
    ]);
    expect(deriveAwaitingInputTopics(topics, sessions)).toEqual(new Set(["a"]));
  });
});
