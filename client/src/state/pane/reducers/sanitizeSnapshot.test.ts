import { describe, test, expect } from "bun:test";
import { sanitizeSnapshot, KNOWN_PANE_TYPES } from "./sanitizeSnapshot";
import type { ClosedPaneRecord } from "../types";
import { CLOSED_STACK_MAX } from "../types";

describe("sanitizeSnapshot (audit fixes)", () => {
  test("KNOWN_PANE_TYPES includes the full PaneType union", () => {
    // Spot-check a handful of entries so a regression (typo, drift from
    // types.ts) fails loudly at test time.
    expect(KNOWN_PANE_TYPES).toContain("chat");
    expect(KNOWN_PANE_TYPES).toContain("terminal");
    expect(KNOWN_PANE_TYPES).toContain("file");
    expect(KNOWN_PANE_TYPES).toContain("processes");
    expect(KNOWN_PANE_TYPES).not.toContain("exec" as never);
  });

  test("closedStack round trip preserves outer topicId and filePath", () => {
    const record: ClosedPaneRecord = {
      id: "closed-1",
      closedAt: 1000,
      pane: {
        id: "chat:t1",
        type: "chat",
        title: "Hello",
        topicId: "t1",
      },
      groupId: "g1",
      groupIndex: 0,
      level: "project",
      projectPath: "/tmp/proj",
      topicId: "t1",
      filePath: "/tmp/proj/notes.md",
      focusedAtClose: true,
      tabOrderSnapshot: ["chat:t1"],
      seq: 1,
    };

    const sanitized = sanitizeSnapshot({
      closedStack: [record],
    });

    expect(sanitized).not.toBeNull();
    expect(sanitized!.closedStack).toHaveLength(1);
    expect(sanitized!.closedStack![0].topicId).toBe("t1");
    expect(sanitized!.closedStack![0].filePath).toBe("/tmp/proj/notes.md");
  });

  test("closedStack entries missing topicId/filePath stay undefined", () => {
    const record = {
      id: "closed-2",
      closedAt: 2000,
      pane: { id: "file:a", type: "file", title: "a" },
      groupId: "g1",
      groupIndex: 0,
      level: "project",
      focusedAtClose: false,
      tabOrderSnapshot: [],
      seq: 2,
    };

    const sanitized = sanitizeSnapshot({ closedStack: [record] });
    expect(sanitized!.closedStack).toHaveLength(1);
    expect(sanitized!.closedStack![0].topicId).toBeUndefined();
    expect(sanitized!.closedStack![0].filePath).toBeUndefined();
  });

  test("panes with an unknown type string (e.g. 'exec') are dropped", () => {
    const sanitized = sanitizeSnapshot({
      panes: {
        "exec:bad": { id: "exec:bad", type: "exec", title: "Pwned" },
        "chat:good": { id: "chat:good", type: "chat", title: "Ok" },
      },
    });

    expect(sanitized).not.toBeNull();
    expect(sanitized!.panes).toBeDefined();
    expect(sanitized!.panes!["exec:bad"]).toBeUndefined();
    expect(sanitized!.panes!["chat:good"]).toBeDefined();
    expect(sanitized!.panes!["chat:good"].type).toBe("chat");
  });

  test("a known pane type ('chat') passes through", () => {
    const sanitized = sanitizeSnapshot({
      panes: {
        "chat:t1": {
          id: "chat:t1",
          type: "chat",
          title: "Hello",
          topicId: "t1",
        },
      },
    });

    expect(sanitized!.panes!["chat:t1"]).toEqual({
      id: "chat:t1",
      type: "chat",
      title: "Hello",
      topicId: "t1",
    });
  });

  test("terminal pane preserves terminalType 'codex' through hydrate", () => {
    // Regression: the sanitizer guard only accepted 'shell' | 'claude-code',
    // so a Codex terminal lost its terminalType on every HYDRATE_FROM_SNAPSHOT
    // (the type union and sanitizeTerminal both already allow 'codex').
    const sanitized = sanitizeSnapshot({
      panes: {
        "terminal:cx": {
          id: "terminal:cx",
          type: "terminal",
          title: "Codex",
          terminalType: "codex",
        },
      },
    });

    expect(sanitized!.panes!["terminal:cx"].terminalType).toBe("codex");
  });

  test("panes with empty-string type are dropped", () => {
    const sanitized = sanitizeSnapshot({
      panes: {
        "x:1": { id: "x:1", type: "", title: "empty" },
      },
    });

    expect(sanitized!.panes).toEqual({});
  });

  test("panes with a non-string type (e.g. number 42) are dropped", () => {
    const sanitized = sanitizeSnapshot({
      panes: {
        "x:2": { id: "x:2", type: 42, title: "num" },
      },
    });

    expect(sanitized!.panes).toEqual({});
  });

  test("sanitizeTerminal strips unknown fields from closedStack[].terminal", () => {
    // Review I3 (round-7): previously a bare `isPlainObject` check let
    // arbitrary fields ride through on `terminal` (including a spoofed
    // `__proto__`). Now only the two whitelisted string fields survive.
    const record = {
      id: "closed-term",
      closedAt: 4000,
      pane: { id: "terminal:1", type: "terminal", title: "t" },
      groupId: "g1",
      groupIndex: 0,
      level: "project",
      focusedAtClose: false,
      tabOrderSnapshot: [],
      seq: 4,
      terminal: {
        sessionId: "abc",
        cwd: "/tmp",
        foo: "nope",
        __proto__: { polluted: true },
      },
    };

    const sanitized = sanitizeSnapshot({ closedStack: [record] });
    expect(sanitized!.closedStack).toHaveLength(1);
    const term = sanitized!.closedStack![0].terminal;
    expect(term).toEqual({ sessionId: "abc", cwd: "/tmp" });
    // Defensive: the unknown field must not have leaked through.
    expect((term as Record<string, unknown>).foo).toBeUndefined();
  });

  test("sanitizeTerminal returns undefined for non-object input", () => {
    // Each variant goes through the same closedStack path; we assert that
    // the sanitized `terminal` is undefined regardless of the raw shape.
    const baseRecord = {
      id: "closed-nonobj",
      closedAt: 5000,
      pane: { id: "terminal:2", type: "terminal", title: "t" },
      groupId: "g1",
      groupIndex: 0,
      level: "project",
      focusedAtClose: false,
      tabOrderSnapshot: [],
      seq: 5,
    };

    for (const bad of ["string", 42, null]) {
      const sanitized = sanitizeSnapshot({
        closedStack: [{ ...baseRecord, terminal: bad }],
      });
      expect(sanitized!.closedStack).toHaveLength(1);
      expect(sanitized!.closedStack![0].terminal).toBeUndefined();
    }
  });

  test("sanitizeTerminal drops non-string sessionId/cwd but keeps the valid fields", () => {
    const record = {
      id: "closed-partial-term",
      closedAt: 6000,
      pane: { id: "terminal:3", type: "terminal", title: "t" },
      groupId: "g1",
      groupIndex: 0,
      level: "project",
      focusedAtClose: false,
      tabOrderSnapshot: [],
      seq: 6,
      terminal: { sessionId: "ok", cwd: 123 },
    };

    const sanitized = sanitizeSnapshot({ closedStack: [record] });
    expect(sanitized!.closedStack![0].terminal).toEqual({ sessionId: "ok" });
  });

  test("closedStack capped at CLOSED_STACK_MAX entries after sanitization", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      id: `closed-${i}`,
      closedAt: i * 1000,
      pane: { id: `chat:t${i}`, type: "chat", title: `T${i}` },
      groupId: "g1",
      groupIndex: 0,
      level: "project",
      focusedAtClose: false,
      tabOrderSnapshot: [],
      seq: i,
    }));

    const sanitized = sanitizeSnapshot({ closedStack: entries });

    expect(sanitized).not.toBeNull();
    expect(sanitized!.closedStack).toHaveLength(CLOSED_STACK_MAX);
    // Tail kept — most recently closed entries survive (slice from back).
    // CLOSE_PANE pushes to the end of closedStack and the reducer drops the
    // OLDEST via `.shift()` when length exceeds MAX; the sanitizer must
    // mirror that semantics so undo still reaches the most-recent closes.
    const firstKept = 100 - CLOSED_STACK_MAX;
    expect(sanitized!.closedStack![0].id).toBe(`closed-${firstKept}`);
    expect(sanitized!.closedStack![CLOSED_STACK_MAX - 1].id).toBe("closed-99");
  });

  test("closedStack entry whose nested pane has an unknown type is dropped", () => {
    // Defensive: the outer record fields are fine, but the nested pane is
    // adversarial. Because sanitizePane returns null for unknown types, the
    // entire record must be dropped (we don't synthesize a placeholder pane).
    const bad = {
      id: "closed-bad",
      closedAt: 3000,
      pane: { id: "exec:1", type: "exec", title: "x" },
      groupId: "g1",
      groupIndex: 0,
      level: "project",
      focusedAtClose: false,
      tabOrderSnapshot: [],
      seq: 3,
    };

    const sanitized = sanitizeSnapshot({ closedStack: [bad] });
    expect(sanitized!.closedStack).toEqual([]);
  });

  test("group splitRatio rejects NaN/Infinity and clamps out-of-range values", () => {
    const out = sanitizeSnapshot({
      groups: {
        gNaN: { id: "gNaN", paneIds: [], splitRatio: NaN, splitAxis: "horizontal" },
        gInf: { id: "gInf", paneIds: [], splitRatio: Infinity, splitAxis: "horizontal" },
        gNeg: { id: "gNeg", paneIds: [], splitRatio: -10, splitAxis: "horizontal" },
        gBig: { id: "gBig", paneIds: [], splitRatio: 1e9, splitAxis: "horizontal" },
        gOk:  { id: "gOk",  paneIds: [], splitRatio: 0.42, splitAxis: "horizontal" },
      },
    });
    expect(out!.groups!.gNaN.splitRatio).toBe(0.5);
    expect(out!.groups!.gInf.splitRatio).toBe(0.5);
    expect(out!.groups!.gNeg.splitRatio).toBe(0.05);
    expect(out!.groups!.gBig.splitRatio).toBe(0.95);
    expect(out!.groups!.gOk.splitRatio).toBe(0.42);
  });

  test("dedups a paneId repeated within a single group", () => {
    const out = sanitizeSnapshot({
      groups: {
        g1: { id: "g1", paneIds: ["chat:t1", "chat:t1", "terminal:x"], splitRatio: 0.5, splitAxis: "horizontal" },
      },
    });
    expect(out!.groups!.g1.paneIds).toEqual(["chat:t1", "terminal:x"]);
  });

  test("a paneId in two groups survives only in the FIRST (single-home invariant)", () => {
    const out = sanitizeSnapshot({
      groups: {
        g1: { id: "g1", paneIds: ["terminal:dup", "chat:a"], splitRatio: 0.5, splitAxis: "horizontal" },
        g2: { id: "g2", paneIds: ["terminal:dup", "chat:b"], splitRatio: 0.5, splitAxis: "horizontal" },
      },
    });
    // 'terminal:dup' would otherwise render its window twice — kept in g1, stripped from g2.
    expect(out!.groups!.g1.paneIds).toEqual(["terminal:dup", "chat:a"]);
    expect(out!.groups!.g2.paneIds).toEqual(["chat:b"]);
  });
});
