/**
 * Tests for the unified attention helpers — the single definition of "this
 * needs you", shared by the tab bar (getBadgeCount / getProjectBadgeCount) and
 * the sidebar (buildSidebarItems). The whole point of these helpers is that the
 * two surfaces can't drift, so the contract worth pinning is:
 *   - a chat counts max(unread, Claude-needs-you), never the sum;
 *   - a terminal counts a finished-but-unseen turn;
 *   - a project rolls up its children, excludes lead (Master) topics, and so
 *     produces the SAME number regardless of whether it's handed the full topic
 *     map (tab bar) or the lead-filtered one (sidebar).
 */
import { describe, test, expect } from "bun:test";
import { topicAttentionCount, terminalAttentionCount, rollupProjectAttention, rollupGlobalAttention } from "./signals";
import type { Topic, TerminalSessionInfo } from "../types";

const unread = (counts: Record<string, number>): Record<string, { unreadCount: number }> =>
  Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, { unreadCount: n }]));

// Minimal Topic factory — only the fields the rollup reads.
const topic = (id: string, over: Partial<Topic> = {}): Topic =>
  ({ id, name: id, ...over } as Topic);

// Minimal terminal — only id + cwd matter to the rollup.
const term = (id: string, cwd: string): TerminalSessionInfo =>
  ({ id, cwd } as TerminalSessionInfo);

describe("topicAttentionCount", () => {
  test("uses server unread when there's no Claude attention", () => {
    expect(topicAttentionCount("t", unread({ t: 3 }), new Set())).toBe(3);
  });

  test("counts Claude needs-you as 1 even with zero unread", () => {
    expect(topicAttentionCount("t", unread({}), new Set(["t"]))).toBe(1);
  });

  test("takes the max, never the sum (no double counting)", () => {
    // unread 5 + needs-you should still read as 5, not 6.
    expect(topicAttentionCount("t", unread({ t: 5 }), new Set(["t"]))).toBe(5);
    // needs-you (1) beats a single unread (1) → still 1, not 2.
    expect(topicAttentionCount("t", unread({ t: 1 }), new Set(["t"]))).toBe(1);
  });

  test("is zero when nothing is pending", () => {
    expect(topicAttentionCount("t", unread({}), new Set())).toBe(0);
  });
});

describe("terminalAttentionCount", () => {
  test("a finished-but-unseen claude-code turn counts 1", () => {
    expect(terminalAttentionCount("s", new Set(["s"]))).toBe(1);
  });
  test("zero when not finished", () => {
    expect(terminalAttentionCount("s", new Set())).toBe(0);
  });
});

describe("rollupProjectAttention", () => {
  const PROJ = "/work/app";

  test("sums child chat attention + finished terminals under the project", () => {
    const topics = {
      a: topic("a", { projectPath: PROJ }),
      b: topic("b", { projectPath: PROJ }),
      other: topic("other", { projectPath: "/work/elsewhere" }),
    };
    const terminals = [term("term1", `${PROJ}/sub`), term("term2", "/work/elsewhere")];
    const sum = rollupProjectAttention(
      PROJ,
      topics,
      terminals,
      unread({ a: 2 }),          // a: 2 unread
      new Set(["b"]),            // b: Claude needs-you (1)
      new Set(["term1"]),        // term1 finished (1) — under the project
    );
    // 2 (a) + 1 (b) + 1 (term1). `other` and `term2` belong to another project.
    expect(sum).toBe(4);
  });

  test("zero for a project with no pending attention", () => {
    const topics = { a: topic("a", { projectPath: PROJ }) };
    expect(rollupProjectAttention(PROJ, topics, [], unread({}), new Set(), new Set())).toBe(0);
  });
});

describe("rollupGlobalAttention", () => {
  test("sums every topic's attention across ALL projects + all finished terminals", () => {
    const topics = {
      a: topic("a", { projectPath: "/work/app" }),
      b: topic("b", { projectPath: "/work/elsewhere" }),
      c: topic("c"), // no project
    };
    const sum = rollupGlobalAttention(
      topics,
      unread({ a: 2, c: 1 }),   // a: 2 unread, c: 1 unread
      new Set(["b"]),           // b: Claude needs-you (1)
      new Set(["t1", "t2"]),    // two finished terminal turns (project-agnostic)
    );
    // 2 (a) + 1 (b) + 1 (c) + 2 (terminals) = 6. Unlike the project rollup, no
    // cwd/project filtering — every subject counts once toward the dock badge.
    expect(sum).toBe(6);
  });

  test("is zero when nothing anywhere is pending", () => {
    const topics = { a: topic("a"), b: topic("b") };
    expect(rollupGlobalAttention(topics, unread({}), new Set(), new Set())).toBe(0);
  });

  test("takes max(unread, needs-you) per chat — never double counts", () => {
    const topics = { a: topic("a") };
    // a is BOTH 3-unread AND needs-you → still 3 (max), plus no terminals.
    expect(rollupGlobalAttention(topics, unread({ a: 3 }), new Set(["a"]), new Set())).toBe(3);
  });
});
