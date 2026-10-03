/**
 * SidechainTracker — unit tests.
 *
 * Validates the per-process tracker that aggregates Claude Code Task() sub-
 * agent events into the parent's actions[] log. The tracker is a pure
 * in-memory state machine; no I/O, no spawned processes — easy to test
 * exhaustively.
 * @covers SUBAGENT-01
 */

import { describe, expect, test } from "bun:test";
import { SidechainTracker } from "./sidechain-tracker";

describe("SidechainTracker", () => {
  test("untracked parent — has() returns false, recordChild* return null", () => {
    const t = new SidechainTracker();
    expect(t.has("toolu_x")).toBe(false);
    expect(t.snapshot("toolu_x")).toBeNull();
    expect(t.recordChildText("toolu_x", "hi")).toBeNull();
    expect(t.recordChildToolUse("toolu_x", "child_1", "Read", { file_path: "a.ts" })).toBeNull();
    expect(t.recordChildToolResult("child_1", "ok", false)).toBeNull();
  });

  test("registerParent — captures subagent_type + description", () => {
    const t = new SidechainTracker();
    t.registerParent("toolu_x", { subagent_type: "Explore", description: "find auth code" });
    expect(t.has("toolu_x")).toBe(true);
    const s = t.snapshot("toolu_x")!;
    expect(s.subAgentType).toBe("Explore");
    expect(s.description).toBe("find auth code");
    expect(s.actions).toEqual([]);
    expect(s.fullText).toBe("");
    expect(s.finished).toBe(false);
  });

  test("registerParent — duplicate call is idempotent", () => {
    const t = new SidechainTracker();
    t.registerParent("toolu_x", { subagent_type: "First" });
    t.registerParent("toolu_x", { subagent_type: "Second" });
    expect(t.snapshot("toolu_x")!.subAgentType).toBe("First");
  });

  test("recordChildText — accumulates fullText + appends [text] action", () => {
    const t = new SidechainTracker();
    t.registerParent("p1", {});
    t.recordChildText("p1", "Hello ");
    t.recordChildText("p1", "world!");
    const s = t.snapshot("p1")!;
    expect(s.fullText).toBe("Hello world!");
    expect(s.actions.length).toBe(2);
    expect(s.actions[0].toolName).toBe("text");
    expect(s.actions[0].summary).toBe("Hello ");
    expect(s.actions[1].summary).toBe("world!");
  });

  test("recordChildToolUse — summarizes by tool input shape", () => {
    const t = new SidechainTracker();
    t.registerParent("p1", {});
    t.recordChildToolUse("p1", "c1", "Bash", { command: "ls -la /tmp" });
    t.recordChildToolUse("p1", "c2", "Read", { file_path: "/Users/me/Projects/foo/bar.ts" });
    t.recordChildToolUse("p1", "c3", "Grep", { pattern: "TODO" });
    t.recordChildToolUse("p1", "c4", "WebFetch", { url: "https://example.com" });
    const s = t.snapshot("p1")!;
    expect(s.actions.length).toBe(4);
    expect(s.actions[0].summary).toBe("ls -la /tmp");
    expect(s.actions[1].summary).toBe("/Users/me/Projects/foo/bar.ts");
    expect(s.actions[2].summary).toBe("TODO");
    expect(s.actions[3].summary).toBe("https://example.com");
    // All start as running until we get a result
    for (const a of s.actions) expect(a.status).toBe("running");
  });

  test("recordChildToolResult — patches matching action by child id", () => {
    const t = new SidechainTracker();
    t.registerParent("p1", {});
    t.recordChildToolUse("p1", "c1", "Bash", { command: "ls" });
    t.recordChildToolResult("c1", "12 files\nfoo.ts\nbar.ts", false);
    const s = t.snapshot("p1")!;
    expect(s.actions[0].status).toBe("success");
    // Summary should grow with first line of result
    expect(s.actions[0].summary).toContain("ls");
    expect(s.actions[0].summary).toContain("12 files");
  });

  test("recordChildToolResult — is_error flag → status=error", () => {
    const t = new SidechainTracker();
    t.registerParent("p1", {});
    t.recordChildToolUse("p1", "c1", "Bash", { command: "false" });
    t.recordChildToolResult("c1", "exit 1", true);
    const s = t.snapshot("p1")!;
    expect(s.actions[0].status).toBe("error");
  });

  test("recordChildToolResult — orphan child id is no-op (no parent registration)", () => {
    const t = new SidechainTracker();
    t.registerParent("p1", {});
    // Child id never registered via recordChildToolUse
    expect(t.recordChildToolResult("orphan_child", "result", false)).toBeNull();
    expect(t.snapshot("p1")!.actions.length).toBe(0);
  });

  test("snapshot — returns a deep copy of actions (mutation safe)", () => {
    const t = new SidechainTracker();
    t.registerParent("p1", {});
    t.recordChildToolUse("p1", "c1", "Read", { file_path: "a.ts" });
    const snap1 = t.snapshot("p1")!;
    snap1.actions[0].summary = "MUTATED";
    const snap2 = t.snapshot("p1")!;
    expect(snap2.actions[0].summary).not.toBe("MUTATED");
  });

  test("finish — marks finished and sets fullText fallback", () => {
    const t = new SidechainTracker();
    t.registerParent("p1", { description: "test" });
    t.recordChildText("p1", "doing work");
    const final = t.finish("p1", "FINAL RESULT");
    expect(final).not.toBeNull();
    expect(final!.finished).toBe(true);
    // fullText was already set by recordChildText, so fallback ignored
    expect(final!.fullText).toBe("doing work");
  });

  test("finish — uses finalResult when fullText was empty", () => {
    const t = new SidechainTracker();
    t.registerParent("p1", {});
    const final = t.finish("p1", "FINAL");
    expect(final!.fullText).toBe("FINAL");
  });

  test("finish — returns null for unknown parent", () => {
    const t = new SidechainTracker();
    expect(t.finish("ghost", "x")).toBeNull();
  });

  test("delete — drops parent + all child mappings", () => {
    const t = new SidechainTracker();
    t.registerParent("p1", {});
    t.recordChildToolUse("p1", "c1", "Read", { file_path: "a.ts" });
    t.delete("p1");
    expect(t.has("p1")).toBe(false);
    // Child result for c1 (now orphaned by delete) should not crash and must
    // return null since the parent state is gone.
    expect(t.recordChildToolResult("c1", "ok", false)).toBeNull();
  });

  test("clear — wipes all state", () => {
    const t = new SidechainTracker();
    t.registerParent("p1", {});
    t.registerParent("p2", {});
    t.clear();
    expect(t.has("p1")).toBe(false);
    expect(t.has("p2")).toBe(false);
  });

  test("cap — actions[] bounded to 200 entries", () => {
    const t = new SidechainTracker();
    t.registerParent("p1", {});
    // Add 250 running tool calls. The tracker's drop-oldest-running policy
    // keeps the array at 200 entries (or close — drop happens when adding).
    for (let i = 0; i < 250; i++) {
      t.recordChildToolUse("p1", `c${i}`, "Read", { file_path: `f${i}.ts` });
    }
    const s = t.snapshot("p1")!;
    expect(s.actions.length).toBeLessThanOrEqual(200);
    // The most recent additions should still be present
    const lastSummaries = s.actions.slice(-3).map((a) => a.summary);
    expect(lastSummaries.some((s) => s?.includes("f249.ts"))).toBe(true);
  });

  test("cap — a new tool call past 200 terminal actions is shown and keeps its own result", () => {
    // At the cap with nothing running (text chunks count as actions), the new
    // call was mapped onto the LAST row: it never appeared, and its result
    // rewrote the status and summary of the row before it.
    const t = new SidechainTracker();
    t.registerParent("p1", {});
    for (let i = 0; i < 200; i++) t.recordChildText("p1", `chunk ${i}`);
    t.recordChildToolUse("p1", "c-new", "Bash", { command: "ls" });
    let s = t.snapshot("p1")!;
    expect(s.actions.length).toBe(200);
    expect(s.actions.at(-1)).toMatchObject({ toolName: "Bash", status: "running" });
    expect(s.actions.at(-2)).toMatchObject({ toolName: "text", summary: "chunk 199" });
    t.recordChildToolResult("c-new", "3 files", false);
    s = t.snapshot("p1")!;
    expect(s.actions.at(-1)).toMatchObject({ toolName: "Bash", status: "success" });
    expect(s.actions.at(-2)).toMatchObject({ toolName: "text", summary: "chunk 199" });
    expect(s.actions.at(-2)!.status).toBeUndefined();
    // Indices stay the positions they name.
    s.actions.forEach((a, i) => expect(a.index).toBe(i));
  });

  test("cap — dropping an old row keeps every running call pointing at its own row", () => {
    const t = new SidechainTracker();
    t.registerParent("p1", {});
    t.recordChildText("p1", "first");
    t.recordChildToolUse("p1", "c-old", "Read", { file_path: "old.ts" });
    for (let i = 0; i < 198; i++) t.recordChildText("p1", `chunk ${i}`);
    t.recordChildToolUse("p1", "c-new", "Read", { file_path: "new.ts" });
    t.recordChildToolResult("c-old", "ok", false);
    const s = t.snapshot("p1")!;
    expect(s.actions.find((a) => a.summary?.includes("old.ts"))!.status).toBe("success");
    expect(s.actions.find((a) => a.summary?.includes("new.ts"))!.status).toBe("running");
    s.actions.forEach((a, i) => expect(a.index).toBe(i));
  });

  test("summary truncation — caps at 160 chars with ellipsis", () => {
    const t = new SidechainTracker();
    t.registerParent("p1", {});
    const longCmd = "x".repeat(500);
    t.recordChildToolUse("p1", "c1", "Bash", { command: longCmd });
    const s = t.snapshot("p1")!;
    expect(s.actions[0].summary!.length).toBeLessThanOrEqual(160);
    expect(s.actions[0].summary!.endsWith("…")).toBe(true);
  });

  test("multiple parents — tracked independently", () => {
    const t = new SidechainTracker();
    t.registerParent("p1", { subagent_type: "A" });
    t.registerParent("p2", { subagent_type: "B" });
    t.recordChildToolUse("p1", "c1", "Read", { file_path: "a.ts" });
    t.recordChildToolUse("p2", "c2", "Bash", { command: "ls" });
    expect(t.snapshot("p1")!.actions.length).toBe(1);
    expect(t.snapshot("p2")!.actions.length).toBe(1);
    expect(t.snapshot("p1")!.actions[0].summary).toContain("a.ts");
    expect(t.snapshot("p2")!.actions[0].summary).toContain("ls");
  });

  test("MCP tool name — falls back to namespace summary", () => {
    const t = new SidechainTracker();
    t.registerParent("p1", {});
    t.recordChildToolUse("p1", "c1", "mcp__omega-memory__omega_query", {});
    const s = t.snapshot("p1")!;
    expect(s.actions[0].toolName).toBe("mcp__omega-memory__omega_query");
    // Summary should include server/tool from the name when args are empty
    expect(s.actions[0].summary).toBeDefined();
  });

  // ── listPendingParents (Fix B in stream-timeout-resilience) ─────────────
  describe("listPendingParents", () => {
    test("empty tracker returns []", () => {
      const t = new SidechainTracker();
      expect(t.listPendingParents()).toEqual([]);
    });

    test("returns ids of registered, unfinished parents", () => {
      const t = new SidechainTracker();
      t.registerParent("p1", {});
      t.registerParent("p2", {});
      const pending = t.listPendingParents().sort();
      expect(pending).toEqual(["p1", "p2"]);
    });

    test("excludes finished parents", () => {
      const t = new SidechainTracker();
      t.registerParent("p1", {});
      t.registerParent("p2", {});
      t.finish("p1", "result text");
      expect(t.listPendingParents()).toEqual(["p2"]);
    });

    test("excludes deleted parents", () => {
      const t = new SidechainTracker();
      t.registerParent("p1", {});
      t.delete("p1");
      expect(t.listPendingParents()).toEqual([]);
    });
  });
});
