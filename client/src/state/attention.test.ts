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
import { topicAttentionCount, terminalAttentionCount, rollupProjectAttention } from "./signals";
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

  test("excludes lead (Master) topics so the badge matches the visible rows", () => {
    const topics = {
      chat: topic("chat", { projectPath: PROJ }),
      master: topic("master", { projectPath: PROJ, agentTeamRole: "lead" }),
    };
    const sum = rollupProjectAttention(
      PROJ,
      topics,
      [],
      unread({ chat: 1, master: 9 }), // master has unread but is a lead
      new Set(),
      new Set(),
    );
    expect(sum).toBe(1); // only the non-lead chat counts
  });

  test("is input-independent across lead filtering — tab bar (full map) and sidebar (pre-filtered) agree", () => {
    const lead = topic("master", { projectPath: PROJ, agentTeamRole: "lead" });
    const chat = topic("chat", { projectPath: PROJ });
    const fullMap = { chat, master: lead };          // tab bar hands the full topic map
    const filteredMap = { chat };                     // sidebar pre-filters leads out
    const u = unread({ chat: 2, master: 7 });
    const fromTabBar = rollupProjectAttention(PROJ, fullMap, [], u, new Set(), new Set());
    const fromSidebar = rollupProjectAttention(PROJ, filteredMap, [], u, new Set(), new Set());
    expect(fromTabBar).toBe(fromSidebar);
    expect(fromTabBar).toBe(2);
  });

  test("zero for a project with no pending attention", () => {
    const topics = { a: topic("a", { projectPath: PROJ }) };
    expect(rollupProjectAttention(PROJ, topics, [], unread({}), new Set(), new Set())).toBe(0);
  });
});
