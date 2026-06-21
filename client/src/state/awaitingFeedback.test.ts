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
 */
import { describe, test, expect } from "bun:test";
import { deriveAwaitingFeedbackTopics, AWAITING_FEEDBACK_PHASES } from "./signals";
import type { Topic, ClaudeSessionState, ClaudeSessionPhase } from "../types";

// Minimal Topic factory — only id + sessionKey are read by the derivation.
const topic = (id: string, sessionKey?: string): Topic =>
  ({ id, name: id, sessionKey } as Topic);

// Minimal session — only `phase` is read; the rest is cast away.
const session = (phase: ClaudeSessionPhase): ClaudeSessionState =>
  ({ phase } as ClaudeSessionState);

describe("AWAITING_FEEDBACK_PHASES", () => {
  test("is exactly the three 'stopped, waiting for you' phases (NOTABLE minus error)", () => {
    expect([...AWAITING_FEEDBACK_PHASES].sort()).toEqual(
      ["awaiting-approval", "awaiting-user", "paused"].sort(),
    );
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
