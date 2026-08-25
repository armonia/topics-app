/**
 * Tests for the snapshot ring buffer.
  * @covers CTX-SNAP-01
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { ContextEnvelope } from "./envelope";
import {
  RING_SIZE,
  clearSnapshots,
  getSnapshots,
  pushSnapshot,
  snapshotCounts,
} from "./snapshots";

function envelope(topicId: string, marker: string): ContextEnvelope {
  return {
    topicId,
    sessionKey: `topic:${topicId}`,
    providerName: "claude",
    providerStrategy: "history-aware",
    systemBlocks: [],
    history: [],
    userMessage: { content: marker },
    diagnostics: {
      totalTokens: 0,
      budgetLimit: 200_000,
      budgetPercent: 0,
      droppedHistoryTurns: 0,
      historyEntries: [],
      warnings: [],
      assembledAt: 0,
    },
  };
}

afterEach(() => {
  // Wipe global state between tests so order doesn't matter.
  clearSnapshots();
});

describe("snapshots", () => {
  it("push 3 → get returns 3 in chronological order", () => {
    pushSnapshot(envelope("t1", "a"));
    pushSnapshot(envelope("t1", "b"));
    pushSnapshot(envelope("t1", "c"));
    const out = getSnapshots("t1");
    expect(out.length).toBe(3);
    expect(out.map((e) => e.userMessage.content)).toEqual(["a", "b", "c"]);
  });

  it("ring size bound (RING_SIZE = 5): push 7 → keeps last 5", () => {
    for (let i = 0; i < 7; i++) pushSnapshot(envelope("t1", `m${i}`));
    const out = getSnapshots("t1");
    expect(out.length).toBe(RING_SIZE);
    expect(out.map((e) => e.userMessage.content)).toEqual(["m2", "m3", "m4", "m5", "m6"]);
  });

  it("two topics are isolated", () => {
    pushSnapshot(envelope("t1", "a"));
    pushSnapshot(envelope("t1", "b"));
    pushSnapshot(envelope("t2", "x"));
    expect(getSnapshots("t1").length).toBe(2);
    expect(getSnapshots("t2").length).toBe(1);
    expect(getSnapshots("t2")[0].userMessage.content).toBe("x");
  });

  it("clearSnapshots(topicId) removes only that topic, returns count", () => {
    pushSnapshot(envelope("t1", "a"));
    pushSnapshot(envelope("t1", "b"));
    pushSnapshot(envelope("t2", "x"));
    const removed = clearSnapshots("t1");
    expect(removed).toBe(2);
    expect(getSnapshots("t1").length).toBe(0);
    expect(getSnapshots("t2").length).toBe(1);
  });

  it("clearSnapshots() with no arg wipes everything", () => {
    pushSnapshot(envelope("t1", "a"));
    pushSnapshot(envelope("t2", "x"));
    pushSnapshot(envelope("t3", "y"));
    const removed = clearSnapshots();
    expect(removed).toBe(3);
    expect(getSnapshots("t1").length).toBe(0);
    expect(getSnapshots("t2").length).toBe(0);
    expect(getSnapshots("t3").length).toBe(0);
  });

  it("getSnapshots returns a defensive copy — mutating it does not affect storage", () => {
    pushSnapshot(envelope("t1", "a"));
    const out = getSnapshots("t1");
    out.push(envelope("t1", "tampered"));
    expect(getSnapshots("t1").length).toBe(1);
  });

  it("getSnapshots for unknown topic returns empty array (not undefined)", () => {
    const out = getSnapshots("nonexistent");
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(0);
  });

  it("pushing an envelope with empty topicId is a no-op (no leakage to '' key)", () => {
    pushSnapshot(envelope("", "ghost"));
    expect(getSnapshots("").length).toBe(0);
    expect(snapshotCounts()).toEqual({});
  });

  it("snapshotCounts reports per-topic sizes", () => {
    pushSnapshot(envelope("t1", "a"));
    pushSnapshot(envelope("t1", "b"));
    pushSnapshot(envelope("t2", "x"));
    expect(snapshotCounts()).toEqual({ t1: 2, t2: 1 });
  });
});
